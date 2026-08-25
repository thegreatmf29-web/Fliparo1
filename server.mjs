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

    /* Run the handler chain (supports our one middleware, `gate`).
       ------------------------------------------------------------------------
       Every handler here is async, and a rejected promise used to go nowhere:
       no catch, no response, no error. The socket simply stayed open until the
       browser gave up. One unreachable database turned into a page that hung
       and then rendered as signed out — the failure mode that made a valid
       session look like an expired one. Now anything that throws gets a 500 and
       a line in the log. */
    let i = 0;
    let answered = false;
    const origJson = res.json.bind(res);
    const origSend = res.send.bind(res);
    res.json = o => { answered = true; return origJson(o); };
    res.send = b => { answered = true; return origSend(b); };

    const fail = e => {
      console.error(`unhandled in ${req.method} ${url.pathname}:`, e?.stack || e?.message || e);
      if (!answered) {
        answered = true;
        send(rawRes, 500, { error: 'Something broke on our end. Try again in a moment.' });
      }
    };

    const next = () => {
      const fn = match.h[i++];
      if (!fn) return;
      try {
        const out = fn(req, res, next);
        if (out && typeof out.catch === 'function') out.catch(fail);
      } catch (e) { fail(e); }
    };
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
   POST /api/read-label — read one field off a photo of a tag

   The scan photographs a whole item, and a size is printed in 6pt type on a
   tongue label or a sewn-in tag that is usually facing away from the camera.
   So when eBay demands a size the scan could not read, the app asks for a
   close-up of the label instead of a typed guess, and this reads it.

   Deliberately narrow: one field, one photo, a value or an honest null. It
   never invents a plausible size, because a wrong size in a listing is worse
   than an empty box — it is a return, a refund and a defect on the account.

   Rate-limited like a scan (one device cannot burn the API budget) but it
   does not consume one of the seller's monthly scans: they already paid for
   this item, and being asked for a close-up is our shortcoming, not theirs.
   ========================================================================== */
app.post('/api/read-label', gate, async (req, res) => {
  try {
    const { image, aspect = 'Size', item = {} } = req.body;
    const b64 = String(image || '').split(',')[1];
    if (!b64) return res.status(400).json({ error: 'Send one photo of the label.' });

    const wantsShoeSize = /shoe|sneaker|footwear/i.test(
      `${aspect} ${item.category || ''} ${item.subcategory || ''} ${item.productName || ''}`);

    const { text } = await askClaude({
      system: 'You read manufacturer labels from photographs for a resale listing tool. '
            + 'You are precise and you say when you cannot read something. A wrong value '
            + 'causes a returned order, so an honest null always beats a confident guess.',
      content: [
        { type: 'text', text: `Photo of a label on this item:\n${JSON.stringify({
            productName: item.productName, brand: item.brand,
            category: item.category, subcategory: item.subcategory
          }, null, 2)}` },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
        { type: 'text', text: `Read the value of "${aspect}" off this label.

${wantsShoeSize ? `Shoe labels print several sizings at once — US, UK, EUR, CM/JP — usually in a
row or a small grid, and often men's and women's on the same tag. This listing
is for eBay US, so return the US size. If the tag shows a men's and a women's
US size, return the men's unless the item is clearly women's. Keep half sizes
exactly as printed (10.5, not 10).` : `Return the value exactly as printed. Do not convert it, expand it or tidy it.`}

Return ONLY raw JSON, no markdown:
{
  "value": "the value, exactly as it should appear in the listing, or null if you cannot read it",
  "system": "the sizing system you read, e.g. \\"US Men's\\", \\"EU\\", \\"UK\\" — null if not applicable",
  "alternates": { "UK": "…", "EU": "…", "CM": "…" },
  "confidence": <0-100>,
  "readable": <true only if you can actually see the value in this photo>,
  "advice": "if unreadable, one concrete sentence on what to photograph instead — which tag, where it usually is on this kind of item"
}

Set readable false and value null if the label is blurred, cropped, out of
frame, or shows something other than ${aspect}. Do not infer the value from
the item's appearance — only report what is legible on the label.` }
      ],
      maxTokens: 700
    });

    const out = extractJSON(text);

    /* One more gate on our side. A low-confidence read is worse than no read,
       because it arrives pre-filled and looks checked. */
    if (!out.readable || !out.value || Number(out.confidence) < 55) {
      return res.json({
        readable: false, value: null,
        confidence: Number(out.confidence) || 0,
        advice: out.advice || `That photo does not show the ${aspect.toLowerCase()} clearly enough to read. Try a straight-on close-up of the label, in good light, filling the frame.`
      });
    }

    res.json({
      readable: true,
      value: String(out.value).trim().slice(0, 65),
      system: out.system || null,
      alternates: out.alternates || null,
      confidence: Number(out.confidence) || 0
    });
  } catch (e) {
    console.error('read-label:', e.message);
    res.status(e.status || 500).json({ error: e.message || 'Could not read that photo.' });
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

/* ─────────────────────── where an eBay link actually lives ───────────────────
   On the user's row, in the database, with the refresh token encrypted.

   It used to live in a Map keyed by a `deviceId` the browser invented and
   asserted in a header, mirrored to a JSON file. Three things were wrong with
   that, and all three were being felt:

     • The file was TOKEN_FILE=/tmp/.tokens.json on Render. Free instances spin
       down after ~15 idle minutes and come back with an empty /tmp, so every
       connection died within the hour. The comment promising it survived
       restarts was true only on a host that kept its disk.

     • The link belonged to a browser, not a person. Clearing site data lost it,
       a second device never had it, and signing in somewhere else did not bring
       it along.

     • A deviceId is a bearer credential in disguise. Anyone who sent someone
       else's x-device-id header got to list on their eBay account, and the ids
       were generated from Math.random.

   Now: keyed by the verified email on the session token, encrypted at rest,
   and it survives restarts because it is in Postgres like everything else.
   ─────────────────────────────────────────────────────────────────────────── */

/* Read once at boot purely to carry existing local connections across this
   upgrade. Anything in here is claimed by the first signed-in user who presents
   the matching deviceId, then deleted. On Render the file is already gone, so
   this does nothing; locally it means nobody has to reconnect. */
const LEGACY_TOKEN_FILE = process.env.TOKEN_FILE || path.join(__dirname, '.tokens.json');
const legacyTokens = new Map();

try {
  if (fs.existsSync(LEGACY_TOKEN_FILE)) {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(LEGACY_TOKEN_FILE, 'utf8')))) legacyTokens.set(k, v);
    if (legacyTokens.size) console.log(`  · ${legacyTokens.size} device-keyed eBay link(s) found; will migrate on next sign-in`);
  }
} catch { /* corrupt or unreadable — nothing to migrate */ }

function forgetLegacy(deviceId) {
  legacyTokens.delete(deviceId);
  try {
    if (legacyTokens.size) fs.writeFileSync(LEGACY_TOKEN_FILE, JSON.stringify(Object.fromEntries(legacyTokens)));
    else if (fs.existsSync(LEGACY_TOKEN_FILE)) fs.unlinkSync(LEGACY_TOKEN_FILE);
  } catch { /* best effort; the entry is gone from memory either way */ }
}

