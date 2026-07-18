-- crew-bus D1 schema (fc#427)

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  from_consumer TEXT NOT NULL,
  to_json TEXT NOT NULL,
  type TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  body TEXT NOT NULL,
  refs_json TEXT,
  requires_ack INTEGER NOT NULL DEFAULT 0,
  ack_of TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS cursors (
  consumer TEXT NOT NULL,
  channel TEXT NOT NULL,
  last_seen_id TEXT,
  last_seen_at TEXT,
  PRIMARY KEY (consumer, channel)
);

CREATE TABLE IF NOT EXISTS acks (
  message_id TEXT NOT NULL,
  from_consumer TEXT NOT NULL,
  body TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, from_consumer)
);

-- Consumer discovery + delivery visibility (fc#427 / #17). last_poll_at is
-- upserted on each authenticated bus_poll; powers bus_consumers and the
-- polled_after signal in bus_thread delivery reports.
CREATE TABLE IF NOT EXISTS consumers (
  name TEXT PRIMARY KEY,
  last_poll_at TEXT
);

-- Doorbell webhooks (#26, v0.4.0). ADDITIVE ONLY: new tables, no ALTER of the
-- tables above. A registered endpoint is rung (never mailed) on a successful
-- send so the receiver polls sooner; a lost/failed doorbell degrades to polling.
-- #40 dual-path targets: target_kind 'url' keeps the v0.4.0 public-https shape;
-- target_kind 'vpc' rings through a Workers VPC binding (vpc_binding) to a per-box
-- doorbell mux, so fleet seats need no public hooks-* tunnel. For a vpc row `url` is
-- the empty string (the NOT NULL is honoured; delivery gates strictly on target_kind).
-- Existing DBs get these two columns via migrations/0001_webhook_vpc_target.sql.
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  consumer    TEXT PRIMARY KEY,   -- FK-by-convention to roster consumer name
  target_kind TEXT NOT NULL DEFAULT 'url',  -- 'url' | 'vpc' (#40)
  url         TEXT NOT NULL,      -- https for a url row; '' for a vpc row
  vpc_binding TEXT,               -- Workers VPC binding NAME for a vpc row; null otherwise (#40)
  secret      TEXT NOT NULL,      -- HMAC key for signing (protects the receiver)
  auth_env    TEXT,               -- optional: NAME of a Worker secret sent as Authorization (D1 holds only the name)
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  message_id   TEXT NOT NULL,
  consumer     TEXT NOT NULL,
  delivered_at TEXT,             -- null until a 2xx lands
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_status  INTEGER,          -- last HTTP status (or 0 for network error)
  PRIMARY KEY (message_id, consumer)
);

-- Claim arbitration for broadcast handoffs (#41, v0.5.0). ADDITIVE ONLY.
-- The PRIMARY KEY on message_id IS the arbitration: the first INSERT lands,
-- every later claim hits ON CONFLICT DO NOTHING and reads back the winner.
-- Rows are immutable; a claim is never transferred or released (re-broadcast a
-- new handoff instead).
CREATE TABLE IF NOT EXISTS claims (
  message_id TEXT PRIMARY KEY,
  claimed_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
