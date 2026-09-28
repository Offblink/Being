/* Being WebUI — 滚动机制仿 Fungi（isNearBottom 60px 阈值 + 回到底部胶囊），
   差别：有新信息时胶囊文案换成「有N条新信息」。状态栏是在线/离线，不是呼吸点。 */

const msgs = document.getElementById('messages');
const input = document.getElementById('input');
const btnSend = document.getElementById('send');
const btnScroll = document.getElementById('scroll-bottom');
const elStatus = document.getElementById('status');
const elConn = document.getElementById('conn');
const elConnText = document.getElementById('conn-text');
const btnClear = document.getElementById('clear');
const btnSessions = document.getElementById('sessions-toggle');
const elPanel = document.getElementById('sessions-panel');
const btnNewSession = document.getElementById('new-session');
const elSessionList = document.getElementById('session-list');

let unread = 0;          // 停在底部时收到的条数 → 胶囊文案
let maxId = -1;          // 已渲染的最大消息 id（SSE 与 POST 响应可能乱序，按 id 去重）
let currentTurn = 0;     // 最新一轮号；旧轮的 turn_end 按号忽略
let typing = false;

/* ---------- 滚动（Fungi 同款） ---------- */
function isNearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

function updateScrollBtn() {
  if (isNearBottom(msgs)) {
    unread = 0;
    btnScroll.classList.remove('visible');
  } else {
    btnScroll.textContent = unread > 0 ? `有${unread}条新信息` : '回到底部';
    btnScroll.classList.add('visible');
  }
}

btnScroll.addEventListener('click', () => {
  msgs.scrollTop = msgs.scrollHeight;
  updateScrollBtn();
});
msgs.addEventListener('scroll', updateScrollBtn);

/* 键盘弹出等视口变化：贴底时保持贴底（Fungi m.js 同款） */
if (window.visualViewport) {
  visualViewport.addEventListener('resize', () => {
    if (isNearBottom(msgs)) msgs.scrollTop = msgs.scrollHeight;
  });
}

/* ---------- 状态栏 ---------- */
function setOnline(v) {
  elConn.dataset.state = v === true ? 'online' : v === false ? 'offline' : 'pending';
  elConnText.textContent = v === true ? '在线' : v === false ? '离线' : '检测中';
}

function setTyping(on) {
  typing = on;
  elStatus.textContent = on ? '对方正在输入…' : '';
}

/* ---------- 渲染 ---------- */
function appendMessage(m) {
  if (typeof m.id !== 'number' || m.id <= maxId) return; // 去重 + 保序
  maxId = m.id;
  const stick = isNearBottom(msgs) || m.role === 'human'; // 自己发的总要看见
  const row = document.createElement('div');
  row.className = 'msg ' + (m.role === 'human' ? 'me' : 'ai');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = m.text;
  row.appendChild(bubble);
  msgs.appendChild(row);
  if (stick) {
    msgs.scrollTop = msgs.scrollHeight;
    unread = 0;
  } else {
    unread++;
  }
  updateScrollBtn();
}

/* ---------- 发送 ---------- */
async function send() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  autoGrow();
  btnSend.disabled = true;
  try {
    const r = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || r.status);
    currentTurn = data.turn;
    setTyping(true);
    // 自己发的消息：滚到底、清未读（SSE 那条可能先到也可能后到，按 id 去重）
    msgs.scrollTop = msgs.scrollHeight;
    unread = 0;
    updateScrollBtn();
  } catch (e) {
    console.error('send failed:', e);
    elStatus.textContent = '发送失败，稍后再试';
    setTimeout(() => { if (!typing) elStatus.textContent = ''; }, 2500);
  }
}

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 152) + 'px';
  btnSend.disabled = !input.value.trim();
}

input.addEventListener('input', autoGrow);
input.addEventListener('keydown', (e) => {
  // 中文输入法选字期间的 Enter 不算发送
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    send();
  }
});
btnSend.addEventListener('click', send);

