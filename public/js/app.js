'use strict';
/* عميل WebRTC — نقل الملفات مباشرة بين المتصفحات عبر RTCDataChannel */
const cfg = window.__APP_CONFIG__ || { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], maxFileSize: 2 * 1024 * 1024 * 1024 };
const CHUNK = 64 * 1024;               // حجم الجزء — توازن بين الأداء وحجم الرسائل
const HIGH_WATER = 1 * 1024 * 1024;    // ضغط تلقائي: نتوقف عند bufferedAmount مرتفع
const MAX_CTL_BYTES = 4096;            // أقصى حجم لرسالة تحكم نصية
const CODE_RE = /^[A-Za-z0-9-]{8,36}$/;
const $ = (id) => document.getElementById(id);
const t = (k) => (window.t ? window.t(k) : k);
const fmtSize = (b) => b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(2) + ' MB' : (b / 1e3).toFixed(1) + ' KB';
const fmtEta = (s) => !isFinite(s) || s < 0 ? '—' : s < 60 ? Math.ceil(s) + ' ' + t('file.seconds') : Math.ceil(s / 60) + ' ' + t('file.minutes');

function refreshMaxSize() { const el = $('cfg-max-size'); if (el) el.textContent = fmtSize(cfg.maxFileSize); }

const socket = io();
let pc = null, dc = null, roomCode = null, isOfferer = false;
let cryptoKey = null;                  // مفتاح AES-GCM مشتق من رمز+كلمة مرور الغرفة
let sendQueue = [];                    // ملفات بانتظار الإرسال {file, id, state...}
let receiving = null;                  // حالة الاستقبال الحالية
let burnOnRead = false;
let pendingJoin = null;                // {finish} — يُنهى مرة واحدة عند الرد/الخطأ/المهلة حتى لا يتسرّب مستمع once
let generatedSecret = null;            // مفتاح مولّد تلقائياً عند التشفير بلا كلمة مرور
let statusOn = false, statusKey = 'room.waiting';

/* ---------- تشفير AES-256-GCM لكل جزء ----------
   IV عشوائي فريد لكل جزء يُسبق للناتج (12 بايت) — لا إعادة استخدام nonce. */
async function deriveKey(secret) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('p2p-file-share-v1'), iterations: 100000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptChunk(buf) {
  if (!cryptoKey) return buf;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, buf);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0); out.set(new Uint8Array(ct), 12);
  return out.buffer;
}
async function decryptChunk(buf) {
  if (!cryptoKey) return buf;
  const bytes = new Uint8Array(buf);
  if (bytes.length <= 28) throw new Error('chunk too short'); // 12 IV + 16 tag
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, cryptoKey, bytes.slice(12));
}
function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- واجهة: غرفة ---------- */
function showRoom(code) {
  roomCode = code;
  $('step-lobby').hidden = true; $('step-room').hidden = false;
  $('room-code').textContent = code;
  setStatus(false, 'room.waiting');
  history.replaceState(null, '', '?room=' + encodeURIComponent(code));
}
function setStatus(on, key) {
  statusOn = on; statusKey = key;
  $('status-dot').classList.toggle('on', on);
  $('status-text').textContent = t(key);
}
function roomError(msg) { $('room-error').textContent = msg; }
function showSecret(secret) {
  generatedSecret = secret;
  $('secret-value').textContent = secret;
  $('secret-row').hidden = false;
}

/* انتظار ردّ الخادم مرة واحدة مع إلغاء عند الخطأ (يمنع تسرب socket.once) */
function emitRoom(event, payload, okEvent) {
  return new Promise((resolve, reject) => {
    let done = false, timer;
    const onOk = (data) => finish(null, data);
    function finish(err, data) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.off(okEvent, onOk);
      if (pendingJoin && pendingJoin.finish === finish) pendingJoin = null;
      if (err) reject(err); else resolve(data);
    }
    timer = setTimeout(() => finish(new Error(t('errors.serverBusy'))), 12000);
    pendingJoin = { finish };
    socket.once(okEvent, onOk);
    socket.emit(event, payload);
  });
}
async function withBusy(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true;
  try { await fn(); } finally { btn.disabled = false; }
}

async function setupCrypto(password, useEncryption) {
  cryptoKey = useEncryption ? await deriveKey(roomCode + '|' + (password || '')) : null;
}

