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

Note on the first set (`home.png` ... `chain-tx.png`): that broker ran the AI roles against the local **mock model
server** of `pnpm e2e:testnet`, so the router trace and the verifier score of 92/100 on `job.png` come from the mock, not
from a real model.

## Judge pass (2026-10-13): `judge-*.png`

A second set, taken by the judge + fix pass with a broker that has **no model API keys** (so `/network` shows the three
AI roles `off`, honestly) and one provider selling the labelled `echo` test capability. The job in `judge-job.png` was
paid from the app's testnet demo account through the real UI path ("Pay ... from demo account"), over x402 into
XorvEscrow, released and receipted on XorvLedger. Production build (`next start`), headless Chromium, 1360 px and 390 px.

| File | Shows |
|---|---|
| `judge-home.png`, `judge-mobile-home.png` | Job board, live Arc strip (block height, 508 ms blocks), the provider list |
| `judge-job.png`, `judge-mobile-job.png` | The paid job: escrow timeline, Arc speed receipt (payment final 2.30 s), Memo tags, rating |
| `judge-provider.png` | Provider with its ERC-8004 agent and escrow record |
| `judge-network-arc-stack.png`, `judge-mobile-network.png` | Arc stack panel with the per-row "exercised live / not exercised live" status |
| `judge-mobile-chain-block.png` | In-app chain viewer at 390 px (a long-hash overflow fixed in this pass) |
| `judge-private.png` | Private jobs (passkey) page |
| `judge-landing.png`, `judge-mobile-landing.png` | Landing page |

Routes visited at both widths with Playwright: `/`, `/jobs`, `/jobs/<id>`, `/providers`, `/providers/<id>`, `/network`,
`/chain`, `/chain/tx/<hash>`, `/chain/address/<addr>`, `/chain/block/<n>`, `/private`, and the landing page: HTTP 200, no
console errors, no failed requests, no horizontal overflow at 390 px, no broken images, no Monad/MON/AUSD/placeholder text.

