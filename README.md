# agent-wallet

Open-source virtual card wallet for AI agents. Agents request purchases via MCP, owners approve with a tap in Feishu, and a Lithic virtual card unlocks momentarily to complete the transaction.

## How it works

```
Agent calls request_purchase → Feishu card sent to owner → Owner taps Approve
→ Card unfreezes → Agent gets card details → Agent completes purchase
→ Agent calls confirm_purchase → Card re-freezes, balance deducted
```

- Every transaction requires human approval via Feishu interactive message card
- Card stays paused by default, only unlocks briefly per approved transaction
- Automatic timeout: unanswered requests expire, card re-pauses
- Daily spend cap as a hard backstop

## Stack

- **Cloudflare Workers** (TypeScript) — backend
- **D1** (SQLite) — wallet & transaction storage
- **Durable Objects** — purchase timeout management
- **Lithic** — virtual card issuing & management
- **Feishu/Lark** — approval UI via interactive message cards
- **MCP** (Model Context Protocol) — agent-facing interface

## Prerequisites

- Cloudflare account (paid plan for Durable Objects)
- [Lithic](https://lithic.com) account (sandbox for testing, production requires business entity)
- Feishu/Lark app with bot and message card permissions

## Setup

### 1. Clone and install

```bash
git clone https://github.com/LinusChestnut/agent-wallet.git
cd agent-wallet
npm install
```

### 2. Create D1 database

```bash
wrangler d1 create agent-wallet-db
```

Copy the database ID into `wrangler.toml` under `[[d1_databases]]`.

### 3. Initialize the database

```bash
npm run db:init        # local
npm run db:init:remote # production
```

### 4. Set secrets

```bash
wrangler secret put LITHIC_API_KEY
wrangler secret put FEISHU_APP_ID
wrangler secret put FEISHU_APP_SECRET
wrangler secret put FEISHU_VERIFY_TOKEN
wrangler secret put ADMIN_SECRET
```

### 5. Configure Feishu bot

1. Create a Feishu app at [open.feishu.cn](https://open.feishu.cn)
2. Enable Bot capability
3. Add message card callback URL: `https://your-worker.workers.dev/webhook/feishu`
4. Grant permissions: `im:message:send_as_bot`, `im:message:patch`
5. Add the bot to the chat where you want approval notifications

### 6. Deploy

```bash
npm run deploy
```

### 7. Register an agent

```bash
curl -X POST https://your-worker.workers.dev/admin/agents \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "initial_balance": 50}'
```

Save the returned `api_key` — the agent uses this for MCP authentication.

### 8. Top up wallet

```bash
curl -X POST https://your-worker.workers.dev/admin/topup \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "...", "amount": 100}'
```

## MCP Usage

Agents connect to `https://your-worker.workers.dev/mcp?chat_id=FEISHU_CHAT_ID` using the API key as a Bearer token.

### Available tools

| Tool | Description |
|------|-------------|
| `request_purchase` | Submit a purchase request for approval |
| `get_purchase_status` | Check status of a purchase request |
| `get_card_details` | Get card PAN/expiry/CVV after approval |
| `confirm_purchase` | Confirm purchase completed (re-pauses card) |
| `cancel_purchase` | Cancel an approved purchase (re-pauses card) |
| `get_balance` | Check wallet balance |
| `get_transactions` | View transaction history |

### Example flow

```
POST /mcp?chat_id=oc_xxx
Authorization: Bearer aw_xxx
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
  "name":"request_purchase",
  "arguments":{"merchant":"Amazon","amount":12.50,"reason":"USB-C cable for testing"}
}}

# → Owner gets Feishu notification, taps Approve

{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
  "name":"get_card_details",
  "arguments":{"transaction_id":"..."}
}}

# → Agent uses card details to complete checkout

{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
  "name":"confirm_purchase",
  "arguments":{"transaction_id":"..."}
}}
```

## Configuration

Environment variables in `wrangler.toml`:

| Variable | Default | Description |
|----------|---------|-------------|
| `LOW_BALANCE_THRESHOLD` | `10` | USD balance that triggers low-balance notification |
| `REQUEST_TIMEOUT_MINUTES` | `10` | Minutes before unanswered requests expire |
| `DAILY_SPEND_CAP` | `100` | Maximum daily spend across all transactions |

## License

MIT
