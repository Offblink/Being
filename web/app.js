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
const btnSettings = document.getElementById('settings-toggle');
const elSettings = document.getElementById('settings-panel');
const btnPhoto = document.getElementById('photo');
const photoInput = document.getElementById('photo-input');
const quoteBar = document.getElementById('quote-bar');
const quoteLabel = document.getElementById('quote-label');
const quoteText = document.getElementById('quote-text');
const btnQuoteClear = document.getElementById('quote-clear');
const elPeer = document.getElementById('peer');
const elPeerName = document.getElementById('peer-name');
const elPeerAvatar = document.getElementById('peer-avatar');
const elPeerFallback = document.getElementById('peer-fallback');
const elPeerPending = document.getElementById('peer-avatar-pending');

let unread = 0;          // 停在底部时收到的条数 → 胶囊文案
let maxId = -1;          // 已渲染的最大消息 id（SSE 与 POST 响应可能乱序，按 id 去重）
let currentTurn = 0;     // 最新一轮号；旧轮的 turn_end 按号忽略
let typing = false;
let features = false;    // 生图与识图是否都填了（昵称与发图片的总开关）
let persona = {};        // 对方的人设：昵称、身份、头像…
let myInfo = { nickname: '', avatar: '' };
let avatarPending = [];  // 头像还在画的会话
let quote = null;        // {id, role, text} 正准备引用的那条
let photoDraft = null;   // {data, name} 已选好还没发出去的照片

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

/* ---------- 头像与时间 ---------- */
function avatarEl(side, src, name) {
  const box = document.createElement('span');
  box.className = 'avatar ' + side;
  if (src) {
    const img = document.createElement('img');
    img.src = '/media/' + src;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    box.appendChild(img);
  } else {
    box.classList.add('empty');
    box.textContent = (name || '?').slice(0, 1);
  }
  return box;
}

/* 悬停时间（Fungi 的换算口径：7 天内给月日+时分，更早只给时分） */
function whenLabel(ts) {
  const t = new Date((ts || 0) * 1000);
  if (!ts || isNaN(t)) return '';
  const now = new Date();
  const sameDay = t.toDateString() === now.toDateString();
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  const days = (now - t) / 86400000;
  if (days < 7) return `${t.getMonth() + 1}月${t.getDate()}日 ${hh}:${mm}`;
  return `${t.getFullYear()}年${t.getMonth() + 1}月${t.getDate()}日 ${hh}:${mm}`;
}

/* ---------- 渲染 ---------- */
function appendMessage(m) {
  if (typeof m.id !== 'number' || m.id <= maxId) return; // 去重 + 保序
  maxId = m.id;
  const mine = m.role === 'human';
  const stick = isNearBottom(msgs) || mine; // 自己发的总要看见
  const row = document.createElement('div');
  row.className = 'msg ' + (mine ? 'me' : 'ai');
  row.dataset.mid = m.id;

  const when = whenLabel(m.ts);
  if (when) { row.dataset.when = when; row.title = when; } // 悬停才显示

  const side = mine ? 'me' : 'ai';
  // 公平规则：生图与识图没同时填齐时，头像与昵称整体不生效 —— 双方都不画，气泡仍按左右分列
  const who = features ? (mine ? myInfo.nickname : (persona.nickname || '')) : '';
  const avSrc = features ? (mine ? myInfo.avatar : (persona.avatar || '')) : '';
  if (features) {
    row.appendChild(avatarEl(side, avSrc, who || '?'));
  }

  const wrap = document.createElement('div');
  wrap.className = 'bubble-wrap';

  if (m.quote && m.quote.text) {
    const q = document.createElement('div');
    q.className = 'quoted';
    q.dataset.qid = m.quote.id == null ? '' : m.quote.id;
    const lab = document.createElement('span');
    lab.className = 'quoted-label';
    lab.textContent = m.quote.role === 'human' ? '引用我' : '引用对方';
    const body = document.createElement('span');
    body.className = 'quoted-text';
    body.textContent = m.quote.text;
    q.append(lab, body);
    q.addEventListener('click', () => {
      const target = msgs.querySelector(`[data-mid="${m.quote.id}"]`);
      if (target) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.classList.add('flash');
        setTimeout(() => target.classList.remove('flash'), 900);
      }
    });
    wrap.appendChild(q);
  }

  if (m.image) {
    const img = document.createElement('img');
    img.className = 'photo';
    img.src = '/media/' + m.image;
    img.alt = m.img_desc || '照片';
    img.loading = 'lazy';
    img.addEventListener('click', () => window.open(img.src, '_blank', 'noopener'));
    wrap.appendChild(img);
  }

  if (m.text) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = m.text;
    wrap.appendChild(bubble);
  }

  // 右键出「引用」（悬停按钮已撤：挡在气泡上方又难点中）
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openCtxMenu(m, e.clientX, e.clientY);
  });

  row.appendChild(wrap);
  msgs.appendChild(row);
  if (stick) {
    msgs.scrollTop = msgs.scrollHeight;
    unread = 0;
  } else {
    unread++;
  }
  updateScrollBtn();
}

