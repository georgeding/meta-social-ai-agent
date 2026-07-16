/**
 * Meta social AI agent — Cloudflare Worker.
 *
 * One webhook endpoint serves both Instagram DMs and WhatsApp messages:
 *
 *   GET  /webhook   Meta verification handshake (hub.challenge echo)
 *   POST /webhook   Event delivery — HMAC-validated, then either
 *                   observed (email only) or answered by the agent,
 *                   depending on AGENT_ENABLED.
 *
 * Staged rollout:
 *   AGENT_ENABLED unset/false → every inbound message is emailed to you
 *   AGENT_ENABLED "true"      → Claude answers customers; escalations go
 *                               to staff WhatsApp (email fallback); staff
 *                               reply `#<ticket> text`; admins manage the
 *                               knowledge bank from WhatsApp.
 */

import { runCustomerAgent, type AgentEnv, type AIMessage } from "./agent";
import { sendInstagramReply, sendWhatsApp, type MetaEnv } from "./meta";
import {
  loadHistory,
  saveMessage,
  underDailyCap,
  bumpDailyCap,
  loadKBText,
  setKB,
  saveTicket,
  lookupTicket,
  type StoreEnv,
} from "./store";
import { BUSINESS } from "./config";

export interface Env extends AgentEnv, MetaEnv, StoreEnv {
  META_VERIFY_TOKEN?: string;
  /** Instagram events sign with the Instagram app secret… */
  META_APP_SECRET?: string;
  /** …WhatsApp events sign with the parent Meta app's App Secret. */
  META_APP_SECRET_2?: string;
  RESEND_API_KEY?: string;
  ADMIN_WA_NUMBERS?: string; // comma-separated, intl format, no '+'
  AGENT_ENABLED?: string;
}

const MAX_BODY = 65_536;

/* ---------------- signature validation ---------------- */

const hex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function signatureValid(
  secret: string,
  rawBody: string,
  header: string | null,
): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = `sha256=${hex(mac)}`;
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

/* ---------------- email (observability + fallback) ---------------- */

async function email(env: Env, subject: string, text: string): Promise<void> {
  if (!env.RESEND_API_KEY) return;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: BUSINESS.notifyFrom,
      to: [BUSINESS.notifyTo],
      subject,
      text,
    }),
  }).catch(() => undefined);
}

/* ---------------- payload normalization ---------------- */

interface InboundMessage {
  channel: "instagram" | "whatsapp";
  senderId: string;
  text: string;
}

/** Normalize both products' payload shapes (live + dashboard Test). */
function extractMessages(payload: Record<string, unknown>): InboundMessage[] {
  const out: InboundMessage[] = [];
  const object = String(payload.object ?? "");
  const entries = (payload.entry ?? []) as Array<Record<string, unknown>>;

  for (const entry of entries) {
    // Instagram live shape
    for (const m of (entry.messaging ?? []) as Array<Record<string, unknown>>) {
      const msg = m.message as { text?: string; is_echo?: boolean } | undefined;
      const sender = m.sender as { id?: string } | undefined;
      if (msg?.text && !msg.is_echo && sender?.id) {
        out.push({ channel: "instagram", senderId: sender.id, text: msg.text });
      }
    }
    // changes[] shape: WhatsApp lives here; dashboard Test events too
    for (const c of (entry.changes ?? []) as Array<Record<string, unknown>>) {
      const v = (c.value ?? {}) as Record<string, unknown>;
      if (object === "whatsapp_business_account") {
        for (const wm of (v.messages ?? []) as Array<Record<string, unknown>>) {
          const body = (wm.text as { body?: string } | undefined)?.body;
          if (wm.type === "text" && body && wm.from) {
            out.push({ channel: "whatsapp", senderId: String(wm.from), text: body });
          }
        }
      } else {
        const msg = v.message as { text?: string; is_echo?: boolean } | undefined;
        const sender = v.sender as { id?: string } | undefined;
        if (msg?.text && !msg.is_echo && sender?.id) {
          out.push({ channel: "instagram", senderId: sender.id, text: msg.text });
        }
      }
    }
  }
  return out;
}

/* ---------------- handlers ---------------- */

