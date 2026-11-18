// Habitat Trail photo map server. Node 18+, no dependencies.
// Start:  ANTHROPIC_API_KEY=sk-... ADMIN_KEY=pick-a-secret node server.js
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const LIVE_MODEL = process.env.CLAUDE_LIVE_MODEL || 'claude-haiku-5-5'; // faster, cheaper model for live camera
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const DELAY_MIN = +(process.env.PIN_DELAY_MINUTES || 60);   // others see a pin this long after posting
const CELL_M = +(process.env.FUZZ_METERS || 500);            // neighborhood blur
const PROTECTED_CELL_M = +(process.env.PROTECTED_FUZZ_METERS || 2000); // endangered species blur
const REPORTS_TO_HIDE = 3;
const PER_PLAYER = 10, MAX_PINS = 1000;
const PUBLIC = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');
const FILE = path.join(DATA, 'pins.json');

// ---------- storage (a JSON file; swap for your main app's database) ----------
let pins = [];
try { pins = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (!Array.isArray(pins)) pins = []; } catch { pins = []; }
let saving = Promise.resolve();
function persist() {
  const body = JSON.stringify(pins);
  saving = saving.then(async () => {
    await fs.promises.mkdir(DATA, { recursive: true });
    const tmp = FILE + '.tmp';
    await fs.promises.writeFile(tmp, body);
    await fs.promises.rename(tmp, FILE);
  }).catch(e => console.error('save failed', e.message));
}
const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---------- location safety ----------
// Snap to the middle of a grid cell, plus a small fixed nudge so pins in one cell don't stack.
// The exact location is never stored.
function fuzz(lat, lng, meters, seed) {
  const dLat = meters / 111320;
  const dLng = meters / (111320 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  const h = crypto.createHash('sha256').update(seed).digest();
  const jx = (h[0] / 255 - 0.5) * 0.4, jy = (h[1] / 255 - 0.5) * 0.4;
  return {
    lat: +((Math.floor(lat / dLat) + 0.5 + jy) * dLat).toFixed(5),
    lng: +((Math.floor(lng / dLng) + 0.5 + jx) * dLng).toFixed(5),
  };
}

// ---------- text safety ----------
const BAD = /(https?:|www\.|@|\.com|\d{3}[\s.\-]?\d{3,4}|\b\d{1,5}\s+\w+\s+(st|street|ave|avenue|dr|drive|rd|road|blvd|way|ln|lane)\b)/i;
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const JPEG = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;

// ---------- rate limits ----------
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

// ---------- photo ID ----------
const ID_PROMPT = `You identify nature photos inside a nature app for children. Reply with ONLY one JSON object and no other text.
If the main subject is a real plant, tree, flower, fungus or non-human animal (insects, birds and pets count), reply:
{"ok":true,"kind":"plant" or "animal" or "fungus","name":"common name","sci":"scientific name or empty string","sure":"high" or "medium" or "low","protected":true if it is endangered, threatened or a species of special concern in California, otherwise false,"kid":"one fun true fact for a 10-year-old, under 25 words","adult":"one or two sentences on its ecology or conservation","help":["short way to help or respect it","another"],"group":"bird" or "mammal" or "reptile" or "amphibian" or "fish" or "insect" (use insect for insects, spiders, snails, worms and other small animals) or "plant" or "fungus","rarity":"common" or "uncommon" or "rare" or "legendary" (how often a person would see it around La Cañada Flintridge in the Los Angeles foothills; legendary means endangered or almost never seen there)}
Use the accepted scientific name.
If the photo shows a person, a toy, a drawing, a screen, food, an object, or nothing clear, reply exactly {"ok":false}. Never identify or describe people. If the photo is too blurry or dark to be sure, reply {"ok":false}.`;

async function identify(image, live, hint) {
  const data = image.slice(image.indexOf(',') + 1);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: live ? LIVE_MODEL : MODEL, max_tokens: 600,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
        { type: 'text', text: ID_PROMPT + (hint ? `\nA small on-phone model guessed "${hint}". It is often wrong: check the photo yourself.` : '') },
      ] }],
    }),
  });
  if (!r.ok) throw new Error('claude ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  let out; try { out = m ? JSON.parse(m[0]) : null; } catch { out = null; }
  if (!out || out.ok !== true || !out.name) return { ok: false };
  return {
    ok: true,
    kind: ['animal', 'fungus'].includes(out.kind) ? out.kind : 'plant',
    name: clean(out.name, 60), sci: clean(out.sci, 80),
    sure: out.sure === 'high' ? 'high' : 'low',
    protected: out.protected === true,
    kid: clean(out.kid, 240), adult: clean(out.adult, 500),
    group: ['bird','mammal','reptile','amphibian','fish','insect','plant','fungus'].includes(out.group) ? out.group : '',
    rarity: ['common','uncommon','rare','legendary'].includes(out.rarity) ? out.rarity : 'uncommon',
    help: (Array.isArray(out.help) ? out.help : []).slice(0, 3).map(h => clean(h, 160)).filter(Boolean),
  };
}

