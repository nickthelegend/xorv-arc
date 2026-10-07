# End-to-end harness

Two runs take the whole Xorv system (chain, broker, provider node, buyers) onto **real contract
code** and check every claim on-chain. They are the tests in the repo that need the network: both
fork Arc testnet with Arc Foundry.

```sh
pnpm install
pnpm build                                                  # the harness runs the built broker, CLI and MCP server
ARC_ANVIL=arc-anvil ARC_FORGE=arc-forge pnpm e2e:arc        # the Arc stack; writes e2e/last-run-arc.md
ARC_ANVIL=arc-anvil ARC_FORGE=arc-forge pnpm e2e            # buyers, AI roles, private jobs; writes e2e/last-run.md
```

`pnpm demo` (`src/demo.ts`) keeps the same kind of stack running for people to use: a fork, the
contracts deployed by the real script, the broker, two provider nodes, a few seeded paid jobs and
the app, on ports 8820 (chain), 8821 (broker) and 8822 (app). See the [root README](../README.md).

Exit code 0 means every step finished and every check held; anything else is a failure, with the tail
of each process's output printed and the run directory kept (the path is printed).

## `pnpm e2e:arc`: the Arc stack

`src/arc.ts`. It deploys XorvLedger, XorvReputation, XorvEscrow and XorvCcipReceiver with
`scripts/deploy.sh local`, starts the built broker with its self-hosted facilitator as the escrow's
attester and the refund keeper on a separate key, takes a real provider node live (`xorv start`,
echo adapter), and pays with the protocol's x402 client. It then checks, on the fork:

1. **USDC.** The forked token is Circle's FiatToken at `0x3600…0000` with EIP-712 `"USDC"`/`"2"`, and
   a party's native balance is the same USDC with 18 decimals.
2. **ERC-8004.** The provider registers an agent on Arc's real Identity Registry and binds it in
   XorvReputation; the broker verifies it.
3. **x402 into escrow.** The buyer holds only USDC and never sends a transaction (nonce 0). The
   facilitator's `fund` goes through Arc's Memo with the escrow job id; the release pays the provider
   exactly the price and is Memo-tagged `xorv:release`.
4. **Reputation.** The release wrote feedback 100 under `successRate` to the real ERC-8004
   Reputation Registry, with XorvReputation as the client; XorvReputation's counters match; the
   broker serves the record at `/api/providers/:id/escrow`.
5. **Ledger and rating.** XorvLedger receipts the job with the release as its payment, and the
   buyer's gasless EIP-712 rating lands as ERC-8004 `starred` feedback through the ledger.
6. **Cancel.** A buyer's cancel refunds the escrow in full, provider not at fault, Memo-tagged
   `xorv:cancel`.
7. **Chainlink CCIP.** The receiver's owner allowlists a sender on Base Sepolia; a quote with
   `payVia: "ccip"` returns CCIP terms; the CCTP mint into the receiver is **simulated by a USDC
   transfer** (no attestation exists on a fork), and the CCIP delivery is made by **impersonating
   Chainlink's real Arc router** on the fork. The receiver funds the real escrow as buyer of record,
   the broker runs the job and releases it, the intent is closed, and the requester spends nothing
   on Arc.
8. **Refund keeper.** An orphaned cross-chain job past its deadline is refunded by the keeper key
   (not the attester, so `providerAtFault` is false) and forwarded to the requester with
   `claimRefund`.
9. **CCTP V2.** The provider burns 1 USDC of earnings on Arc to Base Sepolia with the real
   `TokenMessengerV2` (`DepositForBurn` to domain 6, the provider as mint recipient). The mint on
   Base Sepolia needs Circle's attestation, which a fork cannot get.
10. **Circle Gateway.** The broker reads a unified balance for a fresh buyer from Circle's **live**
    testnet Gateway API (this step needs the internet, not only the Arc RPC).

The last run's report, with every value read back during the run, is
[last-run-arc.md](last-run-arc.md).

## `pnpm e2e`: buyers, AI roles and private jobs

`src/run.ts`. This run pays providers directly with x402 `exact` (the escrow is deployed but not
used) and covers the buyer surfaces:

- The broker's **Hunyuan screen** refuses an abusive prompt with a 422 before any quote; the **Qwen
  router's** pick is the adapter that ran; **Kimi** verifies the result and writes ERC-8004 feedback
  `xorv-verified` from the verifier EOA. The models are stand-ins (below); the roles' request,
  parsing and feedback code is real.
- A provider registers its identity with `xorv identity register` and goes live with `xorv start`,
  selling `echo` and `qwen`.
- Buyers: `xorv run --json`; the MCP server over stdio via the MCP SDK client (`xorv_run_job`,
  `xorv_rate_job`); and a **private job** straight through the broker API, sealed to the buyer's
  inbox key.
- On-chain: each settlement is one USDC transfer buyer → provider for the quoted amount, submitted
  by the facilitator EOA, with the buyer's `AuthorizationUsed` and an Arc Memo tag carrying the job;
  `ProviderRegistered`, a sampled `ProviderHeartbeat`, and a `JobRecorded` per job with its hashes
  recomputed; `JobRated` for each rating; ERC-8004 `NewFeedback` for the verifier and for each buyer
  rating, with the served feedback files hashing to the on-chain `feedbackHash`.
