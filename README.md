# Fliparo

AI resale scanner, valuation engine and multi-marketplace lister.

Point your camera at an item. Fliparo identifies it, grades its condition, estimates what it actually sells for, scores how worth flipping it is, and writes the listing for eBay, Poshmark, Depop or Mercari.

Zero runtime dependencies except `pg`. Node 18+.

---

## Run it locally

```bash
npm install
cp .env.example .env      # add your ANTHROPIC_API_KEY
npm start                 # → http://localhost:8080
```

With no `DATABASE_URL` it stores to a local JSON file, and with no mail provider it prints login codes to the terminal instead of emailing them. Both are fine for local work.

---

## Layout

```
server.mjs        HTTP server, scan/listing routes, eBay OAuth + publish
accounts.mjs      accounts, plans, quotas, Stripe billing
store.mjs         storage layer (Postgres, or JSON file locally)
mailer.mjs        SMTP over implicit TLS + Brevo/Resend HTTP paths
env.mjs           .env loader — must be imported first, see its header
index.html        the entire frontend, single file
render.yaml       Render blueprint
```

Static files are served from the repo root, so `index.html` sits beside the server rather than in a `public/` folder.

---

## Deploying

Render blueprint, free tier. Push this repo, then either point an existing Render service at it (keeps your current URL — nothing registered with Stripe or eBay breaks) or create a new service from `render.yaml`.

Everything marked `sync: false` in the blueprint is a secret; Render prompts for it in the dashboard and it never touches git.

Three of them must be set before real customers can pay:

| Variable | Why |
|---|---|
| `DATABASE_URL` | accounts vanish on restart without it |
| `STRIPE_SECRET_KEY` | cards can't be charged without it |
| `BREVO_API_KEY` | login codes never reach an inbox without it |

See **SETUP-BILLING.md** for how to get each, and **SETUP.md** for the domain and email walkthrough.

---

## Email, briefly

`mailer.mjs` picks a provider by precedence: **gmail → brevo → resend**.

Gmail wins if `GMAIL_USER` and `GMAIL_APP_PASSWORD` are both set. On Render's free tier that's a trap — outbound ports 25/465/587 are blocked, so SMTP times out regardless of how correct the credentials are. **In production, leave the Gmail variables empty and set `BREVO_API_KEY`**, which sends over HTTPS.

Two more Brevo specifics worth knowing before they cost you an afternoon:

- Brevo rejects API calls from unrecognised IPs. Render rotates outbound addresses without warning, so authorising a single IP isn't enough — use **Deactivate for API** at `app.brevo.com/security/authorised_ips` (note the `s`; the URL in Brevo's own error message is misspelled and 404s).
- `BREVO_API_KEY` is the **v3 API key** from SMTP & API → API Keys, not the SMTP password displayed on that same page.

---

## Marketplaces

**eBay** — genuine public Sell API. Full OAuth, creates the inventory item, builds the offer, publishes. Works end to end.

**Poshmark, Depop, Mercari** — no public write API exists. Automating posts would mean scraping, which violates their terms and gets accounts banned. Fliparo instead writes the complete platform-styled listing, copies it to the clipboard, and deep-links into their create-listing screen. About 20 seconds of manual work rather than zero, and your account survives.
