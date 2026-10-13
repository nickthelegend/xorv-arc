# Judge + fix report (2026-10-13)

A strict read of xorv-arc against the Arc Microgrants criteria, followed by the fixes. Arc **testnet** only; nothing was
broadcast to mainnet. The audit ran against `origin/main` at `372985b`, which already carried the live testnet deployment
and the passing `pnpm e2e:testnet` run (46/46, [E2E-TESTNET.md](E2E-TESTNET.md)); that evidence was reused, not re-run.

## Scores

| Criterion | Before | After | Why |
|---|---:|---:|---|
| Relevance to Arc | 8 | 8 | Deep, load-bearing use: USDC as gas with a facilitator that pays it, x402 into an escrow, Arc Memo on every move, ERC-8004 identity and reputation written by settlement. Gateway, CCTP and CCIP are real code but unrun live, so they cannot count for more. |
| Technical credibility | 6 | 8 | Before: README and SUBMISSION said nothing was deployed (false since the deploy), "final in under a second" described a payment that measures 2 to 3 s, the landing page presented a transcript as "a real job", an indexer as powering live stats, and AI roles as always on. The testnet e2e's AI step ran on a mock model server and the report did not say so prominently. After: every claim carries Live / Fork / Not run, mock use is stated on the first screen of the report, and the app's Arc stack panel shows the same status per row. |
| Quality of what was built | 8 | 8 | Typecheck, lint, build and 1,300+ tests green; contracts 105/105. One real defect found and fixed (mobile overflow on the block page). No dead stubs found in the app; the broker has no built-in providers or model fallbacks. |
| Worth taking further | 7 | 8 | A cold judge can now open the contracts (source verified on the explorer), the 10 transactions, the screens and a 10-minute walkthrough, and see exactly what is unproven. Still no hosted URL. |

## 1. Claims audit

Sources read: README.md, SUBMISSION.md, MAINNET.md, ARCHITECTURE.md (status lines), the landing page (every section and
the FAQ), the app's Network / Arc stack / Gateway / CCIP / withdraw panels and composer copy. `docs/JUDGE-WALKTHROUGH.md`
did not exist; it is new.

| Claim (where) | Status found | Fix |
|---|---|---|
| "Nothing is deployed on a public network yet", deployer unfunded (README Arc stack + Status + addresses, MAINNET.md) | False since the testnet deploy | Rewritten: four addresses linked, status section split into live / not run live / mocked / not on mainnet |
| "Final in under a second" for a payment or a job (README, landing hero, how-it-works, ledger, layout meta, app composer, job view, empty states, CLI skill text) | Block time is about 0.5 s (measured 508 ms) but a payment is 2 to 3 s from broker send to receipt, a whole echo job about 8 s | Reworded to "one block, about half a second" for the block and "a few seconds" for jobs; measured numbers shown in the Arc stack panel |
| "Settles on Arc in about a second" (empty states) | Overstated | "in a few seconds" |
| Gateway "minted on Arc in about a second", "no bridge, no chain switch" (landing, FAQ, app panel) | Not run live; no timing exists | Timing removed; "Not yet exercised on testnet" added on the landing, FAQ, Gateway panel, Arc stack row, README, SUBMISSION |
| CCTP V2 withdrawals (landing, earn section, app withdraw panel) | Fork-tested burn only; the mint is user-run | Labelled "not run live" in every place |
| Chainlink CCIP cross-chain jobs (landing, FAQ "agent can use this without a human", app CCIP panel, Arc stack) | `XorvCcipReceiver` deployed, no message ever sent | Labelled; FAQ now says "meant to be able to" and names the tests that cover it |
| "Qwen picks the model, Hunyuan screens, Kimi scores every result" (landing, Network page "Three models take a turn on every job") | True only when the broker has the three API keys; roles are off by default | "Up to three ... each only when its API key is set"; landing notes the testnet run used a mock model server |
| E2E-TESTNET.md AI job and "verification score 92" | Mock model server, not stated up front | New "What is real and what is not" section at the top of the report and in the generator (`e2e/src/testnet.ts`); check labels say "mock verifier model's" |
| "Envio indexer ... powers the live stats and the leaderboard" (landing) and "indexed by Envio" (ledger) | Indexer is not deployed; feeds come from the broker and the RPC | Reworded to what runs |
| "This is a real transcript from a paid job that tried to read them", job id shown (landing security) | Unverifiable for Arc; only 3 of the 5 refusals are asserted by tests | Reworded to the macOS sandbox profile and which lines the tests assert |
| Earnings chart "$4.91 last 7 days" and routing graphic (landing bento) | Illustrations | Labelled "illustration" |
| Privy embedded wallet "signs each payment" (landing) | Requires a Privy app id; without one the app uses an injected wallet plus the testnet demo account | Said so |
| Test counts (README) | protocol 284 included 3 skipped; app 148 now 153 | Corrected and `e2e:testnet` row added |
| "Contracts audited / production" wording | None found | README now says "unaudited" |
| Refund keeper "replaces CRE" | Keeper boots live (reported on `/api/network`), but no deadline refund has run on testnet | Row says so; refund, cancel and reassign are fork-tested only |

