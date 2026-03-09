import { Env, Transaction } from "../types";
import {
  createTransaction,
  getTransaction,
  getAgentById,
  updateTransactionStatus,
} from "../db/queries";
import { sendApprovalCard, sendQrCard, sendNotification, updateCardStatus, uploadImage } from "./feishu";

export async function requestPurchase(
  env: Env,
  agent: { id: string; name: string },
  chatId: string,
  params: { merchant: string; amount: number; currency?: string; reason?: string }
): Promise<{ transactionId: string }> {
  const currency = params.currency ?? "CNY";
  const reason = params.reason ?? "";

  const txnId = crypto.randomUUID();
  const txn: Transaction = {
    id: txnId,
    agent_id: agent.id,
    chat_id: chatId,
    amount: params.amount,
    currency,
    merchant: params.merchant,
    reason,
    status: "pending",
    qr_image_key: null,
    feishu_message_id: null,
    requested_at: new Date().toISOString(),
    approved_at: null,
    completed_at: null,
  };

  // Send Feishu approval card to the user
  const messageId = await sendApprovalCard(
    env.FEISHU_APP_ID,
    env.FEISHU_APP_SECRET,
    chatId,
    {
      id: txnId,
      agentName: agent.name,
      merchant: params.merchant,
      amount: params.amount,
      currency,
      reason,
    }
  );

  txn.feishu_message_id = messageId;
  await createTransaction(env.DB, txn);

  // Set timeout via Durable Object
  const timeoutMinutes = parseInt(env.REQUEST_TIMEOUT_MINUTES) || 10;
  const doId = env.PURCHASE_TIMEOUT.idFromName(txnId);
  const doStub = env.PURCHASE_TIMEOUT.get(doId);
  await doStub.fetch("https://do/set", {
    method: "POST",
    body: JSON.stringify({
      transactionId: txnId,
      agentName: agent.name,
      agentChatId: chatId,
      merchant: params.merchant,
      amount: params.amount,
      currency,
      reason,
      feishuMessageId: messageId,
      timeoutMs: timeoutMinutes * 60 * 1000,
    }),
  });

  return { transactionId: txnId };
}

/**
 * Handle user approval/denial from Feishu callback.
 * On approval, sends a notification to the agent's chat channel
 * so the agent wakes up and proceeds with checkout.
 */
export async function handleApproval(
  env: Env,
  transactionId: string,
  approved: boolean
): Promise<void> {
  const txn = await getTransaction(env.DB, transactionId);
  if (!txn) throw new Error("Transaction not found");
  if (txn.status !== "pending") throw new Error(`Transaction is ${txn.status}, not pending`);

  const agent = await getAgentById(env.DB, txn.agent_id);

  if (!approved) {
    await updateTransactionStatus(env.DB, transactionId, "denied");

    // Cancel timeout
    const doId = env.PURCHASE_TIMEOUT.idFromName(transactionId);
    const doStub = env.PURCHASE_TIMEOUT.get(doId);
    await doStub.fetch("https://do/cancel", { method: "POST" });

    if (txn.feishu_message_id) {
      await updateCardStatus(env.FEISHU_APP_ID, env.FEISHU_APP_SECRET, txn.feishu_message_id, "denied", {
        agentName: agent?.name ?? "",
        merchant: txn.merchant,
        amount: txn.amount,
        currency: txn.currency,
        reason: txn.reason,
      });
    }

    if (txn.chat_id) {
      await sendNotification(
        env.FEISHU_APP_ID,
        env.FEISHU_APP_SECRET,
        txn.chat_id,
        `Purchase denied.\nTransaction: ${transactionId}\nMerchant: ${txn.merchant}\nAmount: ${txn.amount} ${txn.currency}\n\n⚠️ Verify status via get_purchase_status before taking action.`
      );
    }

    return;
  }

  // Approved
  await updateTransactionStatus(env.DB, transactionId, "approved", {
    approved_at: new Date().toISOString(),
  });

  if (txn.feishu_message_id) {
    await updateCardStatus(env.FEISHU_APP_ID, env.FEISHU_APP_SECRET, txn.feishu_message_id, "approved", {
      agentName: agent?.name ?? "",
      merchant: txn.merchant,
      amount: txn.amount,
      currency: txn.currency,
      reason: txn.reason,
    });
  }

  // Notify agent's chat channel — this is the wake signal
  if (agent?.chat_id) {
    await sendNotification(
      env.FEISHU_APP_ID,
      env.FEISHU_APP_SECRET,
      agent.chat_id,
      `Purchase approved by owner.\nTransaction: ${transactionId}\nMerchant: ${txn.merchant}\nAmount: ${txn.amount} ${txn.currency}\n\n⚠️ Verify status via get_purchase_status before proceeding.`
    );
  }
}

