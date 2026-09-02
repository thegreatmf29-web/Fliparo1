/* ============================================================================
   Fliparo — storage layer
   ----------------------------------------------------------------------------
   Two drivers, same interface:

     file      (default)  — JSON on disk. Fine locally. NOT safe on Render's
                            free tier: the filesystem is wiped on every restart
                            and the service restarts after 15 minutes idle.
                            Paying customers would silently lose their plan.

     postgres  (DATABASE_URL set) — what you must use in production. Any free
                            Postgres works: Neon, Supabase, Render Postgres.

   The server refuses to start in production with real Stripe keys unless a
   database is configured, because losing a paying user's record is the one
   failure that costs you money and trust at the same time.
   ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seal, open } from './secrets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATABASE_URL = process.env.DATABASE_URL || '';
export const DRIVER = DATABASE_URL ? 'postgres' : 'file';

/* ══════════════════════════════ file driver ══════════════════════════════ */

const FILE = process.env.DATA_FILE || path.join(__dirname, '.data.json');
let cache = null;

function readFileDb() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { cache = { users: {}, codes: {} }; }
  cache.users ||= {};
  cache.codes ||= {};
  return cache;
}

let writeTimer = null;
function writeFileDb() {
  clearTimeout(writeTimer);
  // debounce: bursts of writes collapse into one fsync
  writeTimer = setTimeout(() => {
    try {
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cache));
      fs.renameSync(tmp, FILE);        // atomic — never leaves a half-written file
    } catch (e) { console.error('store write failed:', e.message); }
  }, 120);
}

/* ════════════════════════════ postgres driver ════════════════════════════ */

let pool = null;
/* The in-flight promise, not the pool itself. Assigning `pool` before the
   CREATE TABLE await meant a second concurrent caller saw a truthy pool and
   queried `users` before the schema existed — which on a cold start is the
   normal case, because the browser fires /api/me, /api/plans, /api/config and
   /api/health in parallel the moment the service wakes. Worse, if CREATE TABLE
   threw, `pool` stayed assigned and every later call skipped the schema step
   forever against a database that was never migrated. Memoising the promise
   and clearing it on failure fixes both: concurrent callers await the same
   initialisation, and a failed one is retried rather than cached. */
let poolReady = null;
const poolErrorHandlers = [];

/* Registered by server.mjs. node-postgres emits 'error' on the Pool when an
   idle connection drops — routine behaviour on Neon and Supabase free tiers —
   and an unhandled 'error' event terminates the process. */
export function onPoolError(fn) { poolErrorHandlers.push(fn); }

async function pg() {
  if (pool) return pool;
  if (poolReady) return poolReady;
  poolReady = (async () => {
    let Pg;
    try { Pg = await import('pg'); }
    catch {
      throw new Error(
        'DATABASE_URL is set but the "pg" package is not installed. Run: npm install pg'
      );
    }
    const p = new Pg.default.Pool({
      connectionString: DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
      max: 4
    });
    p.on('error', e => {
      if (poolErrorHandlers.length) poolErrorHandlers.forEach(h => { try { h(e); } catch {} });
      else console.error('[pg pool]', e.message);
    });
    await p.query(`
    CREATE TABLE IF NOT EXISTS users (
      email             TEXT PRIMARY KEY,
      created_at        BIGINT NOT NULL,
      plan              TEXT NOT NULL DEFAULT 'free',
      stripe_customer   TEXT,
      stripe_sub        TEXT,
      period_start      BIGINT NOT NULL DEFAULT 0,
      scans_used        INT NOT NULL DEFAULT 0,
      listings_used     INT NOT NULL DEFAULT 0,
      tokens            JSONB NOT NULL DEFAULT '[]'::jsonb,
      ebay              JSONB
    );
    CREATE TABLE IF NOT EXISTS codes (
      email      TEXT PRIMARY KEY,
      code_hash  TEXT NOT NULL,
      expires    BIGINT NOT NULL,
      attempts   INT NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS users_customer_idx ON users (stripe_customer);
  `);
    pool = p;              // only once the schema is actually there
    return p;
  })().catch(e => { poolReady = null; throw e; });   // failed init is retried, not cached
  return poolReady;
}

const rowToUser = r => r && ({
  email: r.email,
  createdAt: Number(r.created_at),
  plan: r.plan,
  stripeCustomer: r.stripe_customer || null,
  stripeSub: r.stripe_sub || null,
  periodStart: Number(r.period_start),
  scansUsed: r.scans_used,
  listingsUsed: r.listings_used,
  tokens: r.tokens || [],
  /* Deliberately NOT the link itself. The eBay column is owned by
     getEbayLink/putEbayLink and is never carried on the user object, so a
     stale copy loaded at the start of a long request cannot be written back
     over a link that was created while that request was in flight. What the
     rest of the app wants from the user row is the boolean. */
  ebayConnected: !!r.ebay
});

