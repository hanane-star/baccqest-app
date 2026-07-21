const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 3002;
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://baccquest-app.onrender.com';
const MIME = {'.html':'text/html','.css':'text/css','.js':'application/javascript',
              '.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml',
              '.json':'application/json'};

// ══ AI COMPANION (رفيق) — server-side proxy ══
// Set ANTHROPIC_API_KEY as an environment variable on your host (e.g. Render → Environment)
// so every student gets real AI without needing their own key.
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

// ══ TEACHER ACCESS CODE — never ship the real code to the client ══
// Set TEACHER_ACCESS_CODE as an env var on your host. Falls back to a dev default locally.
const TEACHER_ACCESS_CODE = (process.env.TEACHER_ACCESS_CODE || 'BACC-TCHR-2891').trim().toUpperCase();

// ══ CHARGILY PAY — real card payments (CIB/Edahabia) ══
// Set CHARGILY_SECRET_KEY (test_sk_... or live_sk_...) as an env var. Never ship it to the client.
const CHARGILY_SECRET_KEY = process.env.CHARGILY_SECRET_KEY || '';
// Server-side price list — the source of truth. Never trust a price sent by the client.
const PLAN_PRICES = { plus: 900, pro: 7200 };

// ══ FIREBASE ADMIN — lets the payment webhook upgrade a student's subscription server-side ══
// Set FIREBASE_SERVICE_ACCOUNT_JSON to the full JSON content of a Firebase service account key.
let _admin = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
    _admin = admin;
  }
} catch (e) { console.error('firebase-admin init failed:', e.message); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', d => buf += d);
    req.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); }});
    req.on('error', reject);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', d => buf += d);
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

function chargilyRequest(method, apiPath, payload) {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : '';
    const req = https.request({
      hostname: 'api.chargily.com',
      path: apiPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + CHARGILY_SECRET_KEY,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => { try { resolve({status: res.statusCode, data: JSON.parse(buf)}); } catch(e) { resolve({status: res.statusCode, data: {raw: buf}}); }});
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
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

  // ── POST /api/verify-teacher-code — checks the teacher access code server-side only ──
  if (req.method === 'POST' && url === '/api/verify-teacher-code') {
    try {
      const body = await readBody(req);
      const code = (body.code || '').trim().toUpperCase();
      const codeBuf = Buffer.from(code, 'utf8');
      const realBuf = Buffer.from(TEACHER_ACCESS_CODE, 'utf8');
      const valid = codeBuf.length === realBuf.length && crypto.timingSafeEqual(codeBuf, realBuf);
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ valid }));
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

  // ── POST /api/create-checkout — start a real Chargily Pay checkout (CIB/Edahabia) ──
  if (req.method === 'POST' && url === '/api/create-checkout') {
    if (!CHARGILY_SECRET_KEY) {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: 'NO_KEY', message: 'CHARGILY_SECRET_KEY not configured on the server'}));
      return;
    }
    try {
      const body = await readBody(req);
      const { planId, email } = body;
      // Price is owner-controlled: read the live value from Firestore settings/pricing first.
      // Falls back to the hardcoded PLAN_PRICES only if Firebase Admin isn't configured or the doc is missing.
      let amount = PLAN_PRICES[planId];
      if (_admin) {
        try {
          const doc = await _admin.firestore().collection('settings').doc('pricing').get();
          if (doc.exists && typeof doc.data()[planId] === 'number') amount = doc.data()[planId];
        } catch (e) { console.error('pricing lookup failed, using fallback PLAN_PRICES:', e.message); }
      }
      if (!amount || !email) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: 'invalid planId or email'}));
        return;
      }
      const result = await chargilyRequest('POST', '/v2/checkouts', {
        amount,
        currency: 'dzd',
        locale: 'ar',
        success_url: APP_BASE_URL + '/?pay=success',
        failure_url: APP_BASE_URL + '/?pay=failed',
        webhook_endpoint: APP_BASE_URL + '/api/chargily-webhook',
        description: 'اشتراك funbac — خطة ' + planId,
        metadata: { email, plan: planId }
      });
      if (result.status >= 200 && result.status < 300 && result.data.checkout_url) {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({checkout_url: result.data.checkout_url}));
      } else {
        res.writeHead(502, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: 'chargily_error', details: result.data}));
      }
    } catch (e) {
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: e.message}));
    }
    return;
  }

  // ── POST /api/chargily-webhook — Chargily notifies us here when a checkout is paid ──
  if (req.method === 'POST' && url === '/api/chargily-webhook') {
    try {
      const raw = await readRawBody(req);
      const signature = req.headers['signature'] || '';
      const expected = crypto.createHmac('sha256', CHARGILY_SECRET_KEY).update(raw).digest('hex');
      const sigBuf = Buffer.from(signature, 'utf8');
      const expBuf = Buffer.from(expected, 'utf8');
      const valid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
      if (!valid) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: 'invalid_signature'}));
        return;
      }
      const event = JSON.parse(raw);
      if (event.type === 'checkout.paid') {
        const email = event.data && event.data.metadata && event.data.metadata.email;
        const plan = event.data && event.data.metadata && event.data.metadata.plan;
        if (email && plan && _admin) {
          await _admin.firestore().collection('students').doc(email).set({ sub: plan }, { merge: true });
        } else if (email && plan) {
          console.error('Chargily webhook: payment confirmed for', email, plan, 'but FIREBASE_SERVICE_ACCOUNT_JSON is not configured — subscription NOT upgraded.');
        }
      }
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({received: true}));
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
