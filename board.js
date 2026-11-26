// Vercel Serverless Function: MZu 게시판 (질문 · 건의)
// 저장소: Upstash Redis (Vercel Marketplace). 환경변수: KV_REST_API_URL, KV_REST_API_TOKEN, ADMIN_KEY
const crypto = require('crypto');
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN = process.env.ADMIN_KEY || '';

async function redis(cmds) {
  const r = await fetch(URL_ + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOK, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).map(x => x.result);
}
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const hash = (pw, salt) => crypto.createHash('sha256').update(salt + ':' + pw).digest('hex');
function isAdmin(k) {
  if (!ADMIN || !k) return false;
  const a = Buffer.from(String(k)), b = Buffer.from(ADMIN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const pub = (p, full) => ({
  id: p.id, cat: p.cat, nick: p.nick, ts: p.ts, priv: !!p.priv,
  text: (!p.priv || full) ? p.text : '', locked: !!p.priv && !full,
  answer: (!p.priv || full) ? (p.answer || '') : (p.answer ? '__has__' : ''), at: p.at || 0
});

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!URL_ || !TOK) return res.status(503).json({ error: 'not_configured' });
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  try {
    const admin = isAdmin(b.admin);
    if (b.a === 'admin') return res.json({ ok: admin });



    if (b.a === 'visit') {
      const d = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
      const dk = 'v:' + d;
      let r;
      if (b.first) r = await redis([['INCR', dk], ['EXPIRE', dk, 60 * 60 * 24 * 3], ['INCR', 'v:total']]);
      else r = await redis([['GET', dk], ['GET', 'v:total']]);
      return res.json({ today: Number(r[0]) || 0, total: Number(b.first ? r[2] : r[1]) || 0 });
    }
    if (b.a === 'clist') {
      const rows = (await redis([['LRANGE', 'chat', 0, 79]]))[0] || [];
      const msgs = rows.map(r => { try { return JSON.parse(r); } catch (e) { return null; } }).filter(Boolean)
        .map(m => ({ id: m.id, nick: m.nick, text: m.text, ts: m.ts, mz: !!m.mz }));
      return res.json({ msgs: msgs.reverse() });
    }
    if (b.a === 'cpost') {
      const nick = clean(b.nick, 16) || '익명';
      const text = clean(b.text, 200);
      if (text.length < 1) return res.status(400).json({ error: 'short' });
      if (!admin && /(https?:\/\/|www\.|\.com\b|\.kr\b|t\.me|open\.kakao)/i.test(text)) return res.status(400).json({ error: 'link' });
      if (!admin) {
        const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
        const bucket = 'rc:' + crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
        const n = (await redis([['INCR', bucket], ['EXPIRE', bucket, 30]]))[0];
        if (n > 4) return res.status(429).json({ error: 'rate' });
      }
      const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
      const m = { id, nick: admin ? 'MZu' : nick, text, ts: Date.now(), mz: admin };
      await redis([['LPUSH', 'chat', JSON.stringify(m)], ['LTRIM', 'chat', 0, 199]]);
      return res.json({ ok: true });
    }
    if (b.a === 'cdel') {
      if (!admin) return res.status(403).json({ error: 'admin' });
      const cid = clean(b.id, 30).replace(/[^a-z0-9]/gi, '');
      const rows = (await redis([['LRANGE', 'chat', 0, 199]]))[0] || [];
      const hit = rows.find(r => { try { return JSON.parse(r).id === cid; } catch (e) { return false; } });
      if (hit) await redis([['LREM', 'chat', 0, hit]]);
      return res.json({ ok: true });
    }

    if (b.a === 'list') {
      const ids = (await redis([['LRANGE', 'ids', 0, 59]]))[0] || [];
      if (!ids.length) return res.json({ posts: [] });
      const rows = await redis([['MGET'].concat(ids.map(i => 'post:' + i))]);
      const posts = (rows[0] || []).filter(Boolean).map(s => JSON.parse(s)).map(p => pub(p, admin));
      return res.json({ posts });
    }

    if (b.a === 'post') {
      const cat = b.cat === 'req' ? 'req' : 'q';
      const nick = clean(b.nick, 20) || '익명';
      const text = clean(b.text, 600);
      const pw = clean(b.pw, 30);
      if (text.length < 5) return res.status(400).json({ error: 'short' });
      if (pw.length < 4) return res.status(400).json({ error: 'pw' });
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
      const bucket = 'rl:' + crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
      const n = (await redis([['INCR', bucket], ['EXPIRE', bucket, 600]]))[0];
      if (n > 5) return res.status(429).json({ error: 'rate' });
      const salt = crypto.randomBytes(8).toString('hex');
      const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
      const p = { id, cat, nick, text, priv: !!b.priv, salt, h: hash(pw, salt), ts: Date.now(), answer: '', at: 0 };
      await redis([['SET', 'post:' + id, JSON.stringify(p)], ['LPUSH', 'ids', id], ['LTRIM', 'ids', 0, 499]]);
      return res.json({ ok: true, id });
    }

    const id = clean(b.id, 30).replace(/[^a-z0-9]/gi, '');
    if (!id) return res.status(400).json({ error: 'id' });
    const raw = (await redis([['GET', 'post:' + id]]))[0];
    if (!raw) return res.status(404).json({ error: 'nf' });
    const p = JSON.parse(raw);
    const owner = !!b.pw && hash(clean(b.pw, 30), p.salt) === p.h;

    if (b.a === 'open') {
      if (!admin && !owner) return res.status(403).json({ error: 'pw' });
      return res.json({ post: pub(p, true) });
    }
    if (b.a === 'answer') {
      if (!admin) return res.status(403).json({ error: 'admin' });
      p.answer = clean(b.text, 1500); p.at = Date.now();
      await redis([['SET', 'post:' + id, JSON.stringify(p)]]);
      return res.json({ ok: true });
    }
    if (b.a === 'del') {
      if (!admin && !owner) return res.status(403).json({ error: 'pw' });
      await redis([['DEL', 'post:' + id], ['LREM', 'ids', 0, id]]);
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: 'bad' });
  } catch (e) {
    return res.status(500).json({ error: 'server' });
  }
};
