# Hosted Arc testnet

Railway project `xorv-arc-testnet` (`55891db0-7633-41bb-b41d-8eb894d97c7f`).

| Service | Public URL | Purpose |
|---|---|---|
| app | https://app-production-909f.up.railway.app | Job browser, demo-account payments, Arc viewer |
| broker | https://broker-production-d2c4.up.railway.app | API, WebSockets, x402 facilitator, escrow, refund keeper; SQLite `/data` volume |
| echo-provider | none | Keyless, deterministic Echo test capability; persistent registration token on `/data` |

Addresses are pinned from `deployments/arc-testnet.json`, network `eip155:5042002`.
The app origin is allowed by broker CORS. The public demo account can pay at most
0.01 testnet USDC per job; existing rate and daily caps also apply.
No model credentials were available in the port: Echo is labelled as a test capability,
AI screening/routing/verification are off, and no result is claimed to be real AI output.
To enable AI jobs, connect a real provider and configure its model credentials.
Privy is optional; injected wallets and the labelled demo account remain available.
Mongo and Envio are optional and are not provisioned; persistent SQLite holds broker state.
Cross-chain sends are Not run live. Existing contract/testnet evidence remains in E2E-TESTNET.md.

Build each service from the repository root (`railway up --service <name> --detach`).
`RAILWAY_DOCKERFILE_PATH` selects Dockerfile, apps/app/Dockerfile, or docker/provider.Dockerfile.
Env files, keys, installed dependencies and build artifacts are excluded from every upload.
Screenshots, HTTP checks and action evidence are in `docs/screens/hosted/`.

Verified 2026-10-14: all three services reached SUCCESS; six navigation routes, the
paid job route, broker health/network/providers/jobs and demo-account status returned 200.
Connected-browser Playwright checks captured no console errors. Exact-origin CORS passed.
Job `job_-zKrlXA5IgUy` completed; 0.001 USDC funded escrow and was released:
- funding `0x89f5ceb8b5bbe7af4d4f9ab527cd333b4bcd75f18aca145c6cb8e50db7e80669`
- release `0x159488358edba18fd608125ebd53ce8216261ac6586c02adf6e5baae050e3ead`
This hosted Echo provider has no ERC-8004 identity; it does not claim agent reputation.
The separate earlier testnet identity/reputation proof is documented in E2E-TESTNET.md.
