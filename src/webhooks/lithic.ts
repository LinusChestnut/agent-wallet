import { Env } from "../types";
import { verifyLithicWebhook } from "../services/lithic";
import { writeAuditLog } from "../db/queries";

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
  const body = await request.text();

  // Verify webhook signature
  const webhookId = request.headers.get("webhook-id") ?? "";
  const webhookTimestamp = request.headers.get("webhook-timestamp") ?? "";
  const webhookSignature = request.headers.get("webhook-signature") ?? "";

  const valid = await verifyLithicWebhook(
    body,
    webhookSignature,
    webhookId,
    webhookTimestamp,
    env.LITHIC_WEBHOOK_SECRET
  );
  if (!valid) {
    console.error("Lithic webhook signature verification failed");
    return new Response("Invalid signature", { status: 403 });
  }

  let event: LithicTransactionEvent;
  try {
    event = JSON.parse(body);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Audit log the webhook event
  await writeAuditLog(env.DB, {
    agentId: "lithic_webhook",
    action: `lithic_${event.type}`,
    detail: `card=${event.payload?.card_token} amount=${event.payload?.amount} status=${event.payload?.status} merchant=${event.payload?.merchant?.descriptor}`,
  });

  // We handle card state transitions primarily through our own flow
  // (confirm_purchase / cancel_purchase), but this webhook serves as
  // a safety net and audit log.

  return new Response("OK");
}
