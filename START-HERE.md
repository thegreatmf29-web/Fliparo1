# START HERE — clean rebuild

Everything before this was fighting a half-uploaded repo and a Render service configured for a folder layout that no longer exists. This is a clean start: new repo, new service, nothing inherited.

Work top to bottom. Don't skip to Render.

---

## Part 1 — The 14 files

Every file in this folder goes at the **root** of the new repo. No subfolders. Nothing nested inside a `fliparo/` folder — that nesting is what broke the last attempt.

| # | File | What it is |
|---|---|---|
| 1 | `package.json` | **Critical.** `"start": "node server.mjs"` — no `server/` prefix |
| 2 | `render.yaml` | Render blueprint. Build/start commands live here |
| 3 | `.node-version` | Pins Node 22 LTS. One line: `22` |
| 4 | `.gitignore` | Keeps `.env` and `node_modules/` out of git |
| 5 | `.env.example` | Every variable documented. Not secret — safe to commit |
| 6 | `server.mjs` | HTTP server, scan routes, eBay OAuth |
| 7 | `accounts.mjs` | Accounts, plans, quotas, Stripe |
| 8 | `store.mjs` | Storage layer |
| 9 | `mailer.mjs` | Email — Brevo + SMTP |
| 10 | `env.mjs` | `.env` loader |
| 11 | `index.html` | The whole frontend, one file (~131 KB) |
| 12 | `README.md` | Project readme |
| 13 | `SETUP-BILLING.md` | Stripe + database setup |
| 14 | `SETUP.md` | Domain + email walkthrough |

**Don't hand-paste `index.html`.** It's 131 KB and the browser editor will fight you. Use **Add file → Upload files** and drag it in. Honestly, drag all 14 in at once — same result, five minutes saved.

The three dotfiles (`.node-version`, `.gitignore`, `.env.example`) are easy to miss in Explorer. If drag-and-drop skips them, use **Add file → Create new file** and type the name with the leading dot.

### Making the repo

1. github.com → **New repository**
2. Name: `fliparo`
3. **Private**
4. **Do not** tick "Add a README" or "Add .gitignore" — you have both
5. Create, then upload the 14 files
6. Verify: the file list should show `server.mjs` at the root and **no `server/` folder**

That last check is the whole ballgame. If you see a `server/` folder, the upload nested wrong — delete and redo.

---

## Part 2 — The Render service

Delete the old service, or leave it stopped. Don't reuse it — its dashboard settings override `render.yaml` and are what caused the last three failed deploys.

### Use the Blueprint path, not the manual one

Render dashboard → **New → Blueprint** → connect the `fliparo` repo.

Blueprint reads `render.yaml` and sets the build and start commands itself. That's the point: the manual path makes you type them into dashboard fields, and those fields silently outrank the repo. Every failure so far traced back to a stale dashboard value.

Render will prompt for the `sync: false` variables. Fill in Part 3, then deploy.

### If you use the manual path anyway

Settings must read **exactly**:

| Setting | Value |
|---|---|
| Root Directory | *(empty)* |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |
| Runtime | Node |
| Plan | Free |

Lowercase `npm`. Linux is case-sensitive — `Npm install` fails with "command not found." Root Directory **empty**; anything there and Render looks in a folder that doesn't exist.

---

## Part 3 — Environment variables

### Set these

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | from console.anthropic.com/settings/keys |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` |
| `SESSION_SECRET` | any long random string |
| `NODE_ENV` | `production` |
| `PUBLIC_URL` | `https://<your-service>.onrender.com` — the real URL Render gives you |

### Leave these EMPTY

```
GMAIL_USER
GMAIL_APP_PASSWORD
```

Not "set to something harmless" — **empty, or deleted entirely.**

`mailer.mjs` picks its provider by precedence: `gmail → brevo → resend`. If both Gmail variables are set, Gmail wins and Brevo is never reached. Render's free tier blocks outbound SMTP ports 25/465/587, so the Gmail path times out no matter how correct the credentials are. This is the single most confusing failure in the whole stack, because the error looks like a network problem rather than a config one.

### Add when you're ready

| Variable | When |
|---|---|
| `DATABASE_URL` | before real users — accounts vanish on restart without it |
| `BREVO_API_KEY` | for login emails. The **v3 API key** (`xkeysib-…`), not the SMTP password on the same page |
| `MAIL_FROM` | `Fliparo <verification@fliparo.net>` — only after the domain is authenticated |
| `STRIPE_SECRET_KEY` | before charging anyone |

---

## Part 4 — Confirm it works

1. Deploy. The log should end with `Fliparo running → http://localhost:10000`
2. Open the Render URL — the app loads
3. Visit `/api/health` — returns OK
4. Try a scan (needs `ANTHROPIC_API_KEY`)
5. Try signing up — with no mail provider, the login code **prints in the Render log** instead of emailing. That's expected and a good way to confirm accounts work before touching Brevo.

---

## Part 5 — Then, and only then, the domain

Full detail in `SETUP.md`. Short version:

1. Buy `fliparo.net` (~$11–13/yr, Cloudflare Registrar). It's still unregistered — `fliparo.com` is parked on Afternic and for sale at aftermarket prices
2. Authenticate the domain in Brevo — DKIM CNAMEs with Cloudflare proxy **OFF**
3. Add `fliparo.net` as a custom domain on the Render service
4. Update `PUBLIC_URL` to `https://fliparo.net`
5. Set `BREVO_API_KEY` and `MAIL_FROM`
6. Turn off IP authorisation at `app.brevo.com/security/authorised_ips` — note the `s`, the URL in Brevo's own error message is misspelled and 404s

Do not do Part 5 before Part 4 is green. Debugging DNS and a broken deploy simultaneously is how afternoons disappear.

---

## The three failures already hit, so they don't happen twice

**`Npm: command not found`** — capital N in the dashboard build command. Linux is case-sensitive.

**`Cannot find module '/opt/render/project/src/server/server.mjs'`** — dashboard start command pointed into a `server/` folder that this layout doesn't have.

**Same error again after fixing the dashboard** — the repo itself was the old tree with the old `package.json`, and its `server/` folder had never uploaded. `npm start` reads the script from `package.json`, so no dashboard change could fix it.

All three were the same disease: config pointing at a layout that didn't match reality. The Blueprint path plus a clean repo removes both halves.
