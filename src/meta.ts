/**
 * Meta send helpers — Instagram DM replies and WhatsApp messages.
 * Fail soft (return false) so the webhook can fall back to email; a
 * reply must never take down event ingestion.
 */

export interface MetaEnv {
  IG_ACCESS_TOKEN?: string; // Instagram user token (IGAA…, ~60 days)
  WA_ACCESS_TOKEN?: string; // permanent system-user token (EAA…)
  WA_PHONE_NUMBER_ID?: string;
}

/** Reply to an Instagram user by their app-scoped id. */
export async function sendInstagramReply(
  env: MetaEnv,
  recipientId: string,
  text: string,
): Promise<boolean> {
  if (!env.IG_ACCESS_TOKEN) return false;
  const res = await fetch("https://graph.instagram.com/v23.0/me/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.IG_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text: text.slice(0, 900) },
    }),
  }).catch(() => null);
  return !!res?.ok;
}

/** Send a WhatsApp text message from the business number. */
export async function sendWhatsApp(
  env: MetaEnv,
  to: string,
  text: string,
): Promise<boolean> {
  if (!env.WA_ACCESS_TOKEN || !env.WA_PHONE_NUMBER_ID) return false;
  const res = await fetch(
    `https://graph.facebook.com/v23.0/${env.WA_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.WA_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text.slice(0, 4000) },
      }),
    },
  ).catch(() => null);
  return !!res?.ok;
}
