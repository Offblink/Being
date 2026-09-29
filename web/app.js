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
let features = false;    // 生图与识图是否都填了（头像与发图片的总开关）
let missingFeat = [];    // 具体还差哪一段（红条撤了，只在头像那儿就地提一句）
let persona = {};        // 对方的人设：昵称、身份、头像…
let myInfo = { nickname: '', avatar: '' };
let avatarPending = [];  // 头像还在画的会话
let quote = null;        // {id, role, text} 正准备引用的那条
let photoDraft = null;   // {data, name} 发送失败暂存的照片（正常路径选完直接发，不进暂存）

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

/* 悬停时间：今天只给时分；昨天/前天直接写字；本周内给星期几；跨出本周才写日期 */
function whenLabel(ts) {
  const t = new Date((ts || 0) * 1000);
  if (!ts || isNaN(t)) return '';
  const now = new Date();
  const clock = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  // 按自然日算差几天，不受时分干扰
  const dayDiff = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate())
    - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
  if (dayDiff <= 0) return clock;   // 今天（时钟偏差出来的未来消息也按今天显示）
  if (dayDiff === 1) return `昨天 ${clock}`;
  if (dayDiff === 2) return `前天 ${clock}`;
  const weekStart = (d) => {        // 本周一 0 点（周一为一周之始）
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x.getTime();
  };
  if (weekStart(t) === weekStart(now)) return `星期${'日一二三四五六'[t.getDay()]} ${clock}`;
  const date = t.getFullYear() === now.getFullYear()
    ? `${t.getMonth() + 1}月${t.getDate()}日`
    : `${t.getFullYear()}年${t.getMonth() + 1}月${t.getDate()}日`;
  return `${date} ${clock}`;
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
  // 只留 data-when 给 CSS 自绘的悬停时间戳；不写 title —— 原生 tooltip 是另一套样式，会重复出现
  if (when) { row.dataset.when = when; }

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
    // 点照片不进新网页 —— 交给系统默认程序打开原图（后端 os.startfile）
    img.addEventListener('click', () => openMediaNative((img.getAttribute('src') || '').split('/media/').pop()));
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

/* 投递一条消息：请求、回合跟踪、失败回滚共用这一条路（文字与「选图直接发」都走它） */
async function deliver(body, restore) {
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
    if (restore) restore();
  } finally {
    btnPhoto.disabled = !features;
    autoGrow();   // 按钮状态按「现在还剩什么可发」重算（恢复回来的文字/照片也算）
  }
}

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
  await deliver(body, () => {
    photoDraft = sentPhoto;       // 文字重打一遍能忍，照片重选一遍不能忍
    renderPhotoDraft();
    if (sentQuote) setQuote(sentQuote);
    input.value = text;
    autoGrow();
  });
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
  let data;
  try {
    data = await shrinkToDataURL(file);
  } catch (e) {
    console.error(e);
    elStatus.textContent = '图片读不出来，换一张试试';
    setTimeout(() => { if (typing) elStatus.textContent = ''; }, 2500);
    return;
  }
  // 选完直接发 —— 不在输入框上方暂存；输入框里正在打的字不受影响
  await deliver({ image: data }, () => {
    photoDraft = { data, name: file.name };  // 发送失败才暂存：草稿条出现，点发送可重试
    renderPhotoDraft();
  });
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
  if (e.key === 'Escape') { disarmClear(); closePanel(); closeSettings(); clearQuote(); closeModal(); }
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
  missingFeat = Array.isArray(cfg.missing) ? cfg.missing : [];
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
  document.getElementById('me-avatar-actions').hidden = !canAvatar;
  document.getElementById('me-avatar-pick').hidden = !canAvatar;
  document.getElementById('me-avatar-clear').hidden = !canAvatar;
  const bits = [];
  if (!canAvatar) bits.push(`${missingFeat.join('与') || '生图与识图'}还没填：换头像和发照片都用不了`);
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

/* ---------- 模态框 ---------- */
const elOverlay = document.getElementById('modal-overlay');
const elCardModal = document.getElementById('card-modal');
const elCropModal = document.getElementById('crop-modal');

function modalOpen() { return !elOverlay.hidden; }

function openModal(box) {
  elCardModal.hidden = box !== elCardModal;
  elCropModal.hidden = box !== elCropModal;
  elOverlay.hidden = false;
}

function closeModal() {
  elOverlay.hidden = true;
  elCardModal.hidden = true;
  elCropModal.hidden = true;
  cropImg = null;          // 放弃这次截取（重新选图会重建）
}

