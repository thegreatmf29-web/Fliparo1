/* ============================================================================
   Fliparo — server  (zero dependencies, Node 18+)
   ----------------------------------------------------------------------------
   Why this exists: the Anthropic API key must never reach a user's device. The
   app talks only to this server; this server talks to Anthropic. One key, set
   once, in .env — users never see a key field at all.

   No npm install needed. Just: node server.mjs

   Marketplace publishing:
     eBay — real public Sell API, full OAuth + publish. The only marketplace
            this app lists to, and the only one with a public write API.
            Poshmark, Depop and Mercari were removed: reaching them means
            scraping, which breaks their terms and gets sellers banned.
   ========================================================================== */

/* MUST be first: populates process.env from .env before any module below
   reads it. See env.mjs for the ordering trap this avoids. */
import './env.mjs';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/* Accounts, plans, quotas and Stripe live in their own modules to keep this
   file readable. See accounts.mjs for why quotas are enforced server-side. */
import * as accounts from './accounts.mjs';
import * as store from './store.mjs';
import * as images from './images.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8080;

/* ---- micro router (replaces express) ---- */
const routes = { GET: [], POST: [] };
const add = (m, p, h) => routes[m].push({ p, h });
const app = {
  get:  (p, ...h) => add('GET',  p, h),
  post: (p, ...h) => add('POST', p, h)
};

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'content-type': isObj ? 'application/json' : (headers['content-type'] || 'text/html; charset=utf-8'),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,x-device-id,authorization',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    ...headers
  });
  res.end(payload);
}

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css',
               '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg',
               '.svg':'image/svg+xml', '.ico':'image/x-icon', '.webmanifest':'application/manifest+json' };

const server = http.createServer(async (req, rawRes) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') return send(rawRes, 204, '');

  // express-compatible shim so the handlers below read naturally
  const res = {
    _h: {},
    status(c) { this._code = c; return this; },
    json(o) { send(rawRes, this._code || 200, o, this._h); },
    send(b) { send(rawRes, this._code || 200, b, this._h); },
    set(k, v) { this._h[k] = v; return this; },
    get(k) { return this._h[k]; },
    sendFile(p) {
      fs.readFile(p, (e, buf) => e
        ? send(rawRes, 404, 'Not found')
        : send(rawRes, 200, buf, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }));
    }
  };

  const list = routes[req.method] || [];
  const match = list.find(r => r.p === url.pathname);

  if (match) {
    req.query = Object.fromEntries(url.searchParams);
    req.get = k => req.headers[k.toLowerCase()];
    req.ip = req.socket.remoteAddress;

    if (req.method === 'POST') {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 32 * 1024 * 1024) return send(rawRes, 413, { error: 'Photos are too large. Try fewer or smaller images.' });
        chunks.push(c);
      }
      const raw = Buffer.concat(chunks).toString();

      /* Stripe signs the exact bytes it sent. Parsing and re-serialising the
         body changes those bytes and every signature check would fail, so this
         one route keeps the raw string and skips JSON parsing. */
      if (url.pathname === '/api/stripe/webhook') {
        req.rawBody = raw;
        req.body = {};
      } else {
        try { req.body = JSON.parse(raw || '{}'); }
        catch { return send(rawRes, 400, { error: 'Malformed request.' }); }
      }
    }

    // run the handler chain (supports our one middleware, `gate`)
    let i = 0;
    const next = () => { const fn = match.h[i++]; if (fn) fn(req, res, next); };
    return next();
  }

  /* ---- hosted listing images -----------------------------------------------
     eBay's Inventory API takes `imageUrls`, not image bytes: its servers fetch
     each URL and copy the photo into eBay Picture Services at publish time.
     So this route has to be reachable by a stranger — no session, no token.
     That is safe because ids are 128 bits of randomness and are never listed;
     knowing one tells you nothing about any other.

     It lives here rather than in a route table because the router matches
     paths exactly and this needs a prefix. -------------------------------- */
  if (req.method === 'GET' && url.pathname.startsWith('/i/')) {
    try {
      const img = await images.get(url.pathname.slice(3));
      if (!img) return send(rawRes, 404, 'Not found');
      return send(rawRes, 200, img.buf, {
        'content-type': img.mime,
        /* Immutable: the id is derived from nothing but chance, so a given URL
           can never point at different bytes. Lets eBay and browsers cache
           hard, and keeps repeat fetches off the database. */
        'cache-control': 'public, max-age=31536000, immutable'
      });
    } catch (e) {
      console.error('image serve:', e.message);
      return send(rawRes, 500, 'Image unavailable');
    }
  }

  /* ---- static files, then SPA fallback -------------------------------------
     Everything lives in one flat folder, which means the web root and the
     source folder are the same directory. Serving it naively would hand out
     .env — your Anthropic key — to anyone who typed the URL.

     So this is an ALLOWLIST, not a blocklist: a file is served only if its
     extension is on the list below. .env, .mjs, .json, .yaml and .md are all
     absent from it, so the server's own source and secrets are unreachable no
     matter what path is requested. Dotfiles are refused outright as well.
     -------------------------------------------------------------------------- */
  const SERVABLE = new Set(['.html','.css','.js','.png','.jpg','.jpeg','.gif','.webp',
                            '.svg','.ico','.webmanifest','.woff','.woff2','.txt','.map']);

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const file = path.resolve(__dirname, rel);
  const inRoot = file === __dirname || file.startsWith(__dirname + path.sep);
  const hidden = rel.split(/[\\/]/).some(seg => seg.startsWith('.'));

  if (inRoot && !hidden && SERVABLE.has(path.extname(file).toLowerCase())
      && fs.existsSync(file) && fs.statSync(file).isFile()) {
    return send(rawRes, 200, fs.readFileSync(file), { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  }

  // anything else falls through to the app shell
  send(rawRes, 200, fs.readFileSync(path.join(__dirname, 'index.html')), { 'content-type': 'text/html; charset=utf-8' });
});