Verified true on testnet and now said with the evidence: USDC gas paid by the facilitator and buyer nonce 0, x402
`escrow` scheme, Arc Memo ids on fund and release (read back in the app's job page with "id ✓"), ERC-8004 registration,
XorvReputation feedback, XorvLedger receipt, relayed buyer rating.

## 2. Mocks audit

grep of `apps/`, `services/broker/src`, `packages/*/src` for mock, stub, fake, placeholder, sample, demo, TODO, lorem,
hard-coded data, plus a read of the broker config path.

- No mock, stub or canned data in the app or broker source (matches were comments about tests and the labelled
  **demo account**). The only mock model server is `e2e/src/mock-llm.ts`, reachable only through the
  `XORV_*_BASE_URL` overrides the e2e sets; the broker defaults to Qwen/Kimi/Hunyuan's real endpoints and a role with no
  key reports `off` with the variable to set (seen on `/network` in this pass).
- The broker has no built-in providers; the capacity in the app is whatever provider nodes register. The `echo` adapter
  is shown as "Echo (test)" and the job page says to swap it for `claude-code`, `codex`, `qwen` and so on to sell real
  capacity. The app's "Run a job on someone else's **AI**" heading picks a non-echo adapter's name when one is live.
- The "demo account" in the app is a real funded testnet key signing real x402 payments, labelled "Pay ... from demo
  account", rate-limited and capped (0.50 USDC default); the pass used it for one real job.
- Illustrative landing graphics and the example terminal session are now labelled ("illustration", "example session").
- No dead buttons found. Gateway, CCTP and CCIP controls exist and work against the broker; they now state they have not
  been run end to end.

## 3. Screens audit

Production builds of the app and landing page against the real testnet deployment (broker on the public RPC with the
deployed addresses, one provider node, no model keys). Playwright, desktop 1360 px and mobile 390 px, every route:
`/`, `/jobs`, `/jobs/<id>`, `/providers`, `/providers/<id>`, `/network`, `/chain`, `/chain/tx|address|block/...`,
`/private`, landing `/`.

- All 200 (unknown job and unknown route correctly show "Job not found" and 404), zero console errors, zero failed
  requests, no broken images, no Monad / MON / AUSD / placeholder text, all external links go to
  `explorer.testnet.arc.io` (sampled 5 link shapes: address, tx, block, token, token instance all return 200).
- Found and fixed: `/chain/block/<n>` overflowed horizontally at 390 px (489 px wide, long hashes); now wraps.
- Screenshots: [docs/screens/testnet/](screens/testnet/) (`judge-*.png`, description in its README).
- One real job through the UI: below.

## 4. Feature check on testnet

Reused the passing run; made no new e2e run. One extra real job through the app's own pay path (Playwright clicked
"Pay $0.0010 from demo account"), because the earlier run drove the API, not the UI. Cost about 0.019 USDC total
(broker gas; the 0.001 job price went to the provider). Budget 1 USDC.

| Step | Transaction |
|---|---|
| provider registration receipt on XorvLedger | [0x0695a68a...2fe4](https://explorer.testnet.arc.io/tx/0x0695a68a99cbd10990911d2e25b0c828b573871f38085c4dc19a129560af2fe4) |
| x402 funding, buyer to XorvEscrow (Memo `xorv:fund`) | [0xc577921f...ddb2](https://explorer.testnet.arc.io/tx/0xc577921f36acb56fca96dc46bb7c563bba5721e7a6862b364c1dc101a9d2ddb2) |
| escrow release to the provider (Memo `xorv:release`, ERC-8004 feedback) | [0xd37a914f...7eb5](https://explorer.testnet.arc.io/tx/0xd37a914fadf4e9cd4e4c1fdb044089c4e7cd8d6de6622e50ed232a40f05c7eb5) |
| XorvLedger job receipt | [0x8e4679dc...2db7](https://explorer.testnet.arc.io/tx/0x8e4679dc2bd82aff5d2c8d69798f96d51cf8547b257781a4a24b49faced02db7) |

The job page showed: payment final in 2.30 s, release final in 1.80 s, gas 227,090 for the funding paid by the escrow's
attester with "buyer paid in gas 0 USDC", Memo ids matching the job id. The 10 transactions from the earlier run are in
[E2E-TESTNET.md](E2E-TESTNET.md).

Contracts: XorvEscrow and XorvReputation source verified on explorer.testnet.arc.io (`forge verify-contract`, Blockscout).
See "Still weak" for the other two.

## Checks run

typecheck (all workspaces), lint (app, landing), `next build` (app, landing), protocol 281 (+3 skipped), broker 300
(+1 skipped), cli 300, mcp 93, mm-plugin 74, app 153, landing 24, Foundry 105/105 (+2 skipped fork tests). Solidity
was not changed. The Arc fork e2e suites were not re-run (no chain behaviour changed).

## Still weak

- No hosted deployment: a cold judge sees screenshots and evidence, and must run the app locally to click through.
- Gateway, CCTP withdrawals and CCIP cross-chain jobs remain unrun live (need funded accounts on other chains).
- No real model has ever answered in a recorded run; demo capacity is `echo`.
- Keeper refunds, cancel and reassign have not been run on testnet.
- Reputation can be inflated by self-dealing (a provider paying itself costs only gas and a zero fee); escrow settlement
  makes it cost real USDC but it is not sybil-resistant.
- The broker is a single operator (escrow attester, facilitator, ledger writer); it can never pay anyone but the job's
  provider or the buyer, but it is not decentralised.
- Contracts unaudited; the Envio indexer is not deployed. XorvCcipReceiver and XorvLedger explorer source verification
  was rate-limited by the explorer at the time of this pass (see the final line of the run notes in the commit).
