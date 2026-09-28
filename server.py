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
import json
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
LEGACY_MESSAGES = ROOT / "messages.json"  # 单会话时代的存档，首次启动搬进 sessions/

EMMM = "<<emmm>>"
HISTORY_WINDOW = 40  # 发给模型的历史条数上限（系统提示词不算在内）
PROBE_TIMEOUT = 15.0
TURN_TIMEOUT = 120.0
MAX_TOOL_ROUNDS = 4  # 一条回复里最多允许几次"调工具再接着说"
_WEEKDAYS = "一二三四五六日"

_DEFAULTS = {
    "endpoint": "",
    "api_key": "",
    "model": "",
    "port": 8619,
    "probe_interval": 60,
    # 延迟 = (base + per_char * 字数) ± jitter，再夹在 [min, max]
    "delay": {"base": 1.2, "per_char": 0.13, "min": 1.5, "max": 20.0, "jitter": 0.15},
}


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


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
    return cfg


cfg = _load_config()

sessions: dict[str, dict] = {}  # id -> {id, title, renamed, created, updated, messages}
current_id: str = ""  # 正在聊的那个 Being；消息条目 {id, role: human|ai, text, ts}
subscribers: set[asyncio.Queue] = set()
status: dict = {"online": None}  # None = 还没冒烟过（前端显示"检测中"）
pending: dict[str, asyncio.Task] = {}  # 每个会话在飞的那一轮：**多会话并行**，换房间不打断
unread: dict[str, int] = {}  # sid -> 不在当前会话时收到的条数（只在内存里，不落盘）
turn_seq = 0  # 轮次号：被打断的旧轮 turn_end 会被前端按号忽略


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def _clean_messages(raw) -> list[dict]:
    """存档 -> 内存条目；坏行丢掉，id 按顺序重排（id 只是前端的去重游标）。"""
    out: list[dict] = []
    if isinstance(raw, list):
        for m in raw:
            if isinstance(m, dict) and m.get("text") and m.get("role") in ("human", "ai"):
                out.append(
                    {"id": len(out), "role": m["role"], "text": str(m["text"]), "ts": m.get("ts") or 0.0}
                )
    return out


def title_from(msgs: list[dict]) -> str:
    """标题 = 第一条人话，压掉空白，最多 50 字（机制照抄 Fungi）。"""
    for m in msgs:
        if m["role"] == "human":
            text = " ".join(m["text"].split())
            return text[:47] + "..." if len(text) > 50 else text
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
        sess["title"] = title_from(sess["messages"])
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
        sessions[sid] = {
            "id": sid,
            "title": str(data.get("title") or ""),
            "renamed": bool(data.get("renamed")),
            "created": str(data.get("created") or _now()),
            "updated": str(data.get("updated") or _now()),
            "messages": _clean_messages(data.get("messages")),
        }
    if not sessions and not _migrate_legacy():
        create_session(select=True)
    if current_id not in sessions:
        current_id = newest_id()
    for sess in sessions.values():
        if not sess["title"]:
            sess["title"] = title_from(sess["messages"])


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
        out.append(
            {
                "id": s["id"],
                "title": s["title"] or title_from(s["messages"]),
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


def _auth_headers() -> dict:
    return {"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"}


def build_llm_messages(system_prompt: str, msgs: list[dict]) -> list[dict]:
    """窗口内历史 -> chat 格式。插话后会出现两条相邻 human，合并成一条发。"""
    hist = msgs[-HISTORY_WINDOW:]
    while hist and hist[0]["role"] == "ai":  # 别让对话以 AI 开口
        hist = hist[1:]
    out: list[dict] = [{"role": "system", "content": system_prompt}]
    for m in hist:
        role = "user" if m["role"] == "human" else "assistant"
        if out[-1]["role"] == role:
            out[-1]["content"] += "\n" + m["text"]
        else:
            out.append({"role": role, "content": m["text"]})
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


# 工具表：加一个工具就在这里加一条（描述里写清“什么时候该用”）。
TOOLS = [
    {
        "name": "look_at_clock",
        "description": (
            "看一眼现在真实的时间（日期、星期、几点几分）。对方问几点、几号、星期几，"
            "或聊到“这么晚了”“几点了”“你平时几点睡”，或你自己想提到现在的时间时，先调用它。"
        ),
        "impl": _clock,
    },
]


def run_tool(call: dict) -> str:
    """跑一次工具调用。工具自己出问题不该炸掉整轮：如实告诉模型。"""
    fn = call.get("function") or {}
    name = str(fn.get("name") or "")
    for tool in TOOLS:
        if tool["name"] == name:
            try:
                return str(tool["impl"]())
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
                "parameters": {"type": "object", "properties": {}, "required": []},
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


def system_content() -> str:
    """人设提示词 + 工具说明。每次调用重算；时间不预注入，要用时它自己看钟。"""
    return PROMPT_PATH.read_text(encoding="utf-8").rstrip() + "\n\n" + tools_block()


async def call_llm(sess: dict) -> str:
    """给这个会话生成一条回复，允许中途调用工具（模型自己没有的信息，比如现在几点）。"""
    convo = build_llm_messages(system_content(), sess["messages"])
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
                        "content": run_tool(call),
                    }
                )
    raise RuntimeError(f"tool rounds exhausted ({MAX_TOOL_ROUNDS})")


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
    """冒烟调用：一次最小 completion。成功即"在线"。"""
    if not (cfg["endpoint"] and cfg["api_key"] and cfg["model"]):
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
    if not text:
        return {"ok": False, "error": "empty"}
    global turn_seq
    sess = cur()
    msg = {"id": len(sess["messages"]), "role": "human", "text": text, "ts": time.time()}
    sess["messages"].append(msg)
    touch(sess)
    broadcast({"type": "message", "message": msg, "sessions": session_list()})
    cancel_turn(sess["id"])  # 插话：作废这个 Being 正在写的那一条（别间照旧）
    turn_seq += 1
    pending[sess["id"]] = asyncio.create_task(ai_turn(turn_seq, sess["id"]))
    return {"ok": True, "message": msg, "turn": turn_seq}


def cancel_turn(sid: str) -> None:
    """作废某个会话在飞的那一轮（插话、清空、删会话）。换房间不算 —— 那边接着说。"""
    task = pending.pop(sid, None)
    if task is not None and not task.done():
        task.cancel()


def state_payload() -> dict:
    return {
        "type": "state",
        "online": status["online"],
        "current": current_id,
        "sessions": session_list(),
        "messages": list(cur()["messages"]),
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
    sessions.pop(sid)
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
    """清空这个 Being 的记忆（对所有标签页生效）。名字留着 —— 拿走的是记忆，不是它。
    在飞的那一轮必须一起作废，否则它排好队的气泡会飘进刚清干净的会话里。"""
    sess = cur()
    cancel_turn(sess["id"])
    unread.pop(sess["id"], None)
    sess["messages"].clear()
    touch(sess)  # 没被改过名的会话，标题退回「新的会话」
    broadcast_state()
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


app.mount("/", StaticFiles(directory=str(WEB), html=True), name="web")

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(cfg["port"]), log_level="info")