const adminNumbers = (env: Env): string[] =>
  (env.ADMIN_WA_NUMBERS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^\+/, ""))
    .filter(Boolean);

const ticketCode = (senderId: string, now: number): string => {
  let h = now;
  for (const c of senderId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h.toString(36).slice(-5).toUpperCase();
};

const today = (now: number): string => new Date(now * 1000).toISOString().slice(0, 10);

async function handleAdminWhatsApp(env: Env, m: InboundMessage, now: number): Promise<void> {
  const t = m.text.trim();

  const routed = t.match(/^#(\S+)\s+([\s\S]+)/);
  if (routed) {
    const target =
      (await lookupTicket(env.DB, routed[1].toUpperCase())) ??
      (/^\d{6,}$/.test(routed[1]) ? { channel: "instagram", sender_id: routed[1] } : null);
    if (!target) {
      await sendWhatsApp(env, m.senderId, `No open ticket "${routed[1]}". Use the code from the escalation, or #<customer_id>.`);
      return;
    }
    const body = routed[2].trim();
    const ok =
      target.channel === "instagram"
        ? await sendInstagramReply(env, target.sender_id, body)
        : await sendWhatsApp(env, target.sender_id, body);
    if (ok) await saveMessage(env.DB, target.channel, target.sender_id, "assistant", body, now);
    await sendWhatsApp(env, m.senderId, ok ? "✓ sent to the customer." : "✗ send failed — likely outside the 24h window.");
    if (!ok) await email(env, "[bot] staff reply failed to send", `To ${target.channel} ${target.sender_id}: ${body}`);
    return;
  }

  const setCmd = t.match(/^set\s+([a-z0-9_]+)\s+([\s\S]+)/i);
  if (setCmd) {
    const ok = await setKB(env.DB, setCmd[1].toLowerCase(), setCmd[2].trim(), now, m.senderId);
    await sendWhatsApp(env, m.senderId, ok ? `✓ KB "${setCmd[1].toLowerCase()}" updated. Live now.` : "✗ KB store unavailable (no D1 binding).");
    return;
  }
  const delCmd = t.match(/^del\s+([a-z0-9_]+)/i);
  if (delCmd) {
    const ok = await setKB(env.DB, delCmd[1].toLowerCase(), "", now, m.senderId);
    await sendWhatsApp(env, m.senderId, ok ? `✓ KB "${delCmd[1].toLowerCase()}" blanked.` : "✗ KB store unavailable.");
    return;
  }
  if (/^kb$/i.test(t)) {
    await sendWhatsApp(env, m.senderId, (await loadKBText(env.DB)).slice(0, 3900));
    return;
  }
  if (/^(help|\?)$/i.test(t)) {
    await sendWhatsApp(
      env,
      m.senderId,
      "Admin channel:\n• #<code> <text> — reply to an escalated customer\n• set <key> <content> — add/update a knowledge-bank entry\n• del <key> — blank an entry\n• kb — show the knowledge bank\n• help — this message",
    );
    return;
  }
  await sendWhatsApp(env, m.senderId, "Unrecognized command. Send `help`.");
}

async function handleCustomer(env: Env, m: InboundMessage, now: number): Promise<void> {
  const day = today(now);
  if (!(await underDailyCap(env.DB, m.channel, m.senderId, day))) {
    await email(env, `[bot] ${m.channel} customer over daily cap`, `From ${m.senderId}: ${m.text}`);
    return;
  }

  const [history, kbText] = await Promise.all([
    loadHistory(env.DB, m.channel, m.senderId),
    loadKBText(env.DB),
  ]);
  await saveMessage(env.DB, m.channel, m.senderId, "user", m.text, now);

  const { reply, escalation } = await runCustomerAgent(
    env,
    kbText,
    m.text,
    history as AIMessage[],
  );

  if (reply) {
    const sent =
      m.channel === "instagram"
        ? await sendInstagramReply(env, m.senderId, reply)
        : await sendWhatsApp(env, m.senderId, reply);
    if (sent) {
      await saveMessage(env.DB, m.channel, m.senderId, "assistant", reply, now);
      await bumpDailyCap(env.DB, m.channel, m.senderId, day);
    } else {
      await email(env, "[bot] reply FAILED to send", `Channel ${m.channel}, to ${m.senderId}\nCustomer: ${m.text}\nBot: ${reply}`);
    }
  } else if (!escalation) {
    await email(env, `[bot] unanswered ${m.channel} message`, `From ${m.senderId}: ${m.text}`);
  }

  if (escalation) {
    const code = ticketCode(m.senderId, now);
    await saveTicket(env.DB, code, m.channel, m.senderId, now);
    const note = `🚨 Escalation (${escalation.reason}) · ticket ${code}\nFrom ${m.channel}:\n"${m.text.slice(0, 400)}"\n\nSummary: ${escalation.summary}\n\nReply with:\n#${code} your message`;
    let delivered = false;
    for (const admin of adminNumbers(env)) {
      if (await sendWhatsApp(env, admin, note)) delivered = true;
    }
    if (!delivered) await email(env, `[bot] ESCALATION (${escalation.reason}) ticket ${code}`, note);
  }
}

/* ---------------- worker entry ---------------- */

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/webhook") return new Response("not found", { status: 404 });

    if (request.method === "GET") {
      if (
        url.searchParams.get("hub.mode") === "subscribe" &&
        env.META_VERIFY_TOKEN &&
        url.searchParams.get("hub.verify_token") === env.META_VERIFY_TOKEN &&
        url.searchParams.get("hub.challenge")
      ) {
        return new Response(url.searchParams.get("hub.challenge"), { status: 200 });
      }
      return new Response("forbidden", { status: 403 });
    }

    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    const raw = await request.text();
    if (raw.length > MAX_BODY) return new Response("too large", { status: 413 });

    const secrets = [env.META_APP_SECRET, env.META_APP_SECRET_2].filter(
      (x): x is string => !!x,
    );
    if (secrets.length > 0) {
      const header = request.headers.get("X-Hub-Signature-256");
      let ok = false;
      for (const secret of secrets) {
        if (await signatureValid(secret, raw, header)) {
          ok = true;
          break;
        }
      }
      if (!ok) {
        // Config problem, not an attack — surface it (deduped hourly).
        if (/"object"\s*:\s*"(whatsapp_business_account|instagram)"/.test(raw)) {
          const objectType = raw.includes("whatsapp_business_account") ? "whatsapp" : "instagram";
          const cache = (caches as unknown as { default: Cache }).default;
          const key = new Request(`https://sigfail-dedupe.invalid/${objectType}`);
          if (!(await cache.match(key))) {
            await cache.put(key, new Response("1", { headers: { "Cache-Control": "max-age=3600" } }));
            await email(
              env,
              `[bot] ${objectType} webhook REJECTED (bad signature)`,
              `A ${objectType} delivery failed HMAC validation.\nSignature header present: ${header ? "yes" : "NO"}\nLikely cause: META_APP_SECRET${objectType === "whatsapp" ? "_2 (parent app secret)" : " (Instagram app secret)"} missing or wrong.`,
            );
          }
        }
        return new Response("bad signature", { status: 401 });
      }
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw);
    } catch {
      return new Response("ok", { status: 200 });
    }

    const messages = extractMessages(payload);
    if (messages.length === 0) return new Response("ok", { status: 200 });

    const agentOn = String(env.AGENT_ENABLED ?? "false").toLowerCase() === "true";
    const admins = adminNumbers(env);
    const nowSec = Math.floor(Date.now() / 1000);

    const work = (async () => {
      for (const m of messages) {
        if (!agentOn) {
          await email(env, `[bot] new ${m.channel} message`, `From ${m.senderId}: ${m.text.slice(0, 800)}`);
          continue;
        }
        if (m.channel === "whatsapp" && admins.includes(m.senderId.replace(/^\+/, ""))) {
          await handleAdminWhatsApp(env, m, nowSec);
        } else {
          await handleCustomer(env, m, nowSec);
        }
      }
    })();

    // Answer Meta fast; finish agent work out of band. Meta retries and
    // eventually disables endpoints that respond slowly.
    ctx.waitUntil(work);
    return new Response("ok", { status: 200 });
  },
};
