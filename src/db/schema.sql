CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  api_key TEXT NOT NULL UNIQUE,
  wallet_id TEXT NOT NULL,
  card_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL UNIQUE REFERENCES agents(id),
  balance REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  merchant TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  card_token TEXT,
  lithic_txn_id TEXT,
  feishu_message_id TEXT,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_transactions_wallet ON transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_agents_api_key ON agents(api_key);
