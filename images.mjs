/* ============================================================================
   Fliparo — image hosting
   ----------------------------------------------------------------------------
   Why this module exists.

   Scan photos live in the browser as base64 data URLs. eBay's Inventory API
   will not take those: `imageUrls` must be public HTTPS URLs that eBay's own
   servers can fetch and copy into eBay Picture Services at publish time. So
   between "user took a photo" and "listing has a photo" something has to hold
   the bytes at a stable address. That is this file.

   Two drivers, chosen the same way store.mjs chooses:

     postgres (DATABASE_URL set) — bytea rows. Durable. What production needs,
              because Render's free filesystem is wiped on every restart and
              an image that vanishes is a listing whose photos 404.

     file     (default)          — a directory on disk. Fine locally.

   Deliberately NOT reusing store.mjs's pool: image rows are large and their
   access pattern is nothing like the user table's. Sharing a 4-connection
   pool between "fetch one user row" and "stream a 4MB blob" makes the fast
   path wait behind the slow one.

   Retention: images are addressed by an unguessable id and never listed, so
   the GET route is safe to leave unauthenticated — which it must be, since
   eBay fetches it with no credentials of ours.

   That paragraph used to be the whole retention policy, which is to say there
   wasn't one. Nothing ever deleted an image, and nothing could: there was no
   delete function, no expiry, and no sweep. On a 0.5GB free Postgres, at up
   to 12 photos of up to 6MB per scan, that is a database that fills and then
   starts failing uploads with "Could not store the photos" — which reads to a
   customer as a problem with their camera.

   It was also a promise the privacy notice could not keep. So now:

     · every image carries an expiry, default 180 days from upload
     · remove() deletes on demand, for a scan the user discards
     · sweep() clears anything past its expiry, run at boot and daily

   180 days is chosen so a live listing outlives its photos only in genuinely
   stale cases; if a listing is still up after six months the seller has other
   problems. IMAGE_RETENTION_DAYS overrides it, and 0 disables expiry for
   anyone who would rather keep everything and pay for the storage.
   ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATABASE_URL = process.env.DATABASE_URL || '';
export const DRIVER = DATABASE_URL ? 'postgres' : 'file';

const DIR = process.env.IMAGE_DIR || path.join(__dirname, '.images');

/* eBay rejects anything it cannot fetch quickly, and a 12MB photo from a
   modern phone is both slow to serve and pointless at listing resolution. */
export const MAX_BYTES = 6 * 1024 * 1024;
export const MAX_PER_ITEM = 12;

/* Set IMAGE_RETENTION_DAYS=0 to keep images forever. Anything else is read as
   days; a nonsense value falls back to the default rather than accidentally
   meaning "delete everything immediately". */
const RETENTION_DAYS = (() => {
  const raw = process.env.IMAGE_RETENTION_DAYS;
  if (raw === undefined || raw === '') return 180;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 180;
})();
export const RETENTION_MS = RETENTION_DAYS * 864e5;

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg':  'jpg',
  'image/png':  'png',
  'image/webp': 'webp'
};

/* ══════════════════════════════ postgres ══════════════════════════════ */

let pool = null;
/* Same fix as store.mjs: memoise the in-flight promise rather than the pool,
   so concurrent first callers on a cold start cannot query the table before
   CREATE TABLE has finished, and a failed init is retried instead of cached
   forever against a database that was never migrated. */
let poolReady = null;

async function pg() {
  if (pool) return pool;
  if (poolReady) return poolReady;
  poolReady = (async () => {
    let Pg;
    try { Pg = await import('pg'); }
    catch {
      throw new Error('DATABASE_URL is set but the "pg" package is not installed. Run: npm install pg');
    }
    const p = new Pg.default.Pool({
      connectionString: DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
      max: 3
    });
    /* An unhandled 'error' event on a Pool terminates the process, and idle
       connections dropping is routine on hosted Postgres. */
    p.on('error', e => console.error('[pg images pool]', e.message));

    await p.query(`
      CREATE TABLE IF NOT EXISTS images (
        id          TEXT PRIMARY KEY,
        mime        TEXT NOT NULL,
        bytes       BYTEA NOT NULL,
        created_at  BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS images_created_idx ON images (created_at);
    `);

    /* Added after the table shipped, so it has to be a separate migration
       rather than part of CREATE TABLE — existing deployments already have
       an images table without it. Backfilled from created_at so rows stored
       before retention existed get an expiry too, instead of living forever
       as an invisible exception to the policy. */
    await p.query(`ALTER TABLE images ADD COLUMN IF NOT EXISTS expires_at BIGINT`);
    await p.query(
      `UPDATE images SET expires_at = created_at + $1 WHERE expires_at IS NULL`,
      [RETENTION_MS || 180 * 864e5]
    );
    await p.query(`CREATE INDEX IF NOT EXISTS images_expires_idx ON images (expires_at)`);

    pool = p;
    return p;
  })().catch(e => { poolReady = null; throw e; });
  return poolReady;
}

