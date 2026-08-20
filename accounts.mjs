/* ============================================================================
   Fliparo — accounts, plans, quotas, Stripe billing
   ----------------------------------------------------------------------------
   Design notes worth knowing before you change anything in here:

   • Quotas are enforced on the SERVER. The browser is told what its limits are
     so the UI can be honest, but the browser is never trusted. Anyone can open
     devtools and set their plan to "pro"; it buys them nothing.

   • Login is passwordless. Email + 6-digit code. Codes are stored hashed, so a
     database leak does not hand out logins. Five wrong guesses burns the code.

   • Stripe is called over plain REST with fetch — no SDK, so this file adds no
     npm dependency and cannot break on an SDK major version bump.

   • Webhook signatures are verified. Without that check, anyone who learns your
     webhook URL can POST "subscription active" and upgrade themselves for free.
   ========================================================================== */

import crypto from 'node:crypto';
import * as store from './store.mjs';
import { sendCode as mailCode, mailProvider, mailFrom, verifyMailLogin, providerUsesSmtp, errText } from './mailer.mjs';

/* ═════════════════════════════════ plans ═════════════════════════════════ */

export const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    price: 0,
    priceLabel: '$0',
    /* Three, not one. One proves the app works and then stops — no room to
       form a habit, and no second look at the output before the wall. The
       anonymous allowance and the signed-in free allowance are separate
       counters, so a visitor who makes an account gets three more. */
    scans: 3,
    autoList: false,
    blurb: 'Try it on a few things.',
    features: [
      '3 items a month',
      'Full valuation and condition report',
      'A finished eBay listing, written for you',
      'Paste it in yourself'
    ]
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    price: 3.99,
    priceLabel: '$3.99',
    priceYear: 39.99,
    scans: 10,
    autoList: true,
    popular: true,
    blurb: 'For the weekend flipper.',
    features: [
      '10 items a month',
      'Automatic eBay listing included',
      'No per-listing fee, ever',
      'Condition and authenticity reports',
      'Inventory tracking'
    ]
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    price: 9.99,
    priceLabel: '$9.99',
    priceYear: 99.99,
    scans: 100,
    autoList: true,
    blurb: 'For people doing this for real.',
    features: [
      '100 items a month',
      'Unlimited automatic listings',
      'Priority analysis queue',
      'Full sales and margin history',
      'Everything in Starter'
    ]
  }
};

const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/* ═════════════════════════════════ owners ════════════════════════════════
   Emails in OWNER_EMAILS scan without limit. Comma-separated, matched
   case-insensitively.

   Deliberately NOT a member of PLANS: keeping it out means it can never be
   rendered on the pricing page, never be selected at checkout, and never be
   written to user.plan by a Stripe webhook. Ownership is derived from the
   verified email on every request instead of stored on the record, so it
   cannot be granted by tampering with a row — and revoking it is one
   environment variable away, with no data migration.
   ========================================================================= */
const OWNER_EMAILS = new Set(
  String(process.env.OWNER_EMAILS || '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
);

export const isOwner = user =>
  !!user?.email && OWNER_EMAILS.has(String(user.email).trim().toLowerCase());

const OWNER_PLAN = {
  id: 'owner', name: 'Owner', price: 0, priceLabel: '—',
  scans: Infinity, autoList: true, blurb: 'Unlimited.', features: []
};

/* ═══════════════════════════════ config ══════════════════════════════════ */

const SECRET = process.env.SESSION_SECRET
  || crypto.createHash('sha256').update(process.env.ANTHROPIC_API_KEY || 'fliparo-dev').digest('hex');

const STRIPE_SECRET  = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK = process.env.STRIPE_WEBHOOK_SECRET || '';
/* Annual is a second price on the same plan, not a separate plan. Keeping the
   entitlement ('starter') separate from what was bought ('starter_year') means
   quota, autoList and every gate stay untouched — the only thing that differs
   is the billing interval. A yearly checkout that mapped to its own plan id
   would need every one of those rules duplicated. */
const PRICE_IDS = {
  starter:      process.env.STRIPE_PRICE_STARTER      || '',
  pro:          process.env.STRIPE_PRICE_PRO          || '',
  starter_year: process.env.STRIPE_PRICE_STARTER_YEAR || '',
  pro_year:     process.env.STRIPE_PRICE_PRO_YEAR     || ''
};

/* 'starter_year' → 'starter'. Used for entitlement everywhere downstream. */
const basePlan = id => String(id || '').replace(/_year$/, '');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

const IS_PROD = process.env.NODE_ENV === 'production';

export const billingConfigured = () => !!(STRIPE_SECRET && PRICE_IDS.starter && PRICE_IDS.pro);
export const mailConfigured    = () => mailProvider() !== 'none';
export { mailProvider, mailFrom, verifyMailLogin, providerUsesSmtp, errText };

/* ═════════════════════════════ session tokens ════════════════════════════ */
/* Stateless and signed: <base64url payload>.<hmac>. No session table needed,
   and a token cannot be forged without SESSION_SECRET.                       */

const b64 = s => Buffer.from(s).toString('base64url');
const unb64 = s => Buffer.from(s, 'base64url').toString();
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');

export function issueToken(email) {
  const payload = b64(JSON.stringify({ e: email.toLowerCase(), t: Date.now() }));
  return `${payload}.${sign(payload)}`;
}

export function readToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, mac] = token.split('.');
  const expect = sign(payload);
  // timingSafeEqual throws on length mismatch, so guard first
  if (mac.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const { e, t } = JSON.parse(unb64(payload));
    if (Date.now() - t > 180 * 24 * 60 * 60 * 1000) return null;   // 180-day sessions
    return e;
  } catch { return null; }
}

