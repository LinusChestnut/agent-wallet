export interface Env {
  DB: D1Database;
  PURCHASE_TIMEOUT: DurableObjectNamespace;
  FEISHU_APP_ID: string;
  FEISHU_APP_SECRET: string;
  FEISHU_ENCRYPT_KEY: string;
  FEISHU_VERIFY_TOKEN: string;
  ADMIN_SECRET: string;
  LOW_BALANCE_THRESHOLD: string;
  REQUEST_TIMEOUT_MINUTES: string;
  DAILY_SPEND_CAP: string;
}

export type TransactionStatus =
  | "pending"
  | "approved"
  | "qr_submitted"
  | "completed"
  | "denied"
  | "failed"
  | "expired";

export interface Agent {
  id: string;
  name: string;
  api_key: string;
  wallet_id: string;
  chat_id: string;
  created_at: string;
}

export interface Wallet {
  id: string;
  agent_id: string;
  balance: number;
  currency: string;
  created_at: string;
}

export interface Transaction {
  id: string;
  wallet_id: string;
  agent_id: string;
  amount: number;
  currency: string;
  merchant: string;
  reason: string;
  status: TransactionStatus;
  qr_image_key: string | null;
  feishu_message_id: string | null;
  requested_at: string;
  approved_at: string | null;
  completed_at: string | null;
}

export interface McpRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
