CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  api_key TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  chat_id TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  merchant TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  qr_image_key TEXT,
  feishu_message_id TEXT,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  transaction_id TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_agent ON transactions(agent_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_agents_api_key ON agents(api_key);
CREATE INDEX IF NOT EXISTS idx_audit_log_agent ON audit_log(agent_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_txn ON audit_log(transaction_id);
