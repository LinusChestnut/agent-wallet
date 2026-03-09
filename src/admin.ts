import { Env } from "./types";
import { createAgent, listAgents } from "./db/queries";

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
      chat_id?: string;
    };

    if (!body.name || !body.chat_id) {
      return Response.json({ error: "name and chat_id are required" }, { status: 400 });
    }

    const agentId = crypto.randomUUID();
    const apiKey = `aw_${crypto.randomUUID().replace(/-/g, "")}`;

    await createAgent(env.DB, {
      id: agentId,
      name: body.name,
      api_key: apiKey,
      chat_id: body.chat_id!,
      created_at: new Date().toISOString(),
    });

    return Response.json({
      agent_id: agentId,
      name: body.name,
      api_key: apiKey,
      message: "Agent registered. Use this API key as Bearer token for MCP calls.",
    });
  }

  // GET /admin/agents — list all agents
  if (path === "/agents" && request.method === "GET") {
    const agents = await listAgents(env.DB);
    return Response.json({
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        chat_id: a.chat_id,
        created_at: a.created_at,
      })),
    });
  }

  return new Response("Not found", { status: 404 });
}