/* ═══════════════════════════════ public API ══════════════════════════════ */

export async function getUser(email) {
  email = String(email || '').toLowerCase().trim();
  if (!email) return null;
  if (DRIVER === 'file') {
    const row = readFileDb().users[email];
    if (!row) return null;
    /* Same shape as the postgres driver: the link is reached through
       getEbayLink, never carried on the user object. */
    const { ebay, ...rest } = row;
    return { ...rest, ebayConnected: !!ebay };
  }
  const { rows } = await (await pg()).query('SELECT * FROM users WHERE email=$1', [email]);
  return rowToUser(rows[0]);
}

/* Writes everything about a user EXCEPT the eBay link. That column is left
   alone on purpose: a scan that loaded the user thirty seconds ago and saves an
   incremented counter now must not carry a stale `ebay` value back with it and
   wipe a connection the user made in between. putEbayLink owns that column. */
export async function putUser(u) {
  u.email = String(u.email).toLowerCase().trim();
  if (DRIVER === 'file') {
    const db = readFileDb();
    const existing = db.users[u.email];
    db.users[u.email] = { ...u, ebay: existing?.ebay ?? null };
    writeFileDb();
    return u;
  }
  await (await pg()).query(
    `INSERT INTO users (email, created_at, plan, stripe_customer, stripe_sub,
                        period_start, scans_used, listings_used, tokens)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (email) DO UPDATE SET
       plan=$3, stripe_customer=$4, stripe_sub=$5, period_start=$6,
       scans_used=$7, listings_used=$8, tokens=$9`,
    [u.email, u.createdAt, u.plan, u.stripeCustomer, u.stripeSub,
     u.periodStart, u.scansUsed, u.listingsUsed,
     JSON.stringify(u.tokens || [])]
  );
  return u;
}

/* ── atomic counter bumps ─────────────────────────────────────────────────
   putUser writes the whole row, which makes it the wrong tool for "add one to
   a counter". A scan loads the user, spends 15-40 seconds in Claude, then
   saves. If a Stripe webhook upgraded that user during those seconds — which
   is exactly what happens when somebody hits the paywall mid-scan and pays —
   the save carries the stale row back and overwrites plan, stripe_customer
   and stripe_sub with their pre-payment values. Stripe has the money, the app
   says Free, the webhook has already fired and will not fire again, and
   nothing logs that it happened.

   The same read-modify-write also loses concurrent increments: two tabs at
   scansLeft=1 both pass the check and only one increment survives.

   So the counters are incremented in the database, touching one column and
   reading nothing first. The returned value is authoritative. */
async function bump(email, column) {
  const key = String(email).toLowerCase().trim();
  if (DRIVER === 'file') {
    const db = readFileDb();
    const u = db.users[key];
    if (!u) return null;
    const field = column === 'scans_used' ? 'scansUsed' : 'listingsUsed';
    u[field] = (u[field] || 0) + 1;
    writeFileDb();
    return u[field];
  }
  const { rows } = await (await pg()).query(
    `UPDATE users SET ${column} = ${column} + 1 WHERE email=$1 RETURNING ${column}`, [key]
  );
  return rows[0]?.[column] ?? null;
}

export const bumpScans    = email => bump(email, 'scans_used');
export const bumpListings = email => bump(email, 'listings_used');

export async function findByCustomer(customerId) {
  if (!customerId) return null;
  if (DRIVER === 'file') {
    const row = Object.values(readFileDb().users).find(u => u.stripeCustomer === customerId);
    if (!row) return null;
    const { ebay, ...rest } = row;
    return { ...rest, ebayConnected: !!ebay };
  }
  const { rows } = await (await pg()).query('SELECT * FROM users WHERE stripe_customer=$1', [customerId]);
  return rowToUser(rows[0]);
}

/* Login codes are stored hashed. A leaked database should not hand out logins. */

export async function putCode(email, codeHash, expires) {
  email = email.toLowerCase().trim();
  if (DRIVER === 'file') {
    readFileDb().codes[email] = { codeHash, expires, attempts: 0 };
    writeFileDb();
    return;
  }
  await (await pg()).query(
    `INSERT INTO codes (email, code_hash, expires, attempts) VALUES ($1,$2,$3,0)
     ON CONFLICT (email) DO UPDATE SET code_hash=$2, expires=$3, attempts=0`,
    [email, codeHash, expires]
  );
}

export async function getCode(email) {
  email = String(email || '').toLowerCase().trim();
  if (DRIVER === 'file') return readFileDb().codes[email] || null;
  const { rows } = await (await pg()).query('SELECT * FROM codes WHERE email=$1', [email]);
  const r = rows[0];
  return r && { codeHash: r.code_hash, expires: Number(r.expires), attempts: r.attempts };
}