const ebayConfigured = () => !!(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET && process.env.EBAY_REDIRECT_URI_NAME);

const ebayBasic = () =>
  Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64');

/* Every eBay route needs the same three things: a signed-in user, a stored
   link, and a usable access token. This returns the user or throws something
   the client can act on — `code` is what the app switches on to decide between
   "sign in", "connect eBay" and "reconnect eBay". */
async function ebayUser(req) {
  let user;
  try {
    user = await accounts.currentUser(req);
  } catch (e) {
    console.error('ebay: storage unreachable:', e.message);
    throw Object.assign(new Error('Cannot reach the account database right now. Try again in a moment.'),
      { status: 503, code: 'unavailable' });
  }
  if (!user) {
    throw Object.assign(new Error('Sign in to connect your eBay account.'),
      { status: 401, code: 'signup' });
  }
  return user;
}

/* One-time adoption of a pre-upgrade, device-keyed link. */
async function claimLegacyLink(user, deviceId) {
  const legacy = deviceId && legacyTokens.get(deviceId);
  if (!legacy?.refresh_token) return null;
  const link = {
    access_token: legacy.access_token || null,
    refresh_token: legacy.refresh_token,
    expires: legacy.expires || 0,
    connectedAt: Date.now(),
    /* eBay refresh tokens last 18 months and then require the user to consent
       again. Recording the deadline is what lets the app warn before the
       reconnect lands in the middle of a publish. */
    refreshExpires: Date.now() + 540 * 24 * 60 * 60 * 1000,
    migratedFromDevice: true
  };
  await store.putEbayLink(user.email, link);
  forgetLegacy(deviceId);
  console.log(`  ✓ migrated device-keyed eBay link to ${user.email}`);
  return link;
}

async function ebayLinkFor(req, user) {
  const existing = await store.getEbayLink(user.email);
  if (existing) return existing;
  return claimLegacyLink(user, req.get('x-device-id'));
}

app.get('/api/ebay/status', async (req, res) => {
  const base = { configured: ebayConfigured(), env: EBAY_SANDBOX ? 'sandbox' : 'production' };
  let user;
  try {
    user = await accounts.currentUser(req);
  } catch {
    /* Storage down. Saying "not connected" here would send someone to reconnect
       an account that is connected perfectly well, so it says it does not know. */
    return res.status(503).json({ ...base, connected: false, unknown: true, code: 'unavailable' });
  }
  if (!user) return res.json({ ...base, connected: false, requiresSignIn: true });

  const link = await ebayLinkFor(req, user);
  res.json({
    ...base,
    connected: !!link,
    connectedAt: link?.connectedAt || null,
    /* Surfaced so the account screen can prompt for a reconnect on the user's
       own time rather than at the moment they try to list something. */
    reconsentDue: link?.refreshExpires || null
  });
});

app.get('/api/ebay/login', async (req, res) => {
  if (!ebayConfigured()) {
    return res.status(400).json({ error: 'eBay is not configured on this server. See README §eBay.' });
  }
  let user;
  try { user = await ebayUser(req); }
  catch (e) { return res.status(e.status || 500).json({ error: e.message, code: e.code }); }

  /* The state is signed and carries the email, rather than being a random key
     into a Map. A Map does not survive the restart that a free instance
     performs while the user is still on eBay's consent screen — which turned a
     successful authorisation into "Invalid or expired eBay login" often enough
     to look like the feature simply did not work. */
  const state = accounts.signPayload({ e: user.email, n: crypto.randomBytes(9).toString('base64url') }, 15 * 60_000);

  const url = `https://${EBAY_AUTH_HOST}/oauth2/authorize?client_id=${encodeURIComponent(process.env.EBAY_CLIENT_ID)}`
    + `&response_type=code&redirect_uri=${encodeURIComponent(process.env.EBAY_REDIRECT_URI_NAME)}`
    + `&scope=${encodeURIComponent(EBAY_SCOPES)}&state=${encodeURIComponent(state)}`;
  res.json({ url });
});

/* This page interpolates an error string that originated at eBay, so it gets
   escaped. Not a likely attack, but a server that reflects a third party's text
   into HTML unescaped is one upstream change away from being one. */
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* eBay sends the browser back here. Styled to match the app because it is a
   real screen a user reads, not a redirect they blink past. */
const callbackPage = (ok, heading, detail) => `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ok ? 'eBay connected' : 'eBay connection failed'}</title></head>
<body style="background:#000;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:24px">
<div style="max-width:340px">
  <div style="font-size:52px;color:${ok ? '#30D158' : '#FF5A4E'}">${ok ? '✓' : '✕'}</div>
  <h2 style="margin:12px 0 6px;font-size:22px;letter-spacing:-.02em">${heading}</h2>
  <p style="color:#86868B;font-size:14px;line-height:1.6;margin:0">${detail}</p>
</div>
${ok ? '<script>try{localStorage.setItem("rai.ebayJustLinked",String(Date.now()))}catch(e){};setTimeout(()=>window.close(),1600)</script>' : ''}
</body></html>`;

app.get('/api/ebay/callback', async (req, res) => {
  const { code, state } = req.query;
  const claim = accounts.readPayload(state);

  if (!code || !claim?.e) {
    return res.status(400).send(callbackPage(false, 'That link expired',
      'eBay sign-in links are good for fifteen minutes. Close this window and tap Connect again.'));
  }

  try {
    const r = await fetch(`https://${EBAY_API_HOST}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${ebayBasic()}` },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: process.env.EBAY_REDIRECT_URI_NAME
      })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error_description || 'Token exchange failed');

    /* eBay returns refresh_token_expires_in in seconds (about 18 months). Stored
       rather than assumed, because eBay is free to change it and a hardcoded
       guess would either warn too early or not at all. */
    const refreshTtl = Number(j.refresh_token_expires_in) || 540 * 24 * 60 * 60;

    const written = await store.putEbayLink(claim.e, {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires: Date.now() + (Number(j.expires_in || 7200) - 60) * 1000,
      connectedAt: Date.now(),
      refreshExpires: Date.now() + refreshTtl * 1000
    });

    /* No row to attach it to — the account was removed while the user was on
       eBay's consent screen. Saying "connected" here would be a lie the app
       would then have to walk back. */
    if (!written) {
      console.warn('ebay callback: no account row for', claim.e);
      return res.status(400).send(callbackPage(false, 'Could not save that connection',
        'We could not find your Fliparo account. Sign in again, then reconnect eBay.'));
    }

    console.log(`  ✓ eBay connected for ${claim.e}`);
    res.send(callbackPage(true, 'eBay connected',
      'This stays connected to your account — on every device, and after every restart. You can close this window.'));
  } catch (e) {
    console.error('ebay callback:', e.message);
    res.status(500).send(callbackPage(false, 'eBay connection failed', esc(e.message)));
  }
});

