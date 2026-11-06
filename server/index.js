'use strict';
/**
 * خادم الإشارات (Signaling Server) — Node.js + Socket.io
 * مهمته الوحيدة: التعارف بين الطرفين وتبادل SDP/ICE.
 * لا تمرّ أي بيانات ملف عبر هذا الخادم أبداً — الملفات تنتقل P2P عبر RTCDataChannel.
 */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 2 * 1024 * 1024 * 1024);
const MAX_PEERS = Math.max(2, Math.min(8, Number(process.env.MAX_PEERS || 2)));
const MAX_SDP_BYTES = 64 * 1024;        // حد أقصى لحمولة الإشارة
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 1000);
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 2 * 60 * 60 * 1000);
const ROOM_CODE_RE = /^[A-Za-z0-9-]{8,36}$/;
const IS_PROD = process.env.NODE_ENV === 'production';
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// حدود محاولات الانضمام — ضد تخمين كلمة المرور
const JOIN_WINDOW_MS = 5 * 60 * 1000;
const JOIN_MAX_FAILURES = 10;

// ---------- كلمات مرور الغرف: تجزئة + ملح، لا تُحفظ أبداً كنص صريح ----------
// scrypt غير متزامن حتى لا تُجمَّد حلقة الأحداث أثناء محاولات الانضمام (حماية من DoS)
function scryptAsync(password, salt, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, (err, derived) => (err ? reject(err) : resolve(derived)));
  });
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password, salt, 64)).toString('hex');
  return { salt, hash };
}
async function verifyPassword(password, stored) {
  if (!stored) return true; // غرفة بلا كلمة مرور
  const candidate = await scryptAsync(password || '', stored.salt, 64);
  const expected = Buffer.from(stored.hash, 'hex');
  if (candidate.length !== expected.length) return false; // timingSafeEqual ترمي عند اختلاف الطول
  return crypto.timingSafeEqual(candidate, expected);
}

// ---------- غرف في الذاكرة (تُحذف فور مغادرة آخر جهاز — جلسة قصيرة العمر) ----------
/** @type {Map<string, {peers:Set<string>, password:{salt:string,hash:string}|null, encrypt:boolean, createdAt:number}>} */
const rooms = new Map();
/** @type {Map<string, {count:number, first:number}>} محاولات فاشلة لكل IP */
const joinFailures = new Map();

function clientIp(socket) {
  if (TRUST_PROXY) {
    const xff = socket.handshake.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  }
  return socket.handshake.address || 'unknown';
}
function tooManyFailures(ip) {
  const rec = joinFailures.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > JOIN_WINDOW_MS) { joinFailures.delete(ip); return false; }
  return rec.count >= JOIN_MAX_FAILURES;
}
function noteFailure(ip) {
  const now = Date.now();
  const rec = joinFailures.get(ip);
  if (!rec || now - rec.first > JOIN_WINDOW_MS) joinFailures.set(ip, { count: 1, first: now });
  else rec.count++;
}
function clearFailures(ip) { joinFailures.delete(ip); }

// حدّ معدل بسيط ضد إغراق الإشارة (نافذة منزلقة لكل Socket)
function rateLimited(socket, bucket = 'window', max = 60) {
  const now = Date.now();
  socket.data[bucket] = (socket.data[bucket] || []).filter((t) => now - t < 1000);
  if (socket.data[bucket].length >= max) return true;
  socket.data[bucket].push(now);
  return false;
}

function validSignalPayload(p) {
  if (!p || typeof p !== 'object') return false;
  try { if (JSON.stringify(p).length > MAX_SDP_BYTES) return false; } catch { return false; }
  // Offer/Answer: {type:'offer'|'answer', sdp}
  if (typeof p.type === 'string') {
    return (p.type === 'offer' || p.type === 'answer') && typeof p.sdp === 'string';
  }
  // ICE candidate (RTCIceCandidate.toJSON()): {candidate, sdpMid, sdpMLineIndex} — بلا حقل type
  if (typeof p.candidate === 'string' && p.candidate.length <= 2048) {
    const midOk = p.sdpMid === null || p.sdpMid === undefined || typeof p.sdpMid === 'string';
    const idxOk = p.sdpMLineIndex === null || p.sdpMLineIndex === undefined ||
      (typeof p.sdpMLineIndex === 'number' && Number.isFinite(p.sdpMLineIndex));
    return midOk && idxOk;
  }
  return false;
}

