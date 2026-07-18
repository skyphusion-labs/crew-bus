-- crew-bus migration 0001: dual-path doorbell targets (#40).
--
-- Apply ONCE to an EXISTING crew-bus D1 (fresh installs get these columns from
-- schema.sql and must NOT run this file: ADD COLUMN would error "duplicate column").
--
--   wrangler d1 execute crew-bus --remote --file=worker/migrations/0001_webhook_vpc_target.sql
--
-- ADD COLUMN is additive and O(1) in SQLite: existing rows default to target_kind
-- 'url' with a null vpc_binding, so every registered public-https doorbell keeps
-- working untouched. A vpc row stores url = '' (the NOT NULL is honoured); delivery
-- gates strictly on target_kind, never reads a vpc row's url.
ALTER TABLE webhook_endpoints ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'url';
ALTER TABLE webhook_endpoints ADD COLUMN vpc_binding TEXT;
