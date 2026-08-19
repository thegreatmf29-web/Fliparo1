# Fliparo — full setup

Everything from buying the domain to a working `verification@fliparo.net`, in the order that avoids waiting on things twice.

---

## The short answer on `verification@fliparo.net`

**You don't need a mailbox for it.** This trips up almost everyone.

Sending *as* an address and receiving *at* an address are separate problems. Your app only sends from `verification@fliparo.net` — nobody replies to it. Once the **domain** `fliparo.net` is authenticated in Brevo, every address on that domain works as a sender automatically. No inbox, no mailbox fee, no per-address verification.

That's why authenticating the domain is better than verifying a single address: `verification@`, `billing@`, `support@` all start working at once.

You only need a real mailbox if you want to *read* mail sent to Fliparo. That's optional and comes at the end.

---

## Costs

| Item | Cost |
|---|---|
| `fliparo.net` at Cloudflare Registrar | ~$11–13/yr |
| Brevo free tier | $0 (300 emails/day) |
| Render free tier | $0 |
| Mailbox (optional) — Zoho free | $0 |

**Under $15/year** to get all of this live.

`fliparo.net` is unregistered as of today. `fliparo.com` is taken and parked on Afternic nameservers — that's a for-sale listing, usually four figures. Take the `.net`.

---

## Step 1 — Buy the domain

1. `dash.cloudflare.com` → Domain Registration → Register Domain
2. Search `fliparo.net`, buy it
3. DNS is now managed in the same dashboard

Cloudflare sells at wholesale with no markup and no first-year-cheap/renewal-expensive trick.

---

## Step 2 — Authenticate the domain in Brevo

Do this before touching Render — DNS needs time to propagate and you can do the code work while it does.

Brevo → **Settings → Senders, Domains, IPs → Domains → Add a domain** → `fliparo.net`.

Brevo gives you records. Add each in Cloudflare DNS:

**Brevo code (proves ownership)**

```
Type: TXT     Name: @                  Content: brevo-code:xxxxxxxxxxxxx
```

**DKIM — pick the CNAME option, not TXT**

```
Type: CNAME   Name: brevo1._domainkey   Content: <from Brevo>   Proxy: OFF
Type: CNAME   Name: brevo2._domainkey   Content: <from Brevo>   Proxy: OFF
```

> **Proxy must be OFF (grey cloud) on both.** Proxied, Cloudflare returns its own IP instead of the DKIM value and authentication fails with no useful error. This is the single most common failure in this whole process.

**DMARC**

```
Type: TXT     Name: _dmarc             Content: v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com
```

Brevo requires the `rua` tag. Start at `p=none` — it satisfies the requirement without risking real mail. Tighten to `p=quarantine` after a few weeks.

**SPF**

```
Type: TXT     Name: @                  Content: v=spf1 include:spf.brevo.com ~all
```

Only ever **one** SPF record per domain. If you add a mailbox later (Step 6), merge rather than adding a second — two SPF records is a hard failure.

Wait for Brevo to show the domain **Authenticated** (green). Usually 5–30 minutes on Cloudflare.

---

## Step 3 — Point the domain at your Render service

This kills the ugly `resellai6.onrender.com` URL without renaming the service — which matters, because renaming a Render service breaks every URL registered with Stripe and eBay at once.

1. Render dashboard → your service → **Settings → Custom Domains**
2. Add `fliparo.net` and `www.fliparo.net`
3. Render shows you the DNS target. In Cloudflare:

```
Type: CNAME   Name: www   Content: <your-service>.onrender.com   Proxy: OFF
Type: A       Name: @     Content: <IP Render gives you>          Proxy: OFF
```

Proxy off, or Render's certificate provisioning fails. Wait for the green check and HTTPS in Render.

The `.onrender.com` URL keeps working — you're adding a name, not replacing one.

---

## Step 4 — Repo changes

