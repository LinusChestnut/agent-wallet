import { Env } from "./types";
import {
  createAgent,
  getWallet,
  listAgents,
  updateWalletBalance,
  getAgentById,
} from "./db/queries";

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}

function checkAuth(request: Request, env: Env): boolean {
  const authHeader = request.headers.get("Authorization");
  return authHeader === `Bearer ${env.ADMIN_SECRET}`;
}

export async function handleAdmin(
  request: Request,
  env: Env
): Promise<Response> {
  if (!checkAuth(request, env)) return unauthorized();

  const url = new URL(request.url);
  const path = url.pathname.replace("/admin", "");

  // POST /admin/agents — register a new agent
  if (path === "/agents" && request.method === "POST") {
    const body = await request.json() as {
      name: string;
      initial_balance?: number;
      currency?: string;
      chat_id?: string;
    };

    if (!body.name || !body.chat_id) {
      return Response.json({ error: "name and chat_id are required" }, { status: 400 });
    }

    const agentId = crypto.randomUUID();
    const walletId = crypto.randomUUID();
    const apiKey = `aw_${crypto.randomUUID().replace(/-/g, "")}`;

    const agent = {
      id: agentId,
      name: body.name,
      api_key: apiKey,
      wallet_id: walletId,
      chat_id: body.chat_id!,
      created_at: new Date().toISOString(),
    };

    const wallet = {
      id: walletId,
      agent_id: agentId,
      balance: body.initial_balance ?? 0,
      currency: body.currency ?? "CNY",
      created_at: new Date().toISOString(),
    };

    await createAgent(env.DB, agent, wallet);

    return Response.json({
      agent_id: agentId,
      name: body.name,
      api_key: apiKey,
      message: "Agent registered. Use this API key as Bearer token for MCP calls.",
      wallet: {
        id: walletId,
        balance: wallet.balance,
        currency: wallet.currency,
      },
    });
  }

  // GET /admin/agents — list all agents
  if (path === "/agents" && request.method === "GET") {
    const agents = await listAgents(env.DB);
    return Response.json({
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        balance: a.balance,
        created_at: a.created_at,
      })),
    });
  }

  // POST /admin/topup — add funds to a wallet
  if (path === "/topup" && request.method === "POST") {
    const body = await request.json() as {
      agent_id: string;
      amount: number;
    };

    if (!body.agent_id || !body.amount || body.amount <= 0) {
      return Response.json(
        { error: "agent_id and positive amount are required" },
        { status: 400 }
      );
    }

    const agent = await getAgentById(env.DB, body.agent_id);
    if (!agent) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }

    const wallet = await getWallet(env.DB, agent.wallet_id);
    if (!wallet) {
      return Response.json({ error: "Wallet not found" }, { status: 404 });
    }

    const newBalance = wallet.balance + body.amount;
    await updateWalletBalance(env.DB, wallet.id, newBalance);

    return Response.json({
      wallet_id: wallet.id,
      previous_balance: wallet.balance,
      added: body.amount,
      new_balance: newBalance,
      currency: wallet.currency,
    });
  }

  return new Response("Not found", { status: 404 });
}
