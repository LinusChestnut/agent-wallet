const LITHIC_BASE = "https://api.lithic.com/v1";
const LITHIC_SANDBOX_BASE = "https://sandbox.lithic.com/v1";

interface LithicCardResponse {
  token: string;
  pan: string;
  exp_month: string;
  exp_year: string;
  cvv: string;
  state: "OPEN" | "PAUSED" | "CLOSED" | "PENDING_FULFILLMENT" | "PENDING_ACTIVATION";
  type: "VIRTUAL" | "PHYSICAL" | "SINGLE_USE" | "MERCHANT_LOCKED";
  spend_limit: number;
  spend_limit_duration: "TRANSACTION" | "MONTHLY" | "ANNUALLY" | "FOREVER";
}

function baseUrl(apiKey: string): string {
  // Sandbox keys start with a different prefix
  return apiKey.startsWith("sandbox-") ? LITHIC_SANDBOX_BASE : LITHIC_BASE;
}

async function lithicFetch(
  apiKey: string,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = `${baseUrl(apiKey)}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `api-key ${apiKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
}

export async function createCard(
  apiKey: string,
  opts: { type: "VIRTUAL" | "SINGLE_USE"; spendLimit: number; memo?: string }
): Promise<LithicCardResponse> {
  const res = await lithicFetch(apiKey, "/cards", {
    method: "POST",
    body: JSON.stringify({
      type: opts.type,
      state: "PAUSED",
      spend_limit: Math.round(opts.spendLimit * 100), // cents
      spend_limit_duration: "TRANSACTION",
      memo: opts.memo ?? "agent-wallet card",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Lithic create card failed (${res.status}): ${body}`);
  }
  return res.json();
}

export async function updateCardState(
  apiKey: string,
  cardToken: string,
  state: "OPEN" | "PAUSED"
): Promise<void> {
  const res = await lithicFetch(apiKey, `/cards/${cardToken}`, {
    method: "PATCH",
    body: JSON.stringify({ state }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Lithic update card state failed (${res.status}): ${body}`);
  }
}

export async function updateCardSpendLimit(
  apiKey: string,
  cardToken: string,
  spendLimitCents: number
): Promise<void> {
  const res = await lithicFetch(apiKey, `/cards/${cardToken}`, {
    method: "PATCH",
    body: JSON.stringify({
      spend_limit: spendLimitCents,
      spend_limit_duration: "TRANSACTION",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Lithic update spend limit failed (${res.status}): ${body}`);
  }
}

export async function getCardDetails(
  apiKey: string,
  cardToken: string
): Promise<{ pan: string; exp_month: string; exp_year: string; cvv: string }> {
  const res = await lithicFetch(apiKey, `/cards/${cardToken}`, {
    method: "GET",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Lithic get card failed (${res.status}): ${body}`);
  }
  const card: LithicCardResponse = await res.json();
  return {
    pan: card.pan,
    exp_month: card.exp_month,
    exp_year: card.exp_year,
    cvv: card.cvv,
  };
}

export function verifyLithicWebhook(
  payload: string,
  signature: string,
  webhookSecret: string
): boolean {
  // Lithic uses HMAC-SHA256 for webhook verification
  // In production, verify the signature here
  // For now, we trust the payload if a secret is configured
  if (!webhookSecret) return true;
  // TODO: implement HMAC verification
  return true;
}
