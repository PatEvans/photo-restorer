/* Simple Express proxy + static server for photo restorer */
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import cookieParser from 'cookie-parser';
import Stripe from 'stripe';
import fs from 'fs/promises';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = (process.env.GEMINI_MODEL || 'gemini-2.5-flash-image-preview').trim();
// Restrict models to a safe allowlist
const ALLOWED_MODELS = (process.env.GEMINI_ALLOWED_MODELS
  ? process.env.GEMINI_ALLOWED_MODELS.split(',').map(s => s.trim()).filter(Boolean)
  : [
      'gemini-2.5-flash-image-preview',
      'gemini-2.5-flash',
      'gemini-2.0-flash-lite'
    ]);
if (!ALLOWED_MODELS.includes(MODEL)) ALLOWED_MODELS.push(MODEL);

const API_KEY = process.env.GEMINI_API_KEY;
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const COOKIE_SECRET = process.env.COOKIE_SECRET;
const SITE_ORIGIN = (process.env.SITE_ORIGIN || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
let ACTUAL_PORT = Number(PORT) || 0;
const ALLOWED_ORIGINS = new Set([
  SITE_ORIGIN,
  SITE_ORIGIN.replace('127.0.0.1', 'localhost'),
  ...(process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
    : [])
]);
const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET) : null;
const processedSessions = new Set();

// Very simple in-memory user store (replace with DB in production)
const users = new Map(); // uid -> { credits: number }

app.use(express.json({ limit: '25mb' }));
app.use(cookieParser(COOKIE_SECRET));

// CORS: reflect only allowed origins and allow credentials (API only)
function corsMiddleware(req, res, next) {
  res.setHeader('Vary', 'Origin');
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}
app.use('/api', corsMiddleware);

// Serve static frontend (explicit routes only; do not expose repo root)
const pubDir = __dirname;
app.get('/', async (req, res) => {
  res.sendFile(path.join(pubDir, 'index.html'));
});
app.get('/script.js', async (req, res) => {
  res.sendFile(path.join(pubDir, 'script.js'));
});
app.get('/styles.css', async (req, res) => {
  res.sendFile(path.join(pubDir, 'styles.css'));
});
app.use('/examples', express.static(path.join(pubDir, 'examples'), { dotfiles: 'ignore', fallthrough: true }));

// Resolve site origin robustly for redirects (e.g., Stripe)
function getSiteOrigin(req) {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.has(origin) || /^(https?:\/\/)(localhost|127\.0\.0\.1):\d+$/.test(origin))) {
    return origin.replace(/\/$/, '');
  }
  const host = req.headers.host;
  if (host) {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    return `${proto}://${host}`.replace(/\/$/, '');
  }
  return `http://127.0.0.1:${ACTUAL_PORT || 3000}`;
}

// Assign anonymous uid cookie if missing
app.use((req, res, next) => {
  let uid = req.cookies.uid;
  if (!uid) {
    uid = (global.crypto?.randomUUID?.() || Math.random().toString(36).slice(2));
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('uid', uid, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'Lax',
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });
    req.uid = uid;
  } else {
    req.uid = uid;
  }
  next();
});

function getUser(req) {
  const uid = req.uid || req.cookies.uid;
  if (!users.has(uid)) users.set(uid, { credits: 0 });
  return { uid, data: users.get(uid) };
}

// Simple in-memory rate limiter (fixed window, by IP+path)
const rateState = new Map();
function rateLimit({ windowMs, limit, key = (req) => `${req.ip}:${req.path}` }) {
  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    let entry = rateState.get(k);
    if (!entry || now > entry.reset) {
      entry = { count: 0, reset: now + windowMs };
      rateState.set(k, entry);
    }
    entry.count++;
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - entry.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.floor(entry.reset / 1000)));
    if (entry.count > limit) return res.status(429).json({ error: 'rate_limited' });
    next();
  };
}

