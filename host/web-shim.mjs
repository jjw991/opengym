/* openGym web shim — the Windows stand-in for web/nginx.conf, plus a PIN gate.
 *
 * Serves frontend/dist and media/{img,gif}, proxies /api/* to the API, falls back to
 * index.html for the SPA, all on one origin (passkeys require it). Node stdlib only.
 *
 * PIN gate (optional, ACCESS_PIN): light access control in front of everything, not real
 * security — passkeys + INVITE_ONLY remain the login. Gated responses are 401 on purpose:
 * the service worker only caches res.ok, so the PIN page can never be cached as the app.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.WEB_PORT || 4200);
const API = new URL(process.env.API_TARGET || 'http://127.0.0.1:4201');
const DIST = path.join(ROOT, 'frontend', 'dist');
const MEDIA = path.join(ROOT, 'media');
const SECURE = /^https:/i.test(process.env.ORIGIN || '') ? ' Secure;' : '';

/* ---------- PIN gate config ---------- */
const PIN = (process.env.ACCESS_PIN || '').trim();
const PIN_DAYS = 180;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const COOKIE = 'og_pin';
// Paths that stay reachable without the PIN, so "Add to Home Screen" can read the manifest/icons.
const OPEN = new Set(['/manifest.json', '/icon-180.png', '/icon-512.png', '/favicon.ico', '/__health']);

// The HMAC key is ACCESS_PIN_SECRET, or else the API's own data/secret. Resolved lazily: under
// PM2 both apps start together and the API may not have written data/secret yet.
let token = '';
function pinToken() {
  if (token) return token;
  let secret = process.env.ACCESS_PIN_SECRET;
  if (!secret) {
    try { secret = fs.readFileSync(path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'secret'), 'utf8').trim(); }
    catch { return ''; } // not there yet: stay locked until it is
  }
  // Cookie value is bound to the PIN: changing ACCESS_PIN re-prompts every device.
  return (token = crypto.createHmac('sha256', secret).update('pin:' + PIN).digest('hex'));
}