/* ---------- 通用 POST ---------- */
async function post(url, body) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || r.status);
    return data;
  } catch (e) {
    console.error(url, 'failed:', e);
    elStatus.textContent = '操作失败，稍后再试';
    setTimeout(() => { if (!typing) elStatus.textContent = ''; }, 2500);
    return null;
  }
}

/* ---------- 清空：拿走的是这个 Being 的记忆，不是它 ---------- */
let armedTimer = 0;

function disarmClear() {
  clearTimeout(armedTimer);
  armedTimer = 0;
  btnClear.classList.remove('armed');
  btnClear.textContent = '清空';
}

btnClear.addEventListener('click', async () => {
  if (!armedTimer) {            // 第一下只是"上膛"，防误触
    btnClear.classList.add('armed');
    btnClear.textContent = '确定清空';
    armedTimer = setTimeout(disarmClear, 4000);
    return;
  }
  disarmClear();
  await post('/api/clear');
});

/* ---------- 会话列表（默认收起；每次渲染整表重建，不做行复用） ---------- */
let sessionCache = [];

function renderSessions(list) {
  elSessionList.textContent = '';
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'session-row' + (s.current ? ' current' : '');
    row.dataset.sid = s.id;

    const title = document.createElement('span');
    title.className = 'session-title';
    title.textContent = s.title || '新的会话';

    const meta = document.createElement('span');
    meta.className = 'session-meta' + (s.typing ? ' typing' : '');
    meta.textContent = s.typing ? '正在输入…' : (s.msgCount ? `${s.msgCount} 条消息` : '还没聊过');

    const badge = document.createElement('span');
    badge.className = 'session-unread';
    if (s.unread > 0) {
      badge.textContent = s.unread > 99 ? '99+' : String(s.unread);
      badge.title = `有 ${s.unread} 条新消息`;
    } else {
      badge.hidden = true;
    }

    const acts = document.createElement('span');
    acts.className = 'session-acts';
    for (const [act, label, tip] of [
      ['rename', '改名', '给这个 Being 起个名字'],
      ['delete', '删除', '删掉这个 Being'],
    ]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'session-act' + (act === 'delete' ? ' del' : '');
      b.dataset.act = act;
      b.title = tip;
      b.textContent = label;
      acts.appendChild(b);
    }

    row.append(title, meta, badge, acts);
    elSessionList.appendChild(row);
  }

  // 面板收起时也得看得见：总未读挂到「会话」按钮上
  updateToggleBadge(list);
}

function updateToggleBadge(list) {
  // 独立于列表渲染：面板收着的时候（默认）这一颗才是唯一的提示
  const total = (list || []).reduce((n, s) => n + (s.unread || 0), 0);
  const old = btnSessions.querySelector('.unread-badge');
  if (old) old.remove();
  if (total > 0) {
    const b = document.createElement('span');
    b.className = 'unread-badge';
    b.textContent = total > 99 ? '99+' : String(total);
    b.title = `别的会话里还有 ${total} 条你没看的消息`;
    btnSessions.appendChild(b);
  }
}

async function refreshSessions() {
  try {
    const data = await (await fetch('/api/sessions')).json();
    if (data.ok) {
      sessionCache = data.sessions;
      renderSessions(sessionCache);
    }
  } catch (e) {
    console.error('sessions failed:', e);
  }
}

function openPanel() {
  elPanel.hidden = false;
  btnSessions.setAttribute('aria-expanded', 'true');
  refreshSessions();
}

function closePanel() {
  elPanel.hidden = true;
  btnSessions.setAttribute('aria-expanded', 'false');
}

btnSessions.addEventListener('click', () => (elPanel.hidden ? openPanel() : closePanel()));
btnNewSession.addEventListener('click', async () => {
  if (await post('/api/sessions/new')) closePanel();
});