// Simple health check
app.get('/api/health', (req, res) => {
  const { uid, data } = getUser(req);
  const stripeTestMode = !!(STRIPE_SECRET && STRIPE_SECRET.startsWith('sk_test'));
  const freeUsed = (req.signedCookies && req.signedCookies.free_used === '1') || req.cookies.free_used === '1';
  const freeRemaining = freeUsed ? 0 : 1;
  res.json({ ok: true, modelDefault: MODEL, hasKey: Boolean(API_KEY), uid, usage: data, freeRemaining, stripeTestMode });
});

// Get current user usage/credits
app.get('/api/me', (req, res) => {
  const { uid, data } = getUser(req);
  // Free restore is tracked via signed cookie; 1 if not used
  const freeUsed = (req.signedCookies && req.signedCookies.free_used === '1') || req.cookies.free_used === '1';
  const freeRemaining = freeUsed ? 0 : 1;
  res.json({ uid, credits: data.credits, freeRemaining });
});

// Stripe: create a Checkout Session for credit packs (500/1000/2000)
app.post('/api/buy-credits', rateLimit({ windowMs: 10 * 60 * 1000, limit: 20 }), async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
    const { uid } = getUser(req);
    const { credits } = req.body || {};
    const allowed = [500, 1000, 2000];
    const pack = allowed.includes(Number(credits)) ? Number(credits) : null;
    if (!pack) return res.status(400).json({ error: 'Invalid credits pack' });

    // Pricing: 100 credits = $0.50 (to keep ~$0.50/image)
    // => 1 credit = $0.005; amounts below are in cents
    const amountCents = Math.round(pack * 0.5); // 500->$2.50, 1000->$5.00, 2000->$10.00
    const base = getSiteOrigin(req);
    const successUrl = `${base}/?p=success&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${base}/?p=cancel`;
    const testPrefix = STRIPE_SECRET && STRIPE_SECRET.startsWith('sk_test') ? '[TEST] ' : '';
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      client_reference_id: uid,
      metadata: { credits: String(pack) },
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: `${testPrefix}photo restorer Credits (${pack})` },
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Confirm a completed purchase and add credits
app.post('/api/confirm', rateLimit({ windowMs: 10 * 60 * 1000, limit: 60 }), async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
    const { session_id } = req.body || {};
    if (!session_id) return res.status(400).json({ error: 'Missing session_id' });
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status === 'paid') {
      const uid = session.client_reference_id;
      // Ensure caller is the purchaser
      if (!uid || uid !== (req.uid || req.cookies.uid)) {
        return res.status(403).json({ error: 'forbidden' });
      }
      if (uid) {
        if (!users.has(uid)) users.set(uid, { credits: 0 });
        if (!processedSessions.has(session_id)) {
          const add = parseInt(session?.metadata?.credits || '0', 10) || 0;
          users.get(uid).credits += add;
          processedSessions.add(session_id);
          return res.json({ ok: true, uid, credited: true });
        }
        return res.json({ ok: true, uid, credited: false });
      }
      return res.json({ ok: true, uid, credited: false });
    }
    res.status(400).json({ error: 'Payment not completed' });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Self-test endpoint removed to prevent free key usage

// Analyze proxy removed to prevent open relay of API key