/* إنشاء غرفة — عند التشفير بلا كلمة مرور نولّد مفتاحاً قوياً ونعرضه للمشاركة
   (بدل اشتقاق المفتاح من رمز الغرفة العام فقط، وهو ما يجعل التشفير بلا قيمة) */
$('btn-create').addEventListener('click', () => withBusy($('btn-create'), async () => {
  let password = $('create-password').value;
  const useEncryption = $('opt-encrypt').checked;
  const generated = useEncryption && !password;   // مفتاح مولّد = يُعرض للمشاركة
  burnOnRead = $('opt-burn').checked;
  generatedSecret = null;
  $('lobby-error').textContent = '';
  if (generated) {
    password = randomSecret();
    $('create-password').value = password;
  }
  try {
    const { code } = await emitRoom('room:create', { password, encrypt: useEncryption }, 'room:created');
    roomCode = code; isOfferer = true;
    await setupCrypto(password, useEncryption);
    showRoom(code);
    if (generated) showSecret(password);
  } catch { /* عُرض الخطأ عبر room:error */ }
}));

/* الانضمام — encrypt يأتي من الخادم (إعداد المنشئ) لا من افتراض محلي */
$('btn-join').addEventListener('click', () => withBusy($('btn-join'), async () => {
  const code = $('join-code').value.trim();
  const password = $('join-password').value;
  burnOnRead = $('opt-burn-join').checked;
  $('lobby-error').textContent = '';
  if (!CODE_RE.test(code)) { $('lobby-error').textContent = t('errors.invalidCode'); return; }
  try {
    const { encrypt } = await emitRoom('room:join', { code, password }, 'room:joined');
    roomCode = code; isOfferer = false;
    await setupCrypto(password, encrypt !== false);
    showRoom(code);
  } catch { /* عُرض الخطأ عبر room:error */ }
}));

socket.on('room:error', ({ code, message } = {}) => {
  const key = code && t('errors.' + code) !== 'errors.' + code ? 'errors.' + code : null;
  const text = key ? t(key) : (message || t('errors.serverBusy'));
  if ($('step-room').hidden) $('lobby-error').textContent = text;
  else roomError(text);
  if (pendingJoin) pendingJoin.finish(new Error(text));
});

let allowUnload = false;
$('btn-leave').addEventListener('click', () => {
  if (sendQueue.some((i) => i.state === 'sending' || i._awaitingAccept) || receiving) {
    if (!confirm(t('room.leave') + '?')) return;
  }
  allowUnload = true;
  try { socket.emit('room:leave'); } catch { /* */ }
  location.reload();
});

async function copyText(text, btn, doneKey, idleKey) {
  const label = btn.querySelector('span[data-i18n]') || btn.querySelector('span:last-child');
  try {
    await navigator.clipboard.writeText(text);
    if (label) label.textContent = t(doneKey);
  } catch {
    prompt(t('room.copyPrompt'), text);
  }
  if (label) setTimeout(() => { label.textContent = t(idleKey); }, 2000);
}
$('btn-copy').addEventListener('click', () => {
  const url = location.origin + location.pathname + '?room=' + encodeURIComponent(roomCode || '');
  copyText(url, $('btn-copy'), 'room.copied', 'room.copy');
});
$('btn-copy-secret').addEventListener('click', () => {
  if (generatedSecret) copyText(generatedSecret, $('btn-copy-secret'), 'room.secretCopied', 'room.secretCopy');
});

/* انضمام تلقائي من رابط */
(() => {
  const code = new URLSearchParams(location.search).get('room');
  if (code) $('join-code').value = code;
})();

/* إظهار/إخفاء كلمات المرور */
function wirePasswordToggle(btnId, inputId) {
  const btn = $(btnId), input = $(inputId);
  if (!btn || !input) return;
  btn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(show));
    btn.setAttribute('aria-label', t(show ? 'create.hide' : 'a11y.showPassword'));
    const icon = btn.querySelector('.icon');
    if (icon) icon.className = 'icon ' + (show ? 'i-eye-off' : 'i-eye');
  });
}
wirePasswordToggle('toggle-create-pw', 'create-password');
wirePasswordToggle('toggle-join-pw', 'join-password');

/* لصق رمز الغرفة */
$('btn-paste').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) $('join-code').value = text.trim();
  } catch { $('join-code').focus(); }
});

