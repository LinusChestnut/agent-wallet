import { Env, McpRequest, McpResponse, Agent } from "./types";
import {
  getAgentByApiKey,
  getWalletByAgentId,
  getTransactionsByWallet,
  getTransaction,
  writeAuditLog,
} from "./db/queries";
import {
  requestPurchase,
  submitPaymentQr,
  confirmPurchase,
  cancelPurchase,
} from "./services/purchase";

const TOOLS = [
  {
    name: "request_purchase",
    description:
      "Request approval to make a purchase. Sends a notification to the owner for approval. Returns a transaction ID to track the request. The owner will tap Approve when they're ready — you'll receive a message in your chat channel when approved.",
    inputSchema: {
      type: "object",
      properties: {
        merchant: { type: "string", description: "Merchant/store name" },
        amount: { type: "number", description: "Purchase amount" },
        currency: { type: "string", description: "Currency code (default: CNY)" },
        reason: { type: "string", description: "Why you need to make this purchase" },
      },
      required: ["merchant", "amount"],
    },
  },
  {
    name: "get_purchase_status",
    description:
      "Check the status of a purchase request. Returns: pending, approved, qr_submitted, completed, denied, failed, or expired. IMPORTANT: Always call this to verify status before acting on chat notifications.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_id: { type: "string", description: "Transaction ID from request_purchase" },
      },
      required: ["transaction_id"],
    },
  },
  {
    name: "submit_payment_qr",
    description:
      "Submit a payment QR code for the user to scan. The QR code image is sent to the owner via Feishu. Only call this after the purchase is approved and you have navigated to the merchant checkout page.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_id: { type: "string", description: "Transaction ID of the approved purchase" },
        qr_image: { type: "string", description: "Base64-encoded PNG image of the payment QR code" },
      },
      required: ["transaction_id", "qr_image"],
    },
  },
  {
    name: "confirm_purchase",
    description:
      "Confirm that the payment was completed successfully (merchant page shows success). Deducts the amount from your wallet balance.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_id: { type: "string", description: "Transaction ID of the completed purchase" },
      },
      required: ["transaction_id"],
    },
  },
  {
    name: "cancel_purchase",
    description:
      "Cancel an approved purchase that you no longer need. No charge is applied to your wallet.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_id: { type: "string", description: "Transaction ID to cancel" },
      },
      required: ["transaction_id"],
    },
  },
  {
    name: "get_balance",
    description: "Check your current wallet balance.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_transactions",
    description: "View your recent transaction history.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of transactions to return (default: 20)" },
      },
    },
  },
];

function mcpError(id: string | number | null, code: number, message: string): McpResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function mcpResult(id: string | number | null, result: unknown): McpResponse {
  return { jsonrpc: "2.0", id, result };
}

function textContent(text: string) {
  return { content: [{ type: "text", text }] };
}

async function authenticateAgent(
  env: Env,
  request: Request
): Promise<Agent | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const apiKey = authHeader.slice(7);
  return getAgentByApiKey(env.DB, apiKey);
}

