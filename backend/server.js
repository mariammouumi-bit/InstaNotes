// backend/server.js
// Express backend without Stripe
// - Supabase auth (requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars)
// - Optional Redis rate limiter (use REDIS_URL env var)
// - /api/summarize (protected) uses OpenAI if OPENAI_API_KEY is set, otherwise extractive fallback
// Install deps in backend: npm install express body-parser @supabase/supabase-js ioredis

const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const REDIS_URL = process.env.REDIS_URL || null;
const DISABLE_OPENAI = String(process.env.DISABLE_OPENAI || '').trim() === '1';

// Initialize Supabase admin client (service role)
let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
} else {
  console.warn('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set. Supabase DB logging / auth may fail.');
}

// Optional Redis for rate limiting
let Redis = null;
let redis = null;
try {
  if (REDIS_URL) {
    Redis = require('ioredis');
    redis = new Redis(REDIS_URL);
    redis.on('error', (e) => console.error('Redis error', e));
    console.log('Connected to Redis for rate limiting.');
  } else {
    console.log('No REDIS_URL provided — using in-memory rate limiter (not for production).');
  }
} catch (err) {
  console.warn('ioredis not installed or failed to initialize; continuing without Redis:', err.message);
  redis = null;
}

const app = express();

// Use JSON parser
app.use((req, res, next) => {
  bodyParser.json({ limit: '400kb' })(req, res, next);
});

// Simple CORS for testing (tighten for production)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // restrict in prod
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => res.send('InstaNotes backend running'));

/* ---------------------------
   Rate limiter (per-user)
----------------------------*/
const inMemoryRate = new Map();
function userRateLimiter({ limit = 60, windowSec = 60 } = {}) {
  return async (req, res, next) => {
    try {
      const userId = (req.user && req.user.id) ? req.user.id : (req.ip || 'anon');
      const key = `rl:${userId}`;
      const now = Math.floor(Date.now() / 1000);

      if (redis) {
        const added = await redis.incr(key);
        if (added === 1) await redis.expire(key, windowSec);
        if (added > limit) return res.status(429).json({ error: 'Too many requests' });
      } else {
        const entry = inMemoryRate.get(key) || { start: now, count: 0 };
        if (now - entry.start >= windowSec) {
          entry.start = now;
          entry.count = 1;
        } else {
          entry.count++;
        }
        inMemoryRate.set(key, entry);
        if (entry.count > limit) return res.status(429).json({ error: 'Too many requests' });
      }
      next();
    } catch (err) {
      console.error('rateLimiter error', err);
      next();
    }
  };
}

/* ---------------------------
   Auth middleware using Supabase JWT
   - Expects Authorization: Bearer <access_token>
----------------------------*/
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Missing Authorization token' });

    if (!supabase) {
      console.warn('Supabase client not initialized; rejecting auth.');
      return res.status(500).json({ error: 'Server misconfiguration: Supabase not configured' });
    }

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) {
      console.warn('Invalid Supabase token', error);
      return res.status(401).json({ error: 'Invalid token' });
    }

    req.user = { id: data.user.id, email: data.user.email };
    next();
  } catch (err) {
    console.error('requireAuth error', err);
    return res.status(500).json({ error: 'Auth validation failed' });
  }
}

/* ---------------------------
   Summarize endpoint (protected)
----------------------------*/
app.post('/api/summarize', requireAuth, userRateLimiter({ limit: 60, windowSec: 60 }), async (req, res) => {
  try {
    let { text, model } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Missing text' });
    model = model || process.env.OPENAI_MODEL || 'gpt-3.5-turbo';

    if (DISABLE_OPENAI || !OPENAI_KEY) {
      console.log('[summarize] using extractive fallback');
      const extractive = summarizeExtractive(text, 3);
      await saveSummaryToDB(req.user.id, text, extractive, 'extractive', null);
      return res.json({ summary: extractive, source: 'extractive' });
    }

    const payload = {
      model,
      messages: [
        { role: 'system', content: 'Vat de tekst kort samen in Nederlandse bullets.' },
        { role: 'user', content: text }
      ],
      max_tokens: 300,
      temperature: 0.2
    };

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify(payload)
    });

    const status = openaiRes.status;
    const json = await openaiRes.json().catch(() => null);
    if (status >= 400) {
      console.error('[summarize] OpenAI error', status, json);
      return res.status(500).json({ error: 'OpenAI error', details: json });
    }

    let summary = '';
    if (json?.choices && json.choices[0]?.message?.content) summary = json.choices[0].message.content;
    else if (json?.choices && json.choices[0]?.text) summary = json.choices[0].text;

    const usage = json?.usage || null;
    let costEstimate = null;
    if (usage && usage.total_tokens) {
      costEstimate = usage.total_tokens * 0.000002;
    }

    await saveSummaryToDB(req.user.id, text, summary, 'openai', costEstimate);
    return res.json({ summary, source: 'openai', usage });
  } catch (err) {
    console.error('/api/summarize unexpected', err);
    return res.status(500).json({ error: String(err) });
  }
});

/* ---------------------------
   Simple extractive summarizer
----------------------------*/
function summarizeExtractive(inputText, maxSentences = 3) {
  const text = (inputText || '').replace(/\r\n/g, ' ').replace(/\n/g, ' ');
  const sentences = text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  if (sentences.length <= maxSentences) return sentences.join(' ');
  const stopwords = new Set(['de','het','een','en','van','ik','je','u','we','dat','die','in','op','te','is','om','aan','voor','met','als','zijn','was','werd','bij','door','naar']);
  const wordFreq = Object.create(null);
  const words = text.toLowerCase().replace(/[^a-z0-9\u00C0-\u017F\s]/g, ' ').split(/\s+/).filter(Boolean);
  for (const w of words) if (!stopwords.has(w)) wordFreq[w] = (wordFreq[w] || 0) + 1;
  const sentenceScores = sentences.map(s => {
    const ws = s.toLowerCase().replace(/[^a-z0-9\u00C0-\u017F\s]/g, ' ').split(/\s+/).filter(Boolean);
    let score = 0;
    for (const w of ws) if (wordFreq[w]) score += wordFreq[w];
    return { sentence: s, score };
  });
  const top = sentenceScores.slice().sort((a,b)=>b.score-a.score).slice(0, maxSentences).map(x=>x.sentence);
  const ordered = sentences.filter(s => top.includes(s));
  return ordered.slice(0, maxSentences).join(' ');
}

/* ---------------------------
   Save summary to Supabase 'summaries' table (best-effort)
----------------------------*/
async function saveSummaryToDB(userId, text, summary, source, costEstimate) {
  try {
    if (!supabase) return;
    const payload = {
      id: Date.now().toString(),
      user_id: userId || null,
      text: text || '',
      summary: summary || '',
      source: source || null,
      cost_estimate: costEstimate || null
    };
    const { error } = await supabase.from('summaries').insert(payload);
    if (error) console.warn('Failed to insert summary to Supabase', error);
  } catch (err) {
    console.error('saveSummaryToDB error', err);
  }
}

/* ---------------------------
   Start server
----------------------------*/
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});