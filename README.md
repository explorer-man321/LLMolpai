# Hello AI

A Cloudflare Worker chat application powered by Workers AI. The command-line client connects to the deployed Worker, streams the answer, hides DeepSeek reasoning (`<think>...</think>`), shows a thinking animation, and tracks visible session usage.

## Requirements

- Node.js 20 or newer
- npm
- A Cloudflare account with Workers AI access
- Wrangler authentication
- A Worker account with enough Workers AI quota or an active Workers Paid plan

## First-time setup

Install dependencies:

```bash
npm install
```

Log in to Cloudflare if needed:

```bash
npx wrangler login
```

Run the interactive setup:

```bash
npm run setup
```

Enter:

1. **Cloudflare account ID** — the 32-character account ID that owns the Worker.
2. **Worker domain or URL** — either a complete URL such as `https://hello-ai.example.workers.dev`, a workers.dev subdomain such as `example.workers.dev`, or a custom domain.

The setup command updates `wrangler.jsonc`, updates the chat client URL, and deploys the Worker automatically.

For automation or CI, pass both values directly:

```bash
npm run setup -- CLOUDFLARE_ACCOUNT_ID https://hello-ai.example.workers.dev
```

## Run the chat

```bash
npm run chat
```

Commands inside the chat:

| Command | Action |
|---|---|
| `/newchat` | Clear the current conversation and reset session token usage |
| `/exit` | Exit the chat |

You can override the configured Worker URL:

```bash
npm run chat https://hello-ai.example.workers.dev
```

or:

```bash
WORKER_URL=https://hello-ai.example.workers.dev npm run chat
```

## Development and deployment commands

```bash
npm run dev          # Start Wrangler development mode
npm run start        # Alias for npm run dev
npm run deploy       # Deploy using the current wrangler.jsonc
npm run setup        # Configure account/domain and deploy
npm run cf-typegen   # Regenerate Worker binding types
npm test             # Run tests
```

The Worker uses a remote Workers AI binding during development. If `npm run dev` reports that a workers.dev subdomain is required, use `npm run chat` against the deployed URL instead, or register a workers.dev subdomain in Cloudflare.

## Configuration

The setup command stores the Cloudflare account ID in [wrangler.jsonc](./wrangler.jsonc). The chat client's default URL is stored in [scripts/chat.mjs](./scripts/chat.mjs). Both are safe to override with command-line arguments or `WORKER_URL`.

The Worker exposes:

- `GET /` — health and model information
- `POST /chat` — streaming Server-Sent Events chat endpoint

Example API request:

```bash
curl -N https://hello-ai.example.workers.dev/chat \
  -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}],"sessionTokens":0}'
```

## Token behavior

The application session limit is 2,000 visible tokens. Hidden reasoning is removed from the response and is not added to application `sessionTokens`. The model has a separate reasoning allowance, and visible output is clipped at the remaining session budget with a notice.

The provider may still count or bill internal reasoning tokens according to the Workers AI plan. If the account reaches its daily free allocation, requests fail with Cloudflare error `4006`; use an account with remaining quota or enable the appropriate paid plan.

## Troubleshooting

### `4006: you have used up your daily free allocation`

The configured Cloudflare account has exhausted its Workers AI daily allocation. Run `npm run setup`, enter another account with Workers AI quota, and deploy there.

### `You need to register a workers.dev subdomain`

This affects Wrangler remote development. The deployed chat client does not require a remote preview session. Use `npm run chat` after setup, or register a workers.dev subdomain for `npm run dev`.

### `Request failed` or an unreachable Worker

Check the URL:

```bash
curl https://hello-ai.example.workers.dev/
```

Then run:

```bash
npm run setup
```

and enter the correct account ID and Worker URL.

### Authentication

Check the active Wrangler account:

```bash
npx wrangler whoami
```

Switch accounts:

```bash
npx wrangler logout
npx wrangler login
```
