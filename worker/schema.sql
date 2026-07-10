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
