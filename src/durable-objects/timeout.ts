import { Env } from "../types";
import { getTransaction, updateTransactionStatus } from "../db/queries";
import { updateCardStatus, sendNotification } from "../services/feishu";

interface TimeoutState {
  transactionId: string;
  agentName: string;
  agentChatId?: string;
  merchant: string;
  amount: number;
  currency: string;
  reason: string;
  feishuMessageId: string | null;
}

export class PurchaseTimeout implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/set" && request.method === "POST") {
      const body: TimeoutState & { timeoutMs: number } = await request.json();
      const { timeoutMs, ...data } = body;

      await this.state.storage.put("data", data);
      await this.state.storage.setAlarm(Date.now() + timeoutMs);

      return new Response("OK");
    }

    if (url.pathname === "/cancel" && request.method === "POST") {
      await this.state.storage.deleteAlarm();
      await this.state.storage.deleteAll();
      return new Response("OK");
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const data = await this.state.storage.get<TimeoutState>("data");
    if (!data) return;

    const txn = await getTransaction(this.env.DB, data.transactionId);
    if (!txn) return;

    // Only expire if still pending, approved, or qr_submitted
    if (txn.status === "pending" || txn.status === "approved" || txn.status === "qr_submitted") {
      await updateTransactionStatus(this.env.DB, data.transactionId, "expired");

      // Update Feishu card
      if (data.feishuMessageId) {
        try {
          await updateCardStatus(
            this.env.FEISHU_APP_ID,
            this.env.FEISHU_APP_SECRET,
            data.feishuMessageId,
            "expired",
            {
              agentName: data.agentName,
              merchant: data.merchant,
              amount: data.amount,
              currency: data.currency,
              reason: data.reason,
            }
          );
        } catch {
          // Best effort
        }
      }

      // Notify agent's chat channel
      if (data.agentChatId) {
        try {
          await sendNotification(
            this.env.FEISHU_APP_ID,
            this.env.FEISHU_APP_SECRET,
            data.agentChatId,
            `Purchase request expired.\nTransaction: ${data.transactionId}\nMerchant: ${data.merchant}\nAmount: ${data.amount} ${data.currency}\n\n⚠️ Verify status via get_purchase_status before taking action.`
          );
        } catch {
          // Best effort
        }
      }
    }

    await this.state.storage.deleteAll();
  }
}
