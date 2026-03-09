import { Env } from "./types";
import { handleMcp } from "./mcp";
import { handleFeishuWebhook } from "./webhooks/feishu";
import { handleAdmin } from "./admin";

export { PurchaseTimeout } from "./durable-objects/timeout";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    try {
      let response: Response;

      // MCP endpoint — agent-facing
      if (path === "/mcp") {
        response = await handleMcp(request, env);
      }
      // Feishu card callback
      else if (path === "/webhook/feishu") {
        response = await handleFeishuWebhook(request, env);
      }
      // Admin endpoints
      else if (path.startsWith("/admin")) {
        response = await handleAdmin(request, env);
      }
      // Health check
      else if (path === "/" || path === "/health") {
        response = Response.json({
          service: "agent-wallet",
          version: "0.3.0",
          status: "ok",
        });
      } else {
        response = new Response("Not found", { status: 404 });
      }

      // Add CORS headers to all responses
      response = new Response(response.body, response);
      response.headers.set("Access-Control-Allow-Origin", "*");
      return response;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      console.error("Unhandled error:", message);
      return Response.json({ error: message }, { status: 500 });
    }
  },
};
