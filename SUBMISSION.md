# Xorv on Arc: DoraHacks Arc Microgrants submission

Live: https://xorv-arc.vercel.app (Arc mainnet, chain 5042)


> **This build supersedes the earlier Kazuo-on-Arc testnet build** (`nickthelegend/kazuo-arc`, x402
> payments on Arc testnet). Xorv and Kazuo are the same product; this repo is the one to review. It
> adds the on-chain escrow, ERC-8004 reputation written by escrow settlement, Circle Gateway, CCTP V2
> withdrawals, Chainlink CCIP jobs, Arc Memo tagging and a one-command mainnet deploy.

## Description (≤ 150 words)

Xorv is a decentralized AI capacity network on Arc. People rent out the Claude, Codex, Kimi or Qwen
capacity they already pay for and get paid per job in USDC. A buyer (a person, a CLI, or another AI
agent) signs one x402 USDC authorization; the money waits in **XorvEscrow** on Arc, is released to
the provider when the job delivers and refunded when it doesn't. Every settlement writes the
provider's outcome to Arc's **ERC-8004** Reputation Registry, so reputation is earned by paid,
delivered work and can't be faked. Buyers hold only USDC (it is Arc's gas) and never send a
transaction; Arc's finality is sub-second. They can fund once on any chain with **Circle Gateway**, or post
a job from Base/Ethereum over **Chainlink CCIP** while **CCTP** moves the dollars. Providers withdraw
earnings to any chain with **CCTP V2**, and every payment carries its job id through Arc's **Memo**.
The Gateway, CCIP and CCTP paths are built and tested on forks but not yet run live.

## Live on Arc testnet

The four contracts are deployed on Arc testnet (5042002) and the core loop has been run against them with real
transactions (46 checks, 10 transactions, [docs/E2E-TESTNET.md](docs/E2E-TESTNET.md)):