/* Reads the caller's account from the Authorization header. Returns null for
   signed-out visitors rather than throwing — most routes allow both.          */
export async function currentUser(req) {
  const h = req.get('authorization') || '';
  const email = readToken(h.replace(/^Bearer\s+/i, '').trim());
  if (!email) return null;
  const u = await store.getUser(email);
  return u ? rollPeriod(u) : null;
}

/* ═══════════════════════════════ quotas ══════════════════════════════════ */

/* Roll the usage window forward in whole 30-day steps anchored to the user's
   own start date, so quota resets land on their cycle rather than the 1st of
   the month (which would hand a late-month subscriber a near-instant reset). */
function rollPeriod(u) {
  const now = Date.now();
  if (!u.periodStart) u.periodStart = now;
  if (now - u.periodStart >= PERIOD_MS) {
    const periods = Math.floor((now - u.periodStart) / PERIOD_MS);
    u.periodStart += periods * PERIOD_MS;
    u.scansUsed = 0;
    u.listingsUsed = 0;
    store.putUser(u).catch(e => console.error('period roll save:', e.message));
  }
  return u;
}

export function planOf(user) {
  if (isOwner(user)) return OWNER_PLAN;
  return PLANS[user?.plan] || PLANS.free;
}

export function quotaOf(user) {
  const plan = planOf(user);
  const used = user?.scansUsed || 0;
  /* JSON.stringify turns Infinity into null, so an unlimited plan reports a
     boolean and null counts rather than a number the client would render as
     "Infinity" or, worse, compare against. */
  const unlimited = plan.scans === Infinity;
  return {
    plan: plan.id,
    planName: plan.name,
    scansUsed: used,
    unlimited,
    scansLimit: unlimited ? null : plan.scans,
    scansLeft: unlimited ? null : Math.max(0, plan.scans - used),
    autoList: plan.autoList,
    renewsAt: (user?.periodStart || Date.now()) + PERIOD_MS
  };
}

/* Anonymous visitors get the free allowance keyed to their device, so somebody
   can try the app before handing over an email. Cleared when the process
   restarts — deliberately loose, it is a demo allowance, not an entitlement. */
const anonUsage = new Map();

export function anonQuota(deviceId) {
  const rec = anonUsage.get(deviceId);
  const now = Date.now();
  if (!rec || now - rec.start >= PERIOD_MS) return { scansUsed: 0, start: now };
  return rec;
}

export function anonConsume(deviceId) {
  const q = anonQuota(deviceId);
  q.scansUsed++;
  anonUsage.set(deviceId, q);
}

/* The single gate every paid action goes through. */
export async function checkScanAllowed(req) {
  const user = await currentUser(req);
  if (user) {
    const q = quotaOf(user);
    if (!q.unlimited && q.scansLeft <= 0) {
      return {
        ok: false, user,
        status: 402,
        code: 'quota',
        error: `You've used all ${q.scansLimit} scans on the ${q.planName} plan this month.`,
        quota: q
      };
    }
    return { ok: true, user, quota: q };
  }

  const deviceId = req.get('x-device-id') || 'anon';
  const q = anonQuota(deviceId);
  if (q.scansUsed >= PLANS.free.scans) {
    return {
      ok: false, user: null,
      status: 402,
      code: 'signup',
      error: 'You have used your free scan. Create an account to keep going.',
      quota: { plan: 'free', scansUsed: q.scansUsed, scansLimit: PLANS.free.scans, scansLeft: 0, autoList: false }
    };
  }
  return { ok: true, user: null, anon: deviceId, quota: { plan: 'free', scansUsed: q.scansUsed, scansLimit: PLANS.free.scans, scansLeft: PLANS.free.scans - q.scansUsed, autoList: false } };
}

