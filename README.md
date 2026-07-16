# Meta Social AI Agent

A Claude-powered customer-service agent for **Instagram DMs** and **WhatsApp**, running on a single Cloudflare Worker. One webhook handles both channels: the agent answers common questions from an editable knowledge bank, looks things up with tools, and **escalates anything sensitive to a human** (refunds, complaints, money, uncertainty). Staff reply from WhatsApp; the reply routes back to the customer.

Built to be forked: edit `src/config.ts`, add your secrets, `wrangler deploy`.

## Features

- **Instagram + WhatsApp** through one endpoint, one code path
- **Claude agent** (Anthropic `/messages` API, or any compatible relay) with hard guardrails baked in code
- **Editable knowledge bank** — admins update facts from WhatsApp (`set hours Open 9-5 today`), no redeploy
- **Conversation memory** — context across messages (D1)
- **Human escalation** — ticket-coded, to staff WhatsApp with email fallback
- **Abuse/quota safety** — per-customer daily reply cap
- **Fail-soft everywhere** — any send failure degrades to an email so you're never blind
- **Staged rollout** — `AGENT_ENABLED=false` observes by email first; flip to `true` to go live

## Architecture

```
Instagram DM  ─┐                          ┌─ Claude (agent + guardrails + KB)
WhatsApp msg  ─┼─► Meta webhook ─► Worker ─┼─ D1 (history, KB, tickets, caps)
               │   (HMAC verified)         └─ Resend (escalation + fallback email)
staff WhatsApp ┘   reply "#TICKET text" ──────► back to the customer
```

## Prerequisites

- A Cloudflare account (`npm i -g wrangler`, then `wrangler login`)
- A **Meta app** (developers.facebook.com) with Instagram and/or WhatsApp products
- An **Anthropic API key** (or a compatible relay base URL)
- A **Resend** account + verified sending domain (for escalation/observability email)

---

## Deploy

### 1. Clone & install

```bash
git clone <this-repo> && cd meta-social-ai-agent
npm install
wrangler login
```

### 2. Make it yours

Edit **`src/config.ts`**: business name/location, notify email addresses, the `KB_SEED` facts, and the `SYSTEM_GUARDRAILS` if your rules differ. This is the only file you normally edit.

### 3. Create the database (recommended)

```bash
wrangler d1 create social-agent
```

Copy the printed `database_id` into `wrangler.toml` (uncomment the `[[d1_databases]]` block), then apply the schema:

```bash
wrangler d1 execute social-agent --remote --file=schema.sql
```

> Skipping D1 is fine for a quick test — the bot runs **stateless** (no memory, no editable KB, no caps). Everything else works.

### 4. Set secrets

```bash
wrangler secret put AI_API_KEY            # Anthropic key (or relay key)
wrangler secret put AI_BASE_URL           # https://api.anthropic.com/v1  (or your relay)
wrangler secret put AI_MODEL              # e.g. claude-sonnet-4-6
wrangler secret put META_VERIFY_TOKEN     # any random string you choose (used in step 6)
wrangler secret put META_APP_SECRET       # Instagram app secret  — see §Secrets guide
wrangler secret put META_APP_SECRET_2     # WhatsApp/parent app secret — see §Secrets guide
wrangler secret put IG_ACCESS_TOKEN       # Instagram user token (IGAA…)
wrangler secret put WA_ACCESS_TOKEN       # WhatsApp permanent system-user token (EAA…)
wrangler secret put WA_PHONE_NUMBER_ID    # from WhatsApp API Setup
wrangler secret put ADMIN_WA_NUMBERS      # your staff numbers, comma-separated, intl no '+' (e.g. 61400111222)
wrangler secret put RESEND_API_KEY        # Resend key
```

Generate `META_VERIFY_TOKEN` with e.g. `openssl rand -hex 24`.

### 5. Deploy

```bash
npm run deploy
```

Wrangler prints your URL, e.g. `https://meta-social-ai-agent.<you>.workers.dev`. Your webhook is `<that URL>/webhook`.

### 6. Point Meta at it

In the Meta app, **for each product you use** (Instagram and WhatsApp are configured **separately** — same URL, but each has its own Save):

- **Callback URL:** `https://…workers.dev/webhook`
- **Verify token:** the `META_VERIFY_TOKEN` value from step 4
- Click **Verify and save**
- **Subscribe the `messages` field** (Instagram: also `comments` if you want them)

### 7. Test staged

Leave `AGENT_ENABLED = "false"` (the default in `wrangler.toml`). Send yourself a DM / WhatsApp message → you should get an **email** showing it arrived. That proves the whole pipe end-to-end. When happy, set `AGENT_ENABLED = "true"` and `npm run deploy` — the bot now replies.

