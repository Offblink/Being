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

/* ---------- 清空会话 ---------- */
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
  try {
    const r = await fetch('/api/clear', { method: 'POST' });
    if (!r.ok) throw new Error(r.status);
  } catch (e) {
    console.error('clear failed:', e);
    elStatus.textContent = '清空失败，稍后再试';
    setTimeout(() => { if (!typing) elStatus.textContent = ''; }, 2500);
  }
});

// 点了别处或按 Esc 就当没这回事
document.addEventListener('click', (e) => { if (!btnClear.contains(e.target)) disarmClear(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') disarmClear(); });

/* ---------- SSE ---------- */
function handleEvent(ev) {
  if (ev.type === 'hello') {
    setOnline(ev.online);
    msgs.textContent = '';
    maxId = -1;
    unread = 0;
    for (const m of ev.messages || []) appendMessage(m);
    msgs.scrollTop = msgs.scrollHeight;
    updateScrollBtn();
  } else if (ev.type === 'message') {
    appendMessage(ev.message);
  } else if (ev.type === 'turn_end') {
    if (ev.turn === currentTurn) setTyping(false); // 被打断的旧轮号不匹配，忽略
  } else if (ev.type === 'clear') {
    // 会话被清空（可能别的标签页点的）：DOM、去重游标、未读、胶囊、typing 一起归零；
    // 在飞那一轮的 turn_end 之后才到，轮号对不上（已归零）直接忽略
    msgs.textContent = '';
    maxId = -1;
    unread = 0;
    currentTurn = 0;
    setTyping(false);
    msgs.scrollTop = 0;
    updateScrollBtn();
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