// 点遮罩自己才关（点内容不关）；×也关
elOverlay.addEventListener('click', (e) => { if (e.target === elOverlay) closeModal(); });
elOverlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));

/* ---------- 对方名片：点顶栏或气泡里的 AI 头像弹出 ---------- */
const CARD_ROWS = [['age', '年龄'], ['gender', '性别'], ['origin', '来自'],
                   ['hobbies', '爱好'], ['traits', '性格']];

function cardRowValue(v) {
  // 服务端立人设时把字段 str() 过 —— 模型给的数组会存成 Python repr「['a', 'b']」。
  // 数组与这种字符串都拼成「A、B」；真被方括号包着的短语（如「[笑]」）原样留着。
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).join('、');
  const s = String(v ?? '').trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    const items = s.slice(1, -1).match(/(?:'[^']*'|"[^"]*")/g);
    if (items) return items.map((t) => t.slice(1, -1).trim()).filter(Boolean).join('、');
  }
  return s;
}

function openCard() {
  if (!persona.nickname) return;   // 这个会话还没立人设，没名片可看
  const av = features ? (persona.avatar || '') : '';
  const img = document.getElementById('card-avatar');
  const fb = document.getElementById('card-fallback');
  img.hidden = !av;
  if (av) img.src = '/media/' + av;
  fb.hidden = !!av;
  fb.textContent = persona.nickname.slice(0, 1);
  document.getElementById('card-name').textContent = persona.nickname;
  document.getElementById('card-identity').textContent = persona.identity || '';
  const dl = document.getElementById('card-rows');
  dl.textContent = '';
  for (const [key, label] of CARD_ROWS) {
    const text = cardRowValue(persona[key]);
    if (!text) continue;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = text;
    dl.append(dt, dd);
  }
  const cur = (sessionCache.find((s) => s.current) || {}).id;
  document.getElementById('card-pending').hidden = !(features && avatarPending.includes(cur));
  openModal(elCardModal);
}

elPeer.addEventListener('click', openCard);
msgs.addEventListener('click', (e) => { if (e.target.closest('.msg.ai > .avatar')) openCard(); });
/* 用系统默认程序打开 media/ 里的图片 —— Being 就跑在本机，后端直接 os.startfile。
   名片头像、消息里的照片都走这一条；失败在底部状态栏就地说明。 */
async function openMediaNative(file) {
  if (!file) return;
  try {
    const r = await fetch('/api/media/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    });
    const out = await r.json();
    if (!out.ok) throw new Error(out.error || r.status);
  } catch (e) {
    console.error('open media failed:', e);
    const msg = e.message || '打不开这张图';
    elStatus.textContent = msg;
    setTimeout(() => { if (elStatus.textContent === msg) elStatus.textContent = ''; }, 3000);
  }
}

// 名片里点头像 → 系统默认程序打开原图
document.getElementById('card-avatar').addEventListener('click', () => {
  openMediaNative(features ? (persona.avatar || '') : '');
});

/* ---------- 头像截取：圆形取景框拖动 + 滑块缩放，确认出 512² 方图 ---------- */
const cropCanvas = document.getElementById('crop-canvas');
const cropZoomInput = document.getElementById('crop-zoom');
const CROP_SIZE = 280;
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];  // gif 等 AI 识不了，不收
let cropImg = null;              // 待截取的图片（HTMLImageElement）
let cropFit = 1;                 // 刚好铺满圆形视口的基准缩放
let cropZoom = 1;                // 滑块倍数（0.5–3）
let cropX = 0, cropY = 0;        // 相对中心的偏移（画布像素）
let cropDrag = null;

function cropGeom() {
  const iw = cropImg.width * cropFit * cropZoom;
  const ih = cropImg.height * cropFit * cropZoom;
  // 拖动夹紧：图片边缘不许缩进圆形视口（图太小或缩放太低时就固定居中）
  const maxX = Math.max(0, (iw - CROP_SIZE) / 2);
  const maxY = Math.max(0, (ih - CROP_SIZE) / 2);
  cropX = Math.min(maxX, Math.max(-maxX, cropX));
  cropY = Math.min(maxY, Math.max(-maxY, cropY));
  return { iw, ih };
}

function drawCrop() {
  if (!cropImg) return;
  const { iw, ih } = cropGeom();
  const ctx = cropCanvas.getContext('2d');
  ctx.clearRect(0, 0, CROP_SIZE, CROP_SIZE);
  ctx.save();
  ctx.beginPath();
  ctx.arc(CROP_SIZE / 2, CROP_SIZE / 2, CROP_SIZE / 2, 0, Math.PI * 2);
  ctx.clip();                      // 只画圆里那部分 —— 圆外露出深色取景框
  ctx.drawImage(cropImg, (CROP_SIZE - iw) / 2 + cropX, (CROP_SIZE - ih) / 2 + cropY, iw, ih);
  ctx.restore();
}