export async function consumeScan(ctx) {
  if (ctx.user) {
    ctx.user.scansUsed = (ctx.user.scansUsed || 0) + 1;
    await store.putUser(ctx.user);
  } else if (ctx.anon) {
    anonConsume(ctx.anon);
  }
}

/* Auto-listing is the thing the $3.99 tier actually unlocks. */
export async function checkListingAllowed(req) {
  const user = await currentUser(req);
  if (!user) return { ok: false, status: 402, code: 'signup', error: 'Create an account to publish listings automatically.' };
  const plan = planOf(user);
  if (!plan.autoList) {
    return {
      ok: false, status: 402, code: 'upgrade', user,
      error: 'Automatic listing is part of Starter. Upgrade to publish straight to eBay.',
      quota: quotaOf(user)
    };
  }
  return { ok: true, user, quota: quotaOf(user) };
}

/* ═════════════════════════════ auth handlers ════════════════════════════ */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const codeRate = new Map();      // email -> last request time

const hashCode = (email, code) =>
  crypto.createHmac('sha256', SECRET).update(`${email.toLowerCase()}:${code}`).digest('hex');

export async function requestCode(req, res) {
  const email = String(req.body?.email || '').toLowerCase().trim();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'That does not look like an email address.' });

  const last = codeRate.get(email) || 0;
  if (Date.now() - last < 30_000) {
    return res.status(429).json({ error: 'A code was just sent. Give it a moment before asking for another.' });
  }
  codeRate.set(email, Date.now());

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await store.putCode(email, hashCode(email, code), Date.now() + 10 * 60 * 1000);

  /* With no mail provider there is no way for the code to reach anyone. In
     development we hand it back so local setup is possible. In production we
     say so plainly — the old behaviour was to return ok:true and leave the
     user staring at a code screen for an email that was never sent. */
  if (!mailConfigured()) {
    console.log(`\n  ✉  [no mail provider] code for ${email}: ${code}\n`);
    if (IS_PROD) {
      return res.status(503).json({
        code: 'nomail',
        error: 'Sign-in email is not set up on this server yet. Add BREVO_API_KEY (or RESEND_API_KEY) — see SETUP-BILLING.md.'
      });
    }
    return res.json({ ok: true, mailConfigured: false, devCode: code });
  }

  try {
    await mailCode(email, code);
  } catch (e) {
    const detail = errText(e);
    console.error('mail send failed:', detail);
    return res.status(502).json({ error: detail });
  }

  res.json({ ok: true, mailConfigured: true });
}

export async function verifyCode(req, res) {
  const email = String(req.body?.email || '').toLowerCase().trim();
  const code  = String(req.body?.code || '').trim();
  if (!EMAIL_RE.test(email) || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Enter the 6-digit code from your email.' });
  }

  const rec = await store.getCode(email);
  if (!rec) return res.status(400).json({ error: 'That code has expired. Ask for a new one.' });
  if (Date.now() > rec.expires) { await store.clearCode(email); return res.status(400).json({ error: 'That code has expired. Ask for a new one.' }); }
  if (rec.attempts >= 5) { await store.clearCode(email); return res.status(429).json({ error: 'Too many wrong attempts. Ask for a new code.' }); }

  const given = Buffer.from(hashCode(email, code));
  const want  = Buffer.from(rec.codeHash);
  const good  = given.length === want.length && crypto.timingSafeEqual(given, want);
  if (!good) {
    await store.bumpCodeAttempts(email);
    return res.status(400).json({ error: 'That code is not right.' });
  }
  await store.clearCode(email);

  let user = await store.getUser(email);
  if (!user) {
    user = {
      email, createdAt: Date.now(), plan: 'free',
      stripeCustomer: null, stripeSub: null,
      periodStart: Date.now(), scansUsed: 0, listingsUsed: 0,
      tokens: [], ebay: null
    };
    await store.putUser(user);
  }

  res.json({ token: issueToken(email), user: publicUser(user) });
}

export function publicUser(u) {
  return {
    email: u.email,
    plan: u.plan,
    createdAt: u.createdAt,
    ...quotaOf(u)
  };
}

