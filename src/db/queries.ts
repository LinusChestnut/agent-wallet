import { Agent, Transaction, TransactionStatus, Wallet } from "../types";

export async function getAgentByApiKey(
  db: D1Database,
  apiKey: string
): Promise<Agent | null> {
  return db
    .prepare("SELECT * FROM agents WHERE api_key = ?")
    .bind(apiKey)
    .first<Agent>();
}

export async function getAgentById(
  db: D1Database,
  id: string
): Promise<Agent | null> {
  return db
    .prepare("SELECT * FROM agents WHERE id = ?")
    .bind(id)
    .first<Agent>();
}

export async function getWallet(
  db: D1Database,
  walletId: string
): Promise<Wallet | null> {
  return db
    .prepare("SELECT * FROM wallets WHERE id = ?")
    .bind(walletId)
    .first<Wallet>();
}

export async function getWalletByAgentId(
  db: D1Database,
  agentId: string
): Promise<Wallet | null> {
  return db
    .prepare("SELECT * FROM wallets WHERE agent_id = ?")
    .bind(agentId)
    .first<Wallet>();
}

export async function createAgent(
  db: D1Database,
  agent: Agent,
  wallet: Wallet
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "INSERT INTO agents (id, name, api_key, wallet_id, chat_id) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(agent.id, agent.name, agent.api_key, agent.wallet_id, agent.chat_id),
    db
      .prepare(
        "INSERT INTO wallets (id, agent_id, balance, currency) VALUES (?, ?, ?, ?)"
      )
      .bind(wallet.id, wallet.agent_id, wallet.balance, wallet.currency),
  ]);
}

export async function updateWalletBalance(
  db: D1Database,
  walletId: string,
  newBalance: number
): Promise<void> {
  await db
    .prepare("UPDATE wallets SET balance = ? WHERE id = ?")
    .bind(newBalance, walletId)
    .run();
}

export async function createTransaction(
  db: D1Database,
  txn: Transaction
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO transactions
       (id, wallet_id, agent_id, amount, currency, merchant, reason, status, feishu_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      txn.id,
      txn.wallet_id,
      txn.agent_id,
      txn.amount,
      txn.currency,
      txn.merchant,
      txn.reason,
      txn.status,
      txn.feishu_message_id
    )
    .run();
}

export async function getTransaction(
  db: D1Database,
  id: string
): Promise<Transaction | null> {
  return db
    .prepare("SELECT * FROM transactions WHERE id = ?")
    .bind(id)
    .first<Transaction>();
}

export async function updateTransactionStatus(
  db: D1Database,
  id: string,
  status: TransactionStatus,
  extra?: Partial<Pick<Transaction, "approved_at" | "completed_at" | "qr_image_key">>
): Promise<void> {
  const sets = ["status = ?"];
  const values: unknown[] = [status];

  if (extra?.approved_at) {
    sets.push("approved_at = ?");
    values.push(extra.approved_at);
  }
  if (extra?.completed_at) {
    sets.push("completed_at = ?");
    values.push(extra.completed_at);
  }
  if (extra?.qr_image_key) {
    sets.push("qr_image_key = ?");
    values.push(extra.qr_image_key);
  }

  values.push(id);
  await db
    .prepare(`UPDATE transactions SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
}

export async function getTransactionsByWallet(
  db: D1Database,
  walletId: string,
  limit = 20
): Promise<Transaction[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM transactions WHERE wallet_id = ? ORDER BY requested_at DESC LIMIT ?"
    )
    .bind(walletId, limit)
    .all<Transaction>();
  return results;
}

export async function getDailySpend(
  db: D1Database,
  walletId: string
): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
       WHERE wallet_id = ? AND status IN ('approved', 'qr_submitted', 'completed')
       AND requested_at >= ?`
    )
    .bind(walletId, today + "T00:00:00Z")
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function listAgents(db: D1Database): Promise<(Agent & { balance: number })[]> {
  const { results } = await db
    .prepare(
      `SELECT a.*, w.balance FROM agents a JOIN wallets w ON w.agent_id = a.id ORDER BY a.created_at`
    )
    .all<Agent & { balance: number }>();
  return results;
}

// --- Audit Log ---

export async function writeAuditLog(
  db: D1Database,
  entry: {
    agentId: string;
    transactionId?: string;
    action: string;
    detail?: string;
    ipAddress?: string;
  }
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO audit_log (id, agent_id, transaction_id, action, detail, ip_address) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(
      crypto.randomUUID(),
      entry.agentId,
      entry.transactionId ?? null,
      entry.action,
      entry.detail ?? "",
      entry.ipAddress ?? null
    )
    .run();
}

// --- Feishu callback idempotency ---

export async function isTransactionActionable(
  db: D1Database,
  transactionId: string
): Promise<boolean> {
  const txn = await db
    .prepare("SELECT status FROM transactions WHERE id = ?")
    .bind(transactionId)
    .first<{ status: string }>();
  return txn?.status === "pending";
}
