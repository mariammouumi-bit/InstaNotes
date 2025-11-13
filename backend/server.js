// backend/server.js
// Express server met CORS en DISABLE_OPENAI fallback (extractive summarizer).
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// CORS (voor mobiele testing). In productie, stel origin specifiek in.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '1mb' }));

function stripBOM(s) {
  if (!s || typeof s !== 'string') return s;
  if (s.charCodeAt(0) === 0xFEFF) return s.slice(1);
  return s;
}

function summarizeExtractive(inputText, maxSentences = 3) {
  const text = inputText.replace(/\r\n/g, ' ').replace(/\n/g, ' ');
  const sentences = text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  if (sentences.length <= maxSentences) return sentences.join(' ');
  const stopwords = new Set(['de','het','een','en','van','ik','je','u','we','jij','dat','die','in','op','te','is','om','aan','voor','met','als','zijn','was','werd','bij','door','naar']);
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

app.post('/api/summarize', async (req, res) => {
  try {
    console.log('[summarize] incoming');
    let text = req.body?.text;
    if (typeof text === 'string') text = stripBOM(text).trim();
    if (!text) return res.status(400).json({ error: 'Missing text' });

    if (process.env.DISABLE_OPENAI === '1') {
      console.log('[summarize] using extractive fallback');
      const extractive = summarizeExtractive(text, 3);
      return res.status(200).json({ summary: extractive, source: 'extractive' });
    }

    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_KEY) return res.status(500).json({ error: 'OpenAI key missing' });

    const payload = {
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Vat de tekst kort samen in Nederlandse bullets.' },
        { role: 'user', content: text }
      ],
      max_tokens: 300,
      temperature: 0.2
    };

    // Node 18+ heeft global fetch
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify(payload)
    });

    const status = openaiRes.status;
    const json = await openaiRes.json().catch(()=>null);
    console.log('[summarize] OpenAI status', status);
    if (status >= 400) return res.status(500).json({ error: 'OpenAI error', details: json });

    let summary = '';
    if (json?.choices && json.choices[0]?.message?.content) summary = json.choices[0].message.content;
    else if (json?.choices && json.choices[0]?.text) summary = json.choices[0].text;

    return res.status(200).json({ summary });
  } catch (err) {
    console.error('[summarize] unexpected', err);
    return res.status(500).json({ error: String(err) });
  }
});

app.get('/', (req, res) => res.send('InstaNotes backend running'));
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));