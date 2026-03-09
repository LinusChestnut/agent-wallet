import { Env } from "../types";
import { getApprovedTransactionByCard, writeAuditLog } from "../db/queries";

/**
 * Lithic Authorization Stream Access (ASA) handler.
 *
 * Lithic sends every authorization attempt here in real-time.
 * We must respond within 2 seconds with APPROVE or DECLINE.
 *
 * Security: Only approve if:
 * 1. There's an active approved transaction for this card
 * 2. The authorization amount EXACTLY matches the approved amount (in cents)
 */

interface LithicASARequest {
  token: string;
  card_token: string;
  amount: number; // cents
  merchant: {
    descriptor: string;
    mcc: string;
    city: string;
    state: string;
    country: string;
  };
  status: string;
}

interface LithicASAResponse {
  result: "APPROVE" | "DECLINE";
}

export async function handleLithicASA(
  request: Request,
  env: Env
): Promise<Response> {
  let body: LithicASARequest;
  try {
    body = await request.json();
  } catch {
    return Response.json({ result: "DECLINE" } as LithicASAResponse);
  }

  try {
    // Find the approved transaction for this card
    const txn = await getApprovedTransactionByCard(env.DB, body.card_token);

    if (!txn) {
      await writeAuditLog(env.DB, {
        agentId: "unknown",
        action: "asa_decline_no_txn",
        detail: `card=${body.card_token} amount=${body.amount} merchant=${body.merchant?.descriptor}`,
      });
      return Response.json({ result: "DECLINE" } as LithicASAResponse);
    }

    // Exact amount match (both in cents)
    const approvedAmountCents = Math.round(txn.amount * 100);
    if (body.amount !== approvedAmountCents) {
      await writeAuditLog(env.DB, {
        agentId: txn.agent_id,
        transactionId: txn.id,
        action: "asa_decline_amount_mismatch",
        detail: `expected=${approvedAmountCents} got=${body.amount} merchant=${body.merchant?.descriptor}`,
      });
      return Response.json({ result: "DECLINE" } as LithicASAResponse);
    }

    // Approved — log it
    await writeAuditLog(env.DB, {
      agentId: txn.agent_id,
      transactionId: txn.id,
      action: "asa_approve",
      detail: `amount=${body.amount} merchant=${body.merchant?.descriptor}`,
    });

    return Response.json({ result: "APPROVE" } as LithicASAResponse);
  } catch (err) {
    // On any error, decline for safety
    console.error("ASA handler error:", err);
    return Response.json({ result: "DECLINE" } as LithicASAResponse);
  }
}
