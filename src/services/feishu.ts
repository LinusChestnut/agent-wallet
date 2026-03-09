interface FeishuTokenResponse {
  code: number;
  msg: string;
  tenant_access_token: string;
  expire: number;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getTenantToken(
  appId: string,
  appSecret: string
): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token;
  }

  const res = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    }
  );
  const data: FeishuTokenResponse = await res.json();
  if (data.code !== 0) {
    throw new Error(`Feishu token error (${data.code}): ${data.msg}`);
  }

  cachedToken = {
    token: data.tenant_access_token,
    expiresAt: now + data.expire * 1000,
  };
  return cachedToken.token;
}

export async function sendApprovalCard(
  appId: string,
  appSecret: string,
  chatId: string,
  txn: {
    id: string;
    agentName: string;
    merchant: string;
    amount: number;
    currency: string;
    reason: string;
  }
): Promise<string> {
  const token = await getTenantToken(appId, appSecret);

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "Purchase Request" },
      template: "orange",
    },
    elements: [
      {
        tag: "div",
        fields: [
          {
            is_short: true,
            text: {
              tag: "lark_md",
              content: `**Agent:** ${txn.agentName}`,
            },
          },
          {
            is_short: true,
            text: {
              tag: "lark_md",
              content: `**Merchant:** ${txn.merchant}`,
            },
          },
          {
            is_short: true,
            text: {
              tag: "lark_md",
              content: `**Amount:** ${txn.amount} ${txn.currency}`,
            },
          },
        ],
      },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**Reason:** ${txn.reason}`,
        },
      },
      { tag: "hr" },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "Approve" },
            type: "primary",
            value: JSON.stringify({
              action: "approve",
              transaction_id: txn.id,
            }),
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "Deny" },
            type: "danger",
            value: JSON.stringify({
              action: "deny",
              transaction_id: txn.id,
            }),
          },
        ],
      },
    ],
  };

  const res = await fetch(
    `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
    }
  );

  const data = await res.json() as { code: number; msg: string; data?: { message_id: string } };
  if (data.code !== 0) {
    throw new Error(`Feishu send message error (${data.code}): ${data.msg}`);
  }
  return data.data!.message_id;
}

export async function updateCardStatus(
  appId: string,
  appSecret: string,
  messageId: string,
  status: "approved" | "denied" | "completed" | "expired" | "failed",
  txn: {
    agentName: string;
    merchant: string;
    amount: number;
    currency: string;
    reason: string;
  }
): Promise<void> {
  const token = await getTenantToken(appId, appSecret);

  const statusLabels: Record<string, { text: string; color: string }> = {
    approved: { text: "Approved — awaiting purchase", color: "blue" },
    denied: { text: "Denied", color: "red" },
    completed: { text: `Completed — ${txn.amount} ${txn.currency}`, color: "green" },
    expired: { text: "Expired", color: "grey" },
    failed: { text: "Failed", color: "red" },
  };

  const label = statusLabels[status] ?? { text: status, color: "grey" };

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `Purchase Request — ${label.text}` },
      template: label.color,
    },
    elements: [
      {
        tag: "div",
        fields: [
          {
            is_short: true,
            text: { tag: "lark_md", content: `**Agent:** ${txn.agentName}` },
          },
          {
            is_short: true,
            text: { tag: "lark_md", content: `**Merchant:** ${txn.merchant}` },
          },
          {
            is_short: true,
            text: { tag: "lark_md", content: `**Amount:** ${txn.amount} ${txn.currency}` },
          },
        ],
      },
      {
        tag: "div",
        text: { tag: "lark_md", content: `**Reason:** ${txn.reason}` },
      },
    ],
  };

  await fetch(
    `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
    }
  );
}

export async function sendNotification(
  appId: string,
  appSecret: string,
  chatId: string,
  text: string
): Promise<void> {
  const token = await getTenantToken(appId, appSecret);
  await fetch(
    `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
    }
  );
}

/**
 * Verify Feishu card callback signature.
 * Feishu signs callbacks with: SHA256(timestamp + nonce + encryptKey)
 * and sends the signature in the X-Lark-Signature header.
 */
export async function verifyFeishuSignature(
  timestamp: string,
  nonce: string,
  encryptKey: string,
  body: string,
  signature: string
): Promise<boolean> {
  if (!timestamp || !nonce || !signature || !encryptKey) return false;

  // Reject callbacks older than 5 minutes (replay protection)
  const callbackTime = parseInt(timestamp) * 1000;
  if (Math.abs(Date.now() - callbackTime) > 5 * 60 * 1000) return false;

  const content = timestamp + nonce + encryptKey + body;
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const computed = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

  return computed === signature;
}

/**
 * Fallback: verify using the simple token check (for card action callbacks
 * where Feishu sends the verify token in the payload).
 */
export function verifyFeishuToken(
  verifyToken: string,
  parsed: { token?: string }
): boolean {
  if (!verifyToken || !parsed.token) return false;
  return parsed.token === verifyToken;
}