/* قائمة الجوال */
const navToggle = $('nav-toggle'), navLinks = $('nav-links');
if (navToggle && navLinks) {
  navToggle.addEventListener('click', () => {
    const open = navLinks.classList.toggle('open');
    navToggle.setAttribute('aria-expanded', String(open));
  });
  navLinks.addEventListener('click', (e) => { if (e.target.closest('a')) navLinks.classList.remove('open'); });
}

/* ---------- WebRTC ---------- */
function ensurePeerConnection() {
  if (pc) return;
  pc = new RTCPeerConnection({ iceServers: cfg.iceServers });
  pc.onicecandidate = (e) => e.candidate && socket.emit('signal:ice', e.candidate.toJSON());
  pc.onconnectionstatechange = () => {
    if (!pc) return; // أُغلق الاتصال واستُبدل قبل وصول الحدث
    const s = pc.connectionState;
    if (s === 'connected') setStatus(true, 'status.connected');
    if (s === 'disconnected' || s === 'failed') {
      setStatus(false, 'status.disconnected');
      if (dc) { try { dc.close(); } catch { /* مغلقة أصلاً */ } dc = null; }
    }
  };
  pc.ondatachannel = (e) => { dc = e.channel; wireChannel(dc); };
}
function wireChannel(channel) {
  channel.binaryType = 'arraybuffer';
  channel.onopen = () => {
    setStatus(true, 'status.channelOpen');
    // إعادة إرسال البيانات الوصفية بعد إعادة الاتصال
    sendQueue.forEach((i) => {
      if (i._awaitingAccept || (i.state === 'sending' && !i.cancelled)) { i.state = 'queued'; i._awaitingAccept = false; }
    });
    if (receiving && receiving.received > 0) sendCtl({ type: 'ack', id: receiving.id, received: receiving.received });
    pumpQueue();
  };
  channel.onclose = () => {
    setStatus(false, 'status.channelClosed');
    if (dc === channel) dc = null;
    // إعادة الملفات غير المكتملة إلى الطابور حتى تُستأنف بعد إعادة الفتح
    sendQueue.forEach((i) => { if (i.state === 'sending') { i.state = 'queued'; i._awaitingAccept = false; } });
  };
  channel.onmessage = onMessage;
}
async function makeOffer() {
  ensurePeerConnection();
  if (!dc || dc.readyState === 'closed' || dc.readyState === 'closing') {
    dc = pc.createDataChannel('file-transfer', { ordered: true }); wireChannel(dc);
  }
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal:offer', pc.localDescription.toJSON());
}
socket.on('peer:joined', () => { if (isOfferer) makeOffer().catch(() => setStatus(false, 'status.disconnected')); });
socket.on('peer:left', () => {
  setStatus(false, 'status.peerLeft');
  if (dc) { try { dc.close(); } catch { /* */ } dc = null; }
  // اتصال جديد تماماً عند انضمام طرف آخر لاحقاً (يتجنّب إعادة استخدام PC في حالة failed)
  if (pc) { try { pc.close(); } catch { /* */ } pc = null; }
});
socket.on('signal:offer', async (offer) => {
  ensurePeerConnection();
  try {
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('signal:answer', pc.localDescription.toJSON());
  } catch { /* وصف قديم/غير صالح — تجاهل */ }
});
socket.on('signal:answer', async (answer) => { if (pc) try { await pc.setRemoteDescription(answer); } catch { /* */ } });
socket.on('signal:ice', async (cand) => { if (pc) try { await pc.addIceCandidate(cand); } catch { /* مرشّح قديم */ } });

/* ---------- بروتوكول نقل الملفات ---------- */
function sendCtl(obj) {
  if (dc && dc.readyState === 'open') {
    try { dc.send(JSON.stringify(obj)); } catch { /* القناة تُغلق أثناء الإرسال */ }
  }
}
function rejectFile(id, reason) { sendCtl({ type: 'reject', id, reason }); }

function enqueueFiles(fileList) {
  for (const file of fileList) {
    if (!file || typeof file.name !== 'string' || file.name.length > 255) { roomError(t('errors.rejectInvalid')); continue; }
    if (file.size > cfg.maxFileSize) { roomError(`«${file.name}» ${t('file.tooBig')}`); continue; }
    const item = { file, id: crypto.randomUUID(), state: 'queued', sentBytes: 0, paused: false, cancelled: false, startTime: 0, samples: [], _label: '' };
    sendQueue.push(item); renderFileItem(item);
  }
  pumpQueue();
}

