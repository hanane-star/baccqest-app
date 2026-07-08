const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 3002;
const MIME = {'.html':'text/html','.css':'text/css','.js':'application/javascript',
              '.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'};

// ══ CHARGILY PAY CONFIG ══
// 1. Register at https://pay.chargily.net
// 2. Copy your API key from the dashboard
// 3. Set it as the CHARGILY_KEY environment variable on your hosting provider
const CHARGILY_KEY  = process.env.CHARGILY_KEY  || '';
const CHARGILY_MODE = process.env.CHARGILY_MODE || 'test'; // 'test' or 'live'
const CHARGILY_BASE = CHARGILY_MODE === 'live'
  ? 'https://pay.chargily.net/api/v2'
  : 'https://pay.chargily.net/test/api/v2';

function chargilyRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(CHARGILY_BASE + endpoint);
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': 'Bearer ' + CHARGILY_KEY,
        'Content-Type': 'application/json',
        ...(payload ? {'Content-Length': Buffer.byteLength(payload)} : {})
      }
    };
    const req = https.request(opts, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch(e) { resolve({raw: buf}); }});
    });
    req.on('error', reject);
    if(payload) req.write(payload);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', d => buf += d);
    req.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); }});
    req.on('error', reject);
  });
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = req.url.split('?')[0];

  // ── POST /api/checkout — create Chargily checkout ──
  if (req.method === 'POST' && url === '/api/checkout') {
    const body = await readBody(req);
    if (!CHARGILY_KEY) {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: 'NO_KEY', message: 'Chargily API key not configured — set CHARGILY_KEY env variable'}));
      return;
    }
    try {
      const result = await chargilyRequest('POST', '/checkouts', {
        amount: Math.round((body.amount || 900) * 100),
        currency: 'dzd',
        payment_method: 'edahabia',
        success_url: body.successUrl || '/?pay=ok',
        failure_url:  body.failureUrl  || '/?pay=fail',
        description: body.description || 'funbac Premium',
        locale: 'ar',
        collect_shipping_address: false
      });
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(result));
    } catch(e) {
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: e.message}));
    }
    return;
  }

  // ── GET /api/checkout/verify?id=xxx — check payment status ──
  if (req.method === 'GET' && url === '/api/checkout/verify') {
    const id = new URL('http://x' + req.url).searchParams.get('id');
    if (!CHARGILY_KEY || !id) {
      res.writeHead(400, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: 'Missing key or id'}));
      return;
    }
    try {
      const result = await chargilyRequest('GET', '/checkouts/' + id, null);
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(result));
    } catch(e) {
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: e.message}));
    }
    return;
  }

  // ── Serve static files ──
  let p = path.join(ROOT, req.url.split('?')[0]);
  if (!p.startsWith(ROOT)) p = path.join(ROOT, 'baccquest-app.html');
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(ROOT, 'baccquest-app.html');
  const ext = path.extname(p);
  res.writeHead(200, {'Content-Type': MIME[ext] || 'text/plain'});
  fs.createReadStream(p).pipe(res);

}).listen(PORT, () => console.log('funbac server → http://localhost:' + PORT));