/* ---------- 右键菜单 ---------- */
const ctxMenu = document.getElementById('ctx-menu');
const ctxQuote = document.getElementById('ctx-quote');
let ctxMsg = null;   // 正被右键的那条

function openCtxMenu(m, x, y) {
  ctxMsg = m;
  ctxMenu.hidden = false;
  const r = ctxMenu.getBoundingClientRect();
  // 贴着指针开，但不许伸出屏幕（右下角右键时最要紧）
  const left = Math.min(x, window.innerWidth - r.width - 8);
  const top = Math.min(y, window.innerHeight - r.height - 8);
  ctxMenu.style.left = Math.max(8, left) + 'px';
  ctxMenu.style.top = Math.max(8, top) + 'px';
}

function closeCtxMenu() {
  ctxMenu.hidden = true;
  ctxMsg = null;
}

ctxQuote.addEventListener('click', () => {
  if (ctxMsg) setQuote(ctxMsg);
  closeCtxMenu();
});
// 收起时机：点别处、滚动、改窗口大小、按 Esc。
// 右键本身不触发 click，所以开菜单不会被自己这一下关掉。
document.addEventListener('click', closeCtxMenu);
document.addEventListener('scroll', closeCtxMenu, true);
window.addEventListener('resize', closeCtxMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtxMenu(); });

/* ---------- 引用 ---------- */
function setQuote(m) {
  quote = { id: m.id, role: m.role, text: (m.text || m.img_desc || '[照片]').slice(0, 300) };
  quoteLabel.textContent = m.role === 'human' ? '引用我' : '引用对方';
  quoteText.textContent = quote.text;
  quoteBar.hidden = false;
  input.focus();
}

function clearQuote() {
  quote = null;
  quoteBar.hidden = true;
}
btnQuoteClear.addEventListener('click', clearQuote);

/* ---------- 发送 ---------- */
async function send() {
  const text = input.value.trim();
  if (!text && !photoDraft) return;
  const sentPhoto = photoDraft;   // 先留底：请求失败要原样还回去，照片尤其不能丢
  const sentQuote = quote;
  input.value = '';
  autoGrow();
  const body = { text };
  if (sentPhoto) body.image = sentPhoto.data;
  if (sentQuote) body.quote = sentQuote;
  clearQuote();
  photoDraft = null;
  renderPhotoDraft();
  btnSend.disabled = true;
  btnPhoto.disabled = true;
  try {
    const r = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
    const msg = typeof e?.message === 'string' && e.message && e.message !== 'undefined'
      ? e.message : '发送失败，稍后再试';
    elStatus.textContent = msg;
    setTimeout(() => { if (!typing) elStatus.textContent = ''; }, 2500);
    // 还回去：文字重打一遍能忍，照片重选一遍不能忍
    photoDraft = sentPhoto;
    renderPhotoDraft();
    if (sentQuote) setQuote(sentQuote);
    input.value = text;
    autoGrow();
  } finally {
    btnPhoto.disabled = !features;
  }
}

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 152) + 'px';
  // 有照片草稿时，哪怕一个字没打也能发（照片就是那条消息）
  btnSend.disabled = !input.value.trim() && !photoDraft;
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

