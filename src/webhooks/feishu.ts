import { Env } from "../types";
import { verifyFeishuSignature, verifyFeishuToken } from "../services/feishu";
import { handleApproval } from "../services/purchase";
import { isTransactionActionable, writeAuditLog } from "../db/queries";

interface FeishuChallenge {
  challenge: string;
  token: string;
  type: string;
}

// New format (card.action.trigger)
interface FeishuCardCallbackV2 {
  schema: string;
  header: {
    event_id: string;
    event_type: string;
    token: string;
  };
  event: {
    operator: {
      open_id: string;
    };
    action: {
      tag: string;
      value: Record<string, string>;
    };
  };
}

// Legacy format
interface FeishuCardCallbackLegacy {
  open_id: string;
  token: string;
  action: {
    value: string;
    tag: string;
  };
}

function parseActionData(
  parsed: Record<string, unknown>
): { action: string; transaction_id: string; operatorId: string } | null {
  // New format: card.action.trigger (schema 2.0)
  if (parsed.schema === "2.0" || parsed.header) {
    const v2 = parsed as unknown as FeishuCardCallbackV2;
    const value = v2.event?.action?.value;
    if (!value?.action || !value?.transaction_id) return null;
    return {
      action: value.action,
      transaction_id: value.transaction_id,
      operatorId: v2.event?.operator?.open_id ?? "unknown",
    };
  }

  // Legacy format: action.value is a JSON string
  const legacy = parsed as unknown as FeishuCardCallbackLegacy;
  if (!legacy.action?.value) return null;
  try {
    const value =
      typeof legacy.action.value === "string"
        ? JSON.parse(legacy.action.value)
        : legacy.action.value;
    return {
      action: value.action,
      transaction_id: value.transaction_id,
      operatorId: legacy.open_id ?? "unknown",
    };
  } catch {
    return null;
  }
}

function getToken(parsed: Record<string, unknown>): string | undefined {
  // New format
  if (parsed.header) {
    const header = parsed.header as Record<string, unknown>;
    return header.token as string | undefined;
  }
  // Legacy format
  return parsed.token as string | undefined;
}

export async function handleFeishuWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const body = await request.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    return Response.json(
      { toast: { type: "error", content: "Invalid request." } },
      { status: 400 }
    );
  }

  // Handle URL verification challenge
  if (parsed.type === "url_verification") {
    const challenge = parsed as unknown as FeishuChallenge;
    if (!verifyFeishuToken(env.FEISHU_VERIFY_TOKEN, { token: challenge.token })) {
      return new Response("Invalid token", { status: 403 });
    }
    return Response.json({ challenge: challenge.challenge });
  }

  // Verify signature if encrypt key is configured
  if (env.FEISHU_ENCRYPT_KEY) {
    const timestamp = request.headers.get("X-Lark-Request-Timestamp") ?? "";
    const nonce = request.headers.get("X-Lark-Request-Nonce") ?? "";
    const signature = request.headers.get("X-Lark-Signature") ?? "";

    const valid = await verifyFeishuSignature(
      timestamp,
      nonce,
      env.FEISHU_ENCRYPT_KEY,
      body,
      signature
    );
    if (!valid) {
      console.error("Feishu signature verification failed");
      return new Response("Invalid signature", { status: 403 });
    }
  } else {
    // Fallback: verify token in payload
    const token = getToken(parsed);
    if (!verifyFeishuToken(env.FEISHU_VERIFY_TOKEN, { token })) {
      return new Response("Invalid token", { status: 403 });
    }
  }

  // Parse card action data (supports both new and legacy formats)
  const actionData = parseActionData(parsed);
  if (!actionData) {
    return Response.json({
      toast: { type: "error", content: "Invalid action." },
    });
  }

  // Idempotency: check if transaction is still actionable (pending)
  const actionable = await isTransactionActionable(
    env.DB,
    actionData.transaction_id
  );
  if (!actionable) {
    return Response.json({
      toast: { type: "info", content: "Already processed." },
    });
  }

  const approved = actionData.action === "approve";

  // Respond to Feishu immediately — do heavy work in background.
  // This avoids Feishu's 3-second callback timeout.
  ctx.waitUntil(
    (async () => {
      try {
        await writeAuditLog(env.DB, {
          agentId: "feishu_callback",
          transactionId: actionData.transaction_id,
          action: approved ? "human_approve" : "human_deny",
          detail: `operator=${actionData.operatorId}`,
        });
        await handleApproval(env, actionData.transaction_id, approved);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error("Feishu callback background error:", message);
      }
    })()
  );

  return Response.json({
    toast: {
      type: approved ? "success" : "info",
      content: approved ? "Approved — agent will proceed." : "Denied.",
    },
  });
}
