# PhotoRestore

AI-powered photo restoration and colorization with Gemini 2.5. Upload a photo, get a restored, colorized, and upscaled result. Credits handled via Stripe Checkout.

## Quick start (local)

- Node 18+
- Create a `.env` file (do not commit it):

```
GEMINI_API_KEY=your_google_generative_language_api_key_here
STRIPE_SECRET_KEY=sk_test_...
PORT=3000
GEMINI_MODEL=gemini-2.5-flash-image-preview
SITE_ORIGIN=http://127.0.0.1:3000
ALLOWED_ORIGINS=http://127.0.0.1:3000,http://localhost:3000
```

Then:

```
npm install
npm start
```

Open http://127.0.0.1:3000

## Security defaults

- The server proxies Gemini requests; the API key never reaches the browser.
- CORS is restricted to `SITE_ORIGIN`/`ALLOWED_ORIGINS`.
- Rate limits on key endpoints and model allowlist.
- `.env` is ignored by git.

## Deploy (Render)

1) Push this repo to GitHub.
2) Create a Web Service in Render → Environment: Node.
3) Build: `npm install` — Start: `npm start`.
4) Add env vars (use your URL once Render gives it to you):
   - `NODE_ENV=production`
   - `GEMINI_API_KEY=...`
   - `STRIPE_SECRET_KEY=sk_test_...` (swap to `sk_live_...` after approval)
   - `SITE_ORIGIN=https://YOUR-RENDER-URL.onrender.com`
   - `ALLOWED_ORIGINS=https://YOUR-RENDER-URL.onrender.com`
5) Redeploy after setting the final URL in env.

## Stripe test → live

- Complete Stripe activation, toggle off Test Mode, and use `sk_live_...`.
- The UI shows a small "Test Mode" badge automatically when using `sk_test_...`.

## Notes

- The header "Buy Credits" opens a purchase drawer. Success/cancel URLs are derived from the request origin or `SITE_ORIGIN`.
- Recent Images are cached locally in the browser using IndexedDB (not uploaded).