/* ---------- 发照片（入口在发送按钮左侧；只能是照片） ---------- */
function renderPhotoDraft() {
  let chip = document.getElementById('photo-draft');
  if (!photoDraft) {
    if (chip) chip.remove();
    autoGrow();
    return;
  }
  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'photo-draft';
    const img = document.createElement('img');
    img.alt = '待发送的照片';
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'photo-draft-drop';
    drop.title = '移除这张照片';
    drop.innerHTML = '&times;';
    drop.addEventListener('click', () => { photoDraft = null; renderPhotoDraft(); });
    chip.append(img, drop);
    // 放在输入框正上方（引用条之后），与 quote 条同一列 —— 塞进行内最左会和居中的输入框脱节
    quoteBar.insertAdjacentElement('afterend', chip);
  }
  chip.querySelector('img').src = photoDraft.data;
  autoGrow();
}

/* 浏览器端先把照片压到 1600px / JPEG 0.85 再发：省上行、省它那边的 token */
function shrinkToDataURL(file, maxSide = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const isPng = file.type === 'image/png';
      resolve(canvas.toDataURL(isPng ? 'image/png' : 'image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读不出来')); };
    img.src = url;
  });
}

btnPhoto.addEventListener('click', () => photoInput.click());
photoInput.addEventListener('change', async () => {
  const file = photoInput.files && photoInput.files[0];
  photoInput.value = '';
  if (!file) return;
  if (!features) { elStatus.textContent = '生图与识图都要填，才能发图片'; return; }
  try {
    photoDraft = { data: await shrinkToDataURL(file), name: file.name };
    renderPhotoDraft();
  } catch (e) {
    console.error(e);
    elStatus.textContent = '图片读不出来，换一张试试';
    setTimeout(() => { if (!typing) elStatus.textContent = ''; }, 2500);
  }
});

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
  if (e.key === 'Escape') { disarmClear(); closePanel(); closeSettings(); clearQuote(); }
});

/* ---------- SSE ---------- */
/* ---------- 顶栏：对方是谁（昵称随时显示；头像要生图才画得出来） ---------- */
function renderPeer() {
  const name = persona.nickname || '';
  const cur = (sessionCache.find((s) => s.current) || {}).id;
  const pending = !!name && features && avatarPending.includes(cur);
  elPeer.hidden = !name;
  document.querySelector('.brand').hidden = !!name;  // 有对方名字时让位
  if (!name) return;
  elPeerName.textContent = name;
  // 头像归生图/识图那道门管；门没开就退回昵称首字 —— 纯文字，不受门管
  const av = features ? (persona.avatar || '') : '';
  elPeerAvatar.hidden = !av;
  elPeerFallback.hidden = !!av;
  elPeerPending.hidden = !pending;
  if (av) {
    elPeerAvatar.src = '/media/' + av;
    elPeerAvatar.onerror = () => { elPeerAvatar.hidden = true; elPeerFallback.hidden = false; };
  } else {
    elPeerFallback.textContent = name.slice(0, 1);
  }
  elPeer.title = persona.identity || '';
}

function applyState(ev) {
  // 整页重放：连上、切会话、新建、删除、改名、清空都走这里
  setOnline(ev.online);
  features = !!ev.features;
  persona = ev.persona || {};
  myInfo = ev.me || { nickname: '', avatar: '' };
  avatarPending = ev.avatar_pending || [];
  sessionCache = ev.sessions || [];
  renderSessions(sessionCache);
  renderPeer();
  syncPhotoBtn();
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

function syncPhotoBtn() {
  btnPhoto.hidden = !features;
  if (!features) { photoDraft = null; renderPhotoDraft(); clearQuote(); }
  else btnPhoto.disabled = false;
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
  } else if (ev.type === 'persona') {
    // 它给自己起好名字了（或头像画完了）：换顶栏，必要时重画消息行的头像
    if (ev.sid === (sessionCache.find((s) => s.current) || {}).id) {
      persona = ev.persona || persona;
      if (persona.avatar) avatarPending = avatarPending.filter((s) => s !== ev.sid);
      renderPeer();
      refreshAvatars();
    }
  } else if (ev.type === 'message') {
    appendMessage(ev.message);
    if (ev.sessions) patchSessions(ev.sessions);
    if (ev.persona) { persona = ev.persona; renderPeer(); }
  } else if (ev.type === 'sessions') {
    patchSessions(ev.sessions);
    renderPeer();
  } else if (ev.type === 'turn_end') {
    if (ev.turn === currentTurn) setTyping(false); // 被打断的旧轮号不匹配，忽略
  } else if (ev.type === 'status') {
    setOnline(ev.online);
  }
}