/* ══════════════════════════════ public API ══════════════════════════════ */

/* Accepts a data: URL, returns { id, ext, bytes } or throws a legible error.
   Parsing is strict on purpose — a malformed data URL that slipped through
   would surface much later as an eBay "could not fetch image" error, which
   points nowhere near the real cause. */
export function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!m) throw new Error('Not a base64 data URL.');

  const mime = m[1].toLowerCase();
  if (!MIME_EXT[mime]) throw new Error(`Unsupported image type: ${mime}. Use JPEG, PNG or WebP.`);

  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length)          throw new Error('Image is empty.');
  if (buf.length > MAX_BYTES) {
    throw new Error(`Image is ${(buf.length / 1048576).toFixed(1)}MB — the limit is ${MAX_BYTES / 1048576}MB.`);
  }
  return { mime, buf };
}

export async function put(dataUrl) {
  const { mime, buf } = parseDataUrl(dataUrl);
  const id = crypto.randomBytes(16).toString('hex');
  const ext = MIME_EXT[mime];

  const now = Date.now();
  if (DRIVER === 'file') {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, `${id}.${ext}`), buf);
  } else {
    await (await pg()).query(
      'INSERT INTO images (id, mime, bytes, created_at, expires_at) VALUES ($1,$2,$3,$4,$5)',
      [id, mime, buf, now, RETENTION_MS ? now + RETENTION_MS : null]
    );
  }
  return { id, ext, mime, bytes: buf.length };
}

/* ── deletion ─────────────────────────────────────────────────────────────
   Called when a scan is discarded, so a photo the user never listed does not
   sit in the database for six months. Accepts an id or a full "<id>.<ext>"
   and is deliberately forgiving: deleting an image that is already gone is a
   success, not an error, because the caller's intent is satisfied either way
   and a retry must not fail. */
export async function remove(name) {
  const id = String(name || '').split('/').pop().split('.')[0];
  if (!/^[a-f0-9]{32}$/.test(id)) return false;

  if (DRIVER === 'file') {
    let hit = false;
    for (const ext of ['jpg', 'png', 'webp']) {
      const p = path.join(DIR, `${id}.${ext}`);
      if (fs.existsSync(p)) { fs.unlinkSync(p); hit = true; }
    }
    return hit;
  }
  const { rowCount } = await (await pg()).query('DELETE FROM images WHERE id=$1', [id]);
  return rowCount > 0;
}

/* ── expiry sweep ─────────────────────────────────────────────────────────
   Deletes in bounded batches rather than one statement. A single unbounded
   DELETE over a large backlog holds a long transaction and, on a small
   hosted instance, is exactly the kind of statement that gets killed
   mid-flight — leaving the backlog and repeating forever. Batching means a
   partial run still makes progress.

   Returns the number removed so the caller can log something meaningful. */
export async function sweep({ batch = 200, maxBatches = 25 } = {}) {
  if (!RETENTION_MS) return 0;
  const now = Date.now();
  let removed = 0;

  if (DRIVER === 'file') {
    if (!fs.existsSync(DIR)) return 0;
    for (const f of fs.readdirSync(DIR)) {
      const p = path.join(DIR, f);
      try {
        if (now - fs.statSync(p).mtimeMs > RETENTION_MS) { fs.unlinkSync(p); removed++; }
      } catch { /* vanished under us — fine */ }
    }
    return removed;
  }

  const db = await pg();
  for (let i = 0; i < maxBatches; i++) {
    const { rowCount } = await db.query(
      `DELETE FROM images WHERE id IN (
         SELECT id FROM images WHERE expires_at IS NOT NULL AND expires_at < $1 LIMIT $2
       )`, [now, batch]
    );
    removed += rowCount;
    if (rowCount < batch) break;
  }
  return removed;
}

export async function get(name) {
  /* `name` arrives as "<id>.<ext>" from the URL. The extension is cosmetic —
     it exists so eBay and browsers see a familiar-looking image URL — but it
     must not be trusted for lookup or path building. */
  const id = String(name || '').split('.')[0];
  if (!/^[a-f0-9]{32}$/.test(id)) return null;

  if (DRIVER === 'file') {
    for (const ext of ['jpg', 'png', 'webp']) {
      const p = path.join(DIR, `${id}.${ext}`);
      if (fs.existsSync(p)) {
        const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        return { buf: fs.readFileSync(p), mime };
      }
    }
    return null;
  }

  const { rows } = await (await pg()).query('SELECT mime, bytes FROM images WHERE id=$1', [id]);
  return rows[0] ? { buf: rows[0].bytes, mime: rows[0].mime } : null;
}

/* Absolute URL for eBay. PUBLIC_URL is required in production for exactly
   this reason: a relative path is useless to a server on eBay's side. */
export function urlFor(base, id, ext) {
  /* trim as well as strip slashes — a stray space in PUBLIC_URL makes every
     URL malformed and eBay blames the image, not the environment. */
  return `${String(base || '').trim().replace(/[\s/]+$/, '')}/i/${id}.${ext}`;
}