const fails = new Map(); // ip -> { n, until }

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';')
  .map(s => s.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const clientIp = req => req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?';
const unlocked = req => !PIN || (!!pinToken() && same(cookies(req)[COOKIE] || '', pinToken()));

function pinPage(res, msg = '') {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0c0e12"><link rel="manifest" href="manifest.json">
<link rel="apple-touch-icon" href="icon-180.png"><title>openGym</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#0c0e12;color:#e7e9ee;
    font:16px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  form{width:min(320px,calc(100% - 32px));display:grid;gap:14px;text-align:center}
  img{width:72px;height:72px;border-radius:18px;margin:0 auto}
  h1{font-size:20px;margin:0}
  input{font-size:28px;letter-spacing:.4em;text-align:center;padding:14px;border-radius:14px;
    border:1px solid #2a2f3a;background:#151922;color:inherit;outline:none}
  input:focus{border-color:#a3e635}
  button{font-size:17px;font-weight:600;padding:14px;border:0;border-radius:14px;background:#a3e635;color:#0c0e12}
  p{margin:0;min-height:1.4em;color:#f87171;font-size:14px}
</style></head><body>
<form method="post" action="__pin">
  <img src="icon-180.png" alt=""><h1>Enter PIN</h1>
  <input name="pin" type="password" inputmode="numeric" pattern="[0-9]*" autocomplete="current-password"
    autofocus required aria-label="PIN">
  <button type="submit">Unlock</button><p role="alert">${msg}</p>
</form></body></html>`;
  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function handlePin(req, res) {
  const ip = clientIp(req);
  const f = fails.get(ip);
  if (f && f.until > Date.now()) {
    return pinPage(res, `Too many attempts. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} min.`);
  }
  let body = '';
  req.on('data', d => { body += d; if (body.length > 1024) req.destroy(); });
  req.on('end', () => {
    const pin = new URLSearchParams(body).get('pin') || '';
    if (same(pin, PIN)) {
      if (!pinToken()) return pinPage(res, 'Server is still starting. Try again in a moment.');
      fails.delete(ip);
      res.writeHead(303, {
        'Set-Cookie': `${COOKIE}=${pinToken()}; Path=/; HttpOnly;${SECURE} SameSite=Lax; Max-Age=${PIN_DAYS * 86400}`,
        'Location': './', 'Cache-Control': 'no-store'
      });
      return res.end();
    }
    const expired = f && f.until && f.until <= Date.now(); // a served lockout starts the count over
    const n = (f && !expired ? f.n : 0) + 1;
    fails.set(ip, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
    console.warn(`[pin] wrong PIN from ${ip} (${n}/${MAX_FAILS})`);
    pinPage(res, n >= MAX_FAILS ? 'Too many attempts. Try again in 15 min.' : 'Wrong PIN.');
  });
}

/* ---------- static ---------- */
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'
};
const SHELL = /\.(js|mjs|css|json|html)$/i;
const LONG = /\.(png|jpe?g|gif|ico|svg|woff2?|webp|avif)$/i;
const GZIP = /\.(js|mjs|css|json|html|svg|txt)$/i;

// Resolve under a base dir, refusing anything that escapes it.
function within(base, rel) {
  const p = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  return p === base || p.startsWith(base + path.sep) ? p : null;
}

function sendFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound(req, res);
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream' };
    if (SHELL.test(ext)) headers['Cache-Control'] = 'no-cache, must-revalidate';
    else if (LONG.test(ext)) headers['Cache-Control'] = 'public, max-age=2592000, immutable';
    const stream = fs.createReadStream(file);
    if (GZIP.test(ext) && st.size >= 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
      if (req.method === 'HEAD') return res.end();
      stream.pipe(zlib.createGzip()).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': st.size, 'Vary': 'Accept-Encoding' });
      if (req.method === 'HEAD') return res.end();
      stream.pipe(res);
    }
  });
}

function notFound(req, res) {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

function serveStatic(req, res, pathname) {
  // Media: /img/* and /gif/* from media/, with no SPA fallback (a missing GIF is a 404).
  const m = pathname.match(/^\/(img|gif)\/(.+)$/);
  if (m) {
    const file = within(path.join(MEDIA, m[1]), m[2]);
    return file ? sendFile(req, res, file) : notFound(req, res);
  }
  const file = within(DIST, pathname);
  if (!file) return notFound(req, res);
  fs.stat(file, (err, st) => {
    if (!err && st.isFile()) return sendFile(req, res, file);
    if (!err && st.isDirectory() && fs.existsSync(path.join(file, 'index.html'))) return sendFile(req, res, path.join(file, 'index.html'));
    sendFile(req, res, path.join(DIST, 'index.html')); // SPA fallback
  });
}

/* ---------- /api proxy ---------- */
function proxy(req, res) {
  const headers = { ...req.headers };
  headers['x-real-ip'] = clientIp(req);
  headers['x-forwarded-for'] = [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', ');
  headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || (SECURE ? 'https' : 'http');
  const up = http.request({ host: API.hostname, port: API.port, method: req.method, path: req.url, headers }, r => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end('{"error":"api unavailable"}');
  });
  req.pipe(up);
}

/* ---------- server ---------- */
http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { res.writeHead(400); return res.end(); }

  if (pathname === '/__health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end('{"ok":true}');
  }
  if (PIN && pathname === '/__pin' && req.method === 'POST') return handlePin(req, res);
  if (!unlocked(req) && !OPEN.has(pathname)) {
    if (pathname.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end('{"error":"pin required"}');
    }
    return pinPage(res);
  }
  if (pathname.startsWith('/api/')) return proxy(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, pathname);
}).listen(PORT, () => console.log(`opengym web shim on :${PORT} → api ${API.origin}${PIN ? ' (PIN gate on)' : ''}`));