/* 头像是后来才画好的：已渲染的行就地换图，不整页重放（正在打的字不能被冲掉） */
function refreshAvatars() {
  if (!features) return;
  const src = persona.avatar ? '/media/' + persona.avatar : '';
  msgs.querySelectorAll('.msg.ai > .avatar').forEach((box) => {
    const want = (persona.nickname || '?').slice(0, 1);
    if (src) {
      let img = box.querySelector('img');
      if (!img) {
        box.classList.remove('empty');
        box.textContent = '';
        img = document.createElement('img');
        box.appendChild(img);
      }
      if (img.getAttribute('src') !== src) img.src = src;
    } else if (!box.classList.contains('empty')) {
      box.querySelector('img')?.remove();
      box.classList.add('empty');
      box.textContent = want;
    } else {
      box.textContent = want;
    }
  });
}

/* ---------- 设置（左下角齿轮） ---------- */
const SET_FIELDS = [
  ['cfg-endpoint', 'endpoint'], ['cfg-key', 'api_key'], ['cfg-model', 'model'],
  ['vis-endpoint', 'vision.endpoint'], ['vis-key', 'vision.api_key'], ['vis-model', 'vision.model'],
  ['gen-endpoint', 'imagegen.endpoint'], ['gen-key', 'imagegen.api_key'],
  ['gen-model', 'imagegen.model'], ['gen-size', 'imagegen.size'],
  ['me-nickname', 'me.nickname'],
];

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function setPath(obj, path, val) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] = o[k] || {}), obj);
  target[last] = val;
}

function fillSettings(cfg, opts = {}) {
  for (const [id, path] of SET_FIELDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    // 自动保存的回包不能把用户正在打的字冲掉
    if (opts.skipFocused && document.activeElement === el) continue;
    el.value = getPath(cfg, path) || '';
  }
  const st = cfg.vision_state || {};
  const box = document.getElementById('detect-state');
  box.textContent = st.detail || '';
  box.dataset.known = st.known === true ? 'yes' : st.known === false ? 'no' : '';
  const gate = document.getElementById('set-gate');
  gate.hidden = !!cfg.features;
  const miss = cfg.missing || [];
  document.getElementById('set-gate-missing').textContent =
    miss.length ? `　现在还差：${miss.join('、')}` : '';
  // features 必须先落地 —— 后面的渲染要按它开合头像那组按钮
  if (typeof cfg.features === 'boolean') features = !!cfg.features;
  syncPhotoBtn();
  renderMeAvatar(cfg.me || {});
}

function renderMeAvatar(me) {
  const img = document.getElementById('me-avatar-preview');
  const fb = document.getElementById('me-avatar-fallback');
  const name = me.nickname || myInfo.nickname || '?';
  if (me.avatar) {
    img.src = '/media/' + me.avatar;
    img.hidden = false;
    fb.hidden = true;
  } else {
    img.hidden = true;
    fb.hidden = false;
    fb.textContent = name.slice(0, 1);
  }
  // 门禁：生图/识图没填齐，换头像这组按钮不出现（跟发照片同一道门）。
  // 按钮不见的同时必须就地说明原因 —— 否则用户只会在选完文件后撞上一句报错。
  const canAvatar = !!features;
  document.getElementById('me-avatar-pick').hidden = !canAvatar;
  document.getElementById('me-avatar-clear').hidden = !canAvatar;
  const bits = [];
  if (!canAvatar) bits.push('生图还没填：换头像和发照片都用不了，填齐生图与识图即可');
  if (me.avatar_desc) bits.push('AI 看到的你：' + me.avatar_desc);
  else if (me.avatar) bits.push('头像的描述还没算出来');
  document.getElementById('me-avatar-hint').textContent = bits.join('　·　');
}