cropCanvas.addEventListener('pointerdown', (e) => {
  if (!cropImg) return;
  cropCanvas.setPointerCapture(e.pointerId);   // 指针移出画布也不断拖
  cropDrag = { x: e.clientX, y: e.clientY, ox: cropX, oy: cropY };
});
cropCanvas.addEventListener('pointermove', (e) => {
  if (!cropDrag) return;
  cropX = cropDrag.ox + (e.clientX - cropDrag.x);
  cropY = cropDrag.oy + (e.clientY - cropDrag.y);
  drawCrop();
});
const endCropDrag = () => { cropDrag = null; };
cropCanvas.addEventListener('pointerup', endCropDrag);
cropCanvas.addEventListener('pointercancel', endCropDrag);
cropZoomInput.addEventListener('input', () => {
  cropZoom = parseInt(cropZoomInput.value, 10) / 100;
  drawCrop();
});

function uploadAvatar(data) {   // 存盘并算描述（AI 看得见的那份），成功后回填设置
  return fetch('/api/me/avatar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: data }),
  }).then(async (r) => {
    const out = await r.json();
    if (!out.ok) throw new Error(out.error || r.status);
    fillSettings(out.config);
    myInfo = out.config.me || myInfo;
  });
}

/* 换头像：选图（只收 jpg/png/webp）→ 弹截取 → 确认后上传 */
const meAvatarInput = document.getElementById('me-avatar-input');
const setAvatarStatus = (t) => { document.getElementById('set-status').textContent = t; };
document.getElementById('me-avatar-pick').addEventListener('click', () => meAvatarInput.click());
meAvatarInput.addEventListener('change', () => {
  const file = meAvatarInput.files && meAvatarInput.files[0];
  meAvatarInput.value = '';
  if (!file) return;
  if (!AVATAR_TYPES.includes(file.type)) {
    setAvatarStatus('头像只收 jpg/png/webp —— gif 和其它格式 AI 识不了');
    return;
  }
  setAvatarStatus('读取图片…');
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    cropImg = img;
    cropFit = Math.max(CROP_SIZE / img.width, CROP_SIZE / img.height);  // 基准 = 正好铺满
    cropZoom = 1;
    cropZoomInput.value = '100';
    cropX = 0;
    cropY = 0;
    drawCrop();
    openModal(elCropModal);
    setAvatarStatus('');   // 截取框已就位，读取阶段的提示撤掉
  };
  img.onerror = () => { URL.revokeObjectURL(url); setAvatarStatus('图片读不出来，换一张试试'); };
  img.src = url;
});

document.getElementById('crop-cancel').addEventListener('click', closeModal);

document.getElementById('crop-ok').addEventListener('click', async () => {
  if (!cropImg) return;
  const btn = document.getElementById('crop-ok');
  btn.disabled = true;
  btn.dataset.busy = '1';     // 转圈加载态
  btn.textContent = '上传中…';
  try {
    const OUT = 512;             // 与旧管线同规格：512 / JPEG 0.88
    const out = document.createElement('canvas');
    out.width = out.height = OUT;
    const octx = out.getContext('2d');
    octx.fillStyle = '#fff';     // 透明兜底：jpeg 不吃 alpha
    octx.fillRect(0, 0, OUT, OUT);
    const k = OUT / CROP_SIZE;
    const { iw, ih } = cropGeom();
    octx.drawImage(cropImg,
      ((CROP_SIZE - iw) / 2 + cropX) * k, ((CROP_SIZE - ih) / 2 + cropY) * k,
      iw * k, ih * k);
    setAvatarStatus('头像上传中…');
    await uploadAvatar(out.toDataURL('image/jpeg', 0.88));
    closeModal();
    setAvatarStatus('头像已换');
  } catch (e) {
    console.error('avatar upload failed:', e);
    setAvatarStatus(e.message || '头像上传失败');
  } finally {
    btn.disabled = false;
    delete btn.dataset.busy;
    btn.textContent = '确认';
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

// 点别处或按 Esc：收起设置（模态框开着时不动它 —— 截取头像就是在设置里点出来的）
document.addEventListener('click', (e) => {
  if (!elSettings.hidden && !modalOpen() && !elSettings.contains(e.target) && !btnSettings.contains(e.target)) {
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
