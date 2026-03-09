import { Env } from "../types";
import { verifyFeishuSignature, verifyFeishuToken } from "../services/feishu";
import { handleApproval } from "../services/purchase";
import { isTransactionActionable, writeAuditLog } from "../db/queries";

interface FeishuCardAction {
  open_ids: string[];
  open_id: string;
  token: string;
  action: {
    value: string;
    tag: string;
  };
}

interface FeishuChallenge {
  challenge: string;
  token: string;
  type: string;
}

export async function handleFeishuWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  const body = await request.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
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
    const action = parsed as unknown as FeishuCardAction;
    if (!verifyFeishuToken(env.FEISHU_VERIFY_TOKEN, { token: action.token })) {
      return new Response("Invalid token", { status: 403 });
    }
  }

  // Handle card action callback
  const action = parsed as unknown as FeishuCardAction;
  if (!action.action?.value) {
    return new Response("No action value", { status: 400 });
  }

  let actionData: { action: string; transaction_id: string };
  try {
    actionData = JSON.parse(action.action.value);
  } catch {
    return new Response("Invalid action value", { status: 400 });
  }

  // Idempotency: check if transaction is still actionable (pending)
  const actionable = await isTransactionActionable(
    env.DB,
    actionData.transaction_id
  );
  if (!actionable) {
    // Already processed — return toast to avoid Feishu retries
    return Response.json({
      toast: { type: "info", content: "Already processed." },
    });
  }

  const approved = actionData.action === "approve";

  // Audit log the approval/denial
  await writeAuditLog(env.DB, {
    agentId: "feishu_callback",
    transactionId: actionData.transaction_id,
    action: approved ? "human_approve" : "human_deny",
    detail: `operator=${action.open_id ?? "unknown"}`,
  });

  try {
    await handleApproval(env, actionData.transaction_id, approved);
    return Response.json({
      toast: {
        type: approved ? "success" : "info",
        content: approved ? "Approved — agent will proceed." : "Denied.",
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Feishu callback error:", message);
    return Response.json({
      toast: { type: "error", content: "Something went wrong. Try again." },
    });
  }
}
