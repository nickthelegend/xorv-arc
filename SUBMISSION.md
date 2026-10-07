# Xorv on Arc: DoraHacks Arc Microgrants submission

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
transaction; finality is sub-second. They can fund once on any chain with **Circle Gateway**, or post
a job from Base/Ethereum over **Chainlink CCIP** while **CCTP** moves the dollars. Providers withdraw
earnings to any chain with **CCTP V2**, and every payment carries its job id through Arc's **Memo**.

## What it uses Arc for

- **USDC as gas, sub-second finality**: buyers, providers and the broker hold one token. Buyers sign
  typed data only; the broker's facilitator pays gas in USDC. A job is paid, run and settled in a few
  seconds, final on inclusion.
- **x402 in USDC** (EIP-3009 on Arc's FiatToken, domain "USDC"/"2"): per-request payments, settled by
  the broker's own facilitator (there is no public Arc facilitator) into XorvEscrow.
- **ERC-8004 (headline)**: every provider is an agent in Arc's Identity Registry; XorvReputation writes
  each escrow release (100) or at-fault refund (0) to the Reputation Registry; XorvLedger relays buyers'
  gasless ratings; the AI verifier's scores land there too. The router reads all three to pick providers.
- **Circle Gateway**: a buyer's unified USDC balance on Base, Ethereum, Arbitrum, OP, Polygon, Avalanche
  or Arc, minted to their Arc wallet with one signature.
- **Chainlink CCIP + CCTP**: a buyer agent on Base/Ethereum posts and settles a job with one source
  transaction; a defensive receiver on Arc funds the escrow.
- **CCTP V2**: providers burn their Arc earnings and mint them on another chain.
- **Arc Memo**: every escrow movement and x402 transfer is tagged with its job id on chain.
- **A refund keeper instead of Chainlink CRE** (CRE is testnet-only on Arc): deadline refunds need no
  trusted party.

## Demo steps

1. **Run it locally on an Arc fork (no keys, no funds):** `pnpm install && pnpm build && ARC_ANVIL=… ARC_FORGE=… pnpm demo`
   brings up a fork of Arc testnet with Circle's real USDC, Memo, the ERC-8004 registries and the
   CCIP router, deploys with the real script, starts the broker, two provider nodes (ERC-8004 agents
   bound in XorvReputation) and the app at <http://localhost:8822>.
2. **Post a job** in the app: pick "Auto", pay. Watch the escrow timeline: funded (Memo-tagged), job
   streamed, released to the provider, ERC-8004 outcome written.
3. **Provider page**: the agent's ERC-8004 identity and escrow record; "Withdraw to another chain"
   burns earnings with CCTP V2.
4. **Network page**: the Arc stack panel with every contract linked to the explorer.
5. **Top up from Circle Gateway** in the composer (testnet: needs a USDC deposit on a source chain).
6. **CCIP**: request a quote with "Pay from Base/Ethereum"; a buyer agent calls
   `XorvCcipSender.postJob(...)` on Base Sepolia (`scripts/ccip-send.mjs`, user-run).
7. **Everything checked on chain:** `pnpm e2e:arc` (the report lands in `e2e/last-run-arc.md`).

Testnet deploy: `XORV_BROKER_ADDRESS=0x… pnpm deploy:testnet`; mainnet: [MAINNET.md](MAINNET.md).