/* --------------------------------------------------------------------------
   Config + startup sanity
   -------------------------------------------------------------------------- */
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const MODEL_FALLBACKS = [MODEL, 'claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001']
  .filter((v, i, a) => v && a.indexOf(v) === i);

if (!ANTHROPIC_KEY || ANTHROPIC_KEY.includes('REPLACE_ME')) {
  console.error('\n  ✗ ANTHROPIC_API_KEY is not set in .env');
  console.error('    The app will boot but every scan will fail.\n');
} else {
  console.log(`  ✓ Anthropic key loaded (…${ANTHROPIC_KEY.slice(-6)})`);
}

/* --------------------------------------------------------------------------
   Rate limiting — the thing that stops one user (or one bot) emptying your
   account. In-memory is fine for a single instance; swap for Redis if you
   scale horizontally.
   -------------------------------------------------------------------------- */
const WINDOW_MS = (Number(process.env.RATE_LIMIT_WINDOW_MIN) || 60) * 60_000;
const PER_DEVICE = Number(process.env.RATE_LIMIT_SCANS) || 25;
const DAILY_CEILING = Number(process.env.DAILY_SCAN_CEILING) || 0;

const buckets = new Map();
let dayKey = new Date().toISOString().slice(0, 10);
let dayCount = 0;

function gate(req, res, next) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) { dayKey = today; dayCount = 0; }

  /* Owners skip abuse limiting entirely. This runs after quotaGate, which
     populates req.quotaCtx without consuming anything, so the flag is
     available here. Their scans still count toward dayCount so the operator
     can see real usage — they just are not blocked by it. */
  if (req.quotaCtx?.quota?.unlimited) { dayCount++; return next(); }

  if (DAILY_CEILING && dayCount >= DAILY_CEILING) {
    return res.status(503).json({
      error: 'Fliparo has hit its daily scan limit. Try again tomorrow.',
      code: 'DAILY_CEILING'
    });
  }

  const id = req.get('x-device-id') || req.ip || 'anon';
  const now = Date.now();
  const b = buckets.get(id) || { count: 0, reset: now + WINDOW_MS };
  if (now > b.reset) { b.count = 0; b.reset = now + WINDOW_MS; }

  if (b.count >= PER_DEVICE) {
    const mins = Math.ceil((b.reset - now) / 60000);
    return res.status(429).json({
      error: `You've used all ${PER_DEVICE} scans for now. Resets in ${mins} min.`,
      code: 'RATE_LIMIT', resetInMinutes: mins
    });
  }

  b.count++; buckets.set(id, b); dayCount++;
  res.set('x-scans-remaining', String(PER_DEVICE - b.count));
  next();
}

// keep the map from growing forever
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now > v.reset + WINDOW_MS) buckets.delete(k);
}, 10 * 60_000).unref();

/* --------------------------------------------------------------------------
   Plan quota gate.

   `gate` above is abuse protection — it stops one device burning your API
   budget. This is the commercial limit: how many scans the caller's plan
   actually includes. They are deliberately separate; loosening one should not
   silently loosen the other.

   The scan is only counted AFTER Claude answers successfully, so a failed
   analysis never costs the user one of their scans.
   -------------------------------------------------------------------------- */
async function quotaGate(req, res, next) {
  try {
    const ctx = await accounts.checkScanAllowed(req);
    if (!ctx.ok) {
      return res.status(ctx.status).json({ error: ctx.error, code: ctx.code, quota: ctx.quota });
    }
    req.quotaCtx = ctx;
    next();
  } catch (e) {
    console.error('quota gate:', e.message);
    res.status(500).json({ error: 'Could not check your plan. Try again.' });
  }
}

/* --------------------------------------------------------------------------
   Anthropic call with model fallback
   -------------------------------------------------------------------------- */
