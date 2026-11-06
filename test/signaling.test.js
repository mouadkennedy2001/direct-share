'use strict';
/* اختبار إشارات: إنشاء/انضمام، كلمة مرور خاطئة، تمرير offer و ICE، امتلاء الغرفة، مغادرة */
const assert = require('assert');
const { io } = require('socket.io-client');

const BASE = process.env.BASE || 'http://localhost:3000';
const wait = (ev, sock, timeout = 4000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout waiting ' + ev)), timeout);
  sock.once(ev, (d) => { clearTimeout(t); res(d); });
});
const emitWait = (sock, ev, payload, respEv) => { const p = wait(respEv, sock); sock.emit(ev, payload); return p; };

(async () => {
  const a = io(BASE), b = io(BASE), c = io(BASE), d = io(BASE);
  await Promise.all([a, b, c, d].map((s) => new Promise((r) => s.on('connect', r))));

  // إنشاء بكلمة مرور + إعداد التشفير
  const created = await emitWait(a, 'room:create', { password: 's3cret', encrypt: true }, 'room:created');
  assert.ok(created.code, 'room code returned');
  assert.equal(created.encrypt, true, 'encrypt flag returned to creator');
  console.log('✓ create ->', created.code);

  // رمز غير صالح يُرفض
  const badCode = await emitWait(d, 'room:join', { code: 'x', password: 's3cret' }, 'room:error');
  assert.match(badCode.message, /رمز الغرفة/);
  console.log('✓ invalid code rejected');

  // كلمة مرور خاطئة تُرفض
  const bad = await emitWait(b, 'room:join', { code: created.code, password: 'wrong' }, 'room:error');
  assert.match(bad.message, /كلمة المرور/);
  console.log('✓ wrong password rejected');

  // انضمام صحيح + إشعار المنشئ + تمرير إعداد التشفير
  const peerSeen = wait('peer:joined', a);
  const joined = await emitWait(b, 'room:join', { code: created.code, password: 's3cret' }, 'room:joined');
  assert.equal(joined.peers, 2);
  assert.equal(joined.encrypt, true, 'encrypt flag relayed to joiner');
  await peerSeen;
  console.log('✓ join + peer:joined notified + encrypt flag relayed');

  // تمرير offer
  const offerSeen = wait('signal:offer', b);
  a.emit('signal:offer', { type: 'offer', sdp: 'x'.repeat(100) });
  assert.equal((await offerSeen).type, 'offer');
  console.log('✓ offer relayed');

  // تمرير ICE (لا يحمل حقل type — كان يُرفض في الإصدار السابق)
  const iceSeen = wait('signal:ice', b);
  a.emit('signal:ice', { candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 });
  assert.match((await iceSeen).candidate, /^candidate:/);
  console.log('✓ ICE candidate relayed');

  // حمولة إشارة غير صالحة الشكل لا تُمرَّر (offer بلا sdp)
  const leak = wait('signal:offer', b, 600).then(() => true).catch(() => false);
  a.emit('signal:offer', { type: 'offer' });
  assert.equal(await leak, false, 'malformed offer must not be relayed');
  console.log('✓ malformed signal dropped');

  // الغرفة ممتلئة (MAX_PEERS=2)
  const full = await emitWait(c, 'room:join', { code: created.code, password: 's3cret' }, 'room:error');
  assert.match(full.message, /ممتلئة/);
  console.log('✓ full room rejected');

  // مغادرة ب تُعلم أ
  const leftSeen = wait('peer:left', a);
  b.emit('room:leave');
  await leftSeen;
  console.log('✓ leave notified');

  [a, b, c, d].forEach((s) => s.close());
  console.log('\nAll signaling tests passed.');
  process.exit(0);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
