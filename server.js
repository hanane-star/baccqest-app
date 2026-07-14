const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 3002;
const MIME = {'.html':'text/html','.css':'text/css','.js':'application/javascript',
              '.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'};

// ══ AI COMPANION (رفيق) — server-side proxy ══
// Set ANTHROPIC_API_KEY as an environment variable on your host (e.g. Render → Environment)
// so every student gets real AI without needing their own key.
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', d => buf += d);
    req.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); }});
    req.on('error', reject);
  });
}

function anthropicRequest(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => { try { resolve({status: res.statusCode, data: JSON.parse(buf)}); } catch(e) { resolve({status: res.statusCode, data: {raw: buf}}); }});
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = req.url.split('?')[0];

  // ── POST /api/ai-chat — رفيق AI proxy ──
  if (req.method === 'POST' && url === '/api/ai-chat') {
    if (!ANTHROPIC_KEY) {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: 'NO_KEY', message: 'ANTHROPIC_API_KEY not configured on the server'}));
      return;
    }
    try {
      const body = await readBody(req);
      const result = await anthropicRequest({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 350,
        system: body.system || '',
        messages: body.messages || []
      });
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(result.data));
    } catch (e) {
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
