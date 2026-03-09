import { Env } from "../types";

interface LithicTransactionEvent {
  type: string;
  payload: {
    token: string;
    card_token: string;
    amount: number;
    status: string;
    merchant: {
      descriptor: string;
    };
  };
}

export async function handleLithicWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  // TODO: verify HMAC signature from Lithic
  const body: LithicTransactionEvent = await request.json();

  // Log the event for audit
  console.log("Lithic webhook:", body.type, body.payload?.token);

  // We handle card state transitions primarily through our own flow
  // (confirm_purchase / cancel_purchase), but this webhook serves as
  // a safety net and audit log.
  //
  // Future enhancements:
  // - Auto-detect declined transactions and update status
  // - Reconcile amounts if actual charge differs from requested amount
  // - Handle refunds

  return new Response("OK");
}
