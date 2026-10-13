# App on the public Arc testnet

Screenshots of `xorv-app` (production build, `next start`) pointed at a broker running against `https://rpc.testnet.arc.io` with the
testnet deployment (`deployments/arc-testnet.json`), after a passing `pnpm e2e:testnet` run (the run is held open with
`XORV_TESTNET_HOLD=1` so the app has a live broker, provider node and jobs to show). Taken with Playwright (headless Chromium, 1360 px).

| Page | File | Result |
|---|---|---|
| Home `/` | `home.png` | 200, live chip `Arc testnet · final #… · ~508 ms blocks`, no console errors |
| Job `/jobs/<id>` | `job.png` | 200: escrow timeline with explorer links, Arc speed receipt (payment final 3.18 s), Memo tags `xorv:fund` / `xorv:release`, router trace, verifier 92/100 |
| Browse `/jobs` | `jobs.png` | 200, jobs with how the money moved |
| Providers `/providers`, `/providers/<id>` | `providers.png`, `provider.png` | 200, provider with its ERC-8004 agent |
| Network / Arc stack `/network` | `network.png` | 200: live block interval and gas (25 gwei), every Arc-stack row, receipts and buyer ratings read from XorvLedger over the public RPC |
| Chain `/chain`, `/chain/tx/<hash>` | `chain.png`, `chain-tx.png` | 200, transaction decoded against Xorv's contracts from the public RPC |

No console errors, no failed (>= 400) responses on any page.