function originAllowed(origin, host) {
  if (!origin) return true; // عملاء غير متصفح (اختبارات/سكربتات)
  if (ALLOWED_ORIGINS.length) return ALLOWED_ORIGINS.includes(origin);
  try { return new URL(origin).host === host; } catch { return false; }
}

const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', 1);

const server = http.createServer(app);

// ---------- رؤوس أمان ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; connect-src 'self' ws: wss:; img-src 'self' blob: data:; " +
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" +
    (IS_PROD ? '; upgrade-insecure-requests' : '')
  );
  next();
});

// ---------- إعدادات الواجهة (ICE + حدود) تُحقن من البيئة ----------
app.get('/config.js', (req, res) => {
  const iceServers = [{ urls: process.env.STUN_URL || 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_PASSWORD || '',
    });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.type('application/javascript').send(
    `window.__APP_CONFIG__ = ${JSON.stringify({ iceServers, maxFileSize: MAX_FILE_SIZE, maxPeers: MAX_PEERS })};`
  );
});

// مكتبة Socket.io من الحزمة المثبّتة محلياً (تعمل دون CDN)
app.get('/vendor/socket.io.js', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(__dirname, '..', 'node_modules', 'socket.io-client', 'dist', 'socket.io.js'));
});

// ملفات ثابتة مع تخزين مؤقت للأصول فقط
app.use(express.static(path.join(__dirname, '..', 'public'), {
  index: 'index.html',
  dotfiles: 'ignore',
  setHeaders(res, filePath) {
    if (/\.(css|js|svg|woff2?)$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=3600');
    else if (/\.html$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// فحص صحة بسيط دون كشف معلومات داخلية
app.get('/health', (req, res) => res.json({ ok: true }));

// 404 موحّد (دون كشف بنية الملفات)
app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

// ---------- Socket.io ----------
const io = new Server(server, {
  cors: { origin: false },
  maxHttpBufferSize: 64 * 1024,
  pingInterval: 25000,
  pingTimeout: 20000,
  allowRequest: (req, cb) => {
    if (originAllowed(req.headers.origin, req.headers.host)) return cb(null, true);
    cb('origin_not_allowed', false);
  },
});

io.on('connection', (socket) => {
  socket.data.room = null;
  socket.data.pending = false;
  const ip = clientIp(socket);
  const err = (code, message) => socket.emit('room:error', { code, message });

  socket.on('room:create', async (payload = {}) => {
    if (!payload || typeof payload !== 'object') return err('invalidCode', 'طلب غير صالح');
    if (socket.data.pending) return err('rateLimited', 'طلبات كثيرة — حاول لاحقاً');
    if (rateLimited(socket, 'createWindow', 5)) return err('rateLimited', 'طلبات كثيرة — حاول لاحقاً');
    if (socket.data.room) return err('alreadyInRoom', 'أنت داخل غرفة بالفعل');
    if (rooms.size >= MAX_ROOMS) return err('serverBusy', 'الخادم مشغول الآن — حاول لاحقاً');
    const raw = typeof payload.password === 'string' ? payload.password.slice(0, 256) : '';
    const encrypt = payload.encrypt !== false;
    socket.data.pending = true;
    try {
      const stored = raw ? await hashPassword(raw) : null;
      // إعادة التحقق بعد الانتظار غير المتزامن (قد تتغيّر الحالة)
      if (socket.data.room) return err('alreadyInRoom', 'أنت داخل غرفة بالفعل');
      if (rooms.size >= MAX_ROOMS) return err('serverBusy', 'الخادم مشغول الآن — حاول لاحقاً');
      const code = crypto.randomUUID(); // UUID v4 — صعب التخمين (مضاد Room Hijacking)
      rooms.set(code, { peers: new Set([socket.id]), password: stored, encrypt, createdAt: Date.now() });
      socket.data.room = code;
      socket.join(code);
      socket.emit('room:created', { code, url: `${code}`, encrypt });
    } catch {
      err('serverBusy', 'تعذّر إنشاء الغرفة — حاول لاحقاً');
    } finally {
      socket.data.pending = false;
    }
  });

  socket.on('room:join', async (payload = {}) => {
    if (!payload || typeof payload !== 'object') return err('invalidCode', 'طلب غير صالح');
    if (rateLimited(socket, 'joinWindow', 10)) return err('rateLimited', 'طلبات كثيرة — حاول لاحقاً');
    if (socket.data.pending) return err('rateLimited', 'طلبات كثيرة — حاول لاحقاً');
    if (socket.data.room) return err('alreadyInRoom', 'أنت داخل غرفة بالفعل');
    if (tooManyFailures(ip)) return err('tooManyAttempts', 'محاولات كثيرة خاطئة — انتظر بضع دقائق');
    const code = String(payload.code || '').trim();
    if (!ROOM_CODE_RE.test(code)) { noteFailure(ip); return err('invalidCode', 'رمز الغرفة غير صالح'); }
    const room = rooms.get(code);
    if (!room) { noteFailure(ip); return err('notFound', 'الغرفة غير موجودة أو انتهت نشستها'); }
    const password = typeof payload.password === 'string' ? payload.password.slice(0, 256) : '';
    socket.data.pending = true;
    try {
      if (!(await verifyPassword(password, room.password))) {
        noteFailure(ip);
        return err('wrongPassword', 'كلمة المرور غير صحيحة');
      }
      // إعادة التحقق بعد الانتظار: قد تكون الغرفة دُمّرت أو امتلأت أثناءه
      const current = rooms.get(code);
      if (!current) { noteFailure(ip); return err('notFound', 'الغرفة غير موجودة أو انتهت نشستها'); }
      if (socket.data.room) return err('alreadyInRoom', 'أنت داخل غرفة بالفعل');
      if (current.peers.size >= MAX_PEERS) return err('full', 'الغرفة ممتلئة');
      clearFailures(ip);
      current.peers.add(socket.id);
      socket.data.room = code;
      socket.join(code);
      socket.emit('room:joined', { code, peers: current.peers.size, encrypt: current.encrypt !== false });
      socket.to(code).emit('peer:joined', { peers: current.peers.size });
    } catch {
      err('serverBusy', 'تعذّر الانضمام — حاول لاحقاً');
    } finally {
      socket.data.pending = false;
    }
  });

  // تمرير الإشارة فقط إلى الطرف الآخر في نفس الغرفة — لا بث عام
  const relay = (event) => (payload) => {
    if (rateLimited(socket, 'signalWindow', 120)) return;
    const code = socket.data.room;
    if (!code || !validSignalPayload(payload)) return;
    socket.to(code).emit(event, payload);
  };
  socket.on('signal:offer', relay('signal:offer'));
  socket.on('signal:answer', relay('signal:answer'));
  socket.on('signal:ice', relay('signal:ice'));

  const leave = () => {
    const code = socket.data.room;
    if (!code) return;
    const room = rooms.get(code);
    socket.data.room = null;
    if (room) {
      room.peers.delete(socket.id);
      if (room.peers.size === 0) rooms.delete(code); // تدمير الغرفة فور الفراغ
      else socket.to(code).emit('peer:left', { peers: room.peers.size }); // قبل leave حتى يصل الإشعار حتماً
    }
    socket.leave(code);
  };
  socket.on('room:leave', leave);
  socket.on('disconnect', leave);
});

// ---------- تنظيف الغرف المنتهية ----------
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL_MS) {
      rooms.delete(code);
      io.to(code).emit('room:error', { code: 'notFound', message: 'انتهت الجلسة — أنشئ غرفة جديدة' });
      io.in(code).socketsLeave(code);
    }
  }
  // تنظيف سجل محاولات الانضمام القديمة
  for (const [ip, rec] of joinFailures) {
    if (now - rec.first > JOIN_WINDOW_MS) joinFailures.delete(ip);
  }
}, 60 * 1000);
sweeper.unref();

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n✗ المنفذ ${PORT} مستخدم بالفعل. أغلق العملية السابقة أو شغّل PORT=3001 npm start\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, () => {
  console.log(`P2P signaling server: http://localhost:${PORT}`);
  console.log(`MAX_FILE_SIZE=${MAX_FILE_SIZE}  MAX_PEERS=${MAX_PEERS}  MAX_ROOMS=${MAX_ROOMS}  TURN=${process.env.TURN_URL ? 'on' : 'off (STUN only)'}`);
});

function shutdown() {
  clearInterval(sweeper);
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, server, rooms, hashPassword, verifyPassword, validSignalPayload, originAllowed };