/**
 * Agent submits a payment QR code. The QR is uploaded to Feishu
 * and sent to the user for scanning.
 */
export async function submitPaymentQr(
  env: Env,
  transactionId: string,
  agentId: string,
  qrImageBase64: string
): Promise<void> {
  const txn = await getTransaction(env.DB, transactionId);
  if (!txn) throw new Error("Transaction not found");
  if (txn.agent_id !== agentId) throw new Error("Not your transaction");
  if (txn.status !== "approved") throw new Error(`Transaction is ${txn.status}, not approved`);

  const agent = await getAgentById(env.DB, agentId);
  if (!agent) throw new Error("Agent not found");

  // Decode base64 QR image and upload to Feishu
  const imageData = Uint8Array.from(atob(qrImageBase64), (c) => c.charCodeAt(0));
  const imageKey = await uploadImage(env.FEISHU_APP_ID, env.FEISHU_APP_SECRET, imageData);

  // Send QR card to the user's chat (same chat the request came from)
  await sendQrCard(
    env.FEISHU_APP_ID,
    env.FEISHU_APP_SECRET,
    txn.chat_id,
    {
      id: transactionId,
      agentName: agent.name,
      merchant: txn.merchant,
      amount: txn.amount,
      currency: txn.currency,
    },
    imageKey
  );

  await updateTransactionStatus(env.DB, transactionId, "qr_submitted", {
    qr_image_key: imageKey,
  });
}

/**
 * Agent confirms that the payment went through on the merchant side.
 */
export async function confirmPurchase(
  env: Env,
  transactionId: string
): Promise<void> {
  const txn = await getTransaction(env.DB, transactionId);
  if (!txn) throw new Error("Transaction not found");
  if (txn.status !== "approved" && txn.status !== "qr_submitted") {
    throw new Error(`Transaction is ${txn.status}, expected approved or qr_submitted`);
  }

  const agent = await getAgentById(env.DB, txn.agent_id);

  await updateTransactionStatus(env.DB, transactionId, "completed", {
    completed_at: new Date().toISOString(),
  });

  // Cancel timeout
  const doId = env.PURCHASE_TIMEOUT.idFromName(transactionId);
  const doStub = env.PURCHASE_TIMEOUT.get(doId);
  await doStub.fetch("https://do/cancel", { method: "POST" });

  if (txn.feishu_message_id) {
    await updateCardStatus(env.FEISHU_APP_ID, env.FEISHU_APP_SECRET, txn.feishu_message_id, "completed", {
      agentName: agent?.name ?? "",
      merchant: txn.merchant,
      amount: txn.amount,
      currency: txn.currency,
      reason: txn.reason,
    });
  }
}

/**
 * Agent cancels an approved purchase.
 */
export async function cancelPurchase(
  env: Env,
  transactionId: string
): Promise<void> {
  const txn = await getTransaction(env.DB, transactionId);
  if (!txn) throw new Error("Transaction not found");
  if (txn.status !== "approved" && txn.status !== "qr_submitted") {
    throw new Error(`Transaction is ${txn.status}, expected approved or qr_submitted`);
  }

  await updateTransactionStatus(env.DB, transactionId, "failed");

  // Cancel timeout
  const doId = env.PURCHASE_TIMEOUT.idFromName(transactionId);
  const doStub = env.PURCHASE_TIMEOUT.get(doId);
  await doStub.fetch("https://do/cancel", { method: "POST" });

  const agent = await getAgentById(env.DB, txn.agent_id);
  if (txn.feishu_message_id) {
    await updateCardStatus(env.FEISHU_APP_ID, env.FEISHU_APP_SECRET, txn.feishu_message_id, "failed", {
      agentName: agent?.name ?? "",
      merchant: txn.merchant,
      amount: txn.amount,
      currency: txn.currency,
      reason: txn.reason,
    });
  }
}
