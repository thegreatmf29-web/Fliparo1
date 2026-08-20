# ── Copy to .env and fill in. NEVER commit the real .env. ──
# Format is NAME=value. A bare key with no NAME= in front is the single most
# common mistake — the loader looks for pairs and will find nothing.
#
# In production these live in Render's Environment tab, not in a file.
# Real environment variables always win over this file.

# ── Required ────────────────────────────────────────────────────────────────
# https://console.anthropic.com/settings/keys
ANTHROPIC_API_KEY=sk-ant-REPLACE_ME
ANTHROPIC_MODEL=claude-sonnet-5

# ── Abuse limits (separate from plan limits) ────────────────────────────────
RATE_LIMIT_SCANS=25
RATE_LIMIT_WINDOW_MIN=60
DAILY_SCAN_CEILING=0

# ── Sessions. Any long random string. Changing it signs everyone out. ───────
SESSION_SECRET=

# ── Storage. Leave blank locally (uses a JSON file). ────────────────────────
# REQUIRED in production or accounts vanish on restart — see SETUP-BILLING.md.
DATABASE_URL=

# ── Email (login codes) ─────────────────────────────────────────────────────
# Blank = codes print to this terminal instead of being emailed. Fine locally.
#
# Provider precedence in mailer.mjs is: gmail > brevo > resend.
# GMAIL_USER + GMAIL_APP_PASSWORD therefore OVERRIDE Brevo if both are set.
# Render's free tier blocks outbound SMTP (25/465/587), so the Gmail path
# times out there no matter how correct the credentials are. In production:
# leave the two Gmail vars EMPTY and use BREVO_API_KEY, which sends over HTTPS.
BREVO_API_KEY=
MAIL_FROM=Fliparo <verification@fliparo.net>

# Local-only alternative. Leave blank when deploying to Render.
GMAIL_USER=
GMAIL_APP_PASSWORD=

# ── Sign in with Google ─────────────────────────────────────────────────────
# OAuth 2.0 Web application client ID from console.cloud.google.com.
# Not a secret — it ships in the page. Leave blank and the button never
# renders and the Google script is never loaded.
# Authorised JavaScript origin must be your exact site origin, e.g.
#   https://fliparo.net
GOOGLE_CLIENT_ID=

# ── Owner accounts ──────────────────────────────────────────────────────────
# Comma-separated emails that scan without limit and skip rate limiting.
# Matched case-insensitively against the verified sign-in email, so it cannot
# be granted by editing a database row. Leave blank in a normal deployment.
OWNER_EMAILS=

# ── Billing. Blank = the Plan screen shows but checkout is disabled. ────────
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_STARTER=
STRIPE_PRICE_PRO=

# Builds Stripe checkout return URLs. Must match the host users actually reach.
PUBLIC_URL=http://localhost:8080

# ── Listing photos ──────────────────────────────────────────────────────────
# Scan photos are base64 in the browser; eBay needs public URLs it can fetch.
# They are stored in Postgres when DATABASE_URL is set, otherwise on disk in
# IMAGE_DIR. PUBLIC_URL must be a real public host or eBay cannot reach them.
IMAGE_DIR=

# ── eBay. sandbox until you are ready for real listings. ────────────────────
EBAY_ENV=sandbox

# Used only when eBay's category suggestion returns nothing.
EBAY_FALLBACK_CATEGORY_ID=175759
EBAY_CLIENT_ID=
EBAY_CLIENT_SECRET=
EBAY_REDIRECT_URI_NAME=
EBAY_FULFILLMENT_POLICY_ID=
EBAY_PAYMENT_POLICY_ID=
EBAY_RETURN_POLICY_ID=
EBAY_MERCHANT_LOCATION_KEY=default-location

# ── Depop — only works once they approve you as a partner. ──────────────────
DEPOP_API_KEY=