Your deployable code is the **`github-upload/`** folder. The root `server/` + `public/` pair is the older copy (it has no `mailer.mjs`, so it can't talk to Brevo at all). Push `github-upload/`.

**Already done for you:**

- `mailer.mjs` — Brevo sender is now `Fliparo <verification@fliparo.net>`
- `mailer.mjs` — `EHLO` and `Message-ID` now use `fliparo.net`
- All `Resell.AI` / `resellai` branding → `Fliparo`

**Still to change, once Step 3 is green:**

`github-upload/render.yaml`, line 76:

```yaml
      - key: PUBLIC_URL
        value: https://fliparo.net        # was https://resellai6.onrender.com
```

`github-upload/render.yaml`, line 14 — **optional, and only if you have not deployed yet.** If a service already exists, leave it. Changing the blueprint `name` creates a *second* service rather than renaming the first.

```yaml
    name: fliparo
```

`PUBLIC_URL` matters because `accounts.mjs` uses it to build Stripe checkout success/cancel URLs and the billing-portal return URL. Wrong value means customers get bounced to a dead page after paying.

Push:

```bash
cd github-upload
git add -A
git commit -m "Rebrand to Fliparo; point mail and public URL at fliparo.net"
git push
```

---

## Step 5 — Render environment variables

This is where the actual sending gets fixed. Render dashboard → your service → **Environment**.

### Delete these two, if they exist

```
GMAIL_USER
GMAIL_APP_PASSWORD
```

**This is not optional.** `mailer.mjs` picks its provider by precedence:

```js
if (GMAIL_USER() && GMAIL_PASS()) return 'gmail';
if (BREVO_KEY())                  return 'brevo';
```

Gmail wins if both are set. And Render's free tier blocks outbound ports 25/465/587, so the Gmail path times out no matter how correct the credentials are. Leaving those two variables set means Brevo is never reached — your code's own error message says exactly this.

### Set these

```
BREVO_API_KEY = xkeysib-...
MAIL_FROM     = Fliparo <verification@fliparo.net>
PUBLIC_URL    = https://fliparo.net
```

`BREVO_API_KEY` comes from Brevo → **SMTP & API → API Keys**. It must be the **v3 API key** (starts `xkeysib-`), *not* the SMTP password shown on the same page. Your code returns a specific error for this mix-up because it's so easy to grab the wrong one.

`MAIL_FROM` overrides the hardcoded default in `mailer.mjs`, so this env var is the real source of truth. Set it and the code default never fires.

---

## Step 6 — Authorise Render's IPs in Brevo

Brevo rejects API calls from IP addresses it hasn't seen before. This fires on your first deploy and again any time Render moves you to a different outbound address — so authorising one IP is not enough.

Go to **`https://app.brevo.com/security/authorised_ips`** — note the `s` in `authorised`. The URL in Brevo's own error message is misspelled and 404s.

Two options:

- Add every IP from Render → Settings → **Outbound IP Addresses**, or
- Click **Deactivate for API** on that page

Take the second one. Render rotates outbound IPs without warning, and a rotation on the first option silently kills all your sign-in emails until you notice.

---

## Step 7 — Update the URLs registered with third parties

Only after `https://fliparo.net` is live.

**Stripe** → Developers → Webhooks → edit your endpoint:

```
https://fliparo.net/api/stripe/webhook
```

**eBay** → developer.ebay.com → your app → Redirect URI (RuName). Your code reads `EBAY_REDIRECT_URI_NAME`, so the RuName itself doesn't change — but the URL *behind* it in eBay's console does. Point it at `https://fliparo.net/...`.

Update these before you delete anything old. Both accept the change immediately.

---

## Step 8 — Optional: a mailbox you can actually read

Only if you want `hello@fliparo.net` to reach you. Skip if `verification@` sending is all you need.

**Zoho Mail free** — 5 users, 5 GB, one domain, $0. Webmail and mobile app only (no IMAP; that's the $1/user/month Lite tier).

1. zoho.com/mail → free plan → `fliparo.net`
2. Verify with the TXT record they give you
3. Add their MX records in Cloudflare
4. **Merge the SPF record** — do not add a second:

```
v=spf1 include:zoho.com include:spf.brevo.com ~all
```

---

## Step 9 — Verify

- [ ] Brevo shows `fliparo.net` **Authenticated**
- [ ] `https://fliparo.net` loads over HTTPS
- [ ] Sign up on your own site with a Gmail address
- [ ] Code email arrives, From reads `Fliparo <verification@fliparo.net>`
- [ ] In Gmail: open it → ⋮ → **Show original** → **SPF PASS, DKIM PASS, DMARC PASS**
- [ ] Repeat with an Outlook address — Microsoft is stricter than Google
- [ ] Landed in Inbox, not Spam or Promotions
- [ ] Test a Stripe checkout end to end and confirm the return URL is `fliparo.net`

Independent check: send to the address at **mail-tester.com** and read the score. Below 8/10, fix before sending real volume.

---

## When it breaks

Your `mailer.mjs` already throws specific errors for the common cases — read them, they name the fix.

| Symptom | Cause |
|---|---|
| "sender is not valid" | Domain not authenticated yet, or `MAIL_FROM` doesn't match the authenticated domain |
| "does not recognise this server's IP" | Step 6 |
| "rejected the API key" | You used the SMTP password instead of the v3 API key |
| Connection timeout to `smtp.gmail.com` | `GMAIL_USER` still set — Step 5 |
| Mail sends but lands in spam | DKIM proxied ON in Cloudflare, or two SPF records |
| Stripe redirects to a dead page | `PUBLIC_URL` still points at the old host |

**Warm up gradually.** A brand-new domain sending thousands on day one looks exactly like a spammer. Tens per day, building over two to three weeks. Reputation is earned slowly and lost in an afternoon.