- The broker's own views (`/api/ledger`, `/api/leaderboard`, `/api/network`) agree with the chain;
  `xorv identity show` and `xorv earnings --json` agree with the chain; the private answer never
  touches the broker's API, database or the verifier's inputs.

Its report is [last-run.md](last-run.md).

## What runs

| | Real code | Stand-in |
|---|---|---|
| Chain | A local fork of **Arc testnet** (chain id 5042002) with Arc Foundry's anvil (`arc-anvil --network arc`). Circle's USDC (also the gas token), Arc's Memo predeploy, the canonical ERC-8004 v2.0.0 registries, CCTP's `TokenMessengerV2` and Chainlink's CCIP router are forked in with the rest of the state. | — |
| Contracts | Deployed by `scripts/deploy.sh local` with Arc Foundry's forge (`ARC_FORGE`), the same script that deploys to testnet and mainnet. | — |
| Broker | `services/broker/dist`: x402 upfront settlement through its **self-hosted facilitator**, the escrow, the refund keeper and CCIP watcher, Gateway, the XorvLedger writer, the gasless rating relay, private-job handling, SQLite persistence. | — |
| AI roles (`pnpm e2e`) | The broker's Hunyuan screen, Qwen router and Kimi verifier run their real code. | The **models**: a local OpenAI-compatible server (`src/mock-llm.ts`) answers by rule, one base URL and key per preset. |
| Provider | `packages/cli/dist`: `xorv identity register`, then `xorv start`. | — |
| Buyers | The protocol's x402 client, `xorv run --json`, the MCP server (`packages/mcp/dist`). | The passkey PRF output (fixed bytes into `deriveInboxKeys`). |
| Cross-chain (`pnpm e2e:arc`) | The CCIP receiver, the escrow, `TokenMessengerV2` on Arc, Circle's live Gateway API. | The CCTP mint into the receiver (a USDC transfer) and the CCIP delivery (the real router address, impersonated). |

Every key is generated for the run, except that contracts are deployed from anvil's well-known dev
account 0, which exists only on the fork. Anvil's dev account 1 is on Arc testnet's USDC blocklist,
so no party uses it. Funding is `anvil_setBalance`: on Arc the native balance (18 decimals) *is*
the USDC balance (6 decimals), so balances, transfers and events are genuine.

Nothing from your environment reaches the processes under test: every `XORV_*`, model key, Mongo URI
or indexer URL in your shell or the repo-root `.env` is dropped or blanked (see `src/env.ts`), so a
run can neither spend real money nor test your local setup instead of the code.

## Prerequisites

- Node ≥ 22.18 and pnpm, `pnpm install && pnpm build` done.
- **Arc Foundry**: `arc-anvil` and `arc-forge` on `PATH`, or `ARC_ANVIL` / `ARC_FORGE` pointing at
  them (<https://docs.arc.io/arc/tutorials/install-arc-foundry>). Stock anvil can fork Arc but cannot
  move its native USDC. The contracts must build (`cd contracts && npm ci`, submodules initialised).
- **Network access to the Arc testnet RPC** (`https://rpc.testnet.arc.io`): the fork reads contract
  state from it lazily throughout the run. A private RPC is faster.

## Options

| Variable | Default | |
|---|---|---|
| `ARC_ANVIL` / `ARC_FORGE` | `arc-anvil` / `arc-forge` on `PATH` | Arc Foundry's binaries. |
| `ARC_FORK_URL` | `https://rpc.testnet.arc.io` | RPC to fork from. |
| `ARC_FORK_BLOCK` | latest | Pin the fork block for a reproducible run. |
| `XORV_E2E_FORK_PORT` | 8814 (`e2e`), 8810 (`e2e:arc`) | Port for the fork. |
| `XORV_E2E_BROKER_PORT` | 8812 | Broker port for `e2e:arc` (`e2e` picks a free port). |
| `XORV_E2E_KEEP` | unset | `1` keeps `pnpm e2e`'s run directory (every process's log, the broker's database) after a passing run too. |
| `XORV_E2E_DIR` | `e2e/.runs` | Where `pnpm e2e` puts run directories. |

## Layout

| File | |
|---|---|
| `src/arc.ts` | `pnpm e2e:arc`: the Arc stack, steps, checks, report. |
| `src/run.ts` | `pnpm e2e`: buyers, AI roles, private jobs, steps, checks, report. |
| `src/demo.ts` | `pnpm demo`: the long-running stack with seeded jobs and the app. |
| `src/chain.ts` | The fork (Arc Foundry's anvil), USDC funding with `anvil_setBalance`, deployment with `scripts/deploy.sh local`. |
| `src/onchain.ts` | Reading settlements, ledger events and ERC-8004 feedback back off the fork. |
| `src/mock-llm.ts` | The OpenAI-compatible model stand-in. |
| `src/api.ts` | The broker's public API and x402 payment, as any buyer uses them. |
| `src/procs.ts` | Child processes: logged, awaited, and always torn down (process trees on Windows). |
| `src/env.ts` | Sealed environments for the children. |
| `src/report.ts` | The terminal output and the Markdown reports. |