/* 行是整表重建的，handler 走事件委托、sid 现查现用：不踩"闭包攥着上一代会话对象"的坑 */
elSessionList.addEventListener('click', (e) => {
  const row = e.target.closest('.session-row');
  if (!row) return;
  const sid = row.dataset.sid;
  const act = e.target.closest('[data-act]');
  if (!act) {
    post('/api/sessions/select', { id: sid }).then(() => closePanel());
  } else if (act.dataset.act === 'rename') {
    startRename(row, sid);
  } else if (act.dataset.act === 'delete') {
    armDelete(act, sid);
  }
});

function startRename(row, sid) {
  const title = row.querySelector('.session-title');
  if (!title) return;
  const inp = document.createElement('input');
  inp.className = 'rename-input';
  inp.maxLength = 50;
  inp.value = title.textContent;
  title.replaceWith(inp);
  inp.focus();
  inp.select();
  const finish = (save) => {
    if (inp.dataset.done) return;      // 回车之后 blur 还会来一次，收尾只许一次
    inp.dataset.done = '1';
    const val = inp.value.trim();
    if (save && val) post('/api/sessions/rename', { id: sid, title: val });
    else inp.replaceWith(title);       // 取消：后端没变，画面也不该变
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  inp.addEventListener('blur', () => finish(true));  // 点别处也算保存（跟 Fungi 一样）
}

let deleteTimer = 0;

function armDelete(btn, sid) {
  if (btn.dataset.armed !== '1') {     // 第一下只是确认
    btn.dataset.armed = '1';
    btn.classList.add('armed');
    btn.textContent = '确定删';
    clearTimeout(deleteTimer);
    deleteTimer = setTimeout(() => {
      btn.dataset.armed = '';
      btn.classList.remove('armed');
      btn.textContent = '删除';
    }, 4000);
    return;
  }
  clearTimeout(deleteTimer);
  post('/api/sessions/delete', { id: sid });
}

// 点别处或按 Esc：收起面板，顺带撤掉没确认的操作
document.addEventListener('click', (e) => {
  if (!btnClear.contains(e.target)) disarmClear();
  if (!elPanel.hidden && !elPanel.contains(e.target) && !btnSessions.contains(e.target)) closePanel();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { disarmClear(); closePanel(); }
});

/* ---------- SSE ---------- */
function applyState(ev) {
  // 整页重放：连上、切会话、新建、删除、改名、清空都走这里
  setOnline(ev.online);
  sessionCache = ev.sessions || [];
  renderSessions(sessionCache);
  msgs.textContent = '';
  maxId = -1;
  unread = 0;
  currentTurn = 0;
  // 切回来时，这一间要是还在打字（别的标签页发起的也算），提示要接上
  const mine = sessionCache.find((s) => s.current);
  setTyping(!!(mine && mine.typing));
  for (const m of ev.messages || []) appendMessage(m);
  msgs.scrollTop = msgs.scrollHeight;
  updateScrollBtn();
}

function patchSessions(list) {
  sessionCache = list || [];
  updateToggleBadge(sessionCache);   // 收起态也要跟着变
  if (!elPanel.hidden && !elSessionList.querySelector('.rename-input')) renderSessions(sessionCache);
  const mine = sessionCache.find((s) => s.current);
  setTyping(!!(mine && mine.typing));   // 后台房间开始/结束打字，提示跟着走
}

function handleEvent(ev) {
  if (ev.type === 'state') {
    applyState(ev);
  } else if (ev.type === 'message') {
    appendMessage(ev.message);
    if (ev.sessions) patchSessions(ev.sessions);
  } else if (ev.type === 'sessions') {
    patchSessions(ev.sessions);
  } else if (ev.type === 'turn_end') {
    if (ev.turn === currentTurn) setTyping(false); // 被打断的旧轮号不匹配，忽略
  } else if (ev.type === 'status') {
    setOnline(ev.online);
  }
}

function connect() {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    try { handleEvent(JSON.parse(e.data)); } catch (err) { console.error(err); }
  };
  es.onerror = () => { /* EventSource 自动重连，重连后 hello 会重放全量 */ };
}

connect();