// ---------- http helpers ----------
function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too big'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('bad json'), { code: 400 })); } });
    req.on('error', reject);
  });
}
const ip = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
const publicPin = (p, meHash) => ({
  id: p.id, nick: p.nick, name: p.name, kind: p.kind, note: p.note, img: p.img, lat: p.lat, lng: p.lng,
  protected: p.protected, t: p.t, visibleAt: p.visibleAt, mine: p.owner === meHash, pending: p.visibleAt > Date.now(),
});

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'x-content-type-options': 'nosniff' });
    res.end(buf);
  });
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/identify' && req.method === 'POST') {
      if (!API_KEY) return send(res, 503, { error: 'Photo ID is not set up yet. A grown-up needs to add the Claude API key to the server.' });
      const b = await readJson(req, 3e6);
      const live = b.live === true;
      if (live ? limited('live:' + ip(req), 60, 600e3) : limited('id:' + ip(req), 20, 600e3))
        return send(res, 429, { error: live ? 'Live camera is resting for a minute. Take a photo instead.' : 'Too many photos right now. Wait a few minutes, then try again.' });
      if (typeof b.image !== 'string' || !JPEG.test(b.image)) return send(res, 400, { error: 'That photo could not be read. Try another one.' });
      const hint = typeof b.hint === 'string' ? b.hint.replace(/[^A-Za-z .()'-]/g, '').slice(0, 80) : '';
      return send(res, 200, await identify(b.image, live, hint));
    }

    if (p === '/api/pins' && req.method === 'GET') {
      const meHash = hash(url.searchParams.get('me') || '');
      const now = Date.now();
      const list = pins.filter(x => !x.hidden && (x.visibleAt <= now || x.owner === meHash)).map(x => publicPin(x, meHash));
      return send(res, 200, { pins: list });
    }

    if (p === '/api/pins' && req.method === 'POST') {
      if (limited('pin:' + ip(req), 10, 600e3)) return send(res, 429, { error: 'Too many pins right now. Wait a few minutes.' });
      const b = await readJson(req, 200e3);
      const me = clean(b.me, 64), note = clean(b.note, 90), name = clean(b.name, 60);
      const lat = +b.lat, lng = +b.lng;
      if (me.length < 16) return send(res, 400, { error: 'Reload the app and try again.' });
      if (!name) return send(res, 400, { error: 'Take a photo first.' });
      if (note.length < 3) return send(res, 400, { error: 'Write a little note first.' });
      if (BAD.test(note) || BAD.test(name)) return send(res, 400, { error: 'Keep notes about nature only. No links, phone numbers, emails or addresses.' });
      if (typeof b.img !== 'string' || b.img.length > 120000 || !JPEG.test(b.img)) return send(res, 400, { error: 'That photo is too big to pin. Try again.' });
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180) return send(res, 400, { error: 'That location did not work. Try choosing the spot on the map.' });
      const id = crypto.randomBytes(8).toString('hex');
      const prot = b.protected === true;
      const spot = fuzz(lat, lng, prot ? PROTECTED_CELL_M : CELL_M, id);
      const owner = hash(me), now = Date.now();
      const pin = {
        id, owner, nick: clean(b.nick, 40) || 'Explorer', name, kind: ['animal', 'fungus'].includes(b.kind) ? b.kind : 'plant',
        note, img: b.img, lat: spot.lat, lng: spot.lng, protected: prot, t: now, visibleAt: now + DELAY_MIN * 60e3, reports: [], hidden: false,
      };
      pins.push(pin);
      const mine = pins.filter(x => x.owner === owner);
      if (mine.length > PER_PLAYER) { const drop = new Set(mine.slice(0, mine.length - PER_PLAYER).map(x => x.id)); pins = pins.filter(x => !drop.has(x.id)); }
      if (pins.length > MAX_PINS) pins = pins.slice(pins.length - MAX_PINS);
      persist();
      return send(res, 201, { pin: publicPin(pin, owner) });
    }

    let m;
    if ((m = p.match(/^\/api\/pins\/([a-f0-9]{16})\/report$/)) && req.method === 'POST') {
      const b = await readJson(req, 2e3);
      const pin = pins.find(x => x.id === m[1]);
      if (pin) {
        const who = hash(clean(b.me, 64) || ip(req));
        if (!pin.reports.includes(who)) pin.reports.push(who);
        if (pin.reports.length >= REPORTS_TO_HIDE) pin.hidden = true;
        persist();
      }
      return send(res, 200, { ok: true });
    }

    if ((m = p.match(/^\/api\/pins\/([a-f0-9]{16})$/)) && req.method === 'DELETE') {
      const admin = ADMIN_KEY && url.searchParams.get('admin') === ADMIN_KEY;
      const meHash = hash(url.searchParams.get('me') || '');
      const pin = pins.find(x => x.id === m[1]);
      if (!pin) return send(res, 404, { error: 'Pin not found.' });
      if (!admin && pin.owner !== meHash) return send(res, 403, { error: 'You can only remove your own pins.' });
      pins = pins.filter(x => x.id !== pin.id); persist();
      return send(res, 200, { ok: true });
    }

    // Moderator view: /api/admin/pins?key=ADMIN_KEY  (newest first, includes reported and hidden)
    if (p === '/api/admin/pins' && req.method === 'GET') {
      if (!ADMIN_KEY || url.searchParams.get('key') !== ADMIN_KEY) return send(res, 403, { error: 'Wrong key.' });
      return send(res, 200, { pins: pins.slice().reverse().map(x => ({ ...publicPin(x, ''), reports: x.reports.length, hidden: x.hidden })) });
    }

    if (p.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, p);
  } catch (e) {
    if (e.code === 413) return send(res, 413, { error: 'That photo is too big. Try again.' });
    if (e.code === 400) return send(res, 400, { error: 'Something was wrong with that request.' });
    console.error(e);
    return send(res, 500, { error: 'Something went wrong. Try again.' });
  }
});

server.listen(PORT, () => console.log(`Habitat Trail photo map on http://localhost:${PORT}` + (API_KEY ? '' : '  (photo ID off: set ANTHROPIC_API_KEY)')));
