import { Env, McpRequest, McpResponse, Agent } from "./types";
import { getAgentByApiKey, getWalletByAgentId, getTransactionsByWallet, getTransaction } from "./db/queries";
import {
  requestPurchase,
  confirmPurchase,
  cancelPurchase,
  getCardDetailsForTransaction,
} from "./services/purchase";

const TOOLS = [
  {
    name: "request_purchase",
    description:
      "Request approval to make a purchase. Sends a notification to the owner for approval. Returns a transaction ID to track the request.",
    inputSchema: {
      type: "object",
      properties: {
        merchant: { type: "string", description: "Merchant/store name" },
        amount: { type: "number", description: "Purchase amount" },
        currency: { type: "string", description: "Currency code (default: USD)" },
        reason: { type: "string", description: "Why you need to make this purchase" },
      },
      required: ["merchant", "amount"],
    },
  },
  {
    name: "get_purchase_status",
    description:
      "Check the status of a purchase request. Returns: pending, approved, denied, completed, failed, or expired.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_id: { type: "string", description: "Transaction ID from request_purchase" },
      },
      required: ["transaction_id"],
    },
  },
  {
    name: "get_card_details",
    description:
      "Get card details (PAN, expiry, CVV) for an approved purchase. Only works after the purchase has been approved by the owner.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_id: { type: "string", description: "Transaction ID of the approved purchase" },
      },
      required: ["transaction_id"],
    },
  },
  {
    name: "confirm_purchase",
    description:
      "Confirm that a purchase was completed successfully. This re-pauses the card and deducts the amount from your wallet balance.",
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
      "Cancel an approved purchase that you no longer need. This re-pauses the card without deducting from your balance.",
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
  env: Env,
  chatId: string
): Promise<Response> {
  let body: McpRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json(mcpError(null, -32700, "Parse error"));
  }

  const { id, method, params } = body;

  // tools/list doesn't require auth
  if (method === "tools/list") {
    return Response.json(mcpResult(id, { tools: TOOLS }));
  }

  if (method === "initialize") {
    return Response.json(
      mcpResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-wallet", version: "0.1.0" },
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
        const result = await requestPurchase(env, agent, chatId, {
          merchant,
          amount,
          currency,
          reason,
        });
        return Response.json(
          mcpResult(id, textContent(
            `Purchase request submitted!\nTransaction ID: ${result.transactionId}\nStatus: pending — waiting for owner approval.\n\nUse get_purchase_status to check if approved, then get_card_details to retrieve card info.`
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

      case "get_card_details": {
        const { transaction_id } = args as { transaction_id: string };
        if (!transaction_id) {
          return Response.json(mcpError(id, -32602, "transaction_id is required"));
        }
        const details = await getCardDetailsForTransaction(env, transaction_id, agent.id);
        return Response.json(
          mcpResult(id, textContent(
            `Card details for this transaction:\nPAN: ${details.pan}\nExpiry: ${details.exp_month}/${details.exp_year}\nCVV: ${details.cvv}\n\nUse these to complete your purchase. Call confirm_purchase when done, or cancel_purchase to abort.`
          ))
        );
      }

      case "confirm_purchase": {
        const { transaction_id } = args as { transaction_id: string };
        if (!transaction_id) {
          return Response.json(mcpError(id, -32602, "transaction_id is required"));
        }
        await confirmPurchase(env, transaction_id);
        return Response.json(
          mcpResult(id, textContent("Purchase confirmed. Card re-paused, amount deducted from wallet."))
        );
      }

      case "cancel_purchase": {
        const { transaction_id } = args as { transaction_id: string };
        if (!transaction_id) {
          return Response.json(mcpError(id, -32602, "transaction_id is required"));
        }
        await cancelPurchase(env, transaction_id);
        return Response.json(
          mcpResult(id, textContent("Purchase cancelled. Card re-paused, no charge applied."))
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
            `${t.requested_at} | ${t.status.padEnd(9)} | ${t.amount} ${t.currency} | ${t.merchant} | ${t.reason}`
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
