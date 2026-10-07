# Changelog

All notable changes to this project. Earlier history (the Hedera prototype, 0.1.0, and the Monad
version, 0.2.0) lives in those versions' own repositories.

## [0.3.0] — Arc (unreleased)

Xorv moves to **Arc**, Circle's stablecoin L1. Testnet (`eip155:5042002`) is the default and mainnet
(`eip155:5042`) is opt-in. USDC is the gas token, so buyers, providers and the broker hold one asset.

### Added

- **Arc chain table** (`packages/protocol/src/chains.ts`): RPC, Blockscout explorer, USDC
  (`0x3600…0000`, EIP-712 `"USDC"`/`"2"`; the native 18-decimal balance and the 6-decimal ERC-20 are
  one balance), ERC-8004 registries, CCTP V2, Gateway, Memo, the CCIP router and the remote chains
  (Base and Ethereum, Base Sepolia and Ethereum Sepolia on testnet).
- **XorvEscrow** (Foundry, `contracts/`): x402 `escrow` scheme funded by EIP-3009
  `receiveWithAuthorization` with a job-bound nonce; `fundDirect` for allowlisted contract funders;
  a per-job cap (`maxJobAmount`, 100 USDC at deploy); `release`, `refund`, `cancel`, `reassign`; an
  owner who cannot move escrowed funds.
- **XorvReputation**: binds a payout wallet to its ERC-8004 agent (`bind(agentId)`) and writes every
  escrow release (100) and attester refund (0) to Arc's ERC-8004 Reputation Registry under tag
  `successRate`. The router's new `escrow_outcomes` tool and `GET /api/providers/:id/escrow` read it.
- **Chainlink CCIP jobs**: `XorvCcipSender` on Base / Ethereum burns USDC with CCTP V2 and sends the
  job over CCIP; `XorvCcipReceiver` on Arc (allowlisted source chain and sender, stored and
  retryable failed messages, per-unit accounting, `claimRefund`) funds the escrow as its buyer of
  record. `POST /api/quotes` with `payVia: "ccip"` returns `ccip` terms; `scripts/ccip-send.mjs` is
  a user-run testnet buyer.
- **Refund keeper** (`services/broker/src/keeper.ts`): follows every `JobFunded`, refunds past the
  deadline from a key that is not the attester, opens CCIP-funded jobs, forwards CCIP refunds and
  closes released intents.
- **Arc Memo**: every escrow write and every x402 `transferWithAuthorization` goes through Arc's
  Memo predeploy with the escrow job id as `memoId` and a tag such as `xorv:release`.
- **Circle Gateway**: `GET /api/gateway`, `POST /api/gateway/intent`, `POST /api/gateway/mint`. The
  buyer signs an EIP-712 burn intent, Circle attests, and the broker mints on Arc.
- **CCTP V2 withdrawals**: `xorv withdraw` and the app's withdraw panel burn on Arc and mint on Base
  or Ethereum.
- `GET /api/network` gains an `arc` block (gas token, Memo, XorvReputation, Gateway, CCTP, CCIP,
  keeper).
- **One deploy script**, `scripts/deploy.sh testnet|mainnet|local`, with a shared deployer lock,
  Blockscout verification, and a mainnet refusal without `XORV_CONFIRM_MAINNET=1`.
  `scripts/arc-fork.sh` (`pnpm fork`) deploys onto a local Arc testnet fork.
- **Indexer entities** for the escrow, XorvReputation and the CCIP receiver (`EscrowJob`,
  `EscrowOutcome`, `AgentBinding`, `ReputationContract`, `CrossChainIntent`) and the feedback kind
  `ESCROW_OUTCOME`.
- **`pnpm e2e:arc`**: a fork of Arc testnet with the real deploy script, broker and provider node,
  checking x402 into escrow, Memo, the ERC-8004 outcome and rating, cancel, a CCIP job, the refund
  keeper, a CCTP burn and Circle's live Gateway API. Report in `e2e/last-run-arc.md`.

### Changed

- The broker **self-hosts the x402 facilitator by default** (`XORV_FACILITATOR=self`): there is no
  public facilitator on Arc. Its key is the escrow's attester. With no key, payments are disabled
  with a 503 that names the fix.
- Gas is paid in USDC by every broker key; balances are read as native 18-decimal USDC.
- Log readers work in windows of up to 10,000 blocks (Arc's `eth_getLogs` cap); the fallback ledger
  scan covers 100,000 blocks.
- Transactions are sent with `eth_sendRawTransaction` and a polled receipt: Arc's RPC does not offer
  `eth_sendRawTransactionSync`. Finality is deterministic, so one receipt is final.
- The indexer reads Arc through Envio HyperSync (`arc-testnet.hypersync.xyz`, `arc.hypersync.xyz`).
- `pnpm e2e` and `pnpm demo` (ports 8820–8822) run on an Arc Foundry fork. Parties are funded with
  `anvil_setBalance`, because the native balance is the USDC balance.
- The broker's default database is `data/xorv-arc.db` (Mongo: `xorv_arc`), so an older database is
  never loaded by mistake.
- Deployment notes moved from `DEPLOY.md` to `MAINNET.md`.

### Removed

- Chainlink CRE refund workflow and its `XorvRefundKeeper` contract (CRE is testnet-only on Arc),
  replaced by the broker's refund keeper.
- Nansen wallet trust: the trust score, the wash-rating guard and the router's `nansen_trust` tool
  (now `escrow_outcomes`).
- The Cleanverse identity gate. XorvEscrow keeps a generic, optional `IIdentityGate`, off at deploy.
- Monad specifics: MON gas and its per-account reserve, gas-limit billing figures,
  `eth_sendRawTransactionSync` timing, Monad commit states, the hosted Monad facilitator, and
  `pnpm e2e:escrow` (covered by `pnpm e2e:arc`).
