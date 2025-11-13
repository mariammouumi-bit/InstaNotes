// backend/server.js
// Express backend with Supabase auth, Redis rate limiting (optional), OpenAI proxy, Stripe checkout & webhook
// Paste this file to backend/server.js and install dependencies as instructed.

const express = require('express');
const bodyParser = require('body-parser'); // we will use raw for webhook route
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');
const Redis = require('ioredis');

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const REDIS_URL = process.env.REDIS_URL || null;
const DISABLE_OPENAI = String(process.env.DISABLE_OPENAI || '').trim() === '1';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('Warning: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing. Some features will fail.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;

let redis = null;
if (REDIS_URL) {
  redis = new Redis(REDIS_URL);
  redis.on('error', (e) => console.error('Redis error', e));
} else {
  console.log('No REDIS_URL provided — using in-memory rate limiter (not for production).');
}

// simple in-memory fallback rate limiter map
const rateMap = new Map();

function userRateLimiter({ limit = 60, windowSec = 60 } = {}) {
  return async (req, res, next) => {
    try {
      const userId = req.user?.id || req.ip || 'anon';
      const key = `rl:${userId}`;
      const now = Math.floor(Date.now() / 1000);
      if (redis) {
        const ttl = windowSec;
        const added = await redis.incr(key);
        if (added === 1) {
          await redis.expire(key, ttl);
        }
        const count = added;
        if (count > limit) return res.status(429).json({ error: 'Too many requests' });
      } else {
        // in-memory
        const entry = rateMap.get(key) || { start: now, count: 0 };
        if (now - entry.start >= windowSec) {
          entry.start = now;
          entry.count = 1;
        } else {
          entry.count++;
        }
        rateMap.set(key, entry);
        if (entry.count > limit) return res.status(429).json({ error: 'Too many requests' });
      }
      next();
    } catch (err) {
      console.error('rateLimiter error', err);
      next();
    }
  };
}

// Middleware: require Auth using Supabase access token (JWT)
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Missing Authorization token' });

    // Validate token using Supabase admin client
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) {
      console.warn('Invalid token', error);
      return res.status(401).json({ error: 'Invalid token' });
    }
    req.user = { id: data.user.id, email: data.user.email };
    next();
  } catch (err) {
    console.error('requireAuth error', err);
    return res.status(500).json({ error: 'Auth validation failed' });
  }
}

const app = express();

// We need raw body for Stripe webhook verification. Use bodyParser for others.
app.use((req, res, next) => {
  // For webhook path, skip JSON parsing here
  if (req.originalUrl === '/api/stripe/webhook') return next();
  bodyParser.json({ limit: '200kb' })(req, res, next);
});

// Basic CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // tighten in production
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => res.send('InstaNotes backend running'));

/*
  Protected summarize endpoint
  - Requires Authorization: Bearer <supabase access token>
  - Uses OpenAI if available; otherwise fallback to simple extractive summarizer
  - Logs summary to Supabase table "summaries" (if table exists)
*/
app.post('/api/summarize', requireAuth, userRateLimiter({ limit: 60, windowSec: 60 }), async (req, res) => {
  try {
    let { text, model } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Missing text' });
    model = model || process.env.OPENAI_MODEL || 'gpt-3.5-turbo';

    // If OpenAI disabled or no key – do extractive fallback
    if (DISABLE_OPENAI || !OPENAI_KEY) {
      console.log('[summarize] extractive fallback used');
      const extractive = summarizeExtractive(text, 3);
      // save to DB (best-effort)
      await saveSummaryToDB(req.user.id, text, extractive, 'extractive', null);
      return res.json({ summary: extractive, source: 'extractive' });
    }

    // Call OpenAI Chat Completions
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

    // Estimate cost (very rough) and save usage info if available
    const usage = json?.usage || null;
    let costEstimate = null;
    if (usage && usage.total_tokens) {
      // crude estimate — refine with actual prices later
      costEstimate = usage.total_tokens * 0.000002; // placeholder
    }

    // save to DB
    await saveSummaryToDB(req.user.id, text, summary, 'openai', costEstimate);

    return res.json({ summary, source: 'openai', usage });
  } catch (err) {
    console.error('/api/summarize unexpected', err);
    return res.status(500).json({ error: String(err) });
  }
});

// small extractive summarizer (same as earlier)
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

// Save summary to Supabase table "summaries" (best-effort)
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

/*
  Stripe: create checkout session
  Body: { priceId, successUrl, cancelUrl }
  Requires STRIPE_SECRET_KEY
*/
app.post('/api/create-checkout-session', requireAuth, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
    const { priceId, successUrl, cancelUrl } = req.body || {};
    if (!priceId || !successUrl) return res.status(400).json({ error: 'Missing priceId or successUrl' });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { user_id: req.user.id }
    });

    return res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('create-checkout-session error', err);
    return res.status(500).json({ error: String(err) });
  }
});

// Stripe webhook endpoint (raw body required)
app.post('/api/stripe/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe) return res.status(200).send('stripe not configured');
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  (async () => {
    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = session.metadata?.user_id;
        // Here you might update your DB to grant quota/credits/subscription record
        console.log('Checkout completed for user', userId);
        // Example: insert a record to subscriptions table or update user metadata via Supabase
      }
      // handle other event types...
    } catch (err) {
      console.error('webhook handler error', err);
    }
  })();

  res.json({ received: true });
});

// Start server
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));