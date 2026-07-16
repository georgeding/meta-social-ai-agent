/**
 * D1-backed state: conversation history, per-customer daily reply caps,
 * runtime-editable knowledge bank, escalation tickets. Every helper
 * no-ops gracefully without the DB binding so the bot still runs
 * (stateless) before you wire D1.
 */

import { KB_SEED, formatKB, DAILY_REPLY_CAP, HISTORY_TURNS, type KBEntry } from "./config";

export interface StoreEnv {
  DB?: D1Database;
}

export interface HistoryMsg {
  role: "user" | "assistant";
  content: string;
}

export async function loadHistory(
  db: D1Database | undefined,
  channel: string,
  senderId: string,
): Promise<HistoryMsg[]> {
  if (!db) return [];
  const { results } = await db
    .prepare(
      `SELECT role, content FROM messages
       WHERE channel = ? AND sender_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .bind(channel, senderId, HISTORY_TURNS)
    .all<HistoryMsg>();
  return (results ?? []).reverse();
}

export async function saveMessage(
  db: D1Database | undefined,
  channel: string,
  senderId: string,
  role: "user" | "assistant",
  content: string,
  now: number,
): Promise<void> {
  if (!db) return;
  await db
    .prepare(
      `INSERT INTO messages (channel, sender_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(channel, senderId, role, content.slice(0, 4000), now)
    .run();
}

export async function underDailyCap(
  db: D1Database | undefined,
  channel: string,
  senderId: string,
  day: string,
): Promise<boolean> {
  if (!db) return true;
  const row = await db
    .prepare(
      `SELECT count FROM reply_counts WHERE channel = ? AND sender_id = ? AND day = ?`,
    )
    .bind(channel, senderId, day)
    .first<{ count: number }>();
  return (row?.count ?? 0) < DAILY_REPLY_CAP;
}

export async function bumpDailyCap(
  db: D1Database | undefined,
  channel: string,
  senderId: string,
  day: string,
): Promise<void> {
  if (!db) return;
  await db
    .prepare(
      `INSERT INTO reply_counts (channel, sender_id, day, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(channel, sender_id, day) DO UPDATE SET count = count + 1`,
    )
    .bind(channel, senderId, day)
    .run();
}

/** Merged KB: static seed overlaid with admin edits from D1. */
export async function loadKBText(db: D1Database | undefined): Promise<string> {
  if (!db) return formatKB(KB_SEED);
  const { results } = await db
    .prepare(`SELECT key, content FROM kb`)
    .all<{ key: string; content: string }>();
  const overrides = new Map((results ?? []).map((r) => [r.key, r.content]));
  const merged: KBEntry[] = KB_SEED.map((e) =>
    overrides.has(e.key) ? { key: e.key, content: overrides.get(e.key)! } : e,
  );
  for (const [key, content] of overrides) {
    if (!KB_SEED.some((e) => e.key === key)) merged.push({ key, content });
  }
  return formatKB(merged.filter((e) => e.content.trim() !== ""));
}

export async function setKB(
  db: D1Database | undefined,
  key: string,
  content: string,
  now: number,
  by: string,
): Promise<boolean> {
  if (!db) return false;
  await db
    .prepare(
      `INSERT INTO kb (key, content, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET content = excluded.content,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(key.slice(0, 60), content.slice(0, 2000), now, by)
    .run();
  return true;
}

export async function saveTicket(
  db: D1Database | undefined,
  code: string,
  channel: string,
  senderId: string,
  now: number,
): Promise<void> {
  if (!db) return;
  await db
    .prepare(
      `INSERT OR REPLACE INTO tickets (code, channel, sender_id, created_at) VALUES (?, ?, ?, ?)`,
    )
    .bind(code, channel, senderId, now)
    .run();
}

export async function lookupTicket(
  db: D1Database | undefined,
  code: string,
): Promise<{ channel: string; sender_id: string } | null> {
  if (!db) return null;
  return await db
    .prepare(`SELECT channel, sender_id FROM tickets WHERE code = ?`)
    .bind(code)
    .first<{ channel: string; sender_id: string }>();
}