| Contract | Address |
|---|---|
| XorvEscrow | [0x2827Bb9B8109d602fa617f043A10E47Ef5aEc9eA](https://explorer.testnet.arc.io/address/0x2827Bb9B8109d602fa617f043A10E47Ef5aEc9eA) |
| XorvReputation | [0xe9cCAa186AA7D8dC8CD8c05F964a05E83296Fd89](https://explorer.testnet.arc.io/address/0xe9cCAa186AA7D8dC8CD8c05F964a05E83296Fd89) |
| XorvLedger | [0x035c1f8CD3330EDd547230D578037Ebee4020Cbc](https://explorer.testnet.arc.io/address/0x035c1f8CD3330EDd547230D578037Ebee4020Cbc) |
| XorvCcipReceiver | [0x61d6eC91320be18A4D0499b872307fA781f427B0](https://explorer.testnet.arc.io/address/0x61d6eC91320be18A4D0499b872307fA781f427B0) |

**Exactly what has and has not been run**

- Run live on testnet: USDC as gas, x402 (EIP-3009) funding into XorvEscrow with Arc Memo tags, release to a provider
  that is an ERC-8004 agent, the outcome written to Arc's Reputation Registry by XorvReputation, a ledger receipt, a
  gasless buyer rating relayed into ERC-8004, the app and chain viewer against that deployment.
- **Not run live** (each needs funds on another chain): **Circle Gateway** deposits and mints, **CCTP V2**
  withdrawals, and **Chainlink CCIP** cross-chain jobs. They are built and covered by unit tests, fork tests and
  Chainlink Local; `XorvCcipReceiver` is deployed but has never received a message.
- **Mocked**: in the testnet run the screener, router and verifier models, and the provider's `qwen` adapter, answered
  from a local mock model server, and the demo provider sells an `echo` test capability. No real model API was called.
  A broker with real keys calls Qwen, Kimi and Hunyuan; providers sell their own Claude Code, Codex or API-key capacity.
- Not run on testnet: deadline refunds by the keeper, cancel, reassign. Fork-tested only.
- Not on mainnet, and the contracts are unaudited.

## What it uses Arc for

- **USDC as gas, sub-second finality**: buyers, providers and the broker hold one token. Buyers sign
  typed data only; the broker's facilitator pays gas in USDC. Arc blocks are about half a second and final on
  inclusion; a job is paid, run and settled in a few seconds (measured: the payment is final 2 to 3 s after the
  broker sends it, a whole echo job in about 8 s).
- **x402 in USDC** (EIP-3009 on Arc's FiatToken, domain "USDC"/"2"): per-request payments, settled by
  the broker's own facilitator (there is no public Arc facilitator) into XorvEscrow.
- **ERC-8004 (headline)**: every provider is an agent in Arc's Identity Registry; XorvReputation writes
  each escrow release (100) or at-fault refund (0) to the Reputation Registry; XorvLedger relays buyers'
  gasless ratings; the AI verifier's scores land there too. The router reads all three to pick providers.
- **Circle Gateway** (not run live): a buyer's unified USDC balance on Base, Ethereum, Arbitrum, OP, Polygon,
  Avalanche or Arc, minted to their Arc wallet with one signature.
- **Chainlink CCIP + CCTP** (not run live): a buyer agent on Base/Ethereum posts and settles a job with one source
  transaction; a defensive receiver on Arc funds the escrow.
- **CCTP V2** (not run live): providers burn their Arc earnings and mint them on another chain.
- **Arc Memo**: every escrow movement and x402 transfer is tagged with its job id on chain.
- **A refund keeper instead of Chainlink CRE** (CRE is testnet-only on Arc): deadline refunds need no
  trusted party.

## Demo steps

0. **Read the live evidence first:** [docs/E2E-TESTNET.md](docs/E2E-TESTNET.md) (10 transactions on Arc testnet, each
   linked to the explorer), [docs/screens/testnet/](docs/screens/testnet/) and [docs/JUDGE-REPORT.md](docs/JUDGE-REPORT.md).
1. **Run it locally on an Arc fork (no keys, no funds):** `pnpm install && pnpm build && ARC_ANVIL=… ARC_FORGE=… pnpm demo`
   brings up a fork of Arc testnet with Circle's real USDC, Memo, the ERC-8004 registries and the
   CCIP router, deploys with the real script, starts the broker, two provider nodes (ERC-8004 agents
   bound in XorvReputation) and the app at <http://localhost:8822>.
2. **Post a job** in the app: pick "Auto", pay. Watch the escrow timeline: funded (Memo-tagged), job
   streamed, released to the provider, ERC-8004 outcome written.
3. **Provider page**: the agent's ERC-8004 identity and escrow record; "Withdraw to another chain"
   burns earnings with CCTP V2.
4. **Network page**: the Arc stack panel with every contract linked to the explorer.
5. **Top up from Circle Gateway** in the composer (needs a USDC deposit on a source chain; not run live).
6. **CCIP**: request a quote with "Pay from Base/Ethereum"; a buyer agent calls
   `XorvCcipSender.postJob(...)` on Base Sepolia (`scripts/ccip-send.mjs`, user-run, not run live).
7. **Everything checked on chain:** `pnpm e2e:arc` (the report lands in `e2e/last-run-arc.md`).

Testnet deploy (already done, `deployments/arc-testnet.json`): `XORV_BROKER_ADDRESS=0x… pnpm deploy:testnet`;
mainnet: [MAINNET.md](MAINNET.md).

<!-- MAINNET-ADDRESSES -->
## Addresses — live mainnet and testnet

Mainnet **5042: Live**, deployed 2026-10-14. [All mainnet addresses and transaction receipts](docs/MAINNET-DEPLOYMENT.md).
Testnet **5042002: Live**; [testnet deployment](deployments/arc-testnet.json) and [testnet evidence](docs/E2E-TESTNET.md).

- XorvCcipReceiver: [0xE4de2F7828d580954f8Ea36713Cf40766b37eDe1](https://explorer.arc.io/address/0xE4de2F7828d580954f8Ea36713Cf40766b37eDe1).
- XorvEscrow: [0x6EF98A57FC25e237d25CB59B5F24a964E07e6412](https://explorer.arc.io/address/0x6EF98A57FC25e237d25CB59B5F24a964E07e6412).
- XorvLedger: [0xc9980A3A07A6CBBfc528cf10ccf3285EF0978c3f](https://explorer.arc.io/address/0xc9980A3A07A6CBBfc528cf10ccf3285EF0978c3f).
- XorvReputation: [0x1C2c20852A68b92ed7d95DD372575eD99728158F](https://explorer.arc.io/address/0x1C2c20852A68b92ed7d95DD372575eD99728158F).

Mainnet smoke: [Smoke: fund 0.01 USDC x402 job](https://explorer.arc.io/tx/0x9a03ba343ebb24dd3f1192140c6797b56f866e756f23fffb9a70df4d4977df86).

Mainnet smoke: [Smoke: release escrow and ERC-8004 reputation](https://explorer.arc.io/tx/0x35e45b72d704a59e2082c06975265c53bcc0af8ab058e6ce02f3db68b24ab8ab).
<!-- /MAINNET-ADDRESSES -->

## Production network

Live: https://xorv-arc.vercel.app (Arc mainnet, chain 5042). [Hosted mainnet checks](docs/HOSTED-MAINNET.md). Hosted mode is read-only; job execution requires the on-demand local broker and provider. No mainnet transactions were sent during the hosting migration. Historical **Live (testnet)** and **Fork** results below are separate evidence, not production smoke results.