export async function handleMcp(
  request: Request,
  env: Env
): Promise<Response> {
  let body: McpRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json(mcpError(null, -32700, "Parse error"));
  }

  const { id, method, params } = body;
  const clientIp = request.headers.get("CF-Connecting-IP") ?? undefined;

  // tools/list doesn't require auth
  if (method === "tools/list") {
    return Response.json(mcpResult(id, { tools: TOOLS }));
  }

  if (method === "initialize") {
    return Response.json(
      mcpResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-wallet", version: "0.3.0" },
      })
    );
  }

  if (method === "notifications/initialized") {
    return Response.json(mcpResult(id, {}));
  }

  // All other methods require auth
  const agent = await authenticateAgent(env, request);
  if (!agent) {
    return Response.json(
      mcpError(id, -32001, "Unauthorized. Set Authorization: Bearer <api_key> header.")
    );
  }

  if (method !== "tools/call") {
    return Response.json(mcpError(id, -32601, `Unknown method: ${method}`));
  }

  const toolName = (params as { name: string })?.name;
  const args = (params as { arguments?: Record<string, unknown> })?.arguments ?? {};

  try {
    switch (toolName) {
      case "request_purchase": {
        const { merchant, amount, currency, reason } = args as {
          merchant: string;
          amount: number;
          currency?: string;
          reason?: string;
        };
        if (!merchant || !amount) {
          return Response.json(mcpError(id, -32602, "merchant and amount are required"));
        }
        const result = await requestPurchase(env, agent, agent.chat_id, {
          merchant,
          amount,
          currency,
          reason,
        });

        await writeAuditLog(env.DB, {
          agentId: agent.id,
          transactionId: result.transactionId,
          action: "request_purchase",
          detail: `merchant=${merchant} amount=${amount} ${currency ?? "CNY"}`,
          ipAddress: clientIp,
        });

        return Response.json(
          mcpResult(id, textContent(
            `Purchase request submitted!\nTransaction ID: ${result.transactionId}\nStatus: pending — waiting for owner approval.\n\nYou will receive a notification in your chat when the owner approves or denies. Use get_purchase_status to verify the status before proceeding.`
          ))
        );
      }

      case "get_purchase_status": {
        const { transaction_id } = args as { transaction_id: string };
        if (!transaction_id) {
          return Response.json(mcpError(id, -32602, "transaction_id is required"));
        }
        const txn = await getTransaction(env.DB, transaction_id);
        if (!txn) {
          return Response.json(mcpResult(id, textContent("Transaction not found.")));
        }
        if (txn.agent_id !== agent.id) {
          return Response.json(mcpResult(id, textContent("Not your transaction.")));
        }
        return Response.json(
          mcpResult(id, textContent(
            `Transaction: ${txn.id}\nStatus: ${txn.status}\nMerchant: ${txn.merchant}\nAmount: ${txn.amount} ${txn.currency}\nRequested: ${txn.requested_at}${txn.approved_at ? `\nApproved: ${txn.approved_at}` : ""}${txn.completed_at ? `\nCompleted: ${txn.completed_at}` : ""}`
          ))
        );
      }

      case "submit_payment_qr": {
        const { transaction_id, qr_image } = args as {
          transaction_id: string;
          qr_image: string;
        };
        if (!transaction_id || !qr_image) {
          return Response.json(mcpError(id, -32602, "transaction_id and qr_image are required"));
        }

        await submitPaymentQr(env, transaction_id, agent.id, qr_image);

        await writeAuditLog(env.DB, {
          agentId: agent.id,
          transactionId: transaction_id,
          action: "submit_payment_qr",
          detail: "QR code sent to owner for scanning",
          ipAddress: clientIp,
        });

        return Response.json(
          mcpResult(id, textContent(
            `QR code sent to owner!\nThe owner should scan it with Alipay or WeChat Pay.\n\nWait for the merchant page to confirm payment, then call confirm_purchase.\nIf the QR expires, you can call submit_payment_qr again with a fresh QR code.`
          ))
        );
      }

      case "confirm_purchase": {
        const { transaction_id } = args as { transaction_id: string };
        if (!transaction_id) {
          return Response.json(mcpError(id, -32602, "transaction_id is required"));
        }
        await confirmPurchase(env, transaction_id);

        await writeAuditLog(env.DB, {
          agentId: agent.id,
          transactionId: transaction_id,
          action: "confirm_purchase",
          ipAddress: clientIp,
        });

        return Response.json(
          mcpResult(id, textContent("Purchase confirmed. Amount deducted from wallet."))
        );
      }

      case "cancel_purchase": {
        const { transaction_id } = args as { transaction_id: string };
        if (!transaction_id) {
          return Response.json(mcpError(id, -32602, "transaction_id is required"));
        }
        await cancelPurchase(env, transaction_id);

        await writeAuditLog(env.DB, {
          agentId: agent.id,
          transactionId: transaction_id,
          action: "cancel_purchase",
          ipAddress: clientIp,
        });

        return Response.json(
          mcpResult(id, textContent("Purchase cancelled. No charge applied."))
        );
      }

      case "get_balance": {
        const wallet = await getWalletByAgentId(env.DB, agent.id);
        if (!wallet) {
          return Response.json(mcpResult(id, textContent("Wallet not found.")));
        }
        return Response.json(
          mcpResult(id, textContent(`Balance: ${wallet.balance} ${wallet.currency}`))
        );
      }

      case "get_transactions": {
        const limit = (args as { limit?: number }).limit ?? 20;
        const wallet = await getWalletByAgentId(env.DB, agent.id);
        if (!wallet) {
          return Response.json(mcpResult(id, textContent("Wallet not found.")));
        }
        const txns = await getTransactionsByWallet(env.DB, wallet.id, limit);
        if (txns.length === 0) {
          return Response.json(mcpResult(id, textContent("No transactions yet.")));
        }
        const lines = txns.map(
          (t) =>
            `${t.requested_at} | ${t.status.padEnd(12)} | ${t.amount} ${t.currency} | ${t.merchant} | ${t.reason}`
        );
        return Response.json(
          mcpResult(id, textContent(`Recent transactions:\n${lines.join("\n")}`))
        );
      }

      default:
        return Response.json(mcpError(id, -32602, `Unknown tool: ${toolName}`));
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    return Response.json(mcpError(id, -32000, message));
  }
}
