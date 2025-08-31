/* Simple Express proxy + static server for PhotoRestore */
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import Stripe from 'stripe';
import fs from 'fs/promises';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const OR_MODEL = (process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-image-preview').trim();
// Restrict models to a safe allowlist
const ALLOWED_MODELS = (process.env.OPENROUTER_ALLOWED_MODELS
  ? process.env.OPENROUTER_ALLOWED_MODELS.split(',').map(s => s.trim()).filter(Boolean)
  : [
      'google/gemini-2.5-flash-image-preview',
      'google/gemini-2.5-flash'
    ]);
if (!ALLOWED_MODELS.includes(OR_MODEL)) ALLOWED_MODELS.push(OR_MODEL);

const OR_API_KEY = process.env.OPENROUTER_API_KEY;
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
// Credits are persisted in a signed cookie; this map is no longer authoritative.
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

// OpenRouter app metadata headers
const OR_SITE_URL = (process.env.OPENROUTER_SITE_URL || SITE_ORIGIN);
const OR_APP_NAME = (process.env.OPENROUTER_APP_NAME || 'PhotoRestore');

function policyBlockMessage() {
  return 'We can\'t process images that may include minors, celebrities, or sensitive/controversial topics.';
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
  const credits = getCredits(req);
  if (!users.has(uid)) users.set(uid, { credits });
  else users.get(uid).credits = credits;
  return { uid, data: { credits } };
}

function getCredits(req) {
  let val = undefined;
  if (req.signedCookies) val = req.signedCookies.credits;
  if (val === undefined && req.cookies) val = req.cookies.credits;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function setCredits(res, credits) {
  const isProd = process.env.NODE_ENV === 'production';
  const safe = Math.max(0, Math.floor(Number(credits) || 0));
  res.cookie('credits', String(safe), {
    httpOnly: true,
    secure: isProd,
    sameSite: 'Lax',
    maxAge: 2 * 365 * 24 * 60 * 60 * 1000,
    signed: Boolean(COOKIE_SECRET),
  });
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
  res.json({ ok: true, modelDefault: OR_MODEL, hasKey: Boolean(OR_API_KEY), uid, usage: data, freeRemaining, stripeTestMode });
});

// Get current user usage/credits
app.get('/api/me', (req, res) => {
  const { uid, data } = getUser(req);
  // Free restore is tracked via signed cookie; 1 if not used
  const freeUsed = (req.signedCookies && req.signedCookies.free_used === '1') || req.cookies.free_used === '1';
  const freeRemaining = freeUsed ? 0 : 1;
  res.json({ uid, credits: getCredits(req), freeRemaining });
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
            product_data: { name: `${testPrefix}PhotoRestore Credits (${pack})` },
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
    // Best practice: return the session id for Stripe.js redirectToCheckout
    res.json({ id: session.id, url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Public config for client (exposes only publishable key)
app.get('/api/config', (req, res) => {
  res.json({
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
  });
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
        if (!processedSessions.has(session_id)) {
          const add = parseInt(session?.metadata?.credits || '0', 10) || 0;
          const current = getCredits(req);
          setCredits(res, current + add);
          processedSessions.add(session_id);
          return res.json({ ok: true, uid, credited: true, credits: current + add });
        }
        return res.json({ ok: true, uid, credited: false, credits: getCredits(req) });
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
    if (!OR_API_KEY) {
      return res.status(500).json({ error: 'Server misconfigured: OPENROUTER_API_KEY missing' });
    }
    const { uid } = getUser(req);
    let credits = getCredits(req);
    // Allow one free restore if available; otherwise require 100 credits.
    const freeUsed = (req.signedCookies && req.signedCookies.free_used === '1') || req.cookies.free_used === '1';
    const canUseFree = !freeUsed;
    const hasCredits = credits >= 100;
    if (!canUseFree && !hasCredits) {
      return res.status(402).json({ error: 'payment_required', message: 'Not enough credits. Each image costs 100 credits.', credits, freeRemaining: 0 });
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
    let outMime, outData;
    let blockedByGemini = false;
    // Try Gemini first if configured
    if (process.env.GEMINI_API_KEY) {
      try {
        const requestedGem = (modelOverride || (process.env.GEMINI_MODEL || 'gemini-2.5-flash-image-preview')).trim();
        const allowedGem = (process.env.GEMINI_ALLOWED_MODELS ? process.env.GEMINI_ALLOWED_MODELS.split(',').map(s=>s.trim()) : ['gemini-2.5-flash-image-preview','gemini-2.5-flash']);
        const useGem = allowedGem.includes(requestedGem) ? requestedGem : (process.env.GEMINI_MODEL || 'gemini-2.5-flash-image-preview');
        const endpointGem = `https://generativelanguage.googleapis.com/v1beta/models/${useGem}:generateContent`;
        const bodyGem = { contents: [ { parts: [ { text: `${prompt}\n\nReturn only the restored photograph as an image (no text).` }, { inlineData: { mimeType, data } } ] } ] };
        const rG = await fetch(endpointGem, { method: 'POST', headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(bodyGem) });
        const tG = await rG.text();
        if (rG.ok) {
          let jG; try { jG = JSON.parse(tG); } catch { jG = null; }
          if (jG) {
            const c0 = jG?.candidates?.[0] || {};
            if (c0.finishReason === 'PROHIBITED_CONTENT' || c0.finishReason === 'SAFETY') {
              blockedByGemini = true;
            } else {
              const parts = c0?.content?.parts || [];
              const imgPart = parts.find(p => p.inline_data || p.inlineData);
              const inline = imgPart?.inline_data || imgPart?.inlineData;
              if (inline?.data) {
                outMime = inline.mime_type || inline.mimeType || 'image/png';
                outData = typeof inline.data === 'string' ? inline.data : Buffer.from(inline.data).toString('base64');
              }
            }
          }
        } else if (/SAFETY|PROHIBITED_CONTENT|policy|safety/i.test(tG)) {
          blockedByGemini = true;
        }
      } catch {}
    }

    if (!outData) {
      // If blocked by Gemini, try OpenRouter; if not blocked and Gemini failed, also try OpenRouter as primary path
      if (!OR_API_KEY) {
        if (blockedByGemini) return res.status(422).json({ error: 'blocked', message: policyBlockMessage() });
        return res.status(500).json({ error: 'Internal error', detail: 'OPENROUTER_API_KEY missing' });
      }
      if (blockedByGemini) {
        try { console.log('[fallback]', { route: 'restore', reason: 'gemini_blocked', uid }); } catch {}
      }
      const requested = (modelOverride || OR_MODEL).trim();
      const useModel = ALLOWED_MODELS.includes(requested) ? requested : OR_MODEL;
      const endpoint = 'https://openrouter.ai/api/v1/chat/completions';
      const payload = {
        model: useModel,
        modalities: ['image','text'],
        messages: [ { role: 'user', content: [ { type: 'text', text: `${prompt}\n\nReturn only the restored photograph as an image (no text).` }, { type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } } ] } ]
      };
      const headers = { 'Authorization': `Bearer ${OR_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': OR_SITE_URL, 'X-Title': OR_APP_NAME };
      const r = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
      const text = await r.text();
      if (!r.ok) {
        const isPolicy = /policy|safety|not\s+allowed|blocked/i.test(text);
        if (isPolicy) return res.status(422).json({ error: 'blocked', message: policyBlockMessage(), raw: text.slice(0, 1200) });
        let message; try { const j = JSON.parse(text); message = j?.error?.message || j?.message; } catch {}
        return res.status(r.status).json({ error: 'upstream_error', message: message || 'Unable to process this image right now.', raw: text.slice(0, 1200) });
      }
      let result; try { result = JSON.parse(text); } catch { return res.status(502).json({ error: 'Non-JSON response', raw: text.slice(0,1200) }); }
      const imageUrl = result?.choices?.[0]?.message?.images?.[0]?.image_url?.url || result?.choices?.[0]?.message?.images?.[0]?.image_url;
      if (!imageUrl || !/^data:image\//.test(imageUrl)) { return res.status(502).json({ error: 'no_image', message: 'No children or erotic pictures', model: useModel, raw: result }); }
      const m = imageUrl.match(/^data:([^;]+);base64,(.*)$/);
      outMime = m ? m[1] : 'image/png';
      outData = m ? m[2] : null;
      if (!outData) return res.status(502).json({ error: 'Malformed image data URL', raw: imageUrl.slice(0,120) });
    }
    // Deduct usage: prefer credits, else consume free
    let freeRemaining;
    // Prefer consuming the free restore first, even if credits are available
    if (canUseFree) {
      const isProd = process.env.NODE_ENV === 'production';
      res.cookie('free_used', '1', { httpOnly: true, secure: isProd, sameSite: 'Lax', maxAge: 2 * 365 * 24 * 60 * 60 * 1000, signed: Boolean(COOKIE_SECRET) });
      freeRemaining = 0;
    } else if (hasCredits) {
      credits = Math.max(0, credits - 100);
      setCredits(res, credits);
      const freeUsedNow = (req.signedCookies && req.signedCookies.free_used === '1') || req.cookies.free_used === '1';
      freeRemaining = freeUsedNow ? 0 : 1;
    } else {
      freeRemaining = 0;
    }
    return res.json({ mimeType: outMime, data: outData, usage: { credits, freeRemaining } });
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

    const { uid } = getUser(req);
    let credits = getCredits(req);
    const freeUsed = (req.signedCookies && req.signedCookies.free_used === '1') || req.cookies.free_used === '1';
    const canUseFree = !freeUsed;
    const hasCredits = credits >= 100;
    if (!canUseFree && !hasCredits) {
      return res.status(402).json({ error: 'payment_required', message: 'Not enough credits. Each image costs 100 credits.', credits, freeRemaining: 0 });
    }

    let outMime, outData;
    let blockedByGemini = false;
    if (process.env.GEMINI_API_KEY) {
      try {
        const requestedGem = (modelOverride || (process.env.GEMINI_MODEL || 'gemini-2.5-flash-image-preview')).trim();
        const allowedGem = (process.env.GEMINI_ALLOWED_MODELS ? process.env.GEMINI_ALLOWED_MODELS.split(',').map(s=>s.trim()) : ['gemini-2.5-flash-image-preview','gemini-2.5-flash']);
        const useGem = allowedGem.includes(requestedGem) ? requestedGem : (process.env.GEMINI_MODEL || 'gemini-2.5-flash-image-preview');
        const endpointGem = `https://generativelanguage.googleapis.com/v1beta/models/${useGem}:generateContent`;
        const bodyGem = { contents: [ { parts: [ { text: prompt } ] } ] };
        const rG = await fetch(endpointGem, { method: 'POST', headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(bodyGem) });
        const tG = await rG.text();
        if (rG.ok) {
          let jG; try { jG = JSON.parse(tG); } catch { jG = null; }
          if (jG) {
            const c0 = jG?.candidates?.[0] || {};
            if (c0.finishReason === 'PROHIBITED_CONTENT' || c0.finishReason === 'SAFETY') blockedByGemini = true;
            else {
              const parts = c0?.content?.parts || [];
              const imgPart = parts.find(p => p.inline_data || p.inlineData);
              const inline = imgPart?.inline_data || imgPart?.inlineData;
              if (inline?.data) {
                outMime = inline.mime_type || inline.mimeType || 'image/png';
                outData = typeof inline.data === 'string' ? inline.data : Buffer.from(inline.data).toString('base64');
              }
            }
          }
        } else if (/SAFETY|PROHIBITED_CONTENT|policy|safety/i.test(tG)) {
          blockedByGemini = true;
        }
      } catch {}
    }

    if (!outData) {
      if (!OR_API_KEY) {
        if (blockedByGemini) return res.status(422).json({ error: 'blocked', message: policyBlockMessage() });
        return res.status(500).json({ error: 'Internal error', detail: 'OPENROUTER_API_KEY missing' });
      }
      if (blockedByGemini) {
        try { console.log('[fallback]', { route: 'restore-text', reason: 'gemini_blocked', uid }); } catch {}
      }
      const requested = (modelOverride || OR_MODEL).trim();
      const useModel = ALLOWED_MODELS.includes(requested) ? requested : OR_MODEL;
      const endpoint = 'https://openrouter.ai/api/v1/chat/completions';
      const payload = { model: useModel, modalities: ['image','text'], messages: [ { role: 'user', content: [ { type: 'text', text: prompt } ] } ] };
      const headers = { 'Authorization': `Bearer ${OR_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': OR_SITE_URL, 'X-Title': OR_APP_NAME };
      const r3 = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
      const text2 = await r3.text();
      if (!r3.ok) {
        const isPolicy = /policy|safety|not\s+allowed|blocked/i.test(text2);
        if (isPolicy) return res.status(422).json({ error: 'blocked', message: policyBlockMessage(), raw: (text2 || '').slice(0,1200) });
        let message2; try { const j2 = JSON.parse(text2); message2 = j2?.error?.message || j2?.message; } catch {}
        return res.status(r3.status).json({ error: 'upstream_error', message: message2 || 'Unable to process this image right now.', raw: (text2 || '').slice(0, 1200) });
      }
      let result2; try { result2 = JSON.parse(text2); } catch { return res.status(502).json({ error: 'Non-JSON response', raw: (text2 || '').slice(0,1200) }); }
      const imageUrl2 = result2?.choices?.[0]?.message?.images?.[0]?.image_url?.url || result2?.choices?.[0]?.message?.images?.[0]?.image_url;
      if (!imageUrl2 || !/^data:image\//.test(imageUrl2)) {
        const joinedText = result2?.choices?.[0]?.message?.content || null;
        return res.status(502).json({ error: 'no_image', message: 'No children or erotic pictures', model: useModel, text: joinedText, raw: result2 });
      }
      const m2 = imageUrl2.match(/^data:([^;]+);base64,(.*)$/);
      outMime = m2 ? m2[1] : 'image/png';
      outData = m2 ? m2[2] : null;
    }

    let freeRemaining;
    if (canUseFree) {
      const isProd = process.env.NODE_ENV === 'production';
      res.cookie('free_used', '1', { httpOnly: true, secure: isProd, sameSite: 'Lax', maxAge: 2 * 365 * 24 * 60 * 60 * 1000, signed: Boolean(COOKIE_SECRET) });
      freeRemaining = 0;
    } else if (hasCredits) {
      credits = Math.max(0, credits - 100);
      setCredits(res, credits);
      const freeUsedNow = (req.signedCookies && req.signedCookies.free_used === '1') || req.cookies.free_used === '1';
      freeRemaining = freeUsedNow ? 0 : 1;
    } else {
      freeRemaining = 0;
    }
    return res.json({ mimeType: outMime || 'image/png', data: outData, usage: { credits, freeRemaining } });
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
  console.log(`PhotoRestore server listening on 0.0.0.0:${actualPort} (try http://127.0.0.1:${actualPort} locally)`);
});