---

## Run it locally

```bash
npm run dev              # wrangler dev — serves the Worker on localhost
```

Put your secrets in a `.dev.vars` file (same keys as above, `KEY=value` lines — gitignored). Meta can't reach `localhost`, so to test with real events, tunnel it:

```bash
npx cloudflared tunnel --url http://localhost:8787
```

Use the printed public URL as the Meta callback while developing. For unit-style testing without Meta, POST a sample payload to `http://localhost:8787/webhook` (omit `META_APP_SECRET*` locally to skip signature checks).

---

## Secrets guide — the traps that cost us days

Meta's dashboards make several of these easy to get subtly wrong. Specifics:

### Two different app secrets
Instagram webhook events are signed with the **Instagram product's app secret**; WhatsApp events are signed with the **parent app's App Secret** (App settings → Basic). They are often different values. This Worker validates against **both** (`META_APP_SECRET` and `META_APP_SECRET_2`) and accepts either — set both. Symptom if wrong: `messages` never arrive, deliveries silently 401. This Worker **emails you** when a Meta-shaped payload fails signature validation, so you're not left guessing.

### The WhatsApp "wrong app subscribed" trap
A brand-new WhatsApp Business Account (WABA) is often auto-subscribed to Meta's **placeholder app** ("WA DevX Webhook Events"), not yours — so real messages route into a void while the dashboard looks perfect and the **Test button still works**. Check and fix with your token:

```bash
# List apps subscribed to your WABA:
curl -s "https://graph.facebook.com/v23.0/<WABA_ID>/subscribed_apps" \
  -H "Authorization: Bearer <TOKEN>"
# Subscribe YOUR app:
curl -s -X POST "https://graph.facebook.com/v23.0/<WABA_ID>/subscribed_apps" \
  -H "Authorization: Bearer <TOKEN>"
```

### Token types & lifetimes
- **Instagram** `IG_ACCESS_TOKEN` — an `IGAA…` user token, ~60-day lifetime. Refresh before it lapses (or add a scheduled refresh). Symptom of expiry: agent generates a reply but the **send** fails (you get a "reply FAILED to send" email).
- **WhatsApp** `WA_ACCESS_TOKEN` — use a **permanent System User token** (Business Settings → System users → Add → assign **both** the App and the WhatsApp account as assets → Generate token, expiry **Never**, scopes `whatsapp_business_messaging` + `whatsapp_business_management`). The 24-hour token from the dashboard **expires overnight** — don't use it in production.

### WhatsApp test-number allowlist
A WhatsApp **test** number can only send to numbers in its recipient allowlist (max 5) — add your staff numbers, or escalations fail with `131030: Recipient phone number not in allowed list`. This limit disappears once you register a real business number.

### The 24-hour window (applies even when everything is correct)
WhatsApp only allows free-form messages within **24 hours** of the recipient's last message. Customer replies are always inside it (they messaged you). **Staff escalations are business-initiated** — so a staff number that hasn't messaged the bot recently may not receive the WhatsApp alert. For that reason **email is the more reliable staff-alert channel**; WhatsApp escalation is a bonus when the number is "warm," or wire an approved message template.

### App Review — when you actually need it
Per Meta's docs, **App Review is only required if you build for clients or manage accounts you don't own.** For your own business's own accounts you can go live without review — subject to the 24h window above. (WhatsApp real-number use still needs Business Verification, which runs in the background and doesn't block development.)

---

## Admin commands (from an `ADMIN_WA_NUMBERS` WhatsApp)

| Command | Effect |
|---|---|
| `#<ticket> your message` | Reply to an escalated customer (ticket code is in the escalation) |
| `set <key> <content>` | Add/update a knowledge-bank entry — live immediately |
| `del <key>` | Blank an entry |
| `kb` | Show the current knowledge bank |
| `help` | List commands |

## Customizing

- **Facts** → `src/config.ts` `KB_SEED` (or edit live from WhatsApp)
- **Rules/tone** → `src/config.ts` `SYSTEM_GUARDRAILS`
- **New tools** (stock lookup, order status, booking): add a tool definition + handler in `src/agent.ts`, mirroring `escalateTool`
- **Model / provider** → `AI_MODEL`, `AI_BASE_URL` secrets

## Security notes

- Webhook validates `X-Hub-Signature-256` against your app secret(s) — spoofed events are rejected 401
- Guardrails live in code, not the DB — a compromised admin phone can't rewrite the bot's safety rules
- Customer messages are treated as data; the prompt resists injection and "I'm the manager" social engineering
- Secrets live only in Wrangler secrets, never the repo

## License

MIT — do whatever you want.