async function askClaude({ system, content, maxTokens = 2000 }) {
  let lastErr = 'Unknown error';

  for (const model of MODEL_FALLBACKS) {
    let r;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content }]
        })
      });
    } catch (e) {
      throw Object.assign(new Error('Could not reach the analysis service.'), { status: 502 });
    }

    if (r.ok) {
      const j = await r.json();
      // The response can contain thinking blocks before the text block, so
      // never assume content[0] is the answer — collect every text block.
      const text = (j.content || [])
        .filter(b => b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text).join('\n').trim();
      if (!text) { lastErr = 'Model returned no text content.'; continue; }
      return { text, model, truncated: j.stop_reason === 'max_tokens' };
    }

    let msg = `Request failed (${r.status})`;
    try { const j = await r.json(); if (j.error?.message) msg = j.error.message; } catch {}
    lastErr = msg;

    // Config problems on YOUR side — don't leak details to the user's screen.
    if (r.status === 401) {
      console.error('  ✗ Anthropic rejected the key. Check .env');
      throw Object.assign(new Error('Analysis is temporarily unavailable.'), { status: 503 });
    }
    if (r.status === 400 && /credit|balance/i.test(msg)) {
      console.error('  ✗ Anthropic account out of credits.');
      throw Object.assign(new Error('Analysis is temporarily unavailable.'), { status: 503 });
    }
    if (r.status === 429) {
      throw Object.assign(new Error('Busy right now — try again in a moment.'), { status: 429 });
    }
    // unknown model → try the next one
    if (r.status !== 404 && !/model/i.test(msg)) {
      throw Object.assign(new Error(msg), { status: r.status });
    }
  }
  throw Object.assign(new Error(lastErr), { status: 502 });
}

/* Models occasionally emit real newlines inside JSON string values, which is
   invalid JSON. Rather than fail the user's scan over a formatting slip, we
   walk the text and escape control characters that sit inside a string. */
function repairJSON(s) {
  let out = '', inStr = false, esc = false;
  for (const ch of s) {
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr) {
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
    }
    out += ch;
  }
  return out;
}

function extractJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  let m = raw.match(/\{[\s\S]*\}/);
  // If the model ran out of tokens mid-object there's no closing brace. Take
  // what we have from the first '{' and let the repair pass close it.
  if (!m && raw.includes('{')) m = [raw.slice(raw.indexOf('{'))];
  if (!m) throw Object.assign(new Error('Could not read the analysis. Try a clearer photo.'), { status: 422 });

  try { return JSON.parse(m[0]); } catch {}
  // close an unterminated string / object left by truncation
  try {
    let t = repairJSON(m[0]);
    const quotes = (t.match(/(?<!\\)"/g) || []).length;
    if (quotes % 2) t += '"';
    t = t.replace(/,\s*$/, '');
    const open = (t.match(/\{/g) || []).length - (t.match(/\}/g) || []).length;
    const brk = (t.match(/\[/g) || []).length - (t.match(/\]/g) || []).length;
    t += ']'.repeat(Math.max(0, brk)) + '}'.repeat(Math.max(0, open));
    return JSON.parse(t);
  } catch {}
  try { return JSON.parse(repairJSON(m[0])); } catch {}
  // last resort: drop a trailing truncated line and retry
  try { return JSON.parse(repairJSON(m[0].replace(/,\s*([}\]])/g, '$1'))); } catch (e) {
    console.error('JSON parse failed. First 400 chars of model output:\n', m[0].slice(0, 400));
    throw Object.assign(new Error('Could not read the analysis. Try again.'), { status: 422 });
  }
}

/* --------------------------------------------------------------------------
   Fee model — used to show true net payout per platform.
   Verified Aug 2026. Update here if a platform changes its rates.
   -------------------------------------------------------------------------- */
const FEES = {
  ebay: { name: 'eBay', pct: 0.1335, fixed: 0.40, note: 'Final value fee + $0.40/order' }
};

function netFor(platform, price) {
  const f = FEES[platform];
  if (!f) return price;
  if (f.under15 && price < 15) return Math.max(0, price - f.under15);
  return Math.max(0, price - (price * f.pct) - f.fixed);
}

/* ==========================================================================
   POST /api/analyze
   Body: { images: [dataUrl,...], notes?, category? }
   ========================================================================== */
