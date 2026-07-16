-- Conversation history: last-N messages per (channel, sender) for context.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,          -- 'instagram' | 'whatsapp'
  sender_id TEXT NOT NULL,        -- app-scoped id / wa number
  role TEXT NOT NULL,             -- 'user' | 'assistant'
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL     -- unix seconds
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(channel, sender_id, created_at);

-- Per-customer daily reply cap (anti-abuse, Meta-quota safety).
CREATE TABLE IF NOT EXISTS reply_counts (
  channel TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  day TEXT NOT NULL,              -- YYYY-MM-DD
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel, sender_id, day)
);

-- Editable knowledge bank (overlays the static seed in src/config.ts).
CREATE TABLE IF NOT EXISTS kb (
  key TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

-- Escalation tickets: short code → the customer thread to reply into.
CREATE TABLE IF NOT EXISTS tickets (
  code TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