/* ═══════════════════════════ Sign in with Google ═════════════════════════
   Google Identity Services hands the browser a signed ID token (a JWT). The
   browser posts it here; this exchanges it for one of our own session tokens.

   The token is verified by asking Google, rather than by parsing it here.
   Verifying a JWT properly means fetching Google's JWKS, matching the key id,
   checking the RS256 signature, the issuer, the audience and the expiry — and
   getting any one of those wrong produces a login that works perfectly and is
   trivially forgeable. One HTTPS call to Google's own endpoint has none of
   that surface, needs no dependency, and at this scale costs nothing.

   Two checks matter and are done explicitly:
     aud            — the token must have been minted for OUR client id, or
                      anyone could sign in with a Google token issued to any
                      other site in the world.
     email_verified — Google accounts can hold unverified addresses; without
                      this, someone could claim an email they do not own and
                      collide with a real user's account.
   ========================================================================= */
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
export const googleConfigured = () => !!GOOGLE_CLIENT_ID;

export async function googleAuth(req, res) {
  if (!googleConfigured()) {
    return res.status(400).json({ error: 'Google sign-in is not configured on this server.' });
  }
  const credential = String(req.body?.credential || '').trim();
  if (!credential) return res.status(400).json({ error: 'Missing Google credential.' });

  let info;
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
    info = await r.json();
    if (!r.ok) throw new Error(info?.error_description || 'Google rejected the token.');
  } catch (e) {
    console.error('google verify:', e.message);
    return res.status(400).json({ error: 'Could not verify that Google sign-in. Try again.' });
  }

  if (info.aud !== GOOGLE_CLIENT_ID) {
    console.error('google verify: aud mismatch', info.aud);
    return res.status(401).json({ error: 'That Google sign-in was not issued for this app.' });
  }
  if (info.email_verified !== true && info.email_verified !== 'true') {
    return res.status(401).json({ error: 'That Google account has no verified email address.' });
  }

  const email = String(info.email || '').toLowerCase().trim();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Google returned no usable email address.' });

  /* Same account either way. Someone who signed up with a code and later uses
     Google lands on the record they already have — the email is the identity,
     and the sign-in method is just how they proved it. */
  let user = await store.getUser(email);
  if (!user) {
    user = {
      email, createdAt: Date.now(), plan: 'free',
      stripeCustomer: null, stripeSub: null,
      periodStart: Date.now(), scansUsed: 0, listingsUsed: 0,
      tokens: [], ebay: null
    };
    await store.putUser(user);
  }

  res.json({ token: issueToken(email), user: publicUser(user) });
}

export async function me(req, res) {
  const u = await currentUser(req);
  if (!u) {
    const deviceId = req.get('x-device-id') || 'anon';
    const q = anonQuota(deviceId);
    return res.json({
      signedIn: false,
      plan: 'free',
      scansUsed: q.scansUsed,
      unlimited: false,
      scansLimit: PLANS.free.scans,
      scansLeft: Math.max(0, PLANS.free.scans - q.scansUsed),
      autoList: false
    });
  }
  res.json({ signedIn: true, ...publicUser(u) });
}

/* ═══════════════════════════════ stripe ═════════════════════════════════ */