app.post('/api/analyze', quotaGate, gate, async (req, res) => {
  try {
    const { images = [], notes = '' } = req.body;
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'Add at least one photo.' });
    }

    const content = [];
    images.slice(0, 8).forEach((d, i) => {
      const b64 = String(d).split(',')[1];
      if (!b64) return;
      content.push({ type: 'text', text: `Photo ${i + 1}:` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
    });

    content.push({ type: 'text', text: `${notes ? `Seller's notes about this item: ${notes}\n\n` : ''}Analyze this item and return ONLY raw JSON matching the schema. No markdown, no commentary.

{
  "productName": "specific model/name — be exact, include colorway or model number if visible",
  "brand": "brand name, or 'Unbranded'",
  "category": "one of: Sneakers, Clothing, Outerwear, Bags, Accessories, Jewelry, Watches, Electronics, Collectibles, Home, Toys, Sports, Beauty, Books, Other",
  "subcategory": "more specific, e.g. 'Running Shoes' or 'Denim Jacket'",
  "size": "size as marked, or null if not visible",
  "colorway": "primary color(s)",
  "materials": "main material, or null",
  "styleCode": "style/model number if legible, else null",
  "yearEra": "approx year or era, or null",
  "authenticity": { "verdict": "likely-authentic | uncertain | red-flags", "reasoning": "one sentence on what the photos do and don't let you confirm" },

  "conditionGrade": "New with tags | New without tags | Excellent | Very Good | Good | Fair | Poor",
  "conditionScore": <0-100>,
  "defects": [ { "type":"short label", "severity":"minor|moderate|major", "where":"location on item", "priceImpact": <negative integer, USD> } ],
  "conditionSummary": "two sentences a buyer would find honest and useful",
  "photoQuality": { "score": <0-100>, "advice": "one concrete tip to shoot it better" },

  "averagePrice": <realistic recent SOLD price, USD integer>,
  "priceLow": <integer>, "priceHigh": <integer>,
  "quickSalePrice": <integer, prices to move in ~3 days>,
  "patientPrice": <integer, top of market if you'll wait weeks>,
  "priceConfidence": <0-100>,

  "resellValue": <0-100>, "demand": <0-100>, "trendingLevel": <0-100>,
  "rarityLevel": <0-100>, "sellThroughDays": <typical days to sell, integer>,

  "keywords": ["8-12 search terms real buyers type"],
  "verdict": "one punchy sentence on whether this is worth flipping"
}

Scoring rules — be honest and use the full range. Do not cluster everything at 70.
- Cheap common items score under 25 on resellValue. Say so.
- condition: judge strictly from what is actually visible. List every flaw you can see; missed flaws become buyer disputes.
- prices: base on recent SOLD comps, never retail MSRP. If you cannot identify the item confidently, lower priceConfidence rather than inventing a number.
- if the photos are too poor or ambiguous to identify the item, say so in productName and set priceConfidence under 30.` });

    const { text, model } = await askClaude({
      system: 'You are a professional resale analyst with deep knowledge of eBay sold comps. You are blunt, accurate, and never inflate a valuation to please the seller.',
      content, maxTokens: 2200
    });

    const data = extractJSON(text);

    // attach net-payout math server-side so every screen agrees
    data.netPayout = {};
    for (const p of Object.keys(FEES)) {
      data.netPayout[p] = {
        platform: FEES[p].name,
        note: FEES[p].note,
        atMarket: Math.round(netFor(p, Number(data.averagePrice) || 0)),
        atQuick: Math.round(netFor(p, Number(data.quickSalePrice) || 0)),
        atPatient: Math.round(netFor(p, Number(data.patientPrice) || 0))
      };
    }
    data._model = model;
    data._scansRemaining = Number(res.get('x-scans-remaining') || 0);

    /* Only now, with a real result in hand, does the scan count against the
       plan. A Claude timeout or a malformed response must never cost somebody
       their one free scan of the month. */
    await accounts.consumeScan(req.quotaCtx);
    data.quota = accounts.quotaOf(req.quotaCtx.user) ;
    if (!req.quotaCtx.user) {
      const q = accounts.anonQuota(req.get('x-device-id') || 'anon');
      data.quota = { plan: 'free', scansUsed: q.scansUsed, scansLimit: accounts.PLANS.free.scans,
                     scansLeft: Math.max(0, accounts.PLANS.free.scans - q.scansUsed), autoList: false, signedIn: false };
    }

    res.json(data);
  } catch (e) {
    console.error('analyze:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

/* ==========================================================================
   POST /api/listing — platform-tailored listing copy
   ========================================================================== */
app.post('/api/listing', gate, async (req, res) => {
  try {
    const { item, platform = 'ebay', tone = 'clean' } = req.body;
    if (!item) return res.status(400).json({ error: 'Missing item data.' });

    const rules = {
      ebay: 'eBay: title max 80 chars, keyword-dense, format "Brand Model Colorway Size Condition". Buyers search literally — no cute language. Description should be scannable with short lines and an explicit flaws section.'
    };

    const { text } = await askClaude({
      system: 'You write resale listings that actually sell. You never overstate condition — an honest flaws section prevents returns and protects seller ratings.',
      content: [{ type: 'text', text: `Item analysis:
${JSON.stringify(item, null, 2)}

Write a listing for ${platform}. ${rules[platform] || rules.ebay}
Tone: ${tone}.

Return ONLY raw JSON:
{
  "title": "the listing title, respecting the char limit",
  "description": "full description with line breaks as \\n",
  "tags": ["platform-appropriate tags"],
  "suggestedPrice": <integer>,
  "conditionLabel": "the exact condition wording this platform uses",
  "flawsDisclosure": "the honest flaws paragraph, or 'No flaws noted.' if genuinely none",
  "shippingTip": "one line on how to ship this item"
}` }],
      maxTokens: 2600
    });

    res.json(extractJSON(text));
  } catch (e) {
    console.error('listing:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

/* ==========================================================================
   eBay — real OAuth + real publishing
   ========================================================================== */
const EBAY_SANDBOX = (process.env.EBAY_ENV || 'sandbox') !== 'production';
const EBAY_AUTH_HOST = EBAY_SANDBOX ? 'auth.sandbox.ebay.com' : 'auth.ebay.com';
const EBAY_API_HOST  = EBAY_SANDBOX ? 'api.sandbox.ebay.com' : 'api.ebay.com';
const EBAY_SCOPES = [
  /* The bare api_scope is what the Taxonomy API checks against. Without it,
     category suggestion 403s on some accounts while every sell.* call still
     works — a failure that looks like a bug in the category code. */
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment'
].join(' ');

/* eBay tokens are persisted to disk so users don't have to reconnect every
   time the process restarts — which on a free host happens constantly, because
   free instances spin down after ~15 minutes of inactivity. */
const TOKEN_FILE = process.env.TOKEN_FILE || path.join(__dirname, '.tokens.json');
const ebayTokens = new Map();          // deviceId -> { access_token, refresh_token, expires }
const ebayStates = new Map();          // state -> deviceId

try {
  if (fs.existsSync(TOKEN_FILE)) {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')))) ebayTokens.set(k, v);
    console.log(`  ✓ Restored ${ebayTokens.size} eBay session(s)`);
  }
} catch { /* corrupt or unreadable — start clean */ }

let saveQueued = false;
function persistTokens() {
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(() => {
    saveQueued = false;
    try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(Object.fromEntries(ebayTokens))); }
    catch (e) { console.error('  ! Could not persist eBay tokens:', e.message); }
  }, 250);
}

const ebayConfigured = () => !!(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET && process.env.EBAY_REDIRECT_URI_NAME);

app.get('/api/ebay/status', (req, res) => {
  const id = req.get('x-device-id') || 'anon';
  res.json({
    configured: ebayConfigured(),
    connected: ebayTokens.has(id),
    env: EBAY_SANDBOX ? 'sandbox' : 'production'
  });
});

app.get('/api/ebay/login', (req, res) => {
  if (!ebayConfigured()) {
    return res.status(400).json({ error: 'eBay is not configured on this server. See README §eBay.' });
  }
  const deviceId = req.query.device || 'anon';
  const state = crypto.randomBytes(16).toString('hex');
  ebayStates.set(state, deviceId);
  setTimeout(() => ebayStates.delete(state), 10 * 60_000).unref();

  const url = `https://${EBAY_AUTH_HOST}/oauth2/authorize?client_id=${encodeURIComponent(process.env.EBAY_CLIENT_ID)}`
    + `&response_type=code&redirect_uri=${encodeURIComponent(process.env.EBAY_REDIRECT_URI_NAME)}`
    + `&scope=${encodeURIComponent(EBAY_SCOPES)}&state=${state}`;
  res.json({ url });
});

app.get('/api/ebay/callback', async (req, res) => {
  const { code, state } = req.query;
  const deviceId = ebayStates.get(state);
  if (!code || !deviceId) return res.status(400).send('Invalid or expired eBay login. Close this and try again.');
  ebayStates.delete(state);

  try {
    const basic = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64');
    const r = await fetch(`https://${EBAY_API_HOST}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: process.env.EBAY_REDIRECT_URI_NAME
      })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error_description || 'Token exchange failed');

    ebayTokens.set(deviceId, {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires: Date.now() + (j.expires_in - 60) * 1000
    });
    persistTokens();
    res.send('<html><body style="background:#000;color:#fff;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center"><div><div style="font-size:52px">✓</div><h2 style="margin:12px 0 6px">eBay connected</h2><p style="color:#86868B">You can close this window.</p></div><script>setTimeout(()=>window.close(),1400)</script></body></html>');
  } catch (e) {
    console.error('ebay callback:', e.message);
    res.status(500).send('eBay connection failed: ' + e.message);
  }
});

async function ebayToken(deviceId) {
  const t = ebayTokens.get(deviceId);
  if (!t) throw Object.assign(new Error('Connect your eBay account first.'), { status: 401 });
  if (Date.now() < t.expires) return t.access_token;

  const basic = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`https://${EBAY_API_HOST}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, scope: EBAY_SCOPES })
  });
  const j = await r.json();
  if (!r.ok) { ebayTokens.delete(deviceId); persistTokens(); throw Object.assign(new Error('eBay session expired. Reconnect.'), { status: 401 }); }
  t.access_token = j.access_token;
  t.expires = Date.now() + (j.expires_in - 60) * 1000;
  persistTokens();
  return t.access_token;
}

// our condition words -> eBay's official condition enums
const EBAY_CONDITION = {
  'New with tags': 'NEW_WITH_TAGS',
  'New without tags': 'NEW_WITHOUT_TAGS',
  'Excellent': 'USED_EXCELLENT',
  'Very Good': 'USED_VERY_GOOD',
  'Good': 'USED_GOOD',
  'Fair': 'USED_ACCEPTABLE',
  'Poor': 'USED_ACCEPTABLE'
};

/* ==========================================================================
   POST /api/images
   Body: { images: [dataUrl, ...] }  →  { urls: [absolute https urls] }

   Signed-in only. Publishing already requires a paid plan, so there is no
   case where an anonymous caller needs this — and leaving it open would make
   the server free image hosting for anyone who found the endpoint.
   ========================================================================== */
app.post('/api/images', async (req, res) => {
  try {
    const user = await accounts.currentUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in to upload photos.' });

    const list = Array.isArray(req.body?.images) ? req.body.images : [];
    if (!list.length) return res.status(400).json({ error: 'No images given.' });

    const base = (process.env.PUBLIC_URL || '').replace(/\/+$/, '') || `https://${req.get('host')}`;
    if (/^https?:\/\/localhost|127\.0\.0\.1/.test(base)) {
      /* eBay fetches these itself. A localhost URL is not a slightly worse
         URL, it is one eBay can never resolve — say so now rather than
         letting publish fail with eBay's opaque image error. */
      return res.status(400).json({
        error: 'PUBLIC_URL points at localhost, which eBay cannot reach. Set it to your public URL.'
      });
    }

    const urls = [];
    for (const dataUrl of list.slice(0, images.MAX_PER_ITEM)) {
      const { id, ext } = await images.put(dataUrl);
      urls.push(images.urlFor(base, id, ext));
    }
    res.json({ urls, stored: images.DRIVER });
  } catch (e) {
    console.error('image upload:', e.message);
    res.status(400).json({ error: e.message || 'Could not store the photos.' });
  }
});

/* --------------------------------------------------------------------------
   Category resolution.

   Every listing used to go out as 175759 because the client never sent a
   category. Wrong category means poor search placement and, in categories
   with required aspects, an outright publish rejection.

   The tree id is fetched once and cached: it is a per-marketplace constant,
   and re-fetching it on every publish would add a round trip for a value that
   never changes.

   Failure here is deliberately soft. A missing suggestion should degrade to
   the fallback category and still publish — losing the listing because the
   taxonomy lookup timed out would be a worse outcome than a wrong category.
   -------------------------------------------------------------------------- */
const FALLBACK_CATEGORY = process.env.EBAY_FALLBACK_CATEGORY_ID || '175759';
let categoryTreeId = null;

async function ebayCategoryTree(token) {
  if (categoryTreeId) return categoryTreeId;
  const j = await ebayFetch(token, '/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=EBAY_US');
  categoryTreeId = j?.categoryTreeId || null;
  return categoryTreeId;
}

async function suggestCategory(token, query) {
  const q = String(query || '').trim().slice(0, 120);
  if (!q) return null;
  try {
    const tree = await ebayCategoryTree(token);
    if (!tree) return null;
    const j = await ebayFetch(token,
      `/commerce/taxonomy/v1/category_tree/${tree}/get_category_suggestions?q=${encodeURIComponent(q)}`);
    const hit = j?.categorySuggestions?.[0]?.category;
    return hit?.categoryId ? { id: String(hit.categoryId), name: hit.categoryName || '' } : null;
  } catch (e) {
    console.error('category suggestion:', e.message);
    return null;
  }
}

async function ebayFetch(token, endpoint, opts = {}) {
  const r = await fetch(`https://${EBAY_API_HOST}${endpoint}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'content-language': 'en-US',
      'accept-language': 'en-US',
      ...(opts.headers || {})
    }
  });
  const body = await r.text();
  let json = null; try { json = body ? JSON.parse(body) : null; } catch {}
  if (!r.ok) {
    const msg = json?.errors?.[0]?.message || json?.message || `eBay error ${r.status}`;
    const detail = json?.errors?.[0]?.longMessage;
    throw Object.assign(new Error(detail ? `${msg} — ${detail}` : msg), { status: r.status });
  }
  return json;
}

/* Full publish chain: inventory item -> offer -> publish */
app.post('/api/ebay/publish', async (req, res) => {
  const deviceId = req.get('x-device-id') || 'anon';
  try {
    /* Automatic publishing is the paid feature. Checked here, on the server,
       because this is the endpoint that actually does the work — a paywall
       that only exists in the browser is decoration. */
    const allowed = await accounts.checkListingAllowed(req);
    if (!allowed.ok) {
      return res.status(allowed.status).json({ error: allowed.error, code: allowed.code, quota: allowed.quota });
    }

    const { item, listing, imageUrls = [] } = req.body;
    if (!item || !listing) return res.status(400).json({ error: 'Missing item or listing data.' });

    const token = await ebayToken(deviceId);
    const sku = `FLIP-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

    /* An explicit category from the client wins; otherwise ask eBay what this
       title belongs under; otherwise fall back. */
    let categoryId = req.body.categoryId ? String(req.body.categoryId) : null;
    let categoryName = '';
    if (!categoryId) {
      const guess = await suggestCategory(token, `${listing.title || ''} ${item.brand || ''}`.trim());
      if (guess) { categoryId = guess.id; categoryName = guess.name; }
    }
    if (!categoryId) categoryId = FALLBACK_CATEGORY;

    const aspects = {};
    if (item.brand)     aspects.Brand = [String(item.brand)];
    if (item.size)      aspects.Size = [String(item.size)];
    if (item.colorway)  aspects.Color = [String(item.colorway)];
    if (item.materials) aspects.Material = [String(item.materials)];
    if (item.styleCode) aspects['Style Code'] = [String(item.styleCode)];

    // 1. inventory item
    await ebayFetch(token, `/sell/inventory/v1/inventory_item/${sku}`, {
      method: 'PUT',
      body: JSON.stringify({
        availability: { shipToLocationAvailability: { quantity: 1 } },
        condition: EBAY_CONDITION[item.conditionGrade] || 'USED_GOOD',
        conditionDescription: item.conditionSummary || undefined,
        product: {
          title: String(listing.title).slice(0, 80),
          description: listing.description,
          aspects,
          imageUrls: imageUrls.slice(0, 12)
        }
      })
    });

    // 2. offer
    const offer = await ebayFetch(token, '/sell/inventory/v1/offer', {
      method: 'POST',
      body: JSON.stringify({
        sku, marketplaceId: 'EBAY_US', format: 'FIXED_PRICE',
        availableQuantity: 1,
        categoryId,
        listingDescription: listing.description,
        pricingSummary: { price: { value: String(listing.suggestedPrice), currency: 'USD' } },
        listingPolicies: {
          fulfillmentPolicyId: process.env.EBAY_FULFILLMENT_POLICY_ID,
          paymentPolicyId: process.env.EBAY_PAYMENT_POLICY_ID,
          returnPolicyId: process.env.EBAY_RETURN_POLICY_ID
        },
        merchantLocationKey: process.env.EBAY_MERCHANT_LOCATION_KEY || 'default-location'
      })
    });

    // 3. publish
    const published = await ebayFetch(token, `/sell/inventory/v1/offer/${offer.offerId}/publish`, { method: 'POST' });

    res.json({
      ok: true, sku, offerId: offer.offerId, listingId: published.listingId,
      categoryId, categoryName, photos: imageUrls.length,
      url: EBAY_SANDBOX
        ? `https://sandbox.ebay.com/itm/${published.listingId}`
        : `https://www.ebay.com/itm/${published.listingId}`
    });
  } catch (e) {
    console.error('ebay publish:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

/* ==========================================================================
   Depop — private Partner Selling API. Complete, gated on approval.
   Docs: https://partnerapi.depop.com/api-docs/
   ========================================================================== */
app.get('/api/depop/status', (_req, res) => {
  res.json({
    configured: !!process.env.DEPOP_API_KEY,
    note: 'The Depop Selling API is private. Email partnerapi@depop.com for access, then set DEPOP_API_KEY in .env.'
  });
});

app.post('/api/depop/publish', async (req, res) => {
  if (!process.env.DEPOP_API_KEY) {
    return res.status(503).json({
      error: 'Depop API access not enabled yet.',
      code: 'DEPOP_NOT_APPROVED',
      howTo: 'Depop\'s Selling API is invite-only. Email partnerapi@depop.com to request access. Once approved, add DEPOP_API_KEY to .env and this turns on with no code changes.'
    });
  }
  try {
    const { item, listing, imageUrls = [] } = req.body;
    const sku = `RAI-${Date.now()}`;
    const r = await fetch(`${process.env.DEPOP_API_BASE}/api/v1/products/${sku}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${process.env.DEPOP_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        description: listing.description,
        price: { amount: String(listing.suggestedPrice), currency: 'USD' },
        national_shipping_cost: { amount: '5.00', currency: 'USD' },
        condition: (item.conditionGrade || '').toLowerCase().includes('new') ? 'brand_new' : 'used_excellent',
        department: 'unisex',
        product_type: item.subcategory || item.category || 'other',
        size: item.size || undefined,
        pictures: imageUrls.slice(0, 8).map(url => ({ url })),
        tags: (listing.tags || []).slice(0, 5)
      })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.message || `Depop error ${r.status}`), { status: r.status });
    res.json({ ok: true, sku, ...j });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/* --------------------------------------------------------------------------
   eBay marketplace account deletion notifications
   ----------------------------------------------------------------------------
   eBay will not mark an application Compliant — and a Non Compliant app cannot
   use its production keys for real work — until this endpoint exists and
   answers a challenge correctly.

   Two things arrive here:

     GET  ?challenge_code=…   eBay proving the endpoint is ours. We answer with
                              sha256(challengeCode + verificationToken + endpoint)
                              in hex, as JSON. That order is fixed; any other
                              order fails with no useful error message.

     POST                     A real notification that an eBay user closed their
                              account. We must stop holding their data.

   EBAY_DELETION_ENDPOINT must be the endpoint URL *exactly* as typed into the
   eBay portal — same scheme, host and path. It is read from config rather than
   rebuilt from the request because a proxy that rewrites Host, or forwards as
   http, would silently produce a different string and therefore a hash that
   never matches.
   -------------------------------------------------------------------------- */
const EBAY_VERIFICATION_TOKEN = process.env.EBAY_VERIFICATION_TOKEN || '';
const EBAY_DELETION_ENDPOINT  = process.env.EBAY_DELETION_ENDPOINT  || '';

app.get('/api/ebay/deletion', (req, res) => {
  const challengeCode = req.query.challenge_code;
  if (!challengeCode) return res.status(400).json({ error: 'missing challenge_code' });

  if (!EBAY_VERIFICATION_TOKEN || !EBAY_DELETION_ENDPOINT) {
    console.error('[ebay] deletion challenge arrived but EBAY_VERIFICATION_TOKEN / ' +
                  'EBAY_DELETION_ENDPOINT are not set — eBay will mark this endpoint failed');
    return res.status(500).json({ error: 'endpoint not configured' });
  }

  const challengeResponse = crypto.createHash('sha256')
    .update(challengeCode)
    .update(EBAY_VERIFICATION_TOKEN)
    .update(EBAY_DELETION_ENDPOINT)
    .digest('hex');

  console.log('[ebay] deletion challenge answered');
  res.status(200).json({ challengeResponse });
});

app.post('/api/ebay/deletion', async (req, res) => {
  /* Acknowledge first. eBay retries, and disables an endpoint that is slow to
     acknowledge, so nothing below may delay the response. */
  res.status(200).json({ ok: true });

  try {
    const d = req.body?.notification?.data || {};
    console.log('[ebay] account deletion notification', d.username || '(no username)', d.userId || '');

    /* TODO: erase everything held for this eBay user. At minimum the stored
       eBay OAuth tokens, so no refresh token for a closed account stays on
       disk. This is a legal obligation, not a nicety. */
  } catch (e) {
    console.error('[ebay] failed to process deletion notification', e);
  }
});

/* --------------------------------------------------------------------------
   Health + fees
   -------------------------------------------------------------------------- */
app.get('/api/health', (_req, res) => res.json({
  ok: true,
  keyConfigured: !!ANTHROPIC_KEY && !ANTHROPIC_KEY.includes('REPLACE_ME'),
  model: MODEL,
  ebay: ebayConfigured(),
  depop: !!process.env.DEPOP_API_KEY,
  scansToday: dayCount
}));

app.get('/api/fees', (_req, res) => res.json(FEES));

/* ==========================================================================
   Accounts, plans and billing
   ========================================================================== */
app.get ('/api/plans',            (_req, res) => res.json(accounts.plansPayload()));

/* Answers "why didn't the email send?" without guesswork. Reports only whether
   things are configured and what the server got back — never the credentials
   themselves, so this is safe to open in a browser. */
app.get('/api/auth/diagnose', async (_req, res) => {
 try {
  const out = {
    provider: accounts.mailProvider(),
    from: accounts.mailFrom(),
    gmailUserSet: !!process.env.GMAIL_USER,
    gmailPasswordSet: !!process.env.GMAIL_APP_PASSWORD,
    gmailPasswordLength: (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '').length,
    nodeEnv: process.env.NODE_ENV || 'development'
  };
  // Google shows App Passwords as 16 characters; anything else is usually the
  // account password pasted by mistake.
  if (out.gmailPasswordSet && out.gmailPasswordLength !== 16) {
    out.warning = `App Password is ${out.gmailPasswordLength} characters — Google's are 16. This looks like the wrong password.`;
  }
  out.usesSmtp = accounts.providerUsesSmtp();
  if (out.usesSmtp) {
    out.note = 'SMTP providers do not work on hosts that block outbound ports 25/465/587 '
             + "(Render's free tier does). If the login below times out, that is why.";
  }

  const v = await accounts.verifyMailLogin();
  out.loginOk = v.ok;
  if (!v.ok) out.loginError = v.reason;

  res.json(out);
 } catch (e) {
  res.status(500).json({ error: e.message });
 }
});
app.post('/api/auth/request',     accounts.requestCode);
app.post('/api/auth/verify',      accounts.verifyCode);
app.post('/api/auth/google',      accounts.googleAuth);

/* What the client needs before it can render the auth screen. Public by
   design: a Google client id is not a secret — it is embedded in every page
   that offers the button. */
app.get('/api/config', (_req, res) => res.json({
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  mailConfigured: accounts.mailConfigured()
}));
app.get ('/api/me',               accounts.me);
app.post('/api/billing/checkout', accounts.createCheckout);
app.post('/api/billing/portal',   accounts.billingPortal);

/* Stripe calls this; the browser never does. Always answer 200 once the
   signature checks out — a non-200 makes Stripe retry for days. */
app.post('/api/stripe/webhook', async (req, res) => {
  const v = accounts.verifyWebhook(req.rawBody || '', req.get('stripe-signature'));
  if (!v.ok) {
    console.warn('stripe webhook rejected:', v.reason);
    return res.status(400).json({ error: 'Signature verification failed.' });
  }
  try { await accounts.handleWebhookEvent(v.event); }
  catch (e) { console.error('webhook handler:', e.message); }
  res.json({ received: true });
});

/* ==========================================================================
   Startup
   ========================================================================== */
await store.ready().catch(e => {
  console.error(`\n  ✗ Storage failed to start: ${e.message}\n`);
  process.exit(1);
});

server.listen(PORT, () => {
  const live = (process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live');

  console.log(`\n  Fliparo running → http://localhost:${PORT}`);
  console.log(`  eBay: ${ebayConfigured() ? (EBAY_SANDBOX ? 'sandbox' : 'PRODUCTION') : 'not configured'}`);
  console.log(`  Depop: ${process.env.DEPOP_API_KEY ? 'enabled' : 'awaiting partner approval'}`);
  console.log(`  Billing: ${accounts.billingConfigured() ? (live ? 'LIVE' : 'test mode') : 'not configured'}`);
  console.log(`  Email: ${accounts.mailConfigured() ? accounts.mailProvider() + ' (' + accounts.mailFrom() + ')' : 'console only (codes print here)'}`);
  console.log(`  Storage: ${store.DRIVER}`);

  /* The one combination that quietly loses money: real cards being charged
     while account records sit on a disk that gets wiped on every deploy. */
  if (live && store.DRIVER === 'file') {
    console.error('\n  ✗ REFUSING TO RUN: live Stripe keys with file storage.');
    console.error('    Render wipes the filesystem on restart — paying customers');
    console.error('    would lose their subscription. Set DATABASE_URL first.\n');
    process.exit(1);
  }
  if (!accounts.mailConfigured()) {
    console.log('\n  · No mail provider set, so login codes print in this terminal');
    console.log('    instead of being emailed. Set GMAIL_USER and GMAIL_APP_PASSWORD.');
    console.log('    In production, sign-in returns a clear error rather than');
    console.log('    silently failing. See SETUP-BILLING.md.\n');
  } else {
    accounts.verifyMailLogin().then(v => {
      if (v.ok) console.log('  ✓ Mail login verified\n');
      else console.error(`\n  ✗ Mail login FAILED: ${v.reason || 'no reason reported'}\n    Check /api/auth/diagnose\n`);
    }).catch(e => console.error('  ✗ Mail check error:', accounts.errText(e)));
  }
});