export async function bumpCodeAttempts(email) {
  email = email.toLowerCase().trim();
  if (DRIVER === 'file') {
    const c = readFileDb().codes[email];
    if (c) { c.attempts++; writeFileDb(); }
    return;
  }
  await (await pg()).query('UPDATE codes SET attempts=attempts+1 WHERE email=$1', [email]);
}

/* ── claiming an attempt, atomically ──────────────────────────────────────
   verifyCode used to read the attempt count, compare it to the cap, and
   write an increment as three separate awaited steps. Fire twenty guesses at
   once and all twenty read attempts=0, all twenty pass the check, and the
   five-attempt cap allows twenty tries. Against a six-digit code that
   difference is the whole security margin.

   This claims the attempt and reports the result in one statement, so the
   database — not the order the requests happen to interleave in — decides
   who gets the last try. Returns null when the code is gone or the cap is
   already spent, which the caller treats exactly like a wrong code so a
   guesser learns nothing from the difference. */
export async function claimCodeAttempt(email, max) {
  email = String(email || '').toLowerCase().trim();

  if (DRIVER === 'file') {
    /* Single-threaded and synchronous under the file driver, so read-modify-
       write is genuinely atomic here — there is no await between the read and
       the write for another request to interleave into. */
    const c = readFileDb().codes[email];
    if (!c || c.attempts >= max) return null;
    c.attempts++;
    writeFileDb();
    return { codeHash: c.codeHash, expires: Number(c.expires), attempts: c.attempts };
  }

  const { rows } = await (await pg()).query(
    `UPDATE codes SET attempts = attempts + 1
      WHERE email = $1 AND attempts < $2
      RETURNING code_hash, expires, attempts`,
    [email, max]
  );
  const r = rows[0];
  return r && { codeHash: r.code_hash, expires: Number(r.expires), attempts: r.attempts };
}

export async function clearCode(email) {
  email = String(email || '').toLowerCase().trim();
  if (DRIVER === 'file') { delete readFileDb().codes[email]; writeFileDb(); return; }
  await (await pg()).query('DELETE FROM codes WHERE email=$1', [email]);
}

export async function ready() {
  if (DRIVER === 'file') { readFileDb(); return true; }
  await pg();
  return true;
}

/* ═══════════════════════════ marketplace links ═══════════════════════════
   An eBay connection belongs to an ACCOUNT, not to a browser. It used to be
   keyed by a deviceId the client made up and stored in localStorage, which
   meant it was lost by clearing site data, could not follow anyone to a second
   device, and — because the id was simply asserted in a header — was inherited
   by whoever signed in on that device next.

   These four functions are the whole interface. They read and write only the
   `ebay` column, so a link written mid-request can never clobber a quota
   counter written by a scan running at the same time, which a read-modify-
   write of the entire user row would.

   The refresh token is sealed on the way in and opened on the way out; see
   secrets.mjs. Callers deal in plain objects and never see ciphertext.
   ======================================================================== */

/* Only the refresh token is sealed. The access token expires in two hours and
   the surrounding metadata is what the account screen renders, so leaving it
   readable keeps the column diagnosable without weakening anything that
   matters. */
const sealLink = link => link && ({
  ...link,
  refresh_token: undefined,
  refresh_sealed: seal(link.refresh_token)
});

const openLink = row => {
  if (!row) return null;
  const refresh = open(row.refresh_sealed ?? row.refresh_token ?? null);
  /* A link whose refresh token will not open is not a link. Reporting it as
     absent sends the user down the reconnect path instead of failing later,
     mid-publish, with an error from eBay about a malformed grant. */
  if (!refresh) return null;
  const { refresh_sealed, ...rest } = row;
  return { ...rest, refresh_token: refresh };
};

export async function getEbayLink(email) {
  email = String(email || '').toLowerCase().trim();
  if (!email) return null;
  if (DRIVER === 'file') return openLink(readFileDb().users[email]?.ebay || null);
  const { rows } = await (await pg()).query('SELECT ebay FROM users WHERE email=$1', [email]);
  return openLink(rows[0]?.ebay || null);
}

/* Returns true only if a row was actually updated. The caller needs to know:
   writing a link for an account that no longer exists is a no-op, and reporting
   "eBay connected" for a write that went nowhere is how you get a user staring
   at a connected badge that does not work. */
export async function putEbayLink(email, link) {
  email = String(email || '').toLowerCase().trim();
  if (!email) return false;
  const row = sealLink(link);
  if (DRIVER === 'file') {
    const db = readFileDb();
    if (!db.users[email]) return false;
    db.users[email].ebay = row;
    writeFileDb();
    return true;
  }
  const r = await (await pg()).query('UPDATE users SET ebay=$2 WHERE email=$1',
    [email, row ? JSON.stringify(row) : null]);
  return (r.rowCount ?? 0) > 0;
}

export async function clearEbayLink(email) {
  return putEbayLink(email, null);
}
