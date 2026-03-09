import { Env } from "../types";
import { getTransaction, updateTransactionStatus } from "../db/queries";
import { updateCardState } from "../services/lithic";
import { updateCardStatus } from "../services/feishu";

interface TimeoutState {
  transactionId: string;
  cardToken: string;
  agentName: string;
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

    // Only expire if still pending or approved (not yet used)
    if (txn.status === "pending" || txn.status === "approved") {
      await updateTransactionStatus(this.env.DB, data.transactionId, "expired");

      // Re-pause the card if it was unpaused
      if (txn.status === "approved") {
        try {
          await updateCardState(this.env.LITHIC_API_KEY, data.cardToken, "PAUSED");
        } catch {
          // Best effort — card might already be paused
        }
      }

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
    }

    await this.state.storage.deleteAll();
  }
}
