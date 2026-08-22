# Task: provision accounts, tokens, and money for the PVD311 relaunch

**Who:** Rob + a helper agent, in a fresh session (`cd ~/Code/pvd311`, then: "work through docs/provisioning-task.md").
**Goal:** when this is done, lead agent *alice* can buy the domain, run the VPS, call the AI scout, and page Rob's phone — without asking Rob for anything else.
**Budget:** ~$100 covers a year (domain ~$12, VPS ~$72, AI ~pennies/day). Set hard caps where the platform offers them.

Rules for the helper agent:
- Never paste a secret into chat or a commit. Secrets go into the files named below; confirm by **variable name + last 4 chars** only.
- Runtime secrets → `automation/.env` (gitignored; loaded by the server). Ops/provisioning tokens → `~/.config/pvd311/ops.env` (create it, `chmod 600`).
- Rob-only steps are marked **[Rob]** (cards, identity, payment). Everything else the agent can do or guide.
- After each step, run the verification command. Tick the box only when it passes.

---

## 1. Firebase → Blaze  **[Rob]**   (optional for now — see note)
> Update 2026-08-22: the existing Storage bucket predates the Blaze requirement and still works on Spark, and Spark's hard quotas act as a natural cost cap. Blaze is only needed for reCAPTCHA Enterprise/Identity Platform admin features and real budget alerts. Safe to defer; do steps 2–5 first.
- [ ] https://console.firebase.google.com/project/pvd-snow-report/overview → **Upgrade** → link/create a billing account (card).
- Verify: `gcloud billing projects describe pvd-snow-report --format="value(billingEnabled)"` → `True`
- Then the agent: `gcloud billing budgets create --billing-account=<id> --display-name="pvd311 cap" --budget-amount=25USD --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0` (alerts only; alice installs the kill switch later).

## 2. Telegram bot  **[Rob]** (60 seconds)
- [ ] In Telegram, message **@BotFather** → `/newbot` → name e.g. "PVD311 Ops", username e.g. `pvd311_ops_bot` → copy the token.
- [ ] Add to `automation/.env`: `TELEGRAM_BOT_TOKEN=<token>` (chat id is already defaulted to Rob's; override with `TELEGRAM_CHAT_ID=` if using a different account).
- [ ] Rob must **press Start** on the bot once (bots can't message first).
- Verify: `curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe"` → `"ok":true`; then `curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" -d chat_id=7744052689 -d text="pvd311 ops online"` → arrives on the phone.

## 3. Anthropic API key (agent scout)  **[Rob for the card/limit]**
- [ ] https://console.anthropic.com → Settings → **Limits**: set a monthly spend limit (e.g. $20). → API Keys → create key named `pvd311-scout`.
- [ ] Add to `automation/.env`: `ANTHROPIC_API_KEY=<key>`
- Verify (agent): `cd automation && node -e "import('@anthropic-ai/sdk').then(async m=>{const c=new m.default();const r=await c.messages.create({model:'claude-opus-5',max_tokens:20,messages:[{role:'user',content:'ping'}]});console.log(r.content[0].text)})"` → prints a reply.

## 4. Cloudflare (domain + DNS + inbound email + Turnstile)  **[Rob for account/card]**
- [ ] Create/log into https://dash.cloudflare.com, add a payment method (Billing → Payment info).
- [ ] **Pick the name** (shortlist, all available .org/.com on 2026-08-22: FixMyPVD, FixPVD, HeyPVD, ReportPVD, SnapPVD) — or leave it and alice will re-check availability and buy later.
- [ ] Optional now: Domain Registration → register `<name>.org` (and `.com` if you want both).
- [ ] Create an API token: My Profile → API Tokens → **Create Token** → "Create Custom Token" with permissions: *Zone:DNS:Edit, Zone:Zone:Edit, Zone:Email Routing Rules:Edit, Account:Email Routing Addresses:Edit, Account:Workers Scripts:Edit, Account:Turnstile:Edit, Account:Account Settings:Read* — scoped to this account (and all zones). Name it `pvd311-alice`.
- [ ] Add to `~/.config/pvd311/ops.env`: `CLOUDFLARE_API_TOKEN=<token>` and `CLOUDFLARE_ACCOUNT_ID=<id>` (Overview page, right sidebar).
- Verify: `curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" https://api.cloudflare.com/client/v4/user/tokens/verify` → `"status":"active"`.

## 5. VPS provider (DigitalOcean recommended; Hetzner alternative)  **[Rob for account/card]**
- [ ] DigitalOcean: create account, add card (https://cloud.digitalocean.com/account/billing). API → **Generate New Token**, name `pvd311-alice`, scopes: full access is simplest; custom scopes if preferred: droplet (create/read/delete), ssh_key (read/create), firewall (create/read/update), project (read).
- [ ] Add to `~/.config/pvd311/ops.env`: `DIGITALOCEAN_TOKEN=<token>`
- Verify: `curl -s -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" https://api.digitalocean.com/v2/account | head -c 200` → shows the account with `"status":"active"`.
- (Hetzner instead: project → Security → API Tokens → Read & Write → `HCLOUD_TOKEN=`; note Hetzner does an identity check on new accounts.)

## 6. Optional: transactional email for outbound relays (M6)
- [ ] Resend (https://resend.com) free tier: create API key → `RESEND_API_KEY=` in `automation/.env`. Domain verification happens after the domain exists — alice will add the DNS records via Cloudflare.

---

## Hand-back
When done, the helper agent posts a summary like:
```
Blaze: True | TELEGRAM_BOT_TOKEN ...ab12 (getMe ok, test msg delivered) | ANTHROPIC_API_KEY ...9f3e (ping ok, limit $20)
CLOUDFLARE_API_TOKEN ...77c1 (active) account ...e2 | domain: <bought or "not yet"> | DIGITALOCEAN_TOKEN ...4d0a (active) | RESEND_API_KEY ...(optional)
```
Then tell alice (session "alice 311 lead") via `@alice 311 lead` or SendMessage: "provisioning done, see docs/provisioning-task.md hand-back". Alice takes it from there: kill switch, scout test, Telegram HITL test, domain + inbox, VPS + WAF test.
