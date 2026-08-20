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

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg':  'jpg',
  'image/png':  'png',
  'image/webp': 'webp'
};

/* ══════════════════════════════ postgres ══════════════════════════════ */

let pool = null;

async function pg() {
  if (pool) return pool;
  let Pg;
  try { Pg = await import('pg'); }
  catch {
    throw new Error('DATABASE_URL is set but the "pg" package is not installed. Run: npm install pg');
  }
  pool = new Pg.default.Pool({
    connectionString: DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
    max: 3
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS images (
      id          TEXT PRIMARY KEY,
      mime        TEXT NOT NULL,
      bytes       BYTEA NOT NULL,
      created_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS images_created_idx ON images (created_at);
  `);
  return pool;
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

  if (DRIVER === 'file') {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, `${id}.${ext}`), buf);
  } else {
    await (await pg()).query(
      'INSERT INTO images (id, mime, bytes, created_at) VALUES ($1,$2,$3,$4)',
      [id, mime, buf, Date.now()]
    );
  }
  return { id, ext, mime, bytes: buf.length };
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
  return `${String(base || '').replace(/\/+$/, '')}/i/${id}.${ext}`;
}