async function pumpQueue() {
  if (!dc || dc.readyState !== 'open') return;
  if (sendQueue.some((i) => i.state === 'sending')) return;
  const item = sendQueue.find((i) => i.state === 'queued');
  if (!item) return;
  item.state = 'sending';
  const { file } = item;
  const chunks = Math.ceil(file.size / CHUNK) || 1;
  sendCtl({ type: 'file-meta', id: item.id, name: file.name, size: file.size, mime: file.type || 'application/octet-stream', chunks, encrypted: !!cryptoKey });
  updateItem(item, t('file.waitingAccept'));
  item._awaitingAccept = true;
}

async function sendFile(item, fromChunk = 0) {
  const { file } = item;
  item._awaitingAccept = false;
  item.startTime = Date.now(); item.samples = [];
  updateItem(item, t('file.sending'));
  const totalChunks = Math.ceil(file.size / CHUNK);
  for (let i = fromChunk; i < totalChunks; i++) {
    if (item.cancelled) return;
    while (item.paused || !dc || dc.readyState !== 'open') {
      if (item.cancelled) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (dc.bufferedAmount > HIGH_WATER) await new Promise((r) => setTimeout(r, 50)); // ضغط خلفي
    const slice = await file.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer();
    dc.send(await encryptChunk(slice));
    item.sentBytes = Math.min(file.size, (i + 1) * CHUNK);
    item.samples.push({ t: Date.now(), b: item.sentBytes });
    if (item.samples.length > 40) item.samples.shift();
    if (i % 10 === 0) sendCtl({ type: 'ack', id: item.id, received: i + 1 });
    updateItem(item);
  }
  item.state = 'done';
  sendCtl({ type: 'complete', id: item.id });
  updateItem(item, burnOnRead ? t('file.doneBurn') : t('file.done'));
  pumpQueue();
}

async function onMessage(ev) {
  if (typeof ev.data === 'string') {
    if (ev.data.length > MAX_CTL_BYTES) return; // رسالة تحكم ضخمة — تجاهل
    try { return onControl(JSON.parse(ev.data)); } catch { return; }
  }
  if (!(ev.data instanceof ArrayBuffer) || !receiving) return;
  const r = receiving;
  // جزء أكبر من المتوقع (64KB + 28 بايت تشفير) — حمولة خبيثة
  if (ev.data.byteLength > CHUNK + 64) {
    rejectFile(r.id, t('file.badChunk'));
    removeReceiveItem(r.id); receiving = null; return;
  }
  if (r.received >= r.chunks) { rejectFile(r.id, t('errors.rejectInvalid')); return; }
  try {
    const plain = await decryptChunk(ev.data);
    if (receiving !== r) return; // أُلغي/استُبدل أثناء فك التشفير
    // لا نتجاوز حجم الملف المعلن ولا حجم الجزء — يمنع تضخيم الذاكرة من طرف خبيث
    if (!(plain instanceof ArrayBuffer) || plain.byteLength > CHUNK ||
        r.receivedBytes + plain.byteLength > r.size) {
      throw new Error('bad chunk length');
    }
    r.parts.push(plain);
    r.receivedBytes += plain.byteLength;
    r.received++;
    if (r.received % 10 === 0) sendCtl({ type: 'ack', id: r.id, received: r.received });
    updateReceive();
  } catch {
    if (receiving !== r) return;
    rejectFile(r.id, t('errors.rejectDecrypt'));
    removeReceiveItem(r.id); receiving = null;
  }
}

function onControl(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  if (msg.type === 'file-meta') {
    // تحقق صارم قبل التخزين المؤقت — حماية من الحمولات الخبيثة/الضخمة
    if (receiving) { rejectFile(msg.id, t('errors.rejectBusy')); return; }
    if (!msg.name || typeof msg.name !== 'string' || msg.name.length > 255 ||
        !Number.isInteger(msg.size) || msg.size < 0 || msg.size > cfg.maxFileSize ||
        (msg.mime !== undefined && (typeof msg.mime !== 'string' || msg.mime.length > 128)) ||
        !Number.isInteger(msg.chunks) || msg.chunks < 1 ||
        msg.chunks > Math.ceil(cfg.maxFileSize / CHUNK) + 1) {
      rejectFile(msg.id, t('errors.rejectInvalid')); return;
    }
    if (msg.encrypted && !cryptoKey) { rejectFile(msg.id, t('errors.rejectEncrypted')); return; }
    receiving = { ...msg, parts: [], received: 0, receivedBytes: 0, startTime: Date.now(), samples: [] };
    renderReceive(receiving);
    sendCtl({ type: 'accept', id: msg.id, received: 0 });
    return;
  }
  if (msg.type === 'accept') {
    const item = sendQueue.find((i) => i.id === msg.id);
    if (!item || !item._awaitingAccept) return;
    // موضع الاستئناف يجب أن يكون عدداً صحيحاً داخل حدود أجزاء الملف
    const totalChunks = Math.ceil(item.file.size / CHUNK);
    const from = msg.received === undefined ? 0 : msg.received;
    if (!Number.isInteger(from) || from < 0 || from > totalChunks) {
      item.state = 'rejected'; item.cancelled = true;
      updateItem(item, t('errors.rejectInvalid')); pumpQueue();
      return;
    }
    sendFile(item, from);
    return;
  }
  if (msg.type === 'reject') {
    const item = sendQueue.find((i) => i.id === msg.id);
    if (item) { item.state = 'rejected'; item.cancelled = true; updateItem(item, t('file.rejected') + ' ' + (msg.reason || '')); pumpQueue(); }
    if (receiving && receiving.id === msg.id) { removeReceiveItem(msg.id); receiving = null; }
    return;
  }
  if (msg.type === 'ack') {
    const item = sendQueue.find((i) => i.id === msg.id);
    if (item) item.ackedChunk = msg.received; // آخر موضع مؤكَّد — أساس الاستئناف
    return;
  }
  if (msg.type === 'pause') { const i = sendQueue.find((x) => x.id === msg.id); if (i) i.paused = true; return; }
  if (msg.type === 'resume') {
    const i = sendQueue.find((x) => x.id === msg.id);
    if (i && i.state === 'sending') i.paused = false;
    return;
  }
  if (msg.type === 'cancel') {
    const i = sendQueue.find((x) => x.id === msg.id);
    if (i) { i.cancelled = true; updateItem(i, t('file.cancelledByPeer')); }
    if (receiving && receiving.id === msg.id) { removeReceiveItem(msg.id); receiving = null; }
    return;
  }
  if (msg.type === 'complete' && receiving && receiving.id === msg.id) finishReceive();
}

function finishReceive() {
  if (!receiving) return;
  const r = receiving;
  // تحقق من الحجم النهائي — يمنع ملفات مقتطعة أو معدّلة (الملف الفارغ لا يرسل أجزاء)
  const expectedChunks = r.size === 0 ? 0 : r.chunks;
  if (r.receivedBytes !== r.size || r.received !== expectedChunks) {
    rejectFile(r.id, t('errors.rejectSize'));
    removeReceiveItem(r.id); receiving = null; return;
  }
  const blob = new Blob(r.parts, { type: r.mime });
  const url = URL.createObjectURL(blob);
  receiving = null;
  const el = $('receive-' + r.id);
  if (el) {
    el.querySelector('.file-stats').textContent = t('file.completeReceive');
    const a = el.querySelector('a.dl'); a.href = url; a.download = r.name; a.hidden = false;
    a.addEventListener('click', () => {
      if (burnOnRead) setTimeout(() => { URL.revokeObjectURL(url); r.parts = []; el.querySelector('.file-stats').textContent = t('file.burned'); }, 3000);
    }, { once: true });
  }
  sendCtl({ type: 'done', id: r.id });
}

/* ---------- واجهة: عناصر الملفات ---------- */
const icon = (name) => `<span class="icon i-${name}" aria-hidden="true"></span>`;
function renderFileItem(item) {
  const li = document.createElement('li');
  li.className = 'file-item'; li.id = 'send-' + item.id;
  li.innerHTML = `
    <div class="file-meta"><span></span><span class="file-stats"></span></div>
    <div class="progress"><div></div></div>
    <div class="file-actions">
      <button class="btn btn-small act-pause" type="button">${icon('pause')} <span class="label"></span></button>
      <button class="btn btn-small act-cancel" type="button">${icon('x')} <span class="label"></span></button>
    </div>`;
  li.querySelector('.file-meta span').textContent = item.file.name + ' · ' + fmtSize(item.file.size);
  const pauseBtn = li.querySelector('.act-pause');
  pauseBtn.querySelector('.label').textContent = t('file.pause');
  li.querySelector('.act-cancel .label').textContent = t('file.cancel');
  pauseBtn.addEventListener('click', () => {
    item.paused = !item.paused;
    pauseBtn.querySelector('.icon').className = 'icon ' + (item.paused ? 'i-play' : 'i-pause');
    pauseBtn.querySelector('.label').textContent = t(item.paused ? 'file.resume' : 'file.pause');
    sendCtl({ type: item.paused ? 'pause' : 'resume', id: item.id });
    // حلقة sendFile تنتظر item.paused وتستأنف تلقائياً من آخر ack
  });
  li.querySelector('.act-cancel').addEventListener('click', () => {
    item.cancelled = true; sendCtl({ type: 'cancel', id: item.id }); updateItem(item, t('file.cancelled'));
  });
  $('file-list').appendChild(li);
  item._el = li;
}
function updateItem(item, text) {
  if (!item._el) return;
  if (text !== undefined) item._label = text;
  const pct = item.file.size ? Math.min(100, (item.sentBytes / item.file.size) * 100) : 100;
  item._el.querySelector('.progress div').style.width = pct + '%';
  const s = item.samples;
  const speed = s.length > 1 ? (s[s.length - 1].b - s[0].b) / ((s[s.length - 1].t - s[0].t) / 1000) : 0;
  const eta = speed > 0 ? (item.file.size - item.sentBytes) / speed : -1;
  item._el.querySelector('.file-stats').textContent =
    `${item._label || ''} ${Math.floor(pct)}% · ${speed > 0 ? (speed / 1e6).toFixed(2) + ' MB/s' : ''} · ${t('file.remaining')} ${fmtEta(eta)}`;
}
function renderReceive(r) {
  const li = document.createElement('li');
  li.className = 'file-item'; li.id = 'receive-' + r.id;
  li.innerHTML = `
    <div class="file-meta"><span></span><span class="file-stats"></span></div>
    <div class="progress"><div></div></div>
    <div class="file-actions"><a class="dl btn btn-small" hidden>${icon('download')} <span class="label"></span></a></div>`;
  li.querySelector('.file-meta span').textContent = r.name + ' · ' + fmtSize(r.size);
  li.querySelector('a.dl .label').textContent = t('file.download');
  $('file-list').appendChild(li);
}
function removeReceiveItem(id) { const el = $('receive-' + id); if (el) el.remove(); }
function updateReceive() {
  if (!receiving) return;
  const el = $('receive-' + receiving.id); if (!el) return;
  const pct = receiving.size ? (receiving.receivedBytes / receiving.size) * 100 : 100;
  el.querySelector('.progress div').style.width = pct + '%';
  el.querySelector('.file-stats').textContent = `${t('file.receiving')} ${Math.floor(pct)}%`;
}

/* ---------- سحب وإفلات ---------- */
const dz = $('dropzone'), fi = $('file-input');
dz.addEventListener('click', () => fi.click());
fi.addEventListener('change', () => { enqueueFiles(fi.files); fi.value = ''; });
['dragenter', 'dragover'].forEach((e) => dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach((e) => dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', (ev) => enqueueFiles(ev.dataTransfer.files));
dz.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fi.click(); } });

/* تحذير عند مغادرة الصفحة أثناء نقل جارٍ */
window.addEventListener('beforeunload', (e) => {
  if (!allowUnload && (receiving || sendQueue.some((i) => i.state === 'sending' || i._awaitingAccept))) {
    e.preventDefault(); e.returnValue = '';
  }
});

/* تحديث النصوص الديناميكية عند تبديل اللغة */
if (window.onLangChange) {
  window.onLangChange(() => {
    refreshMaxSize();
    if (roomCode && !$('step-room').hidden) setStatus(statusOn, statusKey);
    sendQueue.forEach((i) => {
      if (!i._el) return;
      const pause = i._el.querySelector('.act-pause .label');
      if (pause) pause.textContent = t(i.paused ? 'file.resume' : 'file.pause');
      const cancel = i._el.querySelector('.act-cancel .label');
      if (cancel) cancel.textContent = t('file.cancel');
      const dl = i._el.querySelector('a.dl .label'); if (dl) dl.textContent = t('file.download');
    });
  });
}
window.ready.then(refreshMaxSize).catch(() => refreshMaxSize());
