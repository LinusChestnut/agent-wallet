import { Env, Transaction } from "../types";
import {
  createTransaction,
  getTransaction,
  getWalletByAgentId,
  getDailySpend,
  updateTransactionStatus,
  updateWalletBalance,
} from "../db/queries";
import { updateCardState, updateCardSpendLimit, getCardDetails } from "./lithic";
import { sendApprovalCard, updateCardStatus } from "./feishu";

export async function requestPurchase(
  env: Env,
  agent: { id: string; name: string; card_token: string },
  chatId: string,
  params: { merchant: string; amount: number; currency?: string; reason?: string }
): Promise<{ transactionId: string }> {
  const currency = params.currency ?? "USD";
  const reason = params.reason ?? "";

  const wallet = await getWalletByAgentId(env.DB, agent.id);
  if (!wallet) throw new Error("Wallet not found");

  if (wallet.balance < params.amount) {
    throw new Error(
      `Insufficient balance: ${wallet.balance} ${currency} available, ${params.amount} ${currency} requested`
    );
  }

  const dailySpend = await getDailySpend(env.DB, wallet.id);
  const dailyCap = parseFloat(env.DAILY_SPEND_CAP);
  if (dailySpend + params.amount > dailyCap) {
    throw new Error(
      `Daily spend cap exceeded: ${dailySpend} ${currency} spent today, cap is ${dailyCap} ${currency}`
    );
  }

  const txnId = crypto.randomUUID();
  const txn: Transaction = {
    id: txnId,
    wallet_id: wallet.id,
    agent_id: agent.id,
    amount: params.amount,
    currency,
    merchant: params.merchant,
    reason,
    status: "pending",
    card_token: agent.card_token,
    lithic_txn_id: null,
    feishu_message_id: null,
    requested_at: new Date().toISOString(),
    approved_at: null,
    completed_at: null,
  };

  // Send Feishu approval card
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
      cardToken: agent.card_token,
      agentName: agent.name,
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

export async function handleApproval(
  env: Env,
  transactionId: string,
  approved: boolean
): Promise<void> {
  const txn = await getTransaction(env.DB, transactionId);
  if (!txn) throw new Error("Transaction not found");
  if (txn.status !== "pending") throw new Error(`Transaction is ${txn.status}, not pending`);

  if (!approved) {
    await updateTransactionStatus(env.DB, transactionId, "denied");

    // Cancel timeout
    const doId = env.PURCHASE_TIMEOUT.idFromName(transactionId);
    const doStub = env.PURCHASE_TIMEOUT.get(doId);
    await doStub.fetch("https://do/cancel", { method: "POST" });

    // Update Feishu card
    if (txn.feishu_message_id) {
      await updateCardStatus(env.FEISHU_APP_ID, env.FEISHU_APP_SECRET, txn.feishu_message_id, "denied", {
        agentName: "", // Will be fetched if needed, keeping simple for now
        merchant: txn.merchant,
        amount: txn.amount,
        currency: txn.currency,
        reason: txn.reason,
      });
    }
    return;
  }

  // Approved — unpause card with spend limit matching the transaction amount
  const amountCents = Math.round(txn.amount * 100);
  await updateCardSpendLimit(env.LITHIC_API_KEY, txn.card_token!, amountCents);
  await updateCardState(env.LITHIC_API_KEY, txn.card_token!, "OPEN");

  await updateTransactionStatus(env.DB, transactionId, "approved", {
    approved_at: new Date().toISOString(),
  });

  if (txn.feishu_message_id) {
    await updateCardStatus(env.FEISHU_APP_ID, env.FEISHU_APP_SECRET, txn.feishu_message_id, "approved", {
      agentName: "",
      merchant: txn.merchant,
      amount: txn.amount,
      currency: txn.currency,
      reason: txn.reason,
    });
  }
}

export async function confirmPurchase(
  env: Env,
  transactionId: string
): Promise<void> {
  const txn = await getTransaction(env.DB, transactionId);
  if (!txn) throw new Error("Transaction not found");
  if (txn.status !== "approved") throw new Error(`Transaction is ${txn.status}, not approved`);

  // Re-pause card
  await updateCardState(env.LITHIC_API_KEY, txn.card_token!, "PAUSED");

  // Deduct from wallet
  const wallet = await getWalletByAgentId(env.DB, txn.agent_id);
  if (wallet) {
    await updateWalletBalance(env.DB, wallet.id, wallet.balance - txn.amount);

    // Check low balance threshold
    const threshold = parseFloat(env.LOW_BALANCE_THRESHOLD);
    if (wallet.balance - txn.amount < threshold) {
      const { sendNotification } = await import("./feishu");
      // We'd need a chat ID stored somewhere — for now, skip
    }
  }

  await updateTransactionStatus(env.DB, transactionId, "completed", {
    completed_at: new Date().toISOString(),
  });

  // Cancel timeout
  const doId = env.PURCHASE_TIMEOUT.idFromName(transactionId);
  const doStub = env.PURCHASE_TIMEOUT.get(doId);
  await doStub.fetch("https://do/cancel", { method: "POST" });

  // Update Feishu card
  if (txn.feishu_message_id) {
    await updateCardStatus(env.FEISHU_APP_ID, env.FEISHU_APP_SECRET, txn.feishu_message_id, "completed", {
      agentName: "",
      merchant: txn.merchant,
      amount: txn.amount,
      currency: txn.currency,
      reason: txn.reason,
    });
  }
}

export async function cancelPurchase(
  env: Env,
  transactionId: string
): Promise<void> {
  const txn = await getTransaction(env.DB, transactionId);
  if (!txn) throw new Error("Transaction not found");
  if (txn.status !== "approved") throw new Error(`Transaction is ${txn.status}, not approved`);

  // Re-pause card
  await updateCardState(env.LITHIC_API_KEY, txn.card_token!, "PAUSED");

  await updateTransactionStatus(env.DB, transactionId, "failed");

  // Cancel timeout
  const doId = env.PURCHASE_TIMEOUT.idFromName(transactionId);
  const doStub = env.PURCHASE_TIMEOUT.get(doId);
  await doStub.fetch("https://do/cancel", { method: "POST" });

  if (txn.feishu_message_id) {
    await updateCardStatus(env.FEISHU_APP_ID, env.FEISHU_APP_SECRET, txn.feishu_message_id, "failed", {
      agentName: "",
      merchant: txn.merchant,
      amount: txn.amount,
      currency: txn.currency,
      reason: txn.reason,
    });
  }
}

export async function getCardDetailsForTransaction(
  env: Env,
  transactionId: string,
  agentId: string
): Promise<{ pan: string; exp_month: string; exp_year: string; cvv: string }> {
  const txn = await getTransaction(env.DB, transactionId);
  if (!txn) throw new Error("Transaction not found");
  if (txn.agent_id !== agentId) throw new Error("Not your transaction");
  if (txn.status !== "approved") throw new Error(`Transaction is ${txn.status}, not approved`);

  return getCardDetails(env.LITHIC_API_KEY, txn.card_token!);
}
