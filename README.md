<div align="center">

<img src="brand/xorv-logo.svg" alt="Xorv" width="260" />

**A decentralized AI capacity network, settled on Arc.**
Rent out the Claude, Codex, Kimi or Qwen capacity you already pay for, and get paid per job in USDC,
through an escrow that pays on delivery, refunds when the job isn't delivered, and writes every
outcome to the provider's ERC-8004 reputation.

[![Arc](https://img.shields.io/badge/Arc-testnet%205042002-1E5EFF?style=flat-square)](https://explorer.testnet.arc.io)
[![x402](https://img.shields.io/badge/x402-v2%20USDC-7C5CFF?style=flat-square)](https://x402.org)
[![ERC-8004](https://img.shields.io/badge/ERC--8004-v2.0.0-3DDCFF?style=flat-square)](https://eips.ethereum.org/EIPS/eip-8004)
[![License](https://img.shields.io/badge/license-MIT-50F0C8?style=flat-square)](LICENSE)

</div>

---

Millions of people pay for an AI subscription or API key and use a fraction of it; anyone who wants
one job done has to buy a whole plan. Xorv is the rail between them. A provider runs one command and
their machine joins the network. A buyer (a person in the browser, a script, or another AI agent)
asks for a quote, signs one USDC authorization, and the job runs on the provider's machine.

On Arc the money moves like this:

1. The buyer signs an **x402** EIP-3009 authorization over **USDC**. They never send a transaction:
   the broker's facilitator submits it and pays the gas, which on Arc is also USDC.
2. The USDC goes into **XorvEscrow**, through Arc's **Memo** extension tagged with the job id.
3. The job runs on the provider's node and streams back to the buyer.
4. On delivery the escrow **releases** to the provider (with the result's hash); if the job fails, is
   cancelled or misses its deadline, it **refunds** the buyer in full.
5. Every release and every at-fault refund is written by **XorvReputation** to the provider's agent in
   Arc's **ERC-8004 Reputation Registry**. The buyer can also rate the job with a free signature
   (relayed by XorvLedger into the same registry), and an AI verifier scores results there too.

Arc's sub-second deterministic finality means steps 1 to 4 take seconds and are final when they land.
Buyers can top up from any chain with **Circle Gateway**, agents on Base or Ethereum can post a job with
one transaction over **Chainlink CCIP** while **CCTP** moves the dollars, and providers withdraw their
earnings to any chain with **CCTP V2**.

> This repo supersedes the earlier **Kazuo-on-Arc** testnet build (`nickthelegend/kazuo-arc`, the same
> product with direct x402 payments). It is a port of Xorv from Monad with the escrow, ERC-8004
> settlement reputation and the Arc stack below.

## Arc stack

Every row is exercised by real code; the "How verified" column says exactly how far. Nothing is
deployed on a public network yet: the shared deployer is unfunded (see [Status](#status)).

| Piece | What it does in Xorv | Contract / file | How verified |
|---|---|---|---|
| **USDC gas + sub-second finality** | One token for everything. Buyers hold USDC only and sign typed data; the broker's facilitator, keeper and relayer pay gas in USDC (≈ 0.01 USDC of gas per job). Releases are final on inclusion. | `packages/protocol/src/chains.ts` (native USDC 18-dec / ERC-20 6-dec), `x402.ts` | Arc-fork e2e: buyer nonce stays 0, balances checked in both views |
| **x402 in USDC** | Per-request payment for each job: `escrow` scheme (EIP-3009 `receiveWithAuthorization` into XorvEscrow, nonce bound to the job) and `exact`. The broker self-hosts the facilitator (Arc has no public one). | `packages/protocol/src/{x402,x402-client,escrow}.ts`, `services/broker/src/app.ts` | 284 protocol + 300 broker tests; Arc-fork e2e pays through Circle's real FiatToken (`"USDC"`/`"2"`) |
| **XorvEscrow** | Holds each job's USDC: release on delivery, refund on failure/cancel/deadline, reassign to another provider. Per-job cap (100 USDC), fee capped at 5 % (0 live), owner can never move escrowed funds. | [`contracts/src/XorvEscrow.sol`](contracts/src/XorvEscrow.sol) | 62 unit + 4 invariant Foundry tests; Arc testnet fork tests with real USDC |
| **ERC-8004 (headline)** | Every provider is an agent in Arc's Identity Registry. **XorvReputation** writes each escrow release (100) and at-fault refund (0) to the Reputation Registry (`successRate` / `xorv-escrow`, feedbackHash = job id); XorvLedger relays buyer ratings (`starred`); the Kimi verifier writes `xorv-verified`. The Qwen router reads all of it to pick providers. | [`contracts/src/XorvReputation.sol`](contracts/src/XorvReputation.sol), `packages/contracts/contracts/XorvLedger.sol`, `services/broker/src/{arc,ratings}.ts`, `services/indexer` | 18 unit tests; fork tests against the **real** Arc testnet registries; Arc-fork e2e: register → bind → release writes value 100 from XorvReputation, rating 95 from XorvLedger |
| **Circle Gateway** | A buyer's unified USDC balance on Base, Ethereum, Arbitrum, OP, Polygon, Avalanche or Arc; one EIP-712 burn intent, Circle attests, the broker calls `GatewayMinter.gatewayMint` on Arc, then the buyer pays. | `packages/protocol/src/gateway.ts`, `services/broker/src/arc.ts` (`/api/gateway*`), app top-up panel | Unit tests (intent built and checked field by field, forged signature refused before Circle); **live against Circle's testnet Gateway API** (balances; a correctly signed intent refused only for the empty balance). Spending a real balance is user-run |
| **Chainlink CCIP (+ CCTP)** | A buyer agent on Base/Ethereum calls `XorvCcipSender.postJob`: CCTP V2 burns the USDC to `XorvCcipReceiver` on Arc, CCIP carries the job; the receiver (allowlisted selector + sender, failed messages stored for retry) funds the escrow and the broker runs the job. `settle` releases it over CCIP too. Fees in native coin. | [`contracts/src/ccip/`](contracts/src/ccip), `services/broker/src/keeper.ts`, [`scripts/ccip-send.mjs`](scripts/ccip-send.mjs) | 21 **Chainlink Local** tests; 4 fork tests against Chainlink's real Arc testnet router (lanes to Base/Ethereum Sepolia, native-USDC fee quote, onlyRouter); Arc-fork e2e (router impersonated on the fork) runs a CCIP-funded job to release. Live sends are user-run |
| **CCTP V2 withdrawals** | Providers burn their Arc earnings with `depositForBurn` and mint native USDC on Base/Ethereum (Iris attestation, `receiveMessage`). | `packages/protocol/src/cctp.ts`, CLI `xorv withdraw`, app provider page | Fork test and Arc-fork e2e burn through the real `TokenMessengerV2` (DepositForBurn to domain 6); the attestation + mint are user-run |
| **Arc Memo** | Every escrow fund/release/refund/cancel/reassign and every x402 transfer goes through Arc's Memo predeploy, `memoId` = job id, memo `xorv:<action>`. Anyone can reconcile Xorv's USDC flows by job without our database. | `packages/protocol/src/{memo,x402}.ts` | Arc-fork e2e reads the `Memo` events on the funding, release and refund |
| **Refund keeper** (replaces Chainlink CRE) | Follows every `JobFunded`; refunds jobs past their deadline from a key that is not the attester (no fault on the provider); forwards CCIP refunds to the requester. CRE is testnet-only on Arc, so this keeps mainnet trust-minimal: the refund is permissionless. | `services/broker/src/keeper.ts` | Broker tests; Arc-fork e2e: orphaned CCIP job refunded by the keeper key and forwarded |
| **Envio indexer** | HyperSync on `arc-testnet` / `arc`: ledger, escrow, XorvReputation outcomes, CCIP intents, ERC-8004 feedback classified by client. | `services/indexer` | 69 tests (Envio test indexer); not deployed |
| **USYC** | **Not used.** Escrowed USDC is held for minutes and must be releasable or refundable in the same block; parking it in a permissioned, NAV-priced fund would break that and needs Circle allowlisting of the escrow. A fee treasury could use it later. | — | — |
| **Data Feeds / StableFX / EURC** | **Not used.** Jobs are priced and paid in USDC; there is no FX or price input on the payment path. | — | — |

## How it works

```
 buyer: web app (Privy) · xorv run · MCP agent · mm xorv          buyer agent on Base / Ethereum
   │ POST /api/quotes                                                 │ XorvCcipSender.postJob
   ▼                                                                  │   ├─ CCTP V2 burn → XorvCcipReceiver (USDC)
 broker ── Hunyuan screens · Qwen routes (reads ERC-8004 + escrow     │   └─ CCIP message (the job)
   │       outcomes + receipts) ── frozen quote                       ▼
   │ 402 → buyer signs EIP-3009 (USDC, no gas)          XorvCcipReceiver (Arc) ── fundDirect ──┐
   ▼                                                                                            │
 facilitator ── Arc Memo(job id) ── XorvEscrow.fund ◄───────────────────────────────────────────┘
   │ job.dispatch over the node's WebSocket
   ▼
 provider node (xorv start): sandboxed claude-code · codex · qwen · kimi · hunyuan · …
   │ result
   ▼
 broker ── Arc Memo ── XorvEscrow.release(resultHash) ── XorvReputation ── ERC-8004 giveFeedback(successRate)
        │            (refund on failure / keeper after the deadline)
        ├─ XorvLedger.recordJobs (receipt) · rateJob (buyer's signed rating → ERC-8004 "starred")
        └─ Kimi verifier → ERC-8004 "xorv-verified"
 provider: xorv withdraw → CCTP V2 depositForBurn on Arc → receiveMessage on Base / Ethereum
 buyer:    Circle Gateway burn intent → gatewayMint on Arc → pay
```

Rules that hold it together ([ARCHITECTURE.md](ARCHITECTURE.md)): the broker is never the payee (the
escrow can only pay the job's provider or refund its buyer); a quote is a price commitment checked by
the buyer before signing; pay first, then work, with free reassignment if a provider fails.

## Contracts and addresses

| | Arc testnet (5042002) | Arc mainnet (5042) |
|---|---|---|
| XorvLedger / XorvEscrow / XorvReputation / XorvCcipReceiver | not deployed yet: `deployments/arc-testnet.json` | not deployed: `deployments/arc-mainnet.json` |
| USDC (gas + payments) | `0x3600000000000000000000000000000000000000` | same |
| ERC-8004 Identity / Reputation | `0x8004A818BFB912233c491871b3d84c89A494BD9e` / `0x8004B663056A597Dffe9eCcC1965A193B7388713` | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` / `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| Memo | `0x5294E9927c3306DcBaDb03fe70b92e01cCede505` | same |
| CCTP TokenMessengerV2 / MessageTransmitterV2 (domain 26) | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` / `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` / `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` |
| Gateway Wallet / Minter | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` / `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` | `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` / `0x2222222d7164433c4C09B0b0D809a9b52C04C205` |
| CCIP router (selector) | `0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8` (3034092155422581607) | `0xB79791184973589c38e114D43Eb8E4588C283A18` (6370580034781731079) |

All of these live in one table, [`packages/protocol/src/chains.ts`](packages/protocol/src/chains.ts)
(TypeScript) and [`contracts/script/ArcConfig.sol`](contracts/script/ArcConfig.sol) (Solidity).

## Run it

Needs Node 22.18+, pnpm 10, and [Arc Foundry](https://docs.arc.io/arc/tutorials/install-arc-foundry)
(`arc-anvil`, `arc-forge`; plain anvil cannot move Arc's native USDC).

```bash
pnpm install && pnpm build
(cd contracts && npm ci && arc-forge build)

# The whole product on a local fork of Arc testnet: real USDC, Memo, ERC-8004 registries and CCIP
# router; contracts deployed by the real script; broker, two provider nodes, seeded jobs, the app.
ARC_ANVIL=arc-anvil ARC_FORGE=arc-forge pnpm demo        # app on http://localhost:8822

# Everything checked on chain (writes e2e/last-run-arc.md)
ARC_ANVIL=arc-anvil ARC_FORGE=arc-forge pnpm e2e:arc
```

Against Arc testnet: deploy (`XORV_BROKER_ADDRESS=0x… pnpm deploy:testnet`, writes
`deployments/arc-testnet.json`), copy the addresses into `.env` (see [.env.example](.env.example)),
then `pnpm broker:start`, `pnpm app`, and on a provider machine
`xorv init && xorv identity register && xorv identity bind && xorv start`.
Faucet: <https://faucet.circle.com> ("Arc Testnet"); that USDC is also your gas.

### Tests

| Suite | Command | Count |
|---|---|---:|
| Solidity (escrow, reputation, CCIP via Chainlink Local) | `cd contracts && forge test` | 105 |
| Solidity on an Arc testnet fork (real USDC, ERC-8004, CCIP router, CCTP) | `cd contracts && ARC_FORK_TESTS=1 arc-forge test --network arc` | +10 |
| `@xorv/protocol` | `pnpm --filter @xorv/protocol test` | 284 |
| `@xorv/broker` | `pnpm --filter @xorv/broker test` | 300 |
| `@xorv/cli` (incl. `xorv withdraw`, `xorv identity bind`) | `pnpm --filter @xorv/cli test` | 300 |
| `@xorv/mcp` (incl. `xorv_ccip_quote`) | `pnpm --filter @xorv/mcp test` | 93 |
| `@xorv/mm-plugin` | `pnpm --filter @xorv/mm-plugin test` | 74 |
| XorvLedger (Hardhat, real ERC-8004 v2 code) | `pnpm --filter @xorv/contracts test` | 48 |
| `xorv-app` / `xorv-landing` | `pnpm --filter xorv-app test` | 148 / 24 |
| Indexer | `cd services/indexer && pnpm check` | 69 |
| Arc-fork end to end: escrow, Memo, ERC-8004, CCIP, keeper, CCTP, Gateway | `pnpm e2e:arc` | 68 on-chain checks |
| Arc-fork end to end: CLI, MCP, private jobs, AI roles | `pnpm e2e` | 195 on-chain checks |

## Deploy to mainnet

One command, refused without explicit confirmation (`NETWORK=mainnet` is a config switch, never a
fallback). Gas measured on a fork: **9.22 M gas ≈ 0.20 USDC** for the whole deploy. Full steps, the
USDC budget, services and env vars: **[MAINNET.md](MAINNET.md)**.

```bash
XORV_CONFIRM_MAINNET=1 XORV_BROKER_ADDRESS=0x… pnpm deploy:mainnet
```

## Status

- Contracts, broker, protocol, indexer and the Arc-fork end to end are done and green.
- **Not yet on a public network**: the shared deployer `0x0648…1FBd` holds 0 USDC on Arc testnet and
  mainnet, so `pnpm deploy:testnet` is the one remaining step; nothing is faked in its place.
- User-run with funds: a live CCIP send from Base Sepolia (`scripts/ccip-send.mjs`), a Gateway top-up
  from a real deposit, a CCTP withdraw's mint on the destination chain.

## Repository map

```
xorv-arc/
├── contracts/          Foundry: XorvEscrow, XorvReputation, ccip/XorvCcip{Sender,Receiver}, tests (unit,
│                       Chainlink Local, Arc fork), script/Deploy.s.sol (+ DeploySender, AllowSender)
├── packages/
│   ├── protocol/       chain table, x402 facilitator + buyer client, escrow scheme, Memo, Gateway, CCTP,
│   │                   ERC-8004 helpers, XorvLedger ABI, private-job crypto
│   ├── contracts/      XorvLedger (Hardhat tests against the vendored ERC-8004 registries)
│   ├── cli/            the provider node and `xorv run`, `xorv identity`, `xorv withdraw`
│   ├── mcp/            MCP server: AI agents buy jobs (local key or Privy server wallet)
│   └── mm-plugin/      MetaMask Agent Wallet plugin
├── services/
│   ├── broker/         registry, matcher, x402, escrow settlement, refund keeper, Gateway, CCIP jobs, AI roles
│   └── indexer/        Envio HyperIndex on Arc
├── apps/app, apps/landing   the product and the site
├── e2e/                Arc-fork harnesses: `pnpm e2e:arc`, `pnpm e2e`, `pnpm demo`
├── scripts/            deploy.sh (testnet|mainnet|local), arc-fork.sh, ccip-send.mjs
└── deployments/        arc-testnet.json, arc-mainnet.json
```

## Documentation

[ARCHITECTURE.md](ARCHITECTURE.md) · [MAINNET.md](MAINNET.md) · [SUBMISSION.md](SUBMISSION.md) ·
[SECURITY.md](SECURITY.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [CHANGELOG.md](CHANGELOG.md) ·
[contracts/README.md](contracts/README.md) · [docs/PRIVATE_JOBS.md](docs/PRIVATE_JOBS.md) ·
[services/broker/README.md](services/broker/README.md) · [services/indexer/README.md](services/indexer/README.md)

On terms of service: many consumer AI subscriptions are licensed to an individual, and reselling that
capacity may breach them. The `qwen`, `kimi` and `hunyuan` adapters use pay-as-you-go API keys. Xorv is
infrastructure and does not decide this for you.

Built with Claude Code (Anthropic); commits written that way carry a `Co-Authored-By: Claude` trailer.

## Licence

MIT, see [LICENSE](LICENSE). The vendored ERC-8004 registries (test-only, `packages/contracts/contracts/vendor/erc8004/`),
OpenZeppelin, forge-std, Chainlink CCIP and x402 packages keep their own licences.
