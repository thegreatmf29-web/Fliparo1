/* ============================================================================
   Fliparo — sealing secrets at rest
   ----------------------------------------------------------------------------
   eBay hands us a refresh token that stays valid for eighteen months and can
   create listings, read orders and change account policies. Stored as plain
   JSON it is a standing key to every connected seller's shop, readable by
   anything that gets one look at the database — a backup, a log, a support
   query, a leaked connection string.

   So it is sealed with AES-256-GCM before it is written and opened on the way
   out. GCM rather than CBC because it authenticates as well as encrypts: a row
   someone tampered with fails to open instead of decrypting into a value we
   would then send to eBay.

   The key is derived, not stored: scrypt over TOKEN_ENCRYPTION_KEY, or over
   SESSION_SECRET when that is not set. That fallback matters — it means an
   existing deployment gets encryption with no new configuration — but it also
   ties the seals to the session secret, so rotating SESSION_SECRET makes every
   stored eBay link unreadable. That is survivable and is handled: open()
   returns null rather than throwing, the link reads as disconnected, and the
   user is asked to reconnect. It is not silent data loss, it is a re-consent.

   Set TOKEN_ENCRYPTION_KEY explicitly if you want to rotate one without the
   other.
   ========================================================================== */

import crypto from 'node:crypto';

const SOURCE = process.env.TOKEN_ENCRYPTION_KEY
  || process.env.SESSION_SECRET
  || process.env.ANTHROPIC_API_KEY
  || 'fliparo-dev';

/* Derived once at boot. scrypt is deliberately slow, which is right for a
   key derivation and wrong for a per-request operation — hence the single
   call here rather than one per seal. */
const KEY = crypto.scryptSync(SOURCE, 'fliparo/token-seal/v1', 32);

const PREFIX = 'v1:';

/* Returns a string safe to put in a JSONB column, or null for empty input. */
export function seal(value) {
  if (value === undefined || value === null || value === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return PREFIX + [iv, tag, body].map(b => b.toString('base64url')).join('.');
}

/* Never throws. A value that cannot be opened — wrong key, corrupt row,
   tampered ciphertext — comes back null, and every caller treats null the
   same way it treats "no link stored". */
export function open(sealed) {
  if (typeof sealed !== 'string' || !sealed) return null;

  /* Written before sealing existed. Returned as-is so an upgrade in place
     keeps working; the next write re-seals it. */
  if (!sealed.startsWith(PREFIX)) return sealed;

  try {
    const [ivB, tagB, bodyB] = sealed.slice(PREFIX.length).split('.');
    if (!ivB || !tagB || !bodyB) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB, 'base64url'));
    d.setAuthTag(Buffer.from(tagB, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(bodyB, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export const isSealed = s => typeof s === 'string' && s.startsWith(PREFIX);
