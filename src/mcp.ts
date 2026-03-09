import { Env, McpRequest, McpResponse, Agent } from "./types";
import {
  getAgentByApiKey,
  getWalletByAgentId,
  getTransactionsByWallet,
  getTransaction,
  writeAuditLog,
  createCardDetailToken,
  consumeCardDetailToken,
} from "./db/queries";
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
        amount: { type: "number", description: "Purchase amount (exact amount that will be charged)" },
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
      "Get a one-time token to retrieve card details (PAN, expiry, CVV) for an approved purchase. The token can only be used once and expires in 5 minutes.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_id: { type: "string", description: "Transaction ID of the approved purchase" },
      },
      required: ["transaction_id"],
    },
  },
  {
    name: "redeem_card_token",
    description:
      "Redeem a one-time token to get the actual card details. This token can only be used once.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "One-time token from get_card_details" },
      },
      required: ["token"],
    },
  },
  {
    name: "confirm_purchase",
    description:
      "Confirm that a purchase was completed successfully. This re-pauses the card and deducts the exact approved amount from your wallet balance.",
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
        serverInfo: { name: "agent-wallet", version: "0.2.0" },
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
        // Use chat_id from agent config, NOT from the request
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
          detail: `merchant=${merchant} amount=${amount} ${currency ?? "USD"}`,
          ipAddress: clientIp,
        });

        return Response.json(
          mcpResult(id, textContent(
            `Purchase request submitted!\nTransaction ID: ${result.transactionId}\nStatus: pending — waiting for owner approval.\n\nUse get_purchase_status to check if approved, then get_card_details to retrieve a one-time card token.`
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
        // Verify transaction belongs to agent and is approved
        const txn = await getTransaction(env.DB, transaction_id);
        if (!txn) {
          return Response.json(mcpError(id, -32000, "Transaction not found"));
        }
        if (txn.agent_id !== agent.id) {
          return Response.json(mcpError(id, -32000, "Not your transaction"));
        }
        if (txn.status !== "approved") {
          return Response.json(mcpError(id, -32000, `Transaction is ${txn.status}, not approved`));
        }

        // Issue a one-time token instead of returning card details directly
        const token = await createCardDetailToken(env.DB, transaction_id, agent.id);

        await writeAuditLog(env.DB, {
          agentId: agent.id,
          transactionId: transaction_id,
          action: "card_token_issued",
          detail: `one-time token created`,
          ipAddress: clientIp,
        });

        return Response.json(
          mcpResult(id, textContent(
            `One-time card token issued.\nToken: ${token}\nExpires in 5 minutes. Use redeem_card_token to get the actual card details.\n\nThis token can only be used ONCE.`
          ))
        );
      }

      case "redeem_card_token": {
        const { token } = args as { token: string };
        if (!token) {
          return Response.json(mcpError(id, -32602, "token is required"));
        }

        const consumed = await consumeCardDetailToken(env.DB, token);
        if (!consumed) {
          await writeAuditLog(env.DB, {
            agentId: agent.id,
            action: "card_token_redeem_failed",
            detail: `token=${token} — expired, already used, or invalid`,
            ipAddress: clientIp,
          });
          return Response.json(
            mcpError(id, -32000, "Token is invalid, expired, or already used.")
          );
        }

        if (consumed.agentId !== agent.id) {
          await writeAuditLog(env.DB, {
            agentId: agent.id,
            transactionId: consumed.transactionId,
            action: "card_token_redeem_wrong_agent",
            detail: `agent ${agent.id} tried to redeem token belonging to ${consumed.agentId}`,
            ipAddress: clientIp,
          });
          return Response.json(mcpError(id, -32000, "Token does not belong to you."));
        }

        const details = await getCardDetailsForTransaction(
          env,
          consumed.transactionId,
          agent.id
        );

        await writeAuditLog(env.DB, {
          agentId: agent.id,
          transactionId: consumed.transactionId,
          action: "card_details_retrieved",
          detail: `PAN ending ${details.pan.slice(-4)}`,
          ipAddress: clientIp,
        });

        return Response.json(
          mcpResult(id, textContent(
            `Card details for this transaction:\nPAN: ${details.pan}\nExpiry: ${details.exp_month}/${details.exp_year}\nCVV: ${details.cvv}\n\nIMPORTANT: The charge must be EXACTLY ${(await getTransaction(env.DB, consumed.transactionId))?.amount} ${(await getTransaction(env.DB, consumed.transactionId))?.currency}. Any other amount will be declined.\n\nCall confirm_purchase when done, or cancel_purchase to abort.`
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
          mcpResult(id, textContent("Purchase confirmed. Card re-paused, amount deducted from wallet."))
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