// Generate a restored image directly from Gemini 2.5 Flash
app.post('/api/restore', rateLimit({ windowMs: 10 * 60 * 1000, limit: 30 }), async (req, res) => {
  try {
    const { prompt, mimeType, data, model: modelOverride } = req.body || {};
    if (!prompt || !mimeType || !data) {
      return res.status(400).json({ error: 'Missing prompt, mimeType, or data' });
    }
    if (!API_KEY) {
      return res.status(500).json({ error: 'Server misconfigured: GEMINI_API_KEY missing' });
    }
    const { uid, data: u } = getUser(req);
    // Allow one free restore if available; otherwise require 100 credits.
    const freeUsed = (req.signedCookies && req.signedCookies.free_used === '1') || req.cookies.free_used === '1';
    const canUseFree = !freeUsed;
    const hasCredits = (u.credits || 0) >= 100;
    if (!canUseFree && !hasCredits) {
      return res.status(402).json({ error: 'payment_required', message: 'Not enough credits. Each image costs 100 credits.', credits: u.credits, freeRemaining: 0 });
    }
    // Validate image input
    if (typeof mimeType !== 'string' || !mimeType.startsWith('image/')) {
      return res.status(400).json({ error: 'Invalid mimeType' });
    }
    try {
      const bytes = Buffer.byteLength(String(data), 'base64');
      const maxBytes = 12 * 1024 * 1024; // 12MB cap (defense-in-depth)
      if (bytes > maxBytes) return res.status(413).json({ error: 'Image too large' });
    } catch {}
    const requested = (modelOverride || MODEL).trim();
    const useModel = ALLOWED_MODELS.includes(requested) ? requested : MODEL;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${useModel}:generateContent`;
    const body = {
      contents: [
        {
          parts: [
            { text: `${prompt}\n\nReturn only the restored photograph as an image (no text).` },
            { inlineData: { mimeType, data } },
          ],
        },
      ],
    };

    const r = await fetch(endpoint, { method: 'POST', headers: { 'x-goog-api-key': API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) return res.status(r.status).send(text);
    let json; try { json = JSON.parse(text); } catch { return res.status(502).json({ error: 'Non-JSON response', raw: text.slice(0, 1200) }); }
    const c0 = json?.candidates?.[0] || {};
    if (c0.finishReason === 'PROHIBITED_CONTENT' || c0.finishReason === 'SAFETY') return res.status(422).json({ error: 'Model blocked content', finishReason: c0.finishReason, raw: json });
    const parts = c0?.content?.parts || [];
    const imgPart = parts.find(p => p.inline_data || p.inlineData);
    const inline = imgPart?.inline_data || imgPart?.inlineData;
    if (!inline?.data) return res.status(502).json({ error: 'No image returned from model', model: useModel, raw: json });
    const mime = inline.mime_type || inline.mimeType || 'image/png';
    const dataOut = typeof inline.data === 'string' ? inline.data : Buffer.from(inline.data).toString('base64');
    // Deduct usage: prefer credits, else consume free
    let freeRemaining;
    if (hasCredits) {
      u.credits = Math.max(0, (u.credits || 0) - 100);
      const freeUsedNow = (req.signedCookies && req.signedCookies.free_used === '1') || req.cookies.free_used === '1';
      freeRemaining = freeUsedNow ? 0 : 1;
    } else if (canUseFree) {
      const isProd = process.env.NODE_ENV === 'production';
      res.cookie('free_used', '1', { httpOnly: true, secure: isProd, sameSite: 'Lax', maxAge: 2 * 365 * 24 * 60 * 60 * 1000, signed: Boolean(COOKIE_SECRET) });
      freeRemaining = 0;
    } else {
      freeRemaining = 0;
    }
    return res.json({ mimeType: mime, data: dataOut, modelUsed: useModel, usage: { credits: u.credits, freeRemaining } });
  } catch (err) {
    const message = err?.message || String(err);
    console.error('Restore proxy error:', message);
    // Surface useful details to the client for debugging
    res.status(500).json({ error: 'Internal error', detail: message });
  }
});

// Generate an image from text only (no input photo) to verify image output works
app.post('/api/restore-text', rateLimit({ windowMs: 10 * 60 * 1000, limit: 20 }), async (req, res) => {
  try {
    const { prompt, model: modelOverride } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
    if (!API_KEY) return res.status(500).json({ error: 'Server misconfigured: GEMINI_API_KEY missing' });

    const { uid, data: u } = getUser(req);
    const freeUsed = (req.signedCookies && req.signedCookies.free_used === '1') || req.cookies.free_used === '1';
    const canUseFree = !freeUsed;
    const hasCredits = (u.credits || 0) >= 100;
    if (!canUseFree && !hasCredits) {
      return res.status(402).json({ error: 'payment_required', message: 'Not enough credits. Each image costs 100 credits.', credits: u.credits, freeRemaining: 0 });
    }
    const requested = (modelOverride || MODEL).trim();
    const useModel = ALLOWED_MODELS.includes(requested) ? requested : MODEL;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${useModel}:generateContent`;
    const body = { contents: [{ parts: [{ text: prompt }] }] };
    const r = await fetch(endpoint, { method: 'POST', headers: { 'x-goog-api-key': API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) return res.status(r.status).send(text);
    let json; try { json = JSON.parse(text); } catch { return res.status(502).json({ error: 'Non-JSON response', raw: text.slice(0, 1200) }); }
    const c0 = json?.candidates?.[0] || {};
    if (c0.finishReason === 'PROHIBITED_CONTENT' || c0.finishReason === 'SAFETY') return res.status(422).json({ error: 'Model blocked content', finishReason: c0.finishReason, raw: json });
    const parts = c0?.content?.parts || [];
    const imgPart = parts.find(p => p.inline_data || p.inlineData);
    const inline = imgPart?.inline_data || imgPart?.inlineData;
    if (!inline?.data) {
      const joinedText = parts.map(p => p.text).filter(Boolean).join('\n') || null;
      return res.status(502).json({ error: 'No image returned from model', model: useModel, text: joinedText, raw: json });
    }
    const mime = inline.mime_type || inline.mimeType || 'image/png';
    const dataOut = typeof inline.data === 'string' ? inline.data : Buffer.from(inline.data).toString('base64');
    let freeRemaining;
    if (hasCredits) {
      u.credits = Math.max(0, (u.credits || 0) - 100);
      const freeUsedNow = (req.signedCookies && req.signedCookies.free_used === '1') || req.cookies.free_used === '1';
      freeRemaining = freeUsedNow ? 0 : 1;
    } else if (canUseFree) {
      const isProd = process.env.NODE_ENV === 'production';
      res.cookie('free_used', '1', { httpOnly: true, secure: isProd, sameSite: 'Lax', maxAge: 2 * 365 * 24 * 60 * 60 * 1000, signed: Boolean(COOKIE_SECRET) });
      freeRemaining = 0;
    } else {
      freeRemaining = 0;
    }
    return res.json({ mimeType: mime, data: dataOut, modelUsed: useModel, usage: { credits: u.credits, freeRemaining } });
  } catch (err) {
    const message = err?.message || String(err);
    console.error('Restore-text proxy error:', message);
    res.status(500).json({ error: 'Internal error', detail: message });
  }
});

// List example before/after pairs from /examples directory
app.get('/api/examples', async (req, res) => {
  try {
    const dir = path.join(__dirname, 'examples');
    const files = await fs.readdir(dir);
    const befores = files.filter(f => /^before\d+\./.test(f)).sort();
    const items = befores.map(b => {
      const n = b.match(/^before(\d+)\./)?.[1];
      const after = files.find(f => f.startsWith(`after${n}.`));
      return { before: `/examples/${b}`, after: after ? `/examples/${after}` : null };
    });
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Bind to 0.0.0.0 so cloud providers (Render/Cloud Run) can route traffic
const server = app.listen(PORT, '0.0.0.0', () => {
  const addr = server.address();
  const actualPort = (addr && typeof addr === 'object') ? addr.port : PORT;
  ACTUAL_PORT = Number(actualPort) || ACTUAL_PORT;
  // Helpful local hint; in cloud, use your service URL
  console.log(`photo restorer server listening on 0.0.0.0:${actualPort} (try http://127.0.0.1:${actualPort} locally)`);
});
