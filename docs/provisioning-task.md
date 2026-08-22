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
> 2026-08-22 decision (Rob): **stay on Spark** — it is the hard $0 cap. Open billing account "Firebase Payment" (018BA7-537B9E-B0BEE1) exists if Blaze is ever needed.
> Update 2026-08-22: the existing Storage bucket predates the Blaze requirement and still works on Spark, and Spark's hard quotas act as a natural cost cap. Blaze is only needed for reCAPTCHA Enterprise/Identity Platform admin features and real budget alerts. Safe to defer; do steps 2–5 first.
- [ ] https://console.firebase.google.com/project/pvd-snow-report/overview → **Upgrade** → link/create a billing account (card).
- Verify: `gcloud billing projects describe pvd-snow-report --format="value(billingEnabled)"` → `True`
- Then the agent: `gcloud billing budgets create --billing-account=<id> --display-name="pvd311 cap" --budget-amount=25USD --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0` (alerts only; alice installs the kill switch later).

## 2. ~~Telegram bot~~ → EMAIL  **(dropped 2026-08-22)**
> Rob: "I would rather they communicate with me via email not telgram." Notifications + HITL go to robertbcorey@gmail.com via Resend (step 6, now required). alice: rework M4 HITL from Telegram taps to email (approve/reject links or reply parsing).
- [ ] In Telegram, message **@BotFather** → `/newbot` → name e.g. "PVD311 Ops", username e.g. `pvd311_ops_bot` → copy the token.
- [ ] Add to `automation/.env`: `TELEGRAM_BOT_TOKEN=<token>` (chat id is already defaulted to Rob's; override with `TELEGRAM_CHAT_ID=` if using a different account).
- [ ] Rob must **press Start** on the bot once (bots can't message first).
- Verify: `curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe"` → `"ok":true`; then `curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" -d chat_id=7744052689 -d text="pvd311 ops online"` → arrives on the phone.

## 3. Anthropic API key (agent scout)  **[Rob for the card/limit]**
- [x] Workspace `pvd311` (wrkspc_01Ri9…q7xf), **$20/mo workspace spend limit** (enforced), email alert at $10, org auto-reload OFF, $20 credits bought 2026-08-22. Key `pvd311-scout` expires 2027-08-24.
- [x] `ANTHROPIC_API_KEY` in `automation/.env` (…GAAA) — ping ok on claude-opus-5.
- Verify (agent): `cd automation && node -e "import('@anthropic-ai/sdk').then(async m=>{const c=new m.default();const r=await c.messages.create({model:'claude-opus-5',max_tokens:20,messages:[{role:'user',content:'ping'}]});console.log(r.content[0].text)})"` → prints a reply.

## 4. Cloudflare (domain + DNS + inbound email + Turnstile + **Browser Run compute**)  **[Rob for account/card]**
> Decision 2026-08-22: Cloudflare Workers + Browser Run will likely replace the VPS (spike code is in `worker/`). So also: **Workers Paid plan ($5/mo)** under Workers & Pages → Plans, and run `cd worker && npx wrangler login` (opens a browser OAuth — Rob clicks Allow) so alice can deploy. Then alice runs the spike; if the city portal's WAF blocks Cloudflare egress, fall back to step 5.
- [x] Account exists (card on file; owns rinnyzerg.win).
- [ ] **Pick the name** (shortlist, all available .org/.com on 2026-08-22: FixMyPVD, FixPVD, HeyPVD, ReportPVD, SnapPVD) — or leave it and alice will re-check availability and buy later.
- [ ] Optional now: Domain Registration → register `<name>.org` (and `.com` if you want both).
- [x] Token `pvd311-alice` created 2026-08-22 (7 perms as listed, no Billing scope → cannot buy anything; **expires 2026-11-15**, renew before then). Create an API token: My Profile → API Tokens → **Create Token** → "Create Custom Token" with permissions: *Zone:DNS:Edit, Zone:Zone:Edit, Zone:Email Routing Rules:Edit, Account:Email Routing Addresses:Edit, Account:Workers Scripts:Edit, Account:Workers KV Storage:Edit, Account:Workers R2 Storage:Edit, Account:Browser Rendering:Edit, Account:Turnstile:Edit, Account:Account Settings:Read* — scoped to this account (and all zones). Name it `pvd311-alice`.
- [x] `CLOUDFLARE_API_TOKEN` (…8ded, status active) + `CLOUDFLARE_ACCOUNT_ID` in `~/.config/pvd311/ops.env`.
- Note: Cloudflare Registrar has no purchase API — domain buy is a Rob dashboard step once the name is picked.
- Verify: `curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" https://api.cloudflare.com/client/v4/user/tokens/verify` → `"status":"active"`.

## 5. VPS provider — ONLY if the Cloudflare spike fails (DigitalOcean recommended)  **[Rob for account/card]**
- [x] DigitalOcean: account active (MC …7594 on file; $0.02 past-due noise). Token `pvd311-alice` 2026-08-22: custom scopes only — droplet/firewall/ssh_key full, account/actions/image/regions/sizes/snapshot/vpc/project read (+project assign); NO billing/domain/app/k8s. **Expires 2026-11-20.** Spend alert "pvd311 monthly cap" $10/mo @50/75/90/100% (plus pre-existing $20 account alert). Droplet limit 25. DigitalOcean: create account, add card (https://cloud.digitalocean.com/account/billing). API → **Generate New Token**, name `pvd311-alice`, scopes: full access is simplest; custom scopes if preferred: droplet (create/read/delete), ssh_key (read/create), firewall (create/read/update), project (read).
- [x] `DIGITALOCEAN_TOKEN` (…86c7, active) in `~/.config/pvd311/ops.env`.
- Verify: `curl -s -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" https://api.digitalocean.com/v2/account | head -c 200` → shows the account with `"status":"active"`.
- (Hetzner instead: project → Security → API Tokens → Read & Write → `HCLOUD_TOKEN=`; note Hetzner does an identity check on new accounts.)

## 6. Resend — REQUIRED (email is the Rob channel; also M6 relays)
- [x] `RESEND_API_KEY` (…Qpqi) in `automation/.env`; test mail delivered 2026-08-22 from `onboarding@resend.dev` → robertbcorey@gmail.com. Until a domain is verified Resend only delivers to Rob's own address (built-in cap). Free tier 3,000/mo. Domain verification happens after the domain exists — alice will add the DNS records via Cloudflare.

---

## Hand-back
When done, the helper agent posts a summary like:
```
Blaze: True | TELEGRAM_BOT_TOKEN ...ab12 (getMe ok, test msg delivered) | ANTHROPIC_API_KEY ...9f3e (ping ok, limit $20)
CLOUDFLARE_API_TOKEN ...77c1 (active) account ...e2 | domain: <bought or "not yet"> | DIGITALOCEAN_TOKEN ...4d0a (active) | RESEND_API_KEY ...(optional)
```
Then tell alice (session "alice 311 lead") via `@alice 311 lead` or SendMessage: "provisioning done, see docs/provisioning-task.md hand-back". Alice takes it from there: kill switch, scout test, Telegram HITL test, domain + inbox, VPS + WAF test.

---

## Hand-back (2026-08-22)
```
Blaze: NO (Spark = $0 cap, by decision) | Telegram: DROPPED → email | ANTHROPIC_API_KEY ...GAAA (ping ok; workspace pvd311 cap $20/mo, alert $10, auto-reload off, $20 credits)
CLOUDFLARE_API_TOKEN ...8ded (active, exp 2026-11-15) account ...5bcb | domain: not yet (Rob buys in dashboard when name picked)
DIGITALOCEAN_TOKEN ...86c7 (active, exp 2026-11-20, custom scopes, no billing) spend alert $10/mo | RESEND_API_KEY ...Qpqi (test mail delivered)
```
Secrets: runtime → `automation/.env`; ops → `~/.config/pvd311/ops.env` (600). Renewals due mid-Nov 2026: Cloudflare + DO tokens.