app.post('/api/ebay/disconnect', async (req, res) => {
  try {
    const user = await ebayUser(req);
    await store.clearEbayLink(user.email);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code });
  }
});

/* Returns a usable access token for this user, refreshing if needed and writing
   the refreshed pair back so the next process to start finds it already valid.
   Takes the user, never a device id. */
async function ebayToken(req, user) {
  const link = await ebayLinkFor(req, user);
  if (!link) {
    throw Object.assign(new Error('Connect your eBay account first.'),
      { status: 401, code: 'ebay_disconnected' });
  }
  if (link.access_token && Date.now() < link.expires) return link.access_token;

  const r = await fetch(`https://${EBAY_API_HOST}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${ebayBasic()}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: link.refresh_token, scope: EBAY_SCOPES })
  });
  const j = await r.json().catch(() => ({}));

  if (!r.ok) {
    /* Only drop the stored link when eBay says the GRANT is dead. A 500 from
       eBay, or a network wobble, used to delete the refresh token and force a
       full reconnect over what was a transient failure. */
    const fatal = r.status === 400 || r.status === 401;
    if (fatal) {
      await store.clearEbayLink(user.email);
      throw Object.assign(new Error('Your eBay connection expired. Reconnect to keep listing.'),
        { status: 401, code: 'ebay_disconnected' });
    }
    console.error('ebay refresh transient failure:', r.status, JSON.stringify(j));
    throw Object.assign(new Error('eBay is not responding right now. Your connection is fine — try again shortly.'),
      { status: 503, code: 'ebay_unavailable' });
  }

  const refreshed = {
    ...link,
    access_token: j.access_token,
    expires: Date.now() + (Number(j.expires_in || 7200) - 60) * 1000
  };
  await store.putEbayLink(user.email, refreshed);
  return refreshed.access_token;
}

/* our condition words -> eBay's official condition enums

   NEW_WITH_TAGS and NEW_WITHOUT_TAGS are NOT members of the Inventory API's
   ConditionEnum — they are Trading API vocabulary. Sending either one gets the
   whole inventory item rejected with

     The request has errors. (reason=Could not serialize field [condition])

   which reads like a malformed body rather than an unknown word. The Inventory
   API spells condition id 1000 as NEW and 1500 as NEW_OTHER, so those are what
   a brand-new item has to be sent as. */
const EBAY_CONDITION = {
  'New with tags': 'NEW',
  'New without tags': 'NEW_OTHER',
  'Excellent': 'USED_EXCELLENT',
  'Very Good': 'USED_VERY_GOOD',
  'Good': 'USED_GOOD',
  'Fair': 'USED_ACCEPTABLE',
  'Poor': 'USED_ACCEPTABLE'
};

/* The model is asked for one of the seven grades above, but it is a model, so
   it sometimes answers "Brand New" or "new with box". Matching those loosely
   is the difference between a correct listing and a brand-new pair of shoes
   going out as USED_EXCELLENT, which is the old default for anything
   unrecognised — wrong in a way the seller only discovers from a buyer. */
function gradeToCondition(grade) {
  const g = String(grade || '').trim();
  if (!g) return 'USED_EXCELLENT';
  if (EBAY_CONDITION[g]) return EBAY_CONDITION[g];

  const k = g.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  const hit = Object.keys(EBAY_CONDITION)
    .find(name => name.toLowerCase() === k);
  if (hit) return EBAY_CONDITION[hit];

  if (/\bnew\b/.test(k)) {
    /* "new without tags", "new without box", "new no tags" → 1500. Anything
       else that says new — including a bare "new" or "brand new" → 1000. */
    return /\b(without|no|missing)\b/.test(k) ? 'NEW_OTHER' : 'NEW';
  }
  if (/\b(parts|not working|broken)\b/.test(k)) return 'FOR_PARTS_OR_NOT_WORKING';
  if (/\b(mint|like new)\b/.test(k))            return 'LIKE_NEW';
  if (/\b(very good)\b/.test(k))                return 'USED_VERY_GOOD';
  if (/\b(good)\b/.test(k))                     return 'USED_GOOD';
  if (/\b(fair|poor|acceptable|worn)\b/.test(k)) return 'USED_ACCEPTABLE';

  console.warn(`[ebay] unrecognised condition grade "${g}" — defaulting to USED_EXCELLENT`);
  return 'USED_EXCELLENT';
}

/* ──────────────────────── conditions are per-category ───────────────────────
   This is the 25021 that stops a publish with "The provided condition id is
   invalid for the selected primary category id."

   eBay's graded used conditions — VERY_GOOD (4000), GOOD (5000), ACCEPTABLE
   (6000), LIKE_NEW (2750) — exist only in the media categories: books, movies,
   music, video games. Everywhere else there is exactly one used condition,
   USED_EXCELLENT (3000), which eBay shows to buyers as plain "Used".

   Our grade vocabulary is Excellent / Very Good / Good / Fair / Poor, so four
   of the five map to ids that most categories reject — and the default for an
   unknown grade was USED_GOOD, the very id in the error. A Pokemon card lot
   and a bottle of perfume both fail, for the same reason.

   So: ask eBay which conditions the chosen category actually allows, and if
   the one we want is not on the list, walk to the nearest one that is. The
   lookup is cached per category and never fatal — if it fails we send what we
   were going to send anyway, which is no worse than before.                  */
const EBAY_CONDITION_ID = {
  NEW: 1000, NEW_WITH_TAGS: 1000, NEW_WITHOUT_TAGS: 1500, NEW_OTHER: 1500,
  NEW_WITH_DEFECTS: 1750, MANUFACTURER_REFURBISHED: 2000,
  CERTIFIED_REFURBISHED: 2000, EXCELLENT_REFURBISHED: 2010,
  VERY_GOOD_REFURBISHED: 2020, GOOD_REFURBISHED: 2030,
  SELLER_REFURBISHED: 2500, LIKE_NEW: 2750, PRE_OWNED_EXCELLENT: 2990,
  USED_EXCELLENT: 3000, PRE_OWNED_FAIR: 3010,
  USED_VERY_GOOD: 4000, USED_GOOD: 5000, USED_ACCEPTABLE: 6000,
  FOR_PARTS_OR_NOT_WORKING: 7000
};

const EBAY_CONDITION_ENUM = {
  1000: 'NEW', 1500: 'NEW_OTHER', 1750: 'NEW_WITH_DEFECTS',
  2000: 'MANUFACTURER_REFURBISHED', 2010: 'EXCELLENT_REFURBISHED',
  2020: 'VERY_GOOD_REFURBISHED', 2030: 'GOOD_REFURBISHED',
  2500: 'SELLER_REFURBISHED', 2750: 'LIKE_NEW', 2990: 'PRE_OWNED_EXCELLENT',
  3000: 'USED_EXCELLENT', 3010: 'PRE_OWNED_FAIR', 4000: 'USED_VERY_GOOD',
  5000: 'USED_GOOD', 6000: 'USED_ACCEPTABLE', 7000: 'FOR_PARTS_OR_NOT_WORKING'
};

/* The only strings the Inventory API will accept in `condition`. Anything else
   — including a perfectly sensible Trading API name — comes back as "Could not
   serialize field [condition]" with no hint as to which word was wrong. Every
   value this file sends is passed through canonicalCondition() first, so an
   alias can never reach eBay again. */
const EBAY_VALID_CONDITIONS = new Set([
  'NEW', 'LIKE_NEW', 'NEW_OTHER', 'NEW_WITH_DEFECTS',
  'MANUFACTURER_REFURBISHED', 'CERTIFIED_REFURBISHED', 'EXCELLENT_REFURBISHED',
  'VERY_GOOD_REFURBISHED', 'GOOD_REFURBISHED', 'SELLER_REFURBISHED',
  'USED_EXCELLENT', 'USED_VERY_GOOD', 'USED_GOOD', 'USED_ACCEPTABLE',
  'FOR_PARTS_OR_NOT_WORKING', 'PRE_OWNED_EXCELLENT', 'PRE_OWNED_FAIR'
]);

/* Returns a value eBay will accept, or null meaning "omit the field". */
function canonicalCondition(value) {
  if (!value) return null;
  if (EBAY_VALID_CONDITIONS.has(value)) return value;

  const viaId = EBAY_CONDITION_ENUM[EBAY_CONDITION_ID[value]];
  if (viaId && EBAY_VALID_CONDITIONS.has(viaId)) {
    console.log(`[ebay] condition alias ${value} rewritten to ${viaId}`);
    return viaId;
  }

  console.error(`[ebay] no valid ConditionEnum for "${value}" — omitting the field`);
  return null;
}

/* Nearest acceptable substitute, best first. Every used grade falls back to
   3000 before anything else, because outside media that is the only "used"
   there is. */
const EBAY_CONDITION_FALLBACK = {
  1000: [1500, 2750, 3000],
  1500: [1000, 2750, 3000],
  1750: [1500, 3000],
  2000: [2500, 3000],
  2500: [2000, 3000],
  2750: [3000, 2990, 1500, 4000],
  2990: [3000, 4000, 2750, 5000],
  3000: [2990, 4000, 2750, 5000, 6000],
  3010: [6000, 3000, 5000],
  4000: [3000, 2990, 5000, 6000],
  5000: [3000, 4000, 6000, 3010],
  6000: [3010, 3000, 5000, 7000],
  7000: [6000, 3000]
};

const conditionPolicyCache = new Map();

async function ebayConditionPolicy(token, categoryId) {
  const key = String(categoryId);
  if (conditionPolicyCache.has(key)) return conditionPolicyCache.get(key);

  let policy = null;
  try {
    const j = await ebayFetch(token,
      `/sell/metadata/v1/marketplace/EBAY_US/get_item_condition_policies` +
      `?filter=${encodeURIComponent(`categoryIds:{${key}}`)}`);
    const p = j?.itemConditionPolicies?.[0];
    if (p) {
      policy = {
        required: p.itemConditionRequired !== false,
        ids: new Set((p.itemConditions || []).map(c => Number(c.conditionId)))
      };
    }
  } catch (e) {
    /* Not fatal. A metadata outage or a missing scope must not stop a listing
       that would otherwise have gone out. */
    console.error('[ebay] condition policy lookup failed for', key, '—', e.message);
  }

  conditionPolicyCache.set(key, policy);
  return policy;
}

/* Returns the enum to send, or null meaning "omit the field entirely". */
async function resolveEbayCondition(token, categoryId, wanted) {
  /* Every exit below goes through canonicalCondition(). The category lookup is
     about picking a condition eBay allows *here*; canonicalisation is about
     spelling it the way the Inventory API spells it. Both have to happen, and
     skipping the second on the happy path is what sent NEW_WITH_TAGS to eBay. */
  const policy = await ebayConditionPolicy(token, categoryId);
  if (!policy) return canonicalCondition(wanted);   // lookup failed — unchanged
  if (!policy.ids.size) return policy.required ? canonicalCondition(wanted) : null;

  const wantedId = EBAY_CONDITION_ID[wanted];
  if (wantedId && policy.ids.has(wantedId)) return canonicalCondition(wanted);

  for (const id of (EBAY_CONDITION_FALLBACK[wantedId] || [3000, 1000])) {
    if (policy.ids.has(id)) {
      console.log(`[ebay] condition ${wanted} (${wantedId}) not valid in category ${categoryId}; using ${EBAY_CONDITION_ENUM[id]} (${id})`);
      return canonicalCondition(EBAY_CONDITION_ENUM[id]);
    }
  }

  const first = [...policy.ids][0];
  return canonicalCondition(EBAY_CONDITION_ENUM[first]) || canonicalCondition(wanted);
}

/* ─────────────────────────── description hygiene ────────────────────────────
   The model returns the description as plain text with \n line breaks, and it
   used to go to eBay exactly as written. eBay parses a description as HTML, so
   three things in ordinary prose break the publish call:

     • a bare &  — "Pokemon & friends" is an unterminated entity
     • a bare < or >  — "<3", "10 > 9" open a tag that never closes
     • \n  — not a line break in HTML, so the listing renders as one blob

   and two more get the offer rejected outright:

     • an empty or whitespace-only description
     • a description past the field's limit (4000 chars on the inventory item's
       product.description; the offer's listingDescription allows far more)

   Escape first, then turn the newlines into <br>, so the breaks we add survive
   the escaping. Truncation never lands inside an entity or a tag.            */
function ebayDescription(text, { limit = 4000 } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return 'See photos for condition and details.';

  const html = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{2,}/g, '<br><br>')
    .replace(/\n/g, '<br>');

  if (html.length <= limit) return html;
  return html.slice(0, limit - 1)
    .replace(/&[a-z]*$/i, '')   // half-written entity
    .replace(/<[^>]*$/, '')     // half-written tag
    + '…';
}

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

    /* trim() before anything else: a trailing space in the PUBLIC_URL env var
       survives into every image URL and eBay rejects the lot with "Invalid
       value for imageUrl", pointing at the photo rather than at the config. */
    const base = (process.env.PUBLIC_URL || '').trim().replace(/[\s/]+$/, '') || `https://${req.get('host')}`;
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

/* ───────────────────────── required item aspects ────────────────────────────
   The second thing that stops a publish once the condition is right. Most
   categories declare aspects the listing must carry — Athletic Shoes wants
   Brand, US Shoe Size, Department and Type — and eBay rejects the offer with

     25002: A required item specific is missing

   naming one aspect at a time, so fixing them by trial and error costs one
   round trip each. Ask the taxonomy service what this category requires, then
   fill what the scan already knows.

   Two rules keep this from inventing listings. A value is only sent for an
   aspect eBay actually asked for, and where the aspect has a closed list of
   permitted values, ours has to match one of them or it is dropped — a wrong
   value is rejected exactly like a missing one, but a wrong value that IS
   accepted becomes a listing that misdescribes the item.

   Everything here is best-effort. Any failure leaves the aspects exactly as
   they were, which is no worse than before.                                  */
const aspectPolicyCache = new Map();

async function ebayCategoryAspects(token, categoryId) {
  const key = String(categoryId);
  if (aspectPolicyCache.has(key)) return aspectPolicyCache.get(key);

  let list = [];
  try {
    const tree = await ebayCategoryTree(token);
    if (tree) {
      const j = await ebayFetch(token,
        `/commerce/taxonomy/v1/category_tree/${tree}/get_item_aspects_for_category?category_id=${encodeURIComponent(key)}`);
      list = Array.isArray(j?.aspects) ? j.aspects : [];
    }
  } catch (e) {
    console.error('[ebay] aspect lookup failed for', key, '—', e.message);
  }

  aspectPolicyCache.set(key, list);
  return list;
}

const normAspect = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/* eBay's name for a thing is rarely our name for it. */
const ASPECT_ALIASES = {
  brand:        ['brand', 'make', 'manufacturer'],
  size:         ['size', 'ussize', 'usshoesize', 'shoesize', 'mensshoesize',
                 'womensshoesize', 'clothingsize', 'sizetype'],
  colorway:     ['color', 'colour', 'maincolor', 'maincolour', 'primarycolor'],
  materials:    ['material', 'outermaterial', 'uppermaterial', 'fabrictype', 'fabric'],
  styleCode:    ['stylecode', 'stylenumber', 'mpn', 'manufacturerpartnumber',
                 'manufacturersku', 'productline'],
  productName:  ['model', 'modelname', 'stylename', 'series'],
  subcategory:  ['type', 'style', 'producttype', 'shoetype'],
  yearEra:      ['year', 'yearmanufactured', 'releaseyear', 'yearofmanufacture']
};

/* Aspects where "Does Not Apply" is the correct answer rather than a dodge:
   eBay documents it for identifiers a second-hand seller genuinely has not
   got. Filling these is what stops a required-aspect rejection on an item
   whose box went in the bin years ago. */
const NOT_APPLICABLE_OK = new Set([
  'upc', 'ean', 'isbn', 'gtin', 'mpn', 'manufacturerpartnumber'
]);

function departmentFrom(item, listing) {
  const hay = `${listing?.title || ''} ${item?.productName || ''} ${item?.subcategory || ''} ${item?.category || ''}`.toLowerCase();
  if (/\b(unisex)\b/.test(hay))                 return 'Unisex Adult';
  if (/\b(women|womens|women's|ladies)\b/.test(hay)) return 'Women';
  if (/\b(men|mens|men's)\b/.test(hay))         return 'Men';
  if (/\b(girls|girl's)\b/.test(hay))           return 'Girls';
  if (/\b(boys|boy's)\b/.test(hay))             return 'Boys';
  if (/\b(kids|youth|toddler|infant|baby)\b/.test(hay)) return 'Unisex Kids';
  return null;
}

async function buildAspects(token, categoryId, item, listing, base) {
  const aspects = { ...base };

  const spec = await ebayCategoryAspects(token, categoryId);
  if (!spec.length) return { aspects, unfilled: [] };

  /* What we could offer, keyed by every name eBay might use for it. */
  const pool = new Map();
  const offer = (sourceKey, value) => {
    const v = String(value ?? '').trim();
    if (!v) return;
    for (const alias of (ASPECT_ALIASES[sourceKey] || [])) {
      if (!pool.has(alias)) pool.set(alias, v);
    }
  };
  offer('brand', item.brand);
  offer('size', item.size);
  offer('colorway', item.colorway);
  offer('materials', item.materials);
  offer('styleCode', item.styleCode);
  offer('productName', item.productName);
  offer('subcategory', item.subcategory);
  offer('yearEra', item.yearEra);

  const dept = departmentFrom(item, listing);
  if (dept) { pool.set('department', dept); pool.set('gender', dept); }

  const unfilled = [];

  for (const a of spec) {
    const name = a?.localizedAspectName;
    if (!name) continue;

    const c = a.aspectConstraint || {};
    const required = c.aspectRequired === true;
    if (!required && aspects[name]) continue;   // already set by the caller
    if (!required) continue;                    // only chase what eBay demands
    if (aspects[name]?.length) continue;

    const key = normAspect(name);
    let value = pool.get(key) || null;

    /* A closed list means our free text has to BE one of eBay's values. Exact
       first, then case-insensitive, then a contains-match in either direction
       so "Nike Air Jordan" can satisfy a "Nike" option. */
    const allowed = (a.aspectValues || []).map(v => v?.localizedValue).filter(Boolean);
    if (allowed.length && c.aspectMode === 'SELECTION_ONLY') {
      const want = String(value || '').toLowerCase();
      value = (want && (
        allowed.find(v => v.toLowerCase() === want) ||
        allowed.find(v => v.toLowerCase().includes(want)) ||
        allowed.find(v => want.includes(v.toLowerCase()))
      )) || null;
    }

    if (!value && NOT_APPLICABLE_OK.has(key)) value = 'Does Not Apply';

    if (!value) { unfilled.push(name); continue; }

    const max = Number(c.aspectMaxLength) || 65;
    aspects[name] = [String(value).slice(0, max)];
  }

  if (unfilled.length) {
    console.warn(`[ebay] category ${categoryId} requires aspects we cannot fill: ${unfilled.join(', ')}`);
  }
  return { aspects, unfilled };
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
    /* eBay's top-level message for a rejected body is "Invalid request — The
       request has errors", which names nothing. What is actually wrong lives in
       errors[].parameters (the offending field) and in the second and later
       entries of errors[]. Flatten all of it into the thrown message, and log
       the raw payload, so a failed publish points at a field instead of at the
       documentation. */
    const errs = Array.isArray(json?.errors) ? json.errors : [];

    const described = errs.map(e => {
      const params = (e.parameters || [])
        .map(p => `${p.name}=${p.value}`)
        .join(', ');
      const text = e.longMessage || e.message || `error ${e.errorId}`;
      return params ? `${text} (${params})` : text;
    });

    const msg = described.length
      ? described.join(' · ')
      : (json?.message || `eBay error ${r.status}`);

    console.error('[ebay]', opts.method || 'GET', endpoint, r.status, JSON.stringify(json));

    throw Object.assign(new Error(msg), {
      status: r.status,
      ebayErrors: errs,
      errorIds: errs.map(e => e.errorId)
    });
  }
  return json;
}

/* Full publish chain: inventory item -> offer -> publish */
app.post('/api/ebay/publish', async (req, res) => {
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

    /* Fail here rather than at eBay. An offer sent with an undefined policy id
       loses the key entirely in JSON.stringify, and eBay answers with a bare
       "Invalid request — The request has errors", naming nothing. Checking
       first turns that dead end into an instruction. */
    const missingCfg = [
      ['EBAY_FULFILLMENT_POLICY_ID', process.env.EBAY_FULFILLMENT_POLICY_ID],
      ['EBAY_PAYMENT_POLICY_ID',     process.env.EBAY_PAYMENT_POLICY_ID],
      ['EBAY_RETURN_POLICY_ID',      process.env.EBAY_RETURN_POLICY_ID]
    ].filter(([, v]) => !v).map(([k]) => k);

    if (missingCfg.length) {
      return res.status(400).json({
        code: 'EBAY_POLICIES_MISSING',
        error: `eBay business policies are not configured on the server (${missingCfg.join(', ')}). `
             + 'Open /api/ebay/setup-check while signed in — it reads the ids off your eBay account and prints them.',
        missing: missingCfg
      });
    }

    /* checkListingAllowed already proved there is a signed-in user on a plan
       that includes auto-listing, so this reuses it rather than re-reading. */
    const token = await ebayToken(req, allowed.user);
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

    /* eBay fetches every photo itself, so a data: URL or an http one is not a
       worse photo — it is one that cannot arrive. Filter first, then insist on
       at least one, because an offer with no picture is rejected at publish. */
    const photos = (Array.isArray(imageUrls) ? imageUrls : [])
      .map(u => String(u || '').trim())
      .filter(u => /^https:\/\//i.test(u))
      .slice(0, 12);

    if (!photos.length) {
      return res.status(400).json({
        code: 'EBAY_PHOTOS_REQUIRED',
        error: 'eBay needs at least one photo, served over https, before it will accept a listing.'
      });
    }

    /* "$1,250" and undefined both become the string eBay rejects. Normalise to
       a plain decimal here so the offer never carries a price it cannot read. */
    const priceNum = Number(String(listing.suggestedPrice ?? '').replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      return res.status(400).json({
        code: 'EBAY_PRICE_REQUIRED',
        error: 'Set a price before listing.'
      });
    }
    const priceValue = priceNum.toFixed(2);

    /* The seller's own words about condition. eBay wants them in
       conditionDescription, buyers read them in the description, and a used
       item published without them is the single most common source of "not as
       described" cases — so this is required rather than optional. */
    const conditionNote = String(
      req.body.conditionNote ?? listing.conditionNote ?? item.conditionSummary ?? ''
    ).trim();

    if (conditionNote.length < 15) {
      return res.status(400).json({
        code: 'EBAY_CONDITION_NOTE_REQUIRED',
        field: 'conditionNote',
        error: 'Describe the condition in your own words before listing — what a buyer would '
             + 'want to know about wear, flaws and what is included.',
        suggestion: String(item.conditionSummary || '').trim() || undefined
      });
    }

    const baseAspects = {};
    if (item.brand)     baseAspects.Brand = [String(item.brand)];
    if (item.size)      baseAspects.Size = [String(item.size)];
    if (item.colorway)  baseAspects.Color = [String(item.colorway)];
    if (item.materials) baseAspects.Material = [String(item.materials)];
    if (item.styleCode) baseAspects['Style Code'] = [String(item.styleCode)];

    /* Anything the seller typed into the "details eBay needs" prompt wins over
       what the scan guessed — they are holding the item and we are not. */
    for (const [name, value] of Object.entries(req.body.aspects || {})) {
      const v = String(Array.isArray(value) ? value[0] : value ?? '').trim();
      if (v) baseAspects[String(name)] = [v.slice(0, 65)];
    }

    const { aspects, unfilled } = await buildAspects(token, categoryId, item, listing, baseAspects);

    /* Ask the seller rather than letting eBay refuse the offer. Returned before
       anything is created, so nothing has to be cleaned up afterwards. */
    if (unfilled.length) {
      const spec = await ebayCategoryAspects(token, categoryId);
      const needed = unfilled.map(name => {
        const a = spec.find(x => x?.localizedAspectName === name) || {};
        const values = (a.aspectValues || []).map(v => v?.localizedValue).filter(Boolean);
        return {
          name,
          mode: a.aspectConstraint?.aspectMode || 'FREE_TEXT',
          values: values.slice(0, 60),
          maxLength: Number(a.aspectConstraint?.aspectMaxLength) || 65
        };
      });

      return res.status(400).json({
        code: 'EBAY_ASPECTS_REQUIRED',
        error: `eBay requires ${unfilled.join(', ')} for this category.`,
        needed, categoryId, categoryName
      });
    }

    // 1. inventory item
    /* USED_EXCELLENT, not USED_GOOD, is the safe default: 3000 is the only
       used condition that exists outside the media categories. */
    const wantedCondition = gradeToCondition(item.conditionGrade);
    const condition = await resolveEbayCondition(token, categoryId, wantedCondition);

    /* eBay accepts conditionDescription only on the used conditions — send it
       with NEW or NEW_OTHER and the whole call is rejected. It caps at 1000. */
    const usedCondition = /^(USED_|PRE_OWNED_|FOR_PARTS)/.test(String(condition || ''));
    const conditionDescription = usedCondition
      ? conditionNote.slice(0, 1000)
      : undefined;

    /* The same words go in the body copy, because conditionDescription is shown
       in a panel many buyers scroll straight past. Skipped when the description
       already says it, so nobody reads it twice. */
    const sellerDescription = String(listing.description || '').trim();
    const fullDescription = sellerDescription.toLowerCase().includes(conditionNote.toLowerCase())
      ? sellerDescription
      : `${sellerDescription}\n\nCondition\n${conditionNote}`.trim();

    await ebayFetch(token, `/sell/inventory/v1/inventory_item/${sku}`, {
      method: 'PUT',
      body: JSON.stringify({
        availability: { shipToLocationAvailability: { quantity: 1 } },
        condition: condition || undefined,
        conditionDescription,
        product: {
          title: String(listing.title || '').trim().slice(0, 80) || 'Untitled item',
          description: ebayDescription(fullDescription),
          aspects,
          imageUrls: photos
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
        listingDescription: ebayDescription(fullDescription, { limit: 500000 }),
        pricingSummary: { price: { value: priceValue, currency: 'USD' } },
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
      categoryId, categoryName, photos: photos.length,
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
   eBay one-time setup check
   ----------------------------------------------------------------------------
   Publishing needs four values that live in environment variables: three
   business policy ids and a merchant location key. Reading them out of eBay
   normally means hand-rolling authenticated calls with a bearer token, which is
   an unpleasant way to start.

   This route does it for you. Connect eBay in the app first, then open:

     /api/ebay/setup-check?zip=97205&state=OR&city=Portland

   It reports which policies exist, creates the inventory location if it is
   missing, and prints the exact lines to paste into your host's environment.
   It only reads and creates the location — it publishes nothing.
   -------------------------------------------------------------------------- */
app.get('/api/ebay/setup-check', async (req, res) => {
  try {
    const user = await ebayUser(req);
    const token = await ebayToken(req, user);
    const mp = 'marketplace_id=EBAY_US';

    const [ful, pay, ret] = await Promise.all([
      ebayFetch(token, `/sell/account/v1/fulfillment_policy?${mp}`).catch(e => ({ _err: e.message })),
      ebayFetch(token, `/sell/account/v1/payment_policy?${mp}`).catch(e => ({ _err: e.message })),
      ebayFetch(token, `/sell/account/v1/return_policy?${mp}`).catch(e => ({ _err: e.message }))
    ]);

    const first = (o, k) => (o && !o._err && Array.isArray(o[k]) && o[k][0]) || null;
    const f = first(ful, 'fulfillmentPolicies');
    const p = first(pay, 'paymentPolicies');
    const r = first(ret, 'returnPolicies');

    /* Inventory locations have no Seller Hub screen — they exist only through
       the API — so create one rather than sending you looking for a page that
       is not there. */
    const key = process.env.EBAY_MERCHANT_LOCATION_KEY || 'default-location';
    let location = 'exists';
    try {
      await ebayFetch(token, `/sell/inventory/v1/location/${encodeURIComponent(key)}`);
    } catch (e) {
      if (e.status !== 404) {
        location = `error: ${e.message}`;
      } else if (!req.query.zip) {
        location = 'missing — re-open this URL with ?zip=YOURZIP&state=XX&city=Yourtown to create it';
      } else {
        try {
          await ebayFetch(token, `/sell/inventory/v1/location/${encodeURIComponent(key)}`, {
            method: 'POST',
            body: JSON.stringify({
              location: { address: {
                city: req.query.city || '', stateOrProvince: req.query.state || '',
                postalCode: String(req.query.zip), country: req.query.country || 'US'
              } },
              locationTypes: ['WAREHOUSE'],
              merchantLocationStatus: 'ENABLED'
            })
          });
          location = 'created';
        } catch (e2) { location = `could not create: ${e2.message}`; }
      }
    }

    const missing = [];
    if (!f) missing.push('fulfillment (shipping) policy');
    if (!p) missing.push('payment policy');
    if (!r) missing.push('return policy');

    res.json({
      ready: !missing.length && (location === 'exists' || location === 'created'),
      missingPolicies: missing,
      hint: missing.length
        ? 'Create these in Seller Hub → Account → Business Policies, then reload this URL.'
        : 'Paste the four lines in envToSet into your host environment, then redeploy.',
      merchantLocation: { key, status: location },
      envToSet: {
        EBAY_FULFILLMENT_POLICY_ID: f?.fulfillmentPolicyId || null,
        EBAY_PAYMENT_POLICY_ID:     p?.paymentPolicyId     || null,
        EBAY_RETURN_POLICY_ID:      r?.returnPolicyId      || null,
        EBAY_MERCHANT_LOCATION_KEY: key
      },
      policyNames: { fulfillment: f?.name || null, payment: p?.name || null, return: r?.name || null },
      errors: [ful._err, pay._err, ret._err].filter(Boolean)
    });
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message,
      code: e.code,
      hint: 'This endpoint identifies you by your session token, which a browser address bar '
          + 'never sends — so opening the URL directly always lands here. Run it from the app instead: '
          + 'Profile → Settings → Diagnostics → eBay setup check.'
    });
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
/* --------------------------------------------------------------------------
   Create the three business policies
   ----------------------------------------------------------------------------
   eBay will not publish an offer without a payment, return and fulfillment
   policy, and the page for creating them by hand moves around inside Seller
   Hub. The Account API can create all three, so this does — including the
   program opt-in, which is itself a prerequisite and easy to miss.

   These are deliberately plain defaults. They are a starting point that lets
   publishing work today; the seller can refine them in Seller Hub afterwards
   and the ids stay the same.
   -------------------------------------------------------------------------- */
const POLICY_BODIES = {
  payment: {
    path: '/sell/account/v1/payment_policy',
    key: 'paymentPolicyId',
    body: {
      name: 'Fliparo default payment',
      marketplaceId: 'EBAY_US',
      categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
      immediatePay: true
    }
  },
  return: {
    path: '/sell/account/v1/return_policy',
    key: 'returnPolicyId',
    body: {
      name: 'Fliparo default returns',
      marketplaceId: 'EBAY_US',
      categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
      returnsAccepted: true,
      returnPeriod: { value: 30, unit: 'DAY' },
      returnShippingCostPayer: 'BUYER',
      refundMethod: 'MONEY_BACK'
    }
  },
  fulfillment: {
    path: '/sell/account/v1/fulfillment_policy',
    key: 'fulfillmentPolicyId',
    /* Built per-attempt — see SHIPPING_CANDIDATES below. */
    body: null
  }
};

/* Valid shipping service codes are per-marketplace, change over time, and are
   not exposed by any REST endpoint we can query — eBay simply rejects an
   unknown one with UNKNOWN_SHIPPING_SERVICE_CODE and no list of alternatives.
   So try the plausible ones in order and keep the first eBay accepts. The
   carrier code is deliberately omitted: eBay derives it from the service, and
   supplying a mismatched pair is its own error. */
const SHIPPING_CANDIDATES = [
  'USPSGroundAdvantage',
  'USPSPriority',
  'USPSParcel',
  'USPSFirstClass',
  'UPSGround',
  'FedExHomeDelivery',
  'ShippingMethodStandard',
  'Other'
];

const fulfillmentBody = serviceCode => ({
  name: 'Fliparo default shipping',
  marketplaceId: 'EBAY_US',
  categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
  handlingTime: { value: 2, unit: 'DAY' },
  shippingOptions: [{
    optionType: 'DOMESTIC',
    costType: 'FLAT_RATE',
    shippingServices: [{
      sortOrder: 1,
      shippingServiceCode: serviceCode,
      shippingCost: { value: '0.00', currency: 'USD' },
      freeShipping: true,
      buyerResponsibleForShipping: false
    }]
  }]
});

app.post('/api/ebay/create-policies', async (req, res) => {
  try {
    const user = await ebayUser(req);
    const token = await ebayToken(req, user);

    /* Business policies live behind a program opt-in. Opting in twice is
       harmless and returns an error saying so, which is not a failure. */
    let optIn = '';
    try {
      await ebayFetch(token, '/sell/account/v1/program/opt_in', {
        method: 'POST',
        body: JSON.stringify({ programType: 'SELLING_POLICY_MANAGEMENT' })
      });
      optIn = 'opted in';
    } catch (e) {
      /* Opting in twice errors, and that error is a success for our purposes.
         Which it is gets settled by the check below, not by this message. */
      optIn = e.message;
    }

    /* "User is not eligible for Business Policy" is what every policy call
       returns until this program is active, and the opt-in call itself is not
       proof — so read the enrolled list back and say plainly whether it took. */
    let optedIn = null;
    try {
      const programs = await ebayFetch(token, '/sell/account/v1/program/get_opted_in_programs');
      const list = (programs?.programs || []).map(p => p.programType);
      optedIn = list.includes('SELLING_POLICY_MANAGEMENT');
      optIn = optedIn
        ? 'Business policies program is active.'
        : `Not enrolled in the business policies program. eBay said: ${optIn}`;
    } catch (e) {
      optIn = `Could not confirm enrolment: ${e.message}`;
    }

    if (optedIn === false) {
      return res.json({
        ok: false, optIn, optedIn, created: {}, failed: {},
        next: 'eBay refused the enrolment. That is an account-level restriction, not a code problem — '
            + 'the account must be a registered seller with eBay-managed payments active before it can '
            + 'use business policies.'
      });
    }

    const created = {};
    const failed = {};

    for (const [kind, spec] of Object.entries(POLICY_BODIES)) {
      /* Never create a second copy of something that already exists. */
      try {
        const existing = await ebayFetch(token, `${spec.path}?marketplace_id=EBAY_US`);
        const listKey = Object.keys(existing || {}).find(k => Array.isArray(existing[k]));
        const first = listKey && existing[listKey][0];
        if (first) { created[kind] = { id: first[spec.key], reused: true, name: first.name }; continue; }
      } catch { /* fall through and try to create one */ }

      if (kind === 'fulfillment') {
        /* Walk the candidate service codes; stop at the first that is accepted. */
        const tried = [];
        let done = false;
        for (const code of SHIPPING_CANDIDATES) {
          try {
            const made = await ebayFetch(token, spec.path, {
              method: 'POST',
              body: JSON.stringify(fulfillmentBody(code))
            });
            created[kind] = { id: made[spec.key], reused: false, name: `Fliparo default shipping (${code})`, serviceCode: code };
            done = true;
            break;
          } catch (e) {
            tried.push(`${code}: ${e.message}`);
            /* Anything that is not "that code does not exist" will fail for
               every code, so stop rather than making seven identical calls. */
            if (!/UNKNOWN_SHIPPING_SERVICE_CODE|LOGISTICS_INFO_IS_MISSING/i.test(e.message)) break;
          }
        }
        if (!done) failed[kind] = tried.join(' | ');
        continue;
      }

      try {
        const made = await ebayFetch(token, spec.path, {
          method: 'POST',
          body: JSON.stringify(spec.body)
        });
        created[kind] = { id: made[spec.key], reused: false, name: spec.body.name };
      } catch (e) {
        failed[kind] = e.message;
      }
    }

    res.json({
      optIn,
      optedIn,
      created,
      failed,
      ok: Object.keys(failed).length === 0,
      next: Object.keys(failed).length === 0
        ? 'Run the setup check again to read the ids and get your Render lines.'
        : 'Some policies could not be created — the messages above name the field eBay rejected.'
    });
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message,
      hint: 'Connect eBay in the app first (Profile → eBay).'
    });
  }
});

/* Why am I being asked to sign in again?
   ----------------------------------------------------------------------------
   A sign-in that appears to work but leaves you signed out has three possible
   causes and they are indistinguishable from the outside: the token failed its
   signature check (SESSION_SECRET changed since it was issued), the database is
   unreachable (so the account cannot be read back), or the account row is
   genuinely absent. This says which. Safe to call signed-out. */
app.get('/api/auth/whoami', async (req, res) => {
  const raw = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const out = {
    tokenSent: !!raw,
    sessionSecretSet: !!process.env.SESSION_SECRET,
    dbDriver: store.DRIVER
  };

  try {
    await store.ready();
    out.dbReachable = true;
  } catch (e) {
    out.dbReachable = false;
    out.dbError = e.message;
  }

  if (raw) {
    const t = accounts.inspectToken(raw);
    const email = t?.email || null;
    out.tokenValid = !!email;
    if (t) {
      out.tokenIssuedAt = new Date(t.issuedAt).toISOString();
      out.tokenAgeDays = Math.floor((Date.now() - t.issuedAt) / 86_400_000);
      out.tokenRenewsSoon = accounts.shouldRenew(t.issuedAt);
    }
    if (!email) {
      out.diagnosis = out.sessionSecretSet
        ? 'Token failed its signature check. SESSION_SECRET almost certainly changed after this token was issued — sign out and sign in again to get a fresh one.'
        : 'Token failed its signature check and SESSION_SECRET is not set, so the secret is derived from ANTHROPIC_API_KEY. Rotating that key invalidates every session. Set SESSION_SECRET to a fixed random value.';
    } else {
      out.email = email;
      try {
        out.accountFound = !!(await store.getUser(email));
        if (out.accountFound) {
          /* The other half of "why am I being asked to do this again" — an eBay
             link that looks connected in the UI and is not there on the server.
             Reported here so both halves of the session story are in one place. */
          const link = await store.getEbayLink(email).catch(() => null);
          out.ebayLinked = !!link;
          if (link) {
            out.ebayConnectedAt = link.connectedAt ? new Date(link.connectedAt).toISOString() : null;
            out.ebayReconsentDue = link.refreshExpires ? new Date(link.refreshExpires).toISOString() : null;
          }
        }
        if (!out.accountFound) {
          out.diagnosis = out.dbReachable
            ? 'Token is valid but no account row exists for it. The account was never written, or the database was replaced.'
            : 'Token is valid but the database is unreachable, so the account cannot be read. Check DATABASE_URL — a rotated database password is the usual cause.';
        }
      } catch (e) {
        out.accountFound = false;
        out.accountError = e.message;
        out.diagnosis = 'Token is valid but reading the account threw. Check DATABASE_URL.';
      }
    }
  }

  if (!out.diagnosis) {
    out.diagnosis = !raw ? 'No token sent — you are simply signed out.' : 'Everything checks out; you are signed in.';
  }
  res.json(out);
});

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

  const IS_PROD = process.env.NODE_ENV === 'production';

  /* The one combination that quietly loses money: real cards being charged
     while account records sit on a disk that gets wiped on every deploy. */
  if (live && store.DRIVER === 'file') {
    console.error('\n  ✗ REFUSING TO RUN: live Stripe keys with file storage.');
    console.error('    Render wipes the filesystem on restart — paying customers');
    console.error('    would lose their subscription. Set DATABASE_URL first.\n');
    process.exit(1);
  }

  /* Widened from the Stripe-only check above, because losing accounts costs you
     users whether or not anyone has paid yet. On a wiped filesystem every
     session token in the wild still passes its signature check and then finds
     no account row behind it, so the entire userbase is silently signed out on
     each restart — and on a free instance that is every fifteen idle minutes. */
  if (IS_PROD && store.DRIVER === 'file') {
    console.error('\n  ✗ REFUSING TO RUN: NODE_ENV=production with file storage.');
    console.error('    Accounts would not survive a restart, so every user would be');
    console.error('    signed out and every eBay connection lost. Set DATABASE_URL.\n');
    process.exit(1);
  }

  /* Without an explicit secret, sessions are signed with a hash of
     ANTHROPIC_API_KEY. Rotating that key — routine, unrelated housekeeping —
     invalidates every token in existence. */
  if (IS_PROD && !accounts.sessionSecretSet()) {
    console.error('\n  ✗ REFUSING TO RUN: SESSION_SECRET is not set in production.');
    console.error('    Sessions would be signed with a key derived from ANTHROPIC_API_KEY,');
    console.error('    so rotating that key would sign out every user at once.');
    console.error('    Set SESSION_SECRET to a long random string, once, and leave it.\n');
    process.exit(1);
  }

  if (process.env.TOKEN_FILE) {
    console.log('\n  · TOKEN_FILE is set but no longer used for storing eBay links.');
    console.log('    Links now live on the user record in the database. The file is read');
    console.log('    once at boot to migrate old device-keyed links, then removed.');
    console.log('    Safe to delete this variable.\n');
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
