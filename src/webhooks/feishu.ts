import { Env } from "../types";
import { verifyFeishuCallback } from "../services/feishu";
import { handleApproval } from "../services/purchase";

interface FeishuCardAction {
  open_ids: string[];
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
    if (!verifyFeishuCallback(body, env.FEISHU_VERIFY_TOKEN, { token: challenge.token })) {
      return new Response("Invalid token", { status: 403 });
    }
    return Response.json({ challenge: challenge.challenge });
  }

  // Handle card action callback
  const action = parsed as unknown as FeishuCardAction;
  if (!action.action?.value) {
    return new Response("No action value", { status: 400 });
  }

  if (!verifyFeishuCallback(body, env.FEISHU_VERIFY_TOKEN, { token: action.token })) {
    return new Response("Invalid token", { status: 403 });
  }

  let actionData: { action: string; transaction_id: string };
  try {
    actionData = JSON.parse(action.action.value);
  } catch {
    return new Response("Invalid action value", { status: 400 });
  }

  const approved = actionData.action === "approve";

  try {
    await handleApproval(env, actionData.transaction_id, approved);
    return new Response("OK");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Feishu callback error:", message);
    return new Response(message, { status: 500 });
  }
}
