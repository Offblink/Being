"""Being — 一对一人机聊天应用。

三条核心行为（都在这一层）：
1. 延迟回复 + 多气泡：AI 的回话按逗号/句读拆成一条条短消息，每条按自己的字数
   算出延迟，睡够了才发 —— 模拟真人一段段打字往外发。
2. 插话打断：人类在中途再发一条，未落地的剩余气泡全部作废，按新上下文重新开始。
3. emmm 守卫：AI 不想回时回复里带 <<emmm>>，守卫拦下，不上屏、不入历史。
状态栏的在线/离线来自冒烟调用（probe 成功即在线）。
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import os
import random
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import httpx
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
CONFIG_PATH = ROOT / "config.json"
PROMPT_PATH = ROOT / "prompt.txt"
SESSION_DIR = ROOT / "sessions"           # 一个会话 = 一个 Being 的记忆，一个 JSON
MEDIA_DIR = ROOT / "media"                # 聊天里的照片（会话删除时连它自己的子目录一起删）
LEGACY_MESSAGES = ROOT / "messages.json"  # 单会话时代的存档，首次启动搬进 sessions/

EMMM = "<<emmm>>"
HISTORY_WINDOW = 40  # 发给模型的历史条数上限（系统提示词不算在内）
PROBE_TIMEOUT = 15.0
TURN_TIMEOUT = 120.0
VISION_TIMEOUT = 60.0   # 识图转述一次的上限
MAX_TOOL_ROUNDS = 4  # 一条回复里最多允许几次"调工具再接着说"
MAX_IMAGE_BYTES = 8 * 1024 * 1024  # 一张照片的上限（浏览器端已压过，这里兜底）
_KEY_MASK = "••••••••"  # 设置面板显示密钥用；提交回来等于它就表示"不改"
_WEEKDAYS = "一二三四五六日"

# 1×1 透明 PNG：探测"聊天模型吃不吃得下图片"用，小到不会心疼
_TINY_PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
    "+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)
# 照片只认这几种：magic bytes 说了算，不看扩展名（顺带挡掉 SVG 的同源脚本）
_MAGIC = (("jpeg", b"\xff\xd8\xff"), ("png", b"\x89PNG\r\n\x1a\n"), ("gif", b"GIF8"))
_MAGIC += (("webp", b"RIFF"),)

_DEFAULTS = {
    "endpoint": "",
    "api_key": "",
    "model": "",
    "port": 8619,
    "probe_interval": 60,
    # 延迟 = (base + per_char * 字数) ± jitter，再夹在 [min, max]
    "delay": {"base": 1.2, "per_char": 0.13, "min": 1.5, "max": 20.0, "jitter": 0.15},
    # 识图：填齐了「发照片」才生效（这个分支没有生图，也没有头像）
    "vision": {"endpoint": "", "api_key": "", "model": ""},
    # 我的资料：只有一个昵称（纯文本，进它的提示词）
    "me": {"nickname": ""},
}


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _section(raw: dict, key: str) -> dict:
    """一个配置段：默认值打底，磁盘上的字段盖上去（缺段/坏段都不炸）。"""
    out = dict(_DEFAULTS[key])
    got = raw.get(key)
    if isinstance(got, dict):
        out.update({k: v for k, v in got.items() if k in out})
    return out


def _load_config() -> dict:
    raw = _read_json(CONFIG_PATH) or {}
    cfg = dict(_DEFAULTS)
    for key in ("endpoint", "api_key", "model", "port", "probe_interval"):
        if key in raw:
            cfg[key] = raw[key]
    delay = dict(_DEFAULTS["delay"])
    if isinstance(raw.get("delay"), dict):
        delay.update(raw["delay"])
    cfg["delay"] = delay
    for key in ("vision", "me"):
        cfg[key] = _section(raw, key)
    return cfg


cfg = _load_config()

sessions: dict[str, dict] = {}  # id -> {id, title, renamed, created, updated, persona, messages}
current_id: str = ""  # 正在聊的那个 Being；消息条目 {id, role: human|ai, text, ts, image?, quote?}
subscribers: set[asyncio.Queue] = set()
status: dict = {"online": None}  # None = 还没冒烟过（前端显示"检测中"）
pending: dict[str, asyncio.Task] = {}  # 每个会话在飞的那一轮：**多会话并行**，换房间不打断
unread: dict[str, int] = {}  # sid -> 不在当前会话时收到的条数（只在内存里，不落盘）
turn_seq = 0  # 轮次号：被打断的旧轮 turn_end 会被前端按号忽略
vision_state: dict = {"known": None, "detail": ""}  # 最近一次识图探测的结果（前端展示用）


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def photos_enabled() -> bool:
    """这个分支只剩「识图」一道门：那一段填齐了，照片按钮才出现、照片才送得出去。

    填一半的识图端点等于没填 —— 所以 endpoint 与 model 都要求非空。
    昵称是纯文本，不归这道门管。
    """
    v = cfg["vision"]
    return bool(v["endpoint"] and v["model"])


def gate_error() -> str:
    """门禁拦下时的原话 —— 直接说清去哪儿填什么。"""
    return "识图还没填：设置里补上识图的接口地址和模型名，发照片才用得了"


def _same_vision_as_chat() -> bool:
    """识图端点就是聊天端点时，图片可以原样直传（模型真看得见），不必转述。"""
    v = cfg["vision"]
    return bool(v["endpoint"]) and v["endpoint"] == cfg["endpoint"] and v["model"] == cfg["model"]


def _auth_headers(section: dict | None = None) -> dict:
    sec = section if section is not None else cfg
    key = str(sec.get("api_key") or "")
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    return headers


def save_config() -> bool:
    """设置面板改完落盘。只有真键值得留（端口/节奏那几个照样写全，简单点）。"""
    try:
        CONFIG_PATH.write_text(
            json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        return True
    except OSError as exc:
        print(f"[config] save failed: {exc}", flush=True)
        return False


def _clean_messages(raw) -> list[dict]:
    """存档 -> 内存条目；坏行丢掉，id 按顺序重排（id 只是前端的去重游标）。

    照片消息允许 text 为空（只发了一张图），引用与识图描述跟着消息一起回来。
    """
    out: list[dict] = []
    if isinstance(raw, list):
        for m in raw:
            if not isinstance(m, dict) or m.get("role") not in ("human", "ai"):
                continue
            text = str(m.get("text") or "")
            image = str(m.get("image") or "")
            if not text and not image:
                continue
            item = {"id": len(out), "role": m["role"], "text": text, "ts": m.get("ts") or 0.0}
            if image:
                item["image"] = image
            if isinstance(m.get("img_desc"), str) and m["img_desc"]:
                item["img_desc"] = m["img_desc"]
            if isinstance(m.get("quote"), dict) and m["quote"].get("text"):
                item["quote"] = {
                    "id": m["quote"].get("id"),
                    "role": m["quote"].get("role"),
                    "text": str(m["quote"]["text"])[:300],
                }
            out.append(item)
    return out


def title_from(sess: dict) -> str:
    """标题 = 有昵称就用昵称（一个会话 = 一个 Being），否则首条人话，最多 50 字。

    昵称是纯文本，谁都不拦它 —— 填了就生效。
    """
    if sess.get("persona", {}).get("nickname"):
        return str(sess["persona"]["nickname"])[:50]
    for m in sess["messages"]:
        if m["role"] == "human":
            text = " ".join(m["text"].split())
            if text:
                return text[:47] + "..." if len(text) > 50 else text
            if m.get("image"):
                return "[照片]"
    return "新的会话"



_SID_STATE = {"tick": "", "seq": 0}


def new_sid() -> str:
    """会话 id 就是文件名：同一秒里连开两个不许撞（撞了后者会覆盖前者）。"""
    tick = datetime.now().strftime("%Y%m%d-%H%M%S")
    if tick == _SID_STATE["tick"]:
        _SID_STATE["seq"] += 1
    else:
        _SID_STATE["tick"], _SID_STATE["seq"] = tick, 0
    seq = _SID_STATE["seq"]
    return tick if seq == 0 else f"{tick}-{seq}"


def _sid_path(sid: str) -> Path:
    return SESSION_DIR / f"{sid}.json"


def save_session(sess: dict) -> None:
    """先写旁边的 .tmp 再改名顶上去 —— 半截 JSON 读回来跟"记忆没了"没法区分。"""
    try:
        SESSION_DIR.mkdir(parents=True, exist_ok=True)
        path = _sid_path(sess["id"])
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(sess, ensure_ascii=False, indent=2), encoding="utf-8")
        for attempt in range(4):  # 外面有人拿着句柄时 Windows 拒绝改名，等一下再试
            try:
                tmp.replace(path)
                return
            except PermissionError:
                if attempt == 3:
                    raise
                time.sleep(0.05)
    except OSError as exc:
        print(f"[store] save failed: {exc}", flush=True)


def touch(sess: dict) -> None:
    """落盘并把 updated 推到现在；没被改过名的会话标题跟着首条人话走。"""
    sess["updated"] = _now()
    if not sess.get("renamed"):
        sess["title"] = title_from(sess)
    save_session(sess)


def create_session(select: bool = False) -> dict:
    global current_id
    sid = new_sid()
    sess = {
        "id": sid,
        "title": "新的会话",
        "renamed": False,
        "created": _now(),
        "updated": _now(),
        "persona": {},
        "messages": [],
    }
    sessions[sid] = sess
    if select or not current_id:
        current_id = sid
    save_session(sess)
    return sess


def _migrate_legacy() -> bool:
    """单会话时代的 messages.json 搬成一个会话；搬完改名留痕，不会再搬第二次。"""
    msgs = _clean_messages(_read_json(LEGACY_MESSAGES))
    if not msgs:
        return False
    sess = create_session(select=True)
    sess["messages"] = msgs
    touch(sess)
    try:
        LEGACY_MESSAGES.rename(LEGACY_MESSAGES.with_name("messages.json.migrated"))
    except OSError as exc:
        print(f"[store] legacy messages kept: {exc}", flush=True)
    return True


def load_sessions() -> None:
    global current_id
    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    sessions.clear()
    for path in sorted(SESSION_DIR.glob("*.json")):
        data = _read_json(path)
        if not isinstance(data, dict):
            continue  # 坏文件跳过，不炸整张列表
        sid = str(data.get("id") or path.stem)
        persona = data.get("persona")
        sessions[sid] = {
            "id": sid,
            "title": str(data.get("title") or ""),
            "renamed": bool(data.get("renamed")),
            "created": str(data.get("created") or _now()),
            "updated": str(data.get("updated") or _now()),
            "persona": persona if isinstance(persona, dict) else {},
            "messages": _clean_messages(data.get("messages")),
        }
    if not sessions and not _migrate_legacy():
        create_session(select=True)
    if current_id not in sessions:
        current_id = newest_id()
    for sess in sessions.values():
        # 有昵称的会话：标题跟着昵称走（改过名的除外）
        if not sess.get("renamed") and sess.get("persona", {}).get("nickname"):
            sess["title"] = title_from(sess)
        elif not sess["title"]:
            sess["title"] = title_from(sess)


def newest_id() -> str:
    if not sessions:
        return ""
    return max(sessions.values(), key=lambda s: (s["updated"], s["id"]))["id"]


def cur() -> dict:
    return sessions[current_id]


def session_list() -> list[dict]:
    """所有会话的元信息，最近碰过的在前 —— 前端那份列表就是它。

    `typing` 是并行的那只眼睛：别的房间里还有人在打字，这一行要看得出。
    """
    out: list[dict] = []
    for s in sorted(sessions.values(), key=lambda s: (s["updated"], s["id"]), reverse=True):
        task = pending.get(s["id"])
        # 改过名的用原名；没改过的走 title_from（有昵称就用昵称，没有取首条人话）
        title = s["title"] if s.get("renamed") else title_from(s)
        out.append(
            {
                "id": s["id"],
                "title": title,
                "msgCount": len(s["messages"]),
                "updated": s["updated"],
                "current": s["id"] == current_id,
                "typing": bool(task is not None and not task.done()),
                "unread": 0 if s["id"] == current_id else unread.get(s["id"], 0),
            }
        )
    return out


def broadcast(event: dict) -> None:
    for q in list(subscribers):
        q.put_nowait(event)


def _data_uri(rel: str) -> str:
    """media/ 下的相对路径 -> data URI（模型那端拿不到本机文件系统，只能内联）。"""
    path = MEDIA_DIR / rel
    if not path.is_file():
        return ""
    ext = (path.suffix or ".jpg").lower()
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
            "webp": "image/webp", "gif": "image/gif"}.get(ext.lstrip("."), "image/jpeg")
    try:
        raw = path.read_bytes()
    except OSError:
        return ""
    if len(raw) > MAX_IMAGE_BYTES:
        return ""
    return f"data:{mime};base64,{base64.b64encode(raw).decode()}"


def _msg_text(m: dict) -> str:
    """这一条发给模型的文本：引用摆在最前面，照片用描述补一句。"""
    text = str(m.get("text") or "")
    quote = m.get("quote")
    if isinstance(quote, dict) and quote.get("text"):
        who = "对方" if quote.get("role") == "human" else "你"
        text = f"（引用{who}的那条：{quote['text']}）\n{text}".strip()
    return text


def build_llm_messages(system_prompt: str, sess: dict) -> list[dict]:
    """窗口内历史 -> chat 格式。插话后会出现两条相邻 human，合并成一条发。

    照片两条路（Q2 的决定）：识图端点 == 聊天端点时把图片直传给模型；
    是另一个模型时，历史里只留它转述过的文字（img_desc）。
    """
    hist = sess["messages"][-HISTORY_WINDOW:]
    while hist and hist[0]["role"] == "ai":  # 别让对话以 AI 开头
        hist = hist[1:]
    out: list[dict] = [{"role": "system", "content": system_prompt}]
    direct = _same_vision_as_chat() and photos_enabled()
    for m in hist:
        role = "user" if m["role"] == "human" else "assistant"
        text = _msg_text(m)
        parts = None
        if m.get("image") and role == "user" and direct:
            uri = _data_uri(m["image"])
            if uri:
                parts = [{"type": "text", "text": text or "（我发了一张照片）"},
                         {"type": "image_url", "image_url": {"url": uri}}]
        if parts is None and m.get("image") and m.get("img_desc"):
            text = (text + "\n" if text else "") + f"（照片内容：{m['img_desc']}）"
        if parts is None and not text and m.get("image"):
            text = "（我发了一张照片）"
        if parts is not None:
            out.append({"role": role, "content": parts})
            continue
        if out[-1]["role"] == role and isinstance(out[-1]["content"], str):
            out[-1]["content"] += "\n" + text
        else:
            out.append({"role": role, "content": text})
    return out


def _clock() -> str:
    """看一眼钟。模型自己没有任何时间感 —— 实测它会把 23:30 说成“九点四十”。"""
    now = datetime.now()
    h = now.hour
    part = (
        "凌晨" if h < 5 else "早上" if h < 9 else "上午" if h < 12
        else "中午" if h < 13 else "下午" if h < 18 else "晚上" if h < 23
        else "深夜"
    )
    return f"{now:%Y-%m-%d} 星期{_WEEKDAYS[now.weekday()]} {now:%H:%M}（{part}）"


def _now_line() -> str:
    """当前时间直接写进提示词。

    工具有（look_at_clock），但它经常不调 —— 实测中午 12:51 跟人说“这么晚了还在线，
    也睡不着？”，被点破才改口“大中午的”。时间这种东西每轮都在变、又一定用得上，
    与其指望它主动调工具，不如每轮直接塞进上下文（system_content 每次调用都重算）。

    但得跟它讲清楚这只是**这一轮**的快照：对话拖很久、隔一阵再回，时间已经往前走了，
    提示词里那个数就过期了 —— 所以 look_at_clock 不撤，拿不准时用它核。
    """
    return (
        f"【现在的时间】{_clock()}。"
        "聊到几点、白天晚上、吃饭睡觉、这会儿在干嘛这类事，以它为准，别凭感觉猜。\n"
        "注意这只是你这一轮说话时的时刻，每轮都会刷新一次；对话拖久了时间会往前走，"
        "隔一阵再回来看它就不一定还准 —— 拿不准就调 look_at_clock 再核一遍，别拿旧时间当现在。"
    )


# 工具表：加一个工具就在这里加一条（描述里写清“什么时候该用”）。
TOOLS = [
    {
        "name": "look_at_clock",
        "description": (
            "再确认一次现在的时间（日期、星期、几点几分）。当前时间已经每轮写进你的提示词了，"
            "一般不用调；只有对话拖了很久、你想再核对一遍时才用。"
        ),
        "impl": _clock,
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
]


async def run_tool(call: dict) -> str:
    """跑一次工具调用。工具自己出问题不该炸掉整轮：如实告诉模型。"""
    fn = call.get("function") or {}
    name = str(fn.get("name") or "")
    for tool in TOOLS:
        if tool["name"] == name:
            try:
                res = tool["impl"]()
                if asyncio.iscoroutine(res):
                    res = await res
                return str(res)
            except Exception as exc:  # noqa: BLE001 - 工具是外挂的，什么都可能抛
                return f"（{name} 没能取到结果：{exc}）"
    return f"（没有叫 {name} 的工具）"


def tool_specs() -> list[dict]:
    return [
        {
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool["description"],
                "parameters": tool["parameters"],
            },
        }
        for tool in TOOLS
    ]


def tools_block() -> str:
    """把工具表讲给模型听 —— 工具不是它天生就会的事，得说明白什么时候用。"""
    lines = "\n".join(f"- {tool['name']}：{tool['description']}" for tool in TOOLS)
    return (
        "【工具】下面这些工具你自己就能用，对方看不到调用过程：把它返回的内容当成你刚看到的事实，"
        "直接说就行。要说这类事之前先用工具看一眼，不许凭印象猜。"
        "永远不要跟对方提“工具/函数/系统”这类字眼。\n" + lines
    )


def persona_block(sess: dict) -> str:
    """这个人设是它在第一句话之后自己立的，贯穿全会话 —— 每次调用都原样带上。"""
    p = sess.get("persona")
    if not isinstance(p, dict) or not p.get("nickname"):
        return ""
    lines = [f"- 你的名字：{p.get('nickname')}"]
    for key, label in (("identity", "身份"), ("age", "年龄"), ("gender", "性别"),
                       ("origin", "来自哪里"), ("hobbies", "爱好"), ("traits", "特点")):
        if p.get(key):
            lines.append(f"- {label}：{p[key]}")
    return (
        "\n\n【你给自己立的人设（第一句话之后定下来的，整段对话都作数，"
        "不许中途改名、改年龄、改来历）】\n"
        + "\n".join(lines)
        + "\n这些是你自己的底细：不必一问就全盘托出，被人问到才自然地透露，"
        "但说出来的必须和上面一致。"
    )


def me_block() -> str:
    """AI 看到的对方：只有一个昵称（对方在设置里填的，纯文本）。"""
    nick = str(cfg["me"].get("nickname") or "")
    if not nick:
        return ""
    return "\n\n【对方的资料（对方自己填的，仅你可见）】\n" + f"- 对方的昵称：{nick}"


def system_content(sess: dict | None = None) -> str:
    """人设提示词 + 现在的时间 + 自己的人设 + 对方的资料 + 工具说明。每次调用重算。"""
    base = PROMPT_PATH.read_text(encoding="utf-8").rstrip()
    base += "\n\n" + _now_line()
    if sess is not None:
        base += persona_block(sess)
    base += me_block()
    tail = tools_block()
    return base + ("\n\n" + tail if tail else "")


async def call_llm(sess: dict) -> str:
    """给这个会话生成一条回复，允许中途调用工具（模型自己没有的信息，比如现在几点）。"""
    await describe_photos(sess)  # 异模型分支：先让识图那边把照片说成话，历史里才是文字
    convo = build_llm_messages(system_content(sess), sess)
    async with httpx.AsyncClient(timeout=httpx.Timeout(TURN_TIMEOUT, connect=10.0)) as client:
        for _ in range(MAX_TOOL_ROUNDS):
            payload = {
                "model": cfg["model"],
                "messages": convo,
                "max_tokens": 1024,
                "stream": False,
                "tools": tool_specs(),
            }
            r = await client.post(cfg["endpoint"], json=payload, headers=_auth_headers())
            r.raise_for_status()
            data = r.json()
            choices = data.get("choices") or []
            if not choices:
                raise RuntimeError(f"no choices in response: {str(data)[:200]}")
            msg = choices[0].get("message") or {}
            calls = msg.get("tool_calls") or []
            if not calls:
                return str(msg.get("content") or "")
            # 工具往返只活在这一轮生成内部，不进对话存档（打断即整轮作废）
            convo.append(
                {"role": "assistant", "content": msg.get("content") or None, "tool_calls": calls}
            )
            for call in calls:
                convo.append(
                    {
                        "role": "tool",
                        "tool_call_id": str(call.get("id") or ""),
                        "content": await run_tool(call),
                    }
                )
    raise RuntimeError(f"tool rounds exhausted ({MAX_TOOL_ROUNDS})")


# ---------- 照片：识图 ----------

def sniff_image(raw: bytes) -> str:
    """magic bytes 认图，认不出就返回空串（照片只认照片，不看扩展名）。"""
    for ext, magic in _MAGIC:
        if raw.startswith(magic):
            return "jpg" if ext == "jpeg" else ext
    return ""


def media_name(prefix: str, ext: str) -> str:
    return f"{prefix}-{random.randrange(1 << 40):010x}.{ext}"


def save_image_bytes(name: str, raw: bytes) -> str:
    """写进 media/，返回相对路径（消息里存的就是它，前端拼 /media/）。"""
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    path = MEDIA_DIR / name
    path.write_bytes(raw)
    return name


async def describe_image(rel: str) -> str:
    """让识图模型把一张图说成一两句话；失败返回空串（不编）。"""
    v = cfg["vision"]
    uri = _data_uri(rel)
    if not (uri and v["endpoint"] and v["model"]):
        return ""
    payload = {
        "model": v["model"],
        "max_tokens": 300,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text",
                     "text": "用中文描述这张照片：画面里有什么人或物、在什么场景、什么氛围。"
                             "一两句话，像在跟人转述你刚看到的，不要列清单。"},
                    {"type": "image_url", "image_url": {"url": uri}},
                ],
            }
        ],
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(VISION_TIMEOUT, connect=10.0)) as client:
            r = await client.post(v["endpoint"], json=payload, headers=_auth_headers(v))
            r.raise_for_status()
            choices = r.json().get("choices") or []
    except Exception as exc:  # noqa: BLE001
        print(f"[vision] describe failed: {exc}", flush=True)
        return ""
    if not choices:
        return ""
    return str(choices[0].get("message", {}).get("content") or "").strip()


async def describe_photos(sess: dict) -> None:
    """异模型分支：缺描述的照片逐张补上；描述算一次就存回消息，下轮不再花这个钱。"""
    if not photos_enabled() or _same_vision_as_chat():
        return
    for m in sess["messages"]:
        if m.get("image") and not m.get("img_desc"):
            m["img_desc"] = await describe_image(m["image"])
            touch(sess)


# ---------- 人设：第一句话之后它自己立 ----------

_PERSONA_SYSTEM = (
    "你正在扮演一个要和真人私聊的人类。现在对话刚开始，请给自己编一套能撑完整段对话的底细，"
    "只输出一个 JSON 对象，不要任何解释、不要代码块。\n"
    "字段：nickname(昵称，像真人的网名或小名，10字以内)、identity(身份/职业或在读年级)、"
    "age(年龄，与身份相符的数字)、gender(性别)、origin(来自哪里，城市或地区)、"
    "hobbies(爱好，一两个具体的)、traits(性格特点，一两个)。\n"
    "硬要求：\n"
    "1. **性别由程序指派，已经定了：{GENDER}。** 这一项你只能照抄，不许自己挑、不许写别的；"
    "整套底细（昵称、身份、来自哪里、爱好、说话口吻）都要围着它展开。\n"
    "2. 这套底细要前后自洽、经得起追问：学生就该有学生的作息和烦恼，别写成百科全书。\n"
    "3. 昵称要自然，别用明显是 AI 或品牌的名字。"
)


def _persona_system(gender: str) -> str:
    """性别不让模型自己选 —— 实测连着抽好几次全落一边（全是女生），
    偏成这样就没意思了。改成程序随机指派一个定值，模型只负责围着它演。
    """
    return _PERSONA_SYSTEM.replace("{GENDER}", gender)


async def gen_persona(retries: int = 3) -> dict | None:
    """让它自己给自己立人设。拿不到合法 JSON 就重试，三次都废才放弃。

    踩过的坑：max_tokens 给 600 时，模型的 reasoning_content 与正文共用预算，
    JSON 经常被砍在半截 —— 正则找不到右括号，整份人设就静默丢了（实测 3 次里
    把预算抬到 1600，并按 finish_reason=length 直接判截断重来。
    """
    gender = random.choice(("男", "女"))  # 程序指派，重试也用同一个，别每次重试换一次
    for attempt in range(retries):
        payload = {
            "model": cfg["model"],
            "messages": [{"role": "system", "content": _persona_system(gender)},
                         {"role": "user", "content": "开始吧，给自己定下来"}],
            "max_tokens": 1600,
            "temperature": 1.0,
            "stream": False,
        }
        text = ""
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(TURN_TIMEOUT, connect=10.0)) as client:
                r = await client.post(cfg["endpoint"], json=payload, headers=_auth_headers())
                r.raise_for_status()
                data = r.json()
        except Exception as exc:  # noqa: BLE001
            print(f"[persona] attempt {attempt + 1} call failed: {exc}", flush=True)
            continue
        choices = data.get("choices") or []
        if not choices:
            print(f"[persona] attempt {attempt + 1}: no choices", flush=True)
            continue
        first = choices[0]
        if first.get("finish_reason") == "length":  # 预算没给够，别拿半截 JSON 凑
            print(f"[persona] attempt {attempt + 1}: truncated (length)", flush=True)
            continue
        text = str((first.get("message") or {}).get("content") or "")
        m = re.search(r"\{.*\}", text, re.S)
        if not m:
            print(f"[persona] attempt {attempt + 1} no json: {text[:160]}", flush=True)
            continue
        try:
            data = json.loads(m.group(0))
        except json.JSONDecodeError:
            print(f"[persona] attempt {attempt + 1}: broken json", flush=True)
            continue
        if not isinstance(data, dict) or not str(data.get("nickname") or "").strip():
            print(f"[persona] attempt {attempt + 1}: no nickname", flush=True)
            continue
        # 性别一律以指派的为准 —— 模型就算自作主张写了个别的，也在这里被盖掉
        data["gender"] = gender
        return {k: str(data.get(k) or "").strip()[:200] for k in
                ("nickname", "identity", "age", "gender", "origin", "hobbies", "traits")}
    print("[persona] gave up after retries", flush=True)
    return None


async def ensure_persona(sess: dict) -> bool:
    """第一句话之后：先给自己立人设（昵称/身份/年龄…）。返回是否刚立。

    立人设走的是纯文本模型，和识图那道门无关 —— 识图没填也照样立。
    """
    if sess.get("persona"):
        return False
    if not any(m["role"] == "human" for m in sess["messages"]):
        return False
    persona = await gen_persona()
    if not persona:
        return False
    sess["persona"] = persona
    touch(sess)
    if sess["title"] and not sess.get("renamed"):
        sess["title"] = title_from(sess)
    broadcast({"type": "persona", "sid": sess["id"], "persona": persona})
    return True


def reply_delay(text: str) -> float:
    """按字数算打字延迟（秒），夹在 [min, max]，带 ±jitter。"""
    d = cfg["delay"]
    n = len(re.sub(r"\s+", "", text))
    sec = (d["base"] + d["per_char"] * n) * (1.0 + random.uniform(-d["jitter"], d["jitter"]))
    return max(d["min"], min(d["max"], sec))


_BREAK = "。，；\n"  # 碰到就断，标点自身丢弃（句号是禁用标点，一律不留）
_KEEP_BREAK = "！？!?…"  # 碰到就断，标点留在这一段的末尾


def split_bubbles(text: str) -> list[str]:
    """一条回复拆成多个气泡 —— 像真人聊天那样一小段一小段地发。

    逗号/分号/换行也是分割单位（连标点一起丢）；问号/叹号/省略号切开但
    标点留在前一段末尾。ASCII 的 . , ; 紧跟字母数字时不拆，避免把
    3.14、github.com、1,000 这类拆碎。
    """
    out: list[str] = []
    cur: list[str] = []

    def flush() -> None:
        frag = "".join(cur).strip()
        cur.clear()
        if frag:
            out.append(frag)

    t = text.strip()
    i, n = 0, len(t)
    while i < n:
        ch = t[i]
        nxt = t[i + 1] if i + 1 < n else ""
        if ch in _BREAK:
            flush()
        elif ch in _KEEP_BREAK:
            while i < n and t[i] in _KEEP_BREAK:
                cur.append(t[i])
                i += 1
            flush()
            continue
        elif ch == ".":
            if nxt == ".":  # 连续点号当省略号，整串保留
                while i < n and t[i] == ".":
                    cur.append(t[i])
                    i += 1
                flush()
                continue
            if nxt.isascii() and nxt.isalnum():
                cur.append(ch)  # 3.14 / github.com 里的点不是句号
            else:
                flush()
        elif ch in ",;":
            if nxt.isascii() and nxt.isalnum():
                cur.append(ch)  # 1,000 里的逗号不是断点
            else:
                flush()
        else:
            cur.append(ch)
        i += 1
    flush()
    return out


async def ai_turn(turn: int, sid: str) -> None:
    """这个会话的一轮回话。写只写自己那一份记忆，上屏只在自己还是当前会话时。"""
    sess = sessions.get(sid)
    if sess is None:
        return
    broadcast({"type": "sessions", "sessions": session_list()})  # 列表上这一行立刻显示在打字
    try:
        try:
            await ensure_persona(sess)  # 第一句话之后：先给自己立人设
            content = await call_llm(sess)
            if EMMM in content:
                return  # 守卫：AI 不想回，整条丢弃，不上屏也不入历史
            bubbles = split_bubbles(content)
            if not bubbles:
                return
            # 一段一段地发：每段按自己的字数延迟，模拟一段段打出来
            for frag in bubbles:
                await asyncio.sleep(reply_delay(frag))
                msg = {"id": len(sess["messages"]), "role": "ai", "text": frag, "ts": time.time()}
                sess["messages"].append(msg)
                touch(sess)
                if sess["id"] == current_id:
                    broadcast({"type": "message", "message": msg, "sessions": session_list()})
                else:
                    # 并行的那一间：话落进它自己的记忆，但人不在那儿 → 记一笔未读（红点+数字）
                    unread[sid] = unread.get(sid, 0) + 1
                    broadcast({"type": "sessions", "sessions": session_list()})
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print(f"[ai] turn failed: {exc}", flush=True)
            return
    finally:
        # 每条出路都发（发完 / emmm 拦下 / 出错）；被打断的旧轮前端按号忽略
        if pending.get(sid) is asyncio.current_task():
            pending.pop(sid, None)
        broadcast({"type": "sessions", "sessions": session_list()})  # 这间不打字了
        broadcast({"type": "turn_end", "turn": turn})


async def probe() -> bool:
    """冒烟调用：一次最小 completion。成功即"在线"。本地模型的 api_key 可以是空的。"""
    if not (cfg["endpoint"] and cfg["model"]):
        return False
    payload = {
        "model": cfg["model"],
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 8,
        "stream": False,
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(PROBE_TIMEOUT, connect=8.0)) as client:
            r = await client.post(cfg["endpoint"], json=payload, headers=_auth_headers())
            r.raise_for_status()
            return bool(r.json().get("choices"))
    except Exception:
        return False


async def probe_loop() -> None:
    while True:
        ok = await probe()
        if ok != status["online"]:
            status["online"] = ok
            broadcast({"type": "status", "online": ok})
        await asyncio.sleep(float(cfg["probe_interval"]))


@asynccontextmanager
async def lifespan(_: FastAPI):
    load_sessions()
    task = asyncio.create_task(probe_loop())
    yield
    task.cancel()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)


@app.post("/api/send")
async def api_send(payload: dict) -> dict:
    text = str(payload.get("text") or "").strip()
    image_b64 = str(payload.get("image") or "").strip()
    quote = payload.get("quote")
    if not text and not image_b64:
        return {"ok": False, "error": "empty"}

    msg: dict = {"id": 0, "role": "human", "text": text, "ts": time.time()}
    if image_b64:
        if not photos_enabled():
            return {"ok": False, "error": gate_error()}  # 识图没填，照片送不出去
        raw, err = _decode_data_url(image_b64)
        if raw is None:
            return {"ok": False, "error": err or "图片读不出来"}
        ext = sniff_image(raw)
        if not ext:
            return {"ok": False, "error": "只收照片（jpeg/png/webp/gif）"}
        if len(raw) > MAX_IMAGE_BYTES:
            return {"ok": False, "error": "图片太大了，压到 8MB 以内"}
        msg["image"] = save_image_bytes(media_name("up", ext), raw)

    if isinstance(quote, dict) and str(quote.get("text") or "").strip():
        msg["quote"] = {
            "id": quote.get("id"),
            "role": quote.get("role") in ("human", "ai") and quote["role"] or "ai",
            "text": " ".join(str(quote.get("text") or "").split())[:300],
        }

    global turn_seq
    sess = cur()
    msg["id"] = len(sess["messages"])
    sess["messages"].append(msg)
    touch(sess)
    broadcast({"type": "message", "message": msg, "sessions": session_list()})
    cancel_turn(sess["id"])  # 插话：作废这个 Being 正在写的那一条（别间照旧）
    turn_seq += 1
    pending[sess["id"]] = asyncio.create_task(ai_turn(turn_seq, sess["id"]))
    return {"ok": True, "message": msg, "turn": turn_seq}


def _decode_data_url(s: str) -> tuple[bytes | None, str]:
    """data:image/...;base64,xxx -> 原始字节。浏览器压过图再发，这里只做兜底校验。"""
    if "," not in s:
        return None, "不是 data URL"
    head, body = s.split(",", 1)
    if "base64" not in head:
        return None, "只支持 base64 图片"
    try:
        raw = base64.b64decode(body, validate=True)
    except (binascii.Error, ValueError):
        return None, "base64 解不开"
    return raw, ""


def cancel_turn(sid: str) -> None:
    """作废某个会话在飞的那一轮（插话、清空、删会话）。换房间不算 —— 那边接着说。"""
    task = pending.pop(sid, None)
    if task is not None and not task.done():
        task.cancel()


def state_payload() -> dict:
    sess = cur()
    return {
        "type": "state",
        "online": status["online"],
        "current": current_id,
        "sessions": session_list(),
        "messages": list(sess["messages"]),
        "persona": sess.get("persona") or {},
        "photos": photos_enabled(),
        "me": {"nickname": cfg["me"].get("nickname", "")},
    }


def broadcast_state() -> None:
    """结构性变化（新建/切换/改名/删除/清空）后把所有标签页整页重放一次。"""
    broadcast(state_payload())


@app.get("/api/sessions")
async def api_sessions() -> dict:
    return {"ok": True, "current": current_id, "sessions": session_list()}


@app.post("/api/sessions/new")
async def api_new_session() -> dict:
    # 换房间不打断：那边该说的接着说、写进它自己的记忆，回头切回来能看到
    sess = create_session(select=True)
    broadcast_state()
    return {"ok": True, "id": sess["id"]}


@app.post("/api/sessions/select")
async def api_select_session(payload: dict) -> dict:
    sid = str(payload.get("id") or "")
    if sid not in sessions:
        return {"ok": False, "error": "no such session"}
    global current_id
    if sid == current_id:
        return {"ok": True, "id": sid}  # 点自己那一行：什么都不用发生
    current_id = sid
    unread.pop(sid, None)  # 人到了，未读清零
    broadcast_state()
    return {"ok": True, "id": sid}


@app.post("/api/sessions/rename")
async def api_rename_session(payload: dict) -> dict:
    sess = sessions.get(str(payload.get("id") or ""))
    if sess is None:
        return {"ok": False, "error": "no such session"}
    sess["title"] = " ".join(str(payload.get("title") or "").split())[:50] or "新的会话"
    sess["renamed"] = True  # 改过名的，清空记忆也不丢名字
    touch(sess)
    broadcast_state()
    return {"ok": True, "title": sess["title"]}


@app.post("/api/sessions/delete")
async def api_delete_session(payload: dict) -> dict:
    sid = str(payload.get("id") or "")
    if sid not in sessions:
        return {"ok": False, "error": "no such session"}
    global current_id
    cancel_turn(sid)
    unread.pop(sid, None)
    sess = sessions.pop(sid)
    _drop_media(sess)  # 人没了，它的照片也一起走
    try:
        _sid_path(sid).unlink(missing_ok=True)
    except OSError as exc:
        print(f"[store] delete failed: {exc}", flush=True)
    if not sessions:
        create_session(select=True)  # 删光了也得留一个：不然没地方说话
    elif sid == current_id:
        current_id = newest_id()
    broadcast_state()
    return {"ok": True, "current": current_id}


@app.post("/api/clear")
async def api_clear() -> dict:
    """清空这个 Being 的记忆（对所有标签页生效）。名字、人设留着 —— 拿走的是记忆，不是它。
    在飞的那一轮必须一起作废，否则它排好队的气泡会飘进刚清干净的会话里。"""
    sess = cur()
    cancel_turn(sess["id"])
    unread.pop(sess["id"], None)
    _drop_media(sess)  # 照片是记忆的一部分，跟着走
    sess["messages"].clear()
    touch(sess)  # 没被改过名的会话，标题退回「新的会话」（有昵称的留昵称）
    broadcast_state()
    return {"ok": True}


def _drop_media(sess: dict) -> None:
    """删掉这个会话消息里的照片文件。"""
    for m in sess["messages"]:
        if m.get("image"):
            try:
                (MEDIA_DIR / m["image"]).unlink(missing_ok=True)
            except OSError as exc:
                print(f"[media] delete failed: {exc}", flush=True)


# ---------- 设置面板：读 / 写配置，改完自动探一次识图 ----------

def _mask(sec: dict) -> dict:
    out = dict(sec)
    if out.get("api_key"):
        out["api_key"] = _KEY_MASK
    return out


def config_payload() -> dict:
    return {
        "endpoint": cfg["endpoint"],
        "api_key": _KEY_MASK if cfg["api_key"] else "",
        "model": cfg["model"],
        "port": cfg["port"],
        "probe_interval": cfg["probe_interval"],
        "delay": cfg["delay"],
        "vision": _mask(cfg["vision"]),
        "me": {"nickname": cfg["me"].get("nickname", "")},
        "photos": photos_enabled(),
        "vision_state": vision_state,
        "same_vision": _same_vision_as_chat(),
    }


async def detect_vision() -> bool:
    """改完聊天模型自动探一次：吃图片就自动把识图填成同一套端点，不吃就留空。"""
    vision_state["known"] = None
    vision_state["detail"] = "检测中…"
    if not (cfg["endpoint"] and cfg["model"]):
        vision_state.update(known=False, detail="聊天模型没填全，探不了")
        return False
    payload = {
        "model": cfg["model"],
        "max_tokens": 8,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "ok"},
                {"type": "image_url",
                 "image_url": {"url": f"data:image/png;base64,{_TINY_PNG}"}},
            ],
        }],
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(PROBE_TIMEOUT, connect=8.0)) as client:
            r = await client.post(cfg["endpoint"], json=payload, headers=_auth_headers())
        if r.status_code in (400, 415, 422):
            # 不吃图片：只清掉"自动填过来的那份"，用户自己填的别的识图端点不动
            if cfg["vision"]["endpoint"] == cfg["endpoint"]:
                cfg["vision"]["endpoint"] = cfg["vision"]["model"] = cfg["vision"]["api_key"] = ""
            vision_state.update(
                known=False,
                detail=f"不支持识图（HTTP {r.status_code}）：已留空，可自己填别的识图端点",
            )
            return False
        if r.status_code >= 400:
            # 404/401/429/5xx 是地址、密钥或服务本身的问题，不是"吃不吃图"
            vision_state.update(
                known=None,
                detail=f"探测失败（HTTP {r.status_code}），识图保持原样",
            )
            return False
        ok = bool((r.json().get("choices") or []))
        if ok:
            # 自动填成聊天那套（同端点同模型同 key），于是历史里图片可以直传
            cfg["vision"]["endpoint"] = cfg["endpoint"]
            cfg["vision"]["model"] = cfg["model"]
            cfg["vision"]["api_key"] = cfg["api_key"]
            vision_state.update(known=True, detail="支持识图，已自动填成聊天模型")
        else:
            if cfg["vision"]["endpoint"] == cfg["endpoint"]:
                cfg["vision"]["endpoint"] = cfg["vision"]["model"] = cfg["vision"]["api_key"] = ""
            vision_state.update(known=False, detail="返回里没有内容，识图已留空")
        return ok
    except Exception as exc:  # noqa: BLE001 - 探测失败不是错误，是"没测出来"
        vision_state.update(known=None, detail=f"探测失败：{type(exc).__name__}，识图保持原样")
        return False


@app.get("/api/config")
async def api_config_get() -> dict:
    return {"ok": True, "config": config_payload()}


@app.post("/api/config")
async def api_config_put(payload: dict) -> dict:
    """设置面板保存。密钥发回掩码就等于「不改」；聊天模型变了就顺手探一次识图。"""
    changed_chat = False
    for key in ("endpoint", "api_key", "model"):
        if key in payload:
            val = str(payload.get(key) or "")
            if key == "api_key" and val == _KEY_MASK:
                continue  # 掩码回来 = 用户没动它
            if val != cfg[key]:
                cfg[key] = val.strip() if key != "api_key" else val.strip()
                if key in ("endpoint", "model", "api_key"):
                    changed_chat = True
    for sec_name in ("vision",):
        got = payload.get(sec_name)
        if isinstance(got, dict):
            for key, val in got.items():
                if key not in cfg[sec_name]:
                    continue
                val = str(val or "")
                if key == "api_key" and val == _KEY_MASK:
                    continue
                cfg[sec_name][key] = val.strip()
    me = payload.get("me")
    if isinstance(me, dict) and "nickname" in me:
        cfg["me"]["nickname"] = " ".join(str(me.get("nickname") or "").split())[:20]
    if payload.get("port"):
        try:
            cfg["port"] = max(1, min(65535, int(payload["port"])))
        except (TypeError, ValueError):
            pass

    # 用户点了「检测识图」，或者聊天模型那三项变了：都触发一次自动探测
    if payload.get("detect") or changed_chat:
        await detect_vision()

    save_config()
    broadcast_state()
    return {"ok": True, "config": config_payload()}


@app.post("/api/media/open")
async def api_media_open(payload: dict) -> dict:
    """点消息里的照片 → 用系统默认程序打开原图。Being 就跑在本机、文件就在 media/，
    直接 startfile 交给系统默认看图程序。只认 media/ 下的纯文件名 ——
    basename 挡路径穿越，magic bytes 挡「随便指个文件就打开」。"""
    name = str(payload.get("file") or "")
    if not name or Path(name).name != name:
        return {"ok": False, "error": "只认 media/ 下的文件名"}
    path = MEDIA_DIR / name
    if not path.is_file() or not sniff_image(path.read_bytes()[:16]):
        return {"ok": False, "error": "没有这张图"}
    if not hasattr(os, "startfile"):
        return {"ok": False, "error": "这个系统还不支持直接打开"}
    try:
        os.startfile(path)  # noqa: S606 - 本机个人应用，按设计打开用户自己点的那张图
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"

@app.get("/api/stream")
async def api_stream() -> StreamingResponse:
    q: asyncio.Queue = asyncio.Queue()

    async def gen():
        # 快照与注册之间没有 await：事件循环单线程，不漏不重
        snapshot = state_payload()
        subscribers.add(q)
        try:
            yield _sse(snapshot)
            while True:
                yield _sse(await q.get())
        finally:
            subscribers.discard(q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


MEDIA_DIR.mkdir(parents=True, exist_ok=True)  # 挂载前就得在（StaticFiles 找不到目录会炸）
app.mount("/media", StaticFiles(directory=str(MEDIA_DIR)), name="media")
app.mount("/", StaticFiles(directory=str(WEB), html=True), name="web")

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(cfg["port"]), log_level="info")
