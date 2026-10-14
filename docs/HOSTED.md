Current production: **Arc mainnet**. See [mainnet hosting and browser checks](HOSTED-MAINNET.md). The report below is historical testnet evidence.

# XORV — Vercel / Live testnet

LEAD: RUN THESE
```sh
node scripts/e2e-browser-hosted.mjs
pnpm --filter xorv-app typecheck
```

Frontend: https://xorv-arc.vercel.app (project xorv-arc, root apps/app).
Next.js pages and read-only service status run as Vercel functions. The browser polls status and reads live Arc testnet blocks, receipts and balances directly. Contract addresses come from deployments/arc-testnet.json.
Draft a job prompt and inspect the network without a server. Provider and job lists are explicitly unavailable for this deployment; empty lists do not claim an empty on-chain history. Payment submission is disabled, and no signer is hosted.

The existing broker cannot become a cron-only service: provider WebSockets dispatch work, an in-memory hub tracks assignments and SSE streams, and one writer sequences settlement and job recovery. Polling replaces browser list sockets already, but cannot preserve the broker hub across function invocations. A durable dispatch queue and provider-poll protocol would be needed for full serverless execution. Minimum local demo: one Node broker, SQLite persistent disk (~512 MiB RAM), and one provider process with its model credentials. No resource was created.
Run locally with pnpm broker and xorv start; point the local frontend at the broker. Refund sweeping is permissionless and can be moved to cron only after durable job tracking is migrated; no hosted keeper or live jobs are claimed here.

Env: NEXT_PUBLIC_XORV_NETWORK=eip155:5042002, NEXT_PUBLIC_XORV_READ_ONLY=1, NEXT_PUBLIC_XORV_RPC_URL=https://rpc.testnet.arc.io, XORV_NETWORK=eip155:5042002. No secrets or managed database are needed for this read-only frontend. Privy is optional; injected-wallet/local passkey UI remains available.
Deploy from repo root: vercel link --project xorv-arc; vercel deploy --prod --yes. Build uses pnpm workspace dependencies. .vercelignore excludes all env files, local state and artifacts.
Screenshots and machine-readable checks: docs/screens/hosted/. No transaction was sent during this hosting pass. Live job execution, paid settlement and cross-chain sends: Not run on Vercel.

Verified: six navigation routes return 200, zero browser console errors or broken images, mobile fits 390 px. Prompt drafting, three status APIs and deployed escrow bytecode on chain 5042002 pass. Workspace protocol build and frontend typecheck pass.