async function stripe(endpoint, params, method = 'POST') {
  if (!STRIPE_SECRET) throw new Error('Billing is not configured on this server.');
  const body = params ? new URLSearchParams(flatten(params)).toString() : undefined;
  const r = await fetch(`https://api.stripe.com/v1/${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${STRIPE_SECRET}`,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Stripe error (${r.status})`);
  return j;
}

/* Stripe's form encoding wants nested keys as a[b][c]. */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') flatten(v, key, out);
    else out[key] = String(v);
  }
  return out;
}

export async function createCheckout(req, res) {
  try {
    if (!billingConfigured()) {
      return res.status(503).json({ error: 'Billing is not switched on yet. See SETUP-BILLING.md.', code: 'unconfigured' });
    }
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in first.', code: 'signup' });

    const planId = String(req.body?.plan || '');
    if (!PRICE_IDS[planId]) return res.status(400).json({ error: 'Unknown plan.' });

    const base = PUBLIC_URL || `https://${req.get('host')}`;

    let customer = user.stripeCustomer;
    if (!customer) {
      const c = await stripe('customers', { email: user.email, metadata: { app: 'fliparo' } });
      customer = c.id;
      user.stripeCustomer = customer;
      await store.putUser(user);
    }

    const session = await stripe('checkout/sessions', {
      mode: 'subscription',
      customer,
      client_reference_id: user.email,
      'line_items[0][price]': PRICE_IDS[planId],
      'line_items[0][quantity]': 1,
      allow_promotion_codes: 'true',
      success_url: `${base}/?billing=success`,
      cancel_url: `${base}/?billing=cancelled`,
      subscription_data: { metadata: { email: user.email, plan: basePlan(planId) } },
      metadata: { email: user.email, plan: basePlan(planId) }
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error('checkout:', e.message);
    res.status(500).json({ error: e.message });
  }
}

export async function billingPortal(req, res) {
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in first.' });
    if (!user.stripeCustomer) return res.status(400).json({ error: 'You do not have a subscription yet.' });
    const base = PUBLIC_URL || `https://${req.get('host')}`;
    const s = await stripe('billing_portal/sessions', { customer: user.stripeCustomer, return_url: base });
    res.json({ url: s.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

/* Verified against the raw request body — see the note in server.mjs about why
   this one route must skip JSON parsing. */
export function verifyWebhook(rawBody, sigHeader) {
  if (!STRIPE_WEBHOOK) return { ok: false, reason: 'no webhook secret configured' };
  const parts = Object.fromEntries(
    String(sigHeader || '').split(',').map(p => p.split('=').map(s => s.trim()))
  );
  if (!parts.t || !parts.v1) return { ok: false, reason: 'malformed signature header' };

  // Reject replays of an old, legitimately-signed request.
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return { ok: false, reason: 'timestamp outside tolerance' };

  const expect = crypto.createHmac('sha256', STRIPE_WEBHOOK)
    .update(`${parts.t}.${rawBody}`).digest('hex');
  const a = Buffer.from(parts.v1), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature mismatch' };

  try { return { ok: true, event: JSON.parse(rawBody) }; }
  catch { return { ok: false, reason: 'body was not JSON' }; }
}

const planFromPriceId = id => {
  for (const [key, price] of Object.entries(PRICE_IDS)) {
    if (price && id === price) return basePlan(key);
  }
  return null;
};

export async function handleWebhookEvent(event) {
  const obj = event?.data?.object || {};
  const type = event?.type || '';

  const resolveUser = async () => {
    const email = obj.metadata?.email || obj.client_reference_id;
    if (email) {
      const u = await store.getUser(email);
      if (u) return u;
    }
    return store.findByCustomer(obj.customer);
  };

  if (type === 'checkout.session.completed') {
    const user = await resolveUser();
    if (!user) return console.warn('webhook: no user for', obj.customer);
    user.stripeCustomer = obj.customer || user.stripeCustomer;
    user.stripeSub = obj.subscription || user.stripeSub;
    user.plan = obj.metadata?.plan && PLANS[obj.metadata.plan] ? obj.metadata.plan : user.plan;
    user.periodStart = Date.now();
    user.scansUsed = 0;                       // fresh allowance the moment they pay
    user.listingsUsed = 0;
    await store.putUser(user);
    console.log(`  ✓ ${user.email} subscribed to ${user.plan}`);
    return;
  }

  if (type === 'customer.subscription.updated' || type === 'customer.subscription.created') {
    const user = await resolveUser();
    if (!user) return;
    const priceId = obj.items?.data?.[0]?.price?.id;
    const plan = planFromPriceId(priceId);
    const active = ['active', 'trialing'].includes(obj.status);
    user.stripeSub = obj.id;
    user.plan = active && plan ? plan : 'free';
    await store.putUser(user);
    console.log(`  ✓ ${user.email} → ${user.plan} (${obj.status})`);
    return;
  }

  if (type === 'customer.subscription.deleted') {
    const user = await resolveUser();
    if (!user) return;
    user.plan = 'free';
    user.stripeSub = null;
    await store.putUser(user);
    console.log(`  · ${user.email} cancelled → free`);
    return;
  }

  if (type === 'invoice.payment_failed') {
    const user = await resolveUser();
    if (user) console.warn(`  ! payment failed for ${user.email}`);
  }
}

export function plansPayload() {
  return {
    plans: Object.values(PLANS).map(p => ({
      id: p.id, name: p.name, price: p.price, priceLabel: p.priceLabel,
      scans: p.scans, autoList: p.autoList, blurb: p.blurb,
      features: p.features, popular: !!p.popular,
      /* Only advertise an annual option once its Stripe price actually exists,
         so the toggle can never offer a checkout that would 400. */
      yearPrice: p.priceYear || null,
      yearAvailable: !!PRICE_IDS[`${p.id}_year`]
    })),
    yearlyConfigured: !!(PRICE_IDS.starter_year || PRICE_IDS.pro_year),
    billingConfigured: billingConfigured(),
    mailConfigured: mailConfigured()
  };
}