async function openSettings() {
  elSettings.hidden = false;
  btnSettings.setAttribute('aria-expanded', 'true');
  const data = await (await fetch('/api/config')).json();
  if (data.ok) fillSettings(data.config);
}

function closeSettings() {
  elSettings.hidden = true;
  btnSettings.setAttribute('aria-expanded', 'false');
}

btnSettings.addEventListener('click', () => (elSettings.hidden ? openSettings() : closeSettings()));
document.getElementById('settings-close').addEventListener('click', closeSettings);
document.getElementById('cfg-detect').addEventListener('click', () => saveSettings(true));

/* 改动自动保存 —— 面板里没有保存按钮，也没有第二个关闭按钮（顶上那个 × 就够了）。
   停手 600ms 落一次盘；回车立刻落；探测可能拖到 15s，期间的改动排队补一次。 */
let saveTimer = 0;
let saveInFlight = false;
let saveQueued = false;
let queuedDetect = false;

function statusSay(text, revert) {
  const status = document.getElementById('set-status');
  status.textContent = text;
  if (revert) {
    clearTimeout(status._t);
    status._t = setTimeout(() => { status.textContent = '改完自动保存'; }, 2600);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSettings(false), 600);
}

async function saveSettings(forceDetect) {
  if (saveInFlight) {           // 上一次还在路上：记下来，回来补一次
    saveQueued = true;
    queuedDetect = queuedDetect || !!forceDetect;
    return;
  }
  saveInFlight = true;
  const body = { detect: !!forceDetect };
  for (const [id, path] of SET_FIELDS) {
    const el = document.getElementById(id);
    if (el) setPath(body, path, el.value.trim());
  }
  const status = document.getElementById('set-status');
  status.textContent = '保存中…';
  try {
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || r.status);
    fillSettings(data.config, { skipFocused: true });
    statusSay('已保存', true);
  } catch (e) {
    console.error('config save failed:', e);
    statusSay('保存失败，改完会再试', true);
    scheduleSave();              // 失败别静默丢掉这次改动
  } finally {
    saveInFlight = false;
    if (saveQueued) {
      saveQueued = false;
      const d = queuedDetect;
      queuedDetect = false;
      saveSettings(d);
    }
  }
}

// 每个字段：停手自动存，回车立刻存
for (const [id] of SET_FIELDS) {
  const el = document.getElementById(id);
  if (!el) continue;
  el.addEventListener('input', scheduleSave);
  el.addEventListener('change', scheduleSave);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(saveTimer);
      saveSettings(false);
    }
  });
}

/* 换头像：先在浏览器里压小，再交给后端存盘并算描述 */
const meAvatarInput = document.getElementById('me-avatar-input');
document.getElementById('me-avatar-pick').addEventListener('click', () => meAvatarInput.click());
meAvatarInput.addEventListener('change', async () => {
  const file = meAvatarInput.files && meAvatarInput.files[0];
  meAvatarInput.value = '';
  if (!file) return;
  try {
    const data = await shrinkToDataURL(file, 512, 0.88);
    const status = document.getElementById('set-status');
    status.textContent = '头像上传中…';
    const r = await fetch('/api/me/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: data }),
    });
    const out = await r.json();
    if (!out.ok) throw new Error(out.error || r.status);
    fillSettings(out.config);
    myInfo = out.config.me || myInfo;
    status.textContent = '头像已换';
  } catch (e) {
    console.error('avatar upload failed:', e);
    document.getElementById('set-status').textContent = e.message || '头像上传失败';
  }
});

document.getElementById('me-avatar-clear').addEventListener('click', async () => {
  document.getElementById('me-avatar-hint').textContent = '';
  const r = await fetch('/api/me/avatar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: '' }),
  });
  const out = await r.json();
  if (out.ok) { fillSettings(out.config); myInfo = out.config.me || myInfo; }
});

// 点别处或按 Esc：收起设置
document.addEventListener('click', (e) => {
  if (!elSettings.hidden && !elSettings.contains(e.target) && !btnSettings.contains(e.target)) {
    closeSettings();
  }
});

function connect() {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    try { handleEvent(JSON.parse(e.data)); } catch (err) { console.error(err); }
  };
  es.onerror = () => { /* EventSource 自动重连，重连后 hello 会重放全量 */ };
}

connect();
