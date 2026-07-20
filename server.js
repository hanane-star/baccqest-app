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

  // ── POST /api/verify-essay — AI-graded philosophy/text-analysis answers ──
  if (req.method === 'POST' && url === '/api/verify-essay') {
    if (!ANTHROPIC_KEY) {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: 'NO_KEY', message: 'ANTHROPIC_API_KEY not configured on the server'}));
      return;
    }
    try {
      const body = await readBody(req);
      const { question, studentAnswer, modelAnswer } = body;
      const prompt = `أنت أستاذ فلسفة يصحّح إجابة تلميذ في البكالوريا الجزائرية.
السؤال: "${question}"
العناصر الأساسية المتوقعة في الإجابة النموذجية: "${modelAnswer}"
إجابة التلميذ: "${studentAnswer}"

قيّم إجابة التلميذ بناءً على مدى تغطيتها للأفكار الجوهرية، وليس تطابقها الحرفي مع النموذج. كن متفهماً لصياغات مختلفة تعبّر عن نفس الفكرة.
أجب بصيغة JSON فقط بدون أي نص إضافي:
{"score": رقم من 0 إلى 100, "correct": true إذا كان score>=50 وإلا false, "feedback": "تعليق قصير بالعربية يوضح نقاط القوة والنقص في إجابة التلميذ"}`;
      const result = await anthropicRequest({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      });
      let verdict = { correct: false, score: 0, feedback: 'تعذّر تحليل الإجابة، حاول مجدداً' };
      try {
        const raw = result.data?.content?.[0]?.text || '';
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) verdict = JSON.parse(match[0]);
      } catch (e) {}
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(verdict));
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
