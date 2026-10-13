# Architecture

How Xorv is put together on Arc, Circle's stablecoin L1, and why the awkward parts are the way
they are.

Xorv began on Hedera and was then ported to Monad. This repository is the port to Arc. Most of the
marketplace (quotes, upfront settlement, reassignment, receipts, ratings, private jobs, the AI
roles) carried over unchanged. What changed is the money layer: payments now wait in an on-chain
escrow, every settlement becomes ERC-8004 reputation, and buyers and providers can reach the
network from other chains through Circle Gateway, Circle CCTP V2 and Chainlink CCIP.

---

## The shape

```
 buyers                          broker (services/broker)                   provider node (xorv start)
 app · xorv run · MCP · mm xorv     │                                          dials OUT over WebSocket
   │ 1 POST /api/quotes ──────────► │ Hunyuan screen → Qwen agent → matcher               │
   │ ◄── frozen quote, accepts[] ── │ (provider, agentId, usdcAmount, escrow job id)       │
   │ 2 POST /api/jobs/:quoteId ───► │ 402: escrow (payTo = XorvEscrow) | exact (payTo = provider)
   │ 3 PAYMENT-SIGNATURE ─────────► │ facilitator = attester ─ Memo ─► XorvEscrow.fund ───► Arc
   │   (EIP-3009, typed data only)  │ (settled BEFORE the handler runs)                    │
   │ ◄── 200 jobId, funding tx ──── │                                                      │
   │                                ├── job.dispatch ─────────────────────────────────────►│
   │ ◄══ SSE ═══════════════════════╪◄═ job.event (tool calls, reasoning, steps) ══════════┤
   │ ◄── result ────────────────────┤◄── job.result (sealed if private) ───────────────────┤
   │                                ├─ Memo ─► XorvEscrow.release ─► USDC to the provider ► Arc
   │                                │            └─► XorvReputation ─► ERC-8004 giveFeedback(100, "successRate")
   │                                ├─ XorvLedger.recordJobs (paymentTx = the release) ─► Arc
   │                                ├─ Kimi verify ─► ERC-8004 giveFeedback("xorv-verified") ► Arc
   │ 6 EIP-712 Rating (free) ──────►├─ XorvLedger.rateJob ─► ERC-8004 giveFeedback("starred") ► Arc
   │                                ├─ RefundKeeper: every JobFunded, refund past the deadline ► Arc
   │                                │
   │                                ◄── Envio HyperIndex (services/indexer) GraphQL ◄── Arc HyperSync
```

Money from and to other chains:

```
 Circle Gateway (buyer tops up on Arc)
   buyer signs an EIP-712 BurnIntent ─► broker ─► Circle Gateway API (attestation)
                                          └─► GatewayMinter.gatewayMint on Arc ─► USDC in the buyer's Arc wallet

 Chainlink CCIP job (buyer agent on Base / Ethereum)
   XorvCcipSender.postJob ─┬─ CCTP V2 depositForBurn(price + maxFee) ─► minted to XorvCcipReceiver on Arc   (the dollars)
                           └─ CCIP POST_JOB message ──────────────────► XorvCcipReceiver.ccipReceive on Arc (the instruction)
   XorvCcipReceiver (once both have arrived, in either order) ─► XorvEscrow.fundDirect ─► the broker runs the job

 CCTP V2 withdrawal (provider takes earnings home)
   provider: TokenMessengerV2.depositForBurn on Arc ─► Circle Iris attestation
             ─► MessageTransmitterV2.receiveMessage on Base / Ethereum ─► native USDC there
```

The broker is the only process that has to run for the network to exist. The indexer, the app and
the landing page are optional. Provider nodes run anywhere.

## Packages

| Package | What it is |
|---|---|
| `packages/protocol` | The shared vocabulary: domain and wire types, the Arc chain table (`chains.ts`), viem helpers (`evm.ts`), the x402 facilitator (`x402.ts`, Node only) and buyer client (`x402-client.ts`), the `escrow` x402 scheme (`escrow.ts`), Arc Memo (`memo.ts`), Circle Gateway intents (`gateway.ts`), CCTP V2 withdrawals (`cctp.ts`), the XorvLedger ABI and feed reader (`ledger.ts`), ERC-8004 helpers (`erc8004.ts`), the OpenAI-compatible model presets (`llm.ts`), private-job crypto (`sealed.ts`, `vault.ts`). `@xorv/protocol/web` is the browser-safe subset. |
| `contracts` | Foundry: `XorvEscrow`, `XorvReputation`, `XorvCcipSender`, `XorvCcipReceiver`, the deploy scripts and their tests. See [contracts/README.md](contracts/README.md). |
| `packages/contracts` | `XorvLedger.sol` and its Hardhat 3 tests against the vendored ERC-8004 registries. On Arc it is compiled and deployed from `contracts/` (the `@xorv/ledger/` remapping) by the same deploy script as the rest. |
| `packages/cli` | `xorv`: the provider node, `xorv run` (a buyer), `xorv identity`, `xorv withdraw` (CCTP V2), the adapters and the sandbox. |
| `packages/mcp` | `@xorv/mcp`: an MCP server that lets an agent buy jobs, from a local key or a Privy server wallet. |
| `packages/mm-plugin` | `@xorv/mm-plugin`: `mm xorv …` for MetaMask Agent Wallet. |
| `services/broker` | Registry, matcher, x402 resource server and self-hosted facilitator, escrow settlement, the refund keeper and CCIP watcher, Circle Gateway, XorvLedger writer, rating relay, AI roles, private-job vaults, SQLite/Mongo, metrics. |
| `services/indexer` | Envio HyperIndex over XorvLedger, XorvEscrow, XorvReputation, XorvCcipReceiver and ERC-8004. It has its own lockfile, outside the workspace. |
| `apps/app` | The job board: Privy wallet, pay, rate, private jobs, Gateway top-up, the CCTP withdraw panel, and the network and providers pages. |
| `apps/landing` | The marketing site, with a live receipts feed. |
| `scripts` | `deploy.sh` (one deploy for testnet, mainnet or a local fork), `arc-fork.sh` (a local Arc testnet fork with everything deployed), `ccip-send.mjs` (a user-run cross-chain buyer). |

---

## What Arc changes

- **USDC is the gas token.** Arc meters gas in native USDC with 18 decimals, and Circle's ERC-20
  at `0x3600000000000000000000000000000000000000` is a 6-decimal view of the same balance (EIP-712
  domain `"USDC"`/`"2"`). Every amount of money in the codebase is the 6-decimal view; the 18-decimal
  view appears only when reading a gas balance (`fetchBalances`, `formatGasUsdc` in
  `packages/protocol/src/evm.ts`). Buyers, providers and the broker hold one asset. A buyer still
  never sends a transaction: they sign EIP-3009 typed data, and the broker's facilitator pays the
  gas, in USDC.
- **Fees.** Arc's mempool refuses `maxFeePerGas` below 20 gwei, and the base fee sits at that floor.
  `scripts/deploy.sh` sends with a 60 gwei maximum and a 2 gwei priority fee. Measured on an Arc
  testnet fork, the full six-transaction deploy used about 9.2M gas, about 0.20 USDC
  ([contracts/README.md](contracts/README.md#gas-measured) has the per-call table).
- **Finality is deterministic and sub-second.** A transaction in a block is final; there are no
  reorgs to wait out and no commit states to track. Writers wait for one receipt.
- **No `eth_sendRawTransactionSync`.** Arc's public RPC answers "method not supported", so
  `packages/protocol/src/sync-send.ts` sends with `eth_sendRawTransaction` and polls for the
  receipt. The sync path stays for nodes that add the method.
- **`eth_getLogs` is capped at 10,000 blocks.** Every log reader works in windows of at most that
  (`MAX_LOG_BLOCK_RANGE`). The broker's fallback ledger scan covers 100,000 blocks by default
  (about 14 hours at ~0.5 s blocks); longer history belongs to the indexer.
- **Every write still carries `eth_estimateGas` + 15%** (`withGasHeadroom`). An unpadded estimate
  can run short when state moves between the estimate and inclusion, and the escrow's reputation
  hook makes that concrete: `release` refuses to start the outcome write unless about 416k gas is
  left, so a release that uses about 306k gas needs a limit near 480k.
- **There is no public x402 facilitator on Arc**, so the broker hosts its own by default
  (`XORV_FACILITATOR=self`). That is also what lets it fund the escrow: the facilitator's key is
  XorvEscrow's attester.
- **Arc Memo** tags each money movement with the job it belongs to (below).

Arc testnet is `eip155:5042002` (the default) and mainnet is `eip155:5042`. Both are configured in
`packages/protocol/src/chains.ts`: RPC (`rpc.testnet.arc.io`, `rpc.mainnet.arc.io`), Blockscout
explorer (`explorer.testnet.arc.io`, `explorer.arc.io`), USDC, the ERC-8004 registries, Circle's
CCTP, Gateway and Memo contracts, the CCIP router and the remote chains. Any other network string
throws at boot.

---

## Decisions worth explaining

### The broker is never the payee

The 402 names either **XorvEscrow** (scheme `escrow`) or **the matched provider's own address**
(scheme `exact`) as `payTo`. Either way the buyer signs an EIP-3009 authorization for exactly the
quoted amount to exactly that address, and the facilitator submits it. The broker's key never
holds the money. That is why `payTo` in the route config (`services/broker/src/app.ts`) is a
resolver over the quote rather than a constant.

The protocol fee is 0%. XorvEscrow can take a fee of at most 5%, set by its owner for jobs funded
afterwards and snapshotted per job; it is 0 at deploy. `XORV_FEE_BPS` on the broker is display
only. It must never become "pay the broker and trust it to forward".

### A quote is a price commitment

x402 asks the server for payment requirements **twice**: once to answer 402, and once to check the
payment that comes back. Both answers must name the same provider and the same amount. If the
matcher ran twice, a buyer could be quoted one node and pay another.

So `POST /api/quotes` freezes the provider, its checksummed payout address, its verified ERC-8004
agent id, the price, the USDC amount and, when the broker escrows, the escrow job id
(`keccak256("xorv:job:" + quoteId)`) and refund deadline (`jobs.createQuote`). Both resolvers read
from the quote. A quote is single-use and expires in 5 minutes (`QUOTE_TTL_SECONDS`). The same 300
seconds become the x402 `maxTimeoutSeconds` and so the EIP-3009 `validBefore`: client, server and
token contract all agree on one window.

The quote response also carries `accepts[]`, exactly the rows the 402 will contain: the `escrow`
row first when the broker has an escrow, then the `exact` row. Every Xorv buyer checks the 402
against the quote before signing (`buyerX402Client` with `expect`, `quoteMatchPolicy` in
`packages/protocol/src/x402-client.ts`). An `escrow` row is signed only if it pays exactly the
escrow the quote named and its `extra.provider` is the quoted provider. On EVM, whoever holds a
signed authorization can spend it, so "the broker swapped the payee" has to be caught before
signing, not after. The app, `xorv run` and the MCP server pass the quote's escrow and so pay into
it; the MetaMask plugin and stock x402 clients pay `exact`.

A quote also carries a `paying` flag. Two signed payments for one quote (a double-click, or two
tabs) cannot both settle: the second gets 409. The flag also keeps a quote resolvable if its TTL
runs out between settlement landing and the job being created.

A settlement can outlast the in-process facilitator's 30-second wait for its receipt (a slow or
rate-limited RPC). The broker then checks the transaction once more; if it is still unconfirmed,
the 402 says so (`code: "settlement_pending"`, with the transaction hash), the quote stays locked
and out of the TTL prune, a second payment for it gets 409, and the sweep keeps checking. When the
transaction lands, the job is created and dispatched under that quote; if it fails, or stays
unconfirmed for 15 minutes, the quote is released. `GET /api/quotes/:id` reports `open`,
`settling` or `paid`, with the job id once there is one.

### Payment settles before the job runs

The paid route uses x402's **upfront** payment flow (`extra: { paymentFlow: "upfront" }`, supported
by `@x402/core` 2.27). The facilitator settles the authorization *before* the handler runs, so the
handler only ever sees a payment that has already landed on Arc (an escrow funding or a direct
transfer), and only then creates and dispatches the job.

The default flow settles after the handler returns. An earlier port used it, and it was a real bug:
the job was dispatched from the handler, so a provider could start working on a payment that then
failed to settle (the buyer spent the USDC in between, or signed two quotes against one balance),
and it would never be paid. Settling first also means a five-minute authorization can never lapse
under a ten-minute job.

With `exact`, the remaining risk is a provider that takes the money and fails. With `escrow`, the
money has not reached the provider yet: it is released on delivery and refunded otherwise (below).
In both modes a failed job is first **reassigned to another provider at no extra charge**, up to
three providers in total (`MAX_PROVIDERS_PER_JOB`). A reassignment is a fresh assignment with fresh
timestamps, and it never returns to a provider that already had the job. The failure counts
against the original provider's success rate, which is the matcher's second sort key after price.
Under escrow the reassignment is also on-chain (`XorvEscrow.reassign`), so the escrow pays the
provider that finished, and the previous provider gets a failed outcome in XorvReputation.

### A settlement is matched to its job by quote id

The settle hook (`onAfterSettle`) takes the quote id from the paid URL. Under the upfront flow the
job does not exist yet, so the payment record waits in a map keyed by quote id until the handler
picks it up. The Hedera prototype matched a settlement to "the most recent unpaid job for this
payTo", which could swap the records of two buyers who paid the same provider at the same moment.

### Cancel refunds an escrowed job, and only an escrowed job

`POST /api/jobs/:id/cancel` stops the work and frees the provider's slot. On an escrowed payment
the money has not moved yet, so cancel refunds it in full (`XorvEscrow.cancel`: no fault on the
provider, no reputation entry), and the response carries the refund transaction. On an `exact`
payment it does not refund, because the money has already moved and the provider may already have
used real quota. Only the buyer who paid can cancel: the payment response carries a one-time
`cancelToken`, and the broker stores only its hash. Job ids are listed publicly on `/api/jobs`, so
knowing one proves nothing. `cancel` is attester-only on chain for a reason given in the contract:
a buyer who could cancel directly could void payment for work already delivered in the moments
before its release.

### Provider nodes dial out

The node opens a WebSocket **to** the broker, and the broker never calls in. Someone sharing a
laptop is behind NAT, on hotel wifi, on a machine that sleeps. Outbound works from all of those with
no port forwarding and no inbound attack surface. Results and events also have authenticated HTTP
fallbacks (`POST /api/jobs/:id/result`, `/events`), because the work is already paid for and a
dropped socket must not be the reason a buyer never gets an answer.

The socket is also what makes a provider sellable. Quotes and reassignments only consider providers
that hold an open control socket, and the paid route answers 409 before any payment when the quoted
provider has lost it, so the buyer is never charged for a node that can't be reached. If the socket
drops after payment, the paid dispatch counts as a failure against the quoted provider and the job
is reassigned.

### Liveness is not a database row

The registry is in memory on purpose: a provider is only real while heartbeats keep arriving (every
15 s, offline after 45 s, reaped after 10 minutes). `registry.get()` re-derives status on every call,
because status is a function of the clock and the guard that decides whether a quoted provider is
still alive enough to be paid reads it. A provider with at least three failures in the last 30
minutes, and more failures than completions in that window, is left out of matching until they age
out.

Provider ids are derived from the node's stable id (`providerIdFor` in `@xorv/protocol`: `prv_` and
a truncated SHA-256 of the node id), not minted per broker process. They are hashed into XorvLedger
events (`providerId = keccak256(id)`) and written into ERC-8004 agent URIs, so a new id per restart
would split one node into many on-chain. The node id itself never goes on-chain, because it is what
a node registers with. Re-registering a node id whose session is still live needs that session's
bearer token (409 `node_live` otherwise). The node id alone reclaims only a slot nobody holds (after
a broker restart, or once the old session went offline), and always gets a freshly minted token.

What does survive a restart goes to SQLite or MongoDB (jobs, payments, earnings, vaults) and to Arc
(escrow state, registrations, sampled heartbeats, receipts, ratings, reputation). The chain is the
part nobody has to take on trust.

---

## XorvEscrow: money that waits for the work

`contracts/src/XorvEscrow.sol` holds each job's USDC between "the buyer signed" and "the provider
delivered". The broker offers it when `XORV_ESCROW_ADDRESS` is set and the facilitator is
self-hosted, because the facilitator's key is the escrow's **attester**: the only account that may
fund a signed job, release before the deadline, refund at fault, cancel or reassign. Without an
escrow the broker pays providers directly with `exact`.

- **Funding is the payment.** The x402 `escrow` scheme (`packages/protocol/src/escrow.ts`) is EIP-3009
  `ReceiveWithAuthorization` to the escrow, redeemed by `XorvEscrow.fund`. `receiveWithAuthorization`
  requires the caller to be the payee, so only the escrow can redeem it and a leaked authorization
  can't be front-run into a plain transfer. The nonce is not random: it is
  `keccak256(abi.encode(FUNDING_NONCE_TYPEHASH, chainId, escrow, jobId, deadline))`, which the
  contract derives the same way. The buyer's one signature therefore commits to the amount, token,
  payee, job and refund deadline, and the buyer's client recomputes the nonce rather than accepting
  one from the broker.
- **Direct funding for contracts.** A contract cannot sign EIP-3009, so an owner-allowlisted funder
  (`setFunder`; today only XorvCcipReceiver) funds with `fundDirect` and becomes the buyer of record.
  It is allowlisted rather than open so nobody can front-run a broker job id and squat on it.
- **Caps.** Every job, on both funding paths, is capped at `maxJobAmount`: 100 USDC by default at
  deploy (`XORV_MAX_JOB_AMOUNT`), changeable by the owner but never to zero. A deadline must be 1
  minute to 7 days out at funding. The broker's default deadline is 30 minutes after the quote
  (`XORV_ESCROW_DEADLINE_S`, at least 120), and 2 hours for a CCIP job (`XORV_CCIP_DEADLINE_S`, at
  least 600), because CCIP and CCTP transit come first.
- **Release carries the result.** `release(jobId, resultHash)` pays the provider and puts
  `keccak256(result)` on-chain. The attester may release until the deadline; the buyer of record may
  release at any time. The XorvLedger receipt is written **after** the release, with the release as
  its `paymentTx`.
- **Three ways to refund, with different meanings.** `refund` from the attester means the provider
  failed and nobody else could take the job: it counts against the provider. `refund` from anyone
  after the deadline says nothing about fault, because an unsettled job may equally be the broker's
  fault. `cancel` (attester only) is the buyer calling it off: no fault, no reputation entry.
- **Reassignment is on-chain.** `reassign(jobId, newProvider)` re-points a funded job before the
  deadline; the deadline is unchanged, so reassignment can never extend how long a buyer waits for a
  refund. The escrow never pays an address that isn't its current provider.
- **Settlement is retried.** If a release or refund fails, the broker reads the job's state back
  from the chain, records who settled it (`settledBy`) and otherwise retries in its 15-second sweep.
- **The owner cannot move escrowed funds.** The owner can allow tokens, rotate the attester, set
  the outcome sink, set or clear the optional identity gate, allow funders, set the cap, set a fee
  of at most 5% for future jobs, pause new funding and sweep tokens above `totalEscrowed`. There is
  no admin withdrawal, `pause` never blocks a release, refund or cancel, ownership moves in two
  steps and cannot be renounced.
- **The identity gate is generic and off.** `IIdentityGate` is an optional hook the owner may set;
  when set, funding, release and reassignment require verified parties, and a refund never does.
  The deploy script does not set one.

### XorvReputation: every settlement becomes ERC-8004 reputation

`contracts/src/XorvReputation.sol` is the escrow's outcome sink. The escrow reports to it on every
release (success), every attester refund (failure) and every reassignment (failure for the previous
provider). A deadline refund and a cancel report nothing.

- **Binding.** A provider (or anyone) calls `bind(agentId)` once. It maps the agent's verified
  payout wallet (`getAgentWallet(agentId)` on Arc's Identity Registry) to the agent. Binding is
  permissionless because the Identity Registry already proves the wallet consented; only the wallet
  itself may move a still-valid binding to another agent; and `bind` refuses an agent this contract
  owns or operates, because ERC-8004 rejects feedback from an agent's owner and operators.
- **The write.** For a bound provider whose agent wallet still equals the provider, the outcome is
  written to Arc's ERC-8004 Reputation Registry as
  `giveFeedback(agentId, 100 or 0, 0, "successRate", "xorv-escrow", "", "", jobId)`. ERC-8004
  clears an agent's wallet when the NFT changes hands, so a sold agent stops collecting the
  provider's history automatically.
- **It can't hold a payment hostage.** The escrow forwards the sink a fixed 400k gas
  (`REGISTRY_GAS_LIMIT`) and catches any revert. It also refuses to start the call unless enough
  gas is left to give the sink its whole budget, so a caller can't starve the reputation write by
  choosing a tight gas limit. Inside the sink, a failed `giveFeedback` is caught and logged
  (`FeedbackFailed`); on-chain counters (`stats`, a Laplace-smoothed `score`) are kept for every
  provider, bound or not.
- **Why it matters.** Only the escrow can report, and it reports only from a settlement that moved
  real USDC, so feedback with `clientAddress == XorvReputation` is paid-and-delivered reputation that
  cannot be inflated without paying for each job. Read it with
  `getSummary(agentId, [XorvReputation], "successRate", "xorv-escrow")`. The router's
  `escrow_outcomes` tool and `GET /api/providers/:id/escrow` read the counters and the binding.

So ERC-8004 carries three Xorv signals, each from a different client address and tag:
`successRate` from XorvReputation (escrow outcomes), `starred` from XorvLedger (buyer ratings) and
`xorv-verified` from the verifier EOA (Kimi scores).

### Arc Memo: every money movement names its job

Arc predeploys a Memo contract (`0x5294E9927c3306DcBaDb03fe70b92e01cCede505` on both networks).
`memo(target, data, memoId, memoData)` runs `data` against `target` through Arc's CallFrom
precompile, so the target still sees the original EOA as `msg.sender`, and then emits
`Memo(sender, target, callDataHash, memoId, memo, memoIndex)`.

Xorv routes its own money movements through it (`packages/protocol/src/memo.ts`, `x402.ts`):

- every escrow write the broker sends (`fund`, `release`, `refund`, `cancel`, `reassign`) and the
  keeper's `refund`, `claimRefund` and `markReleased`, with `memoId` = the escrow job id and text
  `xorv:<function>` (for example `xorv:release`);
- every x402 `transferWithAuthorization` of a direct `exact` payment, with `memoId` = the escrow job
  id derived from the quote and text `xorv:pay:<quote id>`.

Because the escrow sees the facilitator's EOA as `msg.sender`, attester checks are unchanged.
Anyone reconciling Arc's USDC flows can look a transfer up by job without Xorv's database, by
filtering `Memo` events on `memoId`. Memo text is cut at 96 characters. Memo must be called by an EOA
directly, which Xorv's settlement keys are. Calls made by contracts (the CCIP receiver's
`fundDirect` and its release on a RELEASE message), Gateway mints, CCTP burns, ledger writes and
ERC-8004 feedback are not tagged. `XORV_MEMO=off` turns tagging off for a dev chain without the
predeploy.

### The refund keeper

On Monad, a Chainlink CRE workflow refunded expired escrows. CRE is not available on Arc mainnet,
so the broker runs the keeper itself (`services/broker/src/keeper.ts`), on its 15-second sweep,
with nothing but RPC reads and permissionless calls:

1. **Refunds past the deadline.** It follows every `JobFunded` the escrow emits, not only the jobs
   this broker remembers, so a job orphaned by a crash or a lost database is still refunded. For
   each one past its deadline that is still funded, it calls `refund(jobId)`. The money can only go
   to the buyer.
2. **It refunds from a key that is not the attester.** An attester refund means "the provider
   failed" and writes a 0 to the provider's reputation; a deadline refund must not. If the keeper's
   key is the attester's, the keeper logs why and leaves deadline refunds to anyone else.
3. **Cross-chain funding.** A `JobFunded` whose buyer is XorvCcipReceiver is handed to the broker,
   which opens the matching CCIP quote's job (below).
4. **Cross-chain book-keeping.** After a cross-chain job settles, it calls the receiver's
   `claimRefund` (forwards a refund to the requester) or `markReleased` (closes the receiver's books
   after a release). Both are permissionless.

The keeper key is `XORV_KEEPER_KEY`, else the operator key; `XORV_KEEPER=off` turns it off. The
first scan reaches back to `XORV_LEDGER_FROM_BLOCK`, or about 70,000 blocks (roughly 10 hours) when
that is unset, in windows inside Arc's 10,000-block `eth_getLogs` cap. The escrow's `isRefundable`
view lets anyone else run the same check.

### Circle Gateway: fund once, spend on Arc

A buyer may hold a unified USDC balance in Circle's GatewayWallet on any chain Gateway supports
(Base, Ethereum, Arbitrum, Avalanche, OP, Polygon and Arc itself; the testnet equivalents on
testnet). When their Arc wallet is short, the app tops it up without a chain switch or gas:

1. `GET /api/gateway?depositor=0x…` reads the balance per source chain from Circle's Gateway API.
2. `POST /api/gateway/intent` builds an EIP-712 `BurnIntent` ("burn `value` of my Gateway balance
   on domain N and mint it on Arc to me"), with a fresh salt and a `maxFee` from Circle's fee table.
   The buyer signs it.
3. `POST /api/gateway/mint` checks the intent field by field (destination Arc, Circle's
   GatewayMinter, Arc's USDC, signer = depositor, no destination caller, no hook, a fee no higher
   than Xorv's), recovers the signer locally so a bad signature never reaches Circle or costs gas,
   posts it to Circle's `/v1/transfer` for an attestation, and calls `GatewayMinter.gatewayMint`
   on Arc from the operator key, paying the gas in USDC.

The broker cannot redirect the money: the recipient is in the intent the buyer signed, Circle's
operator signs the attestation, and `gatewayMint` mints only to the recipient it names. A transfer
is capped at 1,000 USDC. A retry of the same signed intent returns the first mint instead of asking
Circle twice. The routes share a 20-per-minute rate limit. Pure intent logic is in
`packages/protocol/src/gateway.ts`; the HTTP calls and the mint are in
`services/broker/src/arc.ts`. Without an operator key, minting answers 503.

### CCTP V2 withdrawals: take earnings home

A provider is paid in USDC on Arc. `xorv withdraw` (`packages/cli/src/commands/withdraw.ts`) and the
app's withdraw panel move it to Base or Ethereum (or their testnets) with Circle CCTP V2: approve
`TokenMessengerV2` when the allowance is short, `depositForBurn` on Arc, poll Circle's Iris API until
the message is attested, then `MessageTransmitterV2.receiveMessage` on the destination, which mints
native USDC to the recipient. Fast transfers (`minFinalityThreshold` 1000) attest in seconds for a
fee capped by `maxFee`; standard (2000) is free and waits longer. Arc's own finality is sub-second,
so the wait is Circle's attestation. The destination mint costs that chain's gas, so the CLI sends
it only with a destination key (`--mint-key-env`, default `XORV_DEST_KEY`) and otherwise prints the
exact command that finishes it; `--resume <burnTx>` picks a withdrawal back up. Because Arc's gas
is the same USDC being withdrawn, the default amount keeps a small reserve for the approve and the
burn. Pure helpers are in `packages/protocol/src/cctp.ts`.

### Chainlink CCIP jobs: CCTP moves the dollars, CCIP carries the instruction

A buyer agent on Base or Ethereum (Base Sepolia or Ethereum Sepolia on testnet) can post and settle
a job without holding anything on Arc. USDC is not a CCIP token on Arc, so the two halves travel
separately:

1. **Quote.** `POST /api/quotes` with `payVia: "ccip"` returns the usual quote plus a `ccip` block:
   the receiver, Arc's chain selector, the escrow job id, provider, price and deadline, the source
   chains with their selectors, USDC and CCTP domains, and the known sender contracts
   (`XORV_CCIP_SENDERS`). The quote is held for the cross-chain payment (nobody can pay it over x402
   meanwhile) and lives until its escrow deadline. A broker without a receiver answers 400.
2. **Send.** `XorvCcipSender.postJob` on the source chain burns `price + maxFee` USDC with CCTP V2
   `depositForBurn`, minted on Arc (CCTP domain 26) to XorvCcipReceiver, and sends a POST_JOB message
   (`jobId, requester, provider, price, deadline`) over CCIP in the same transaction. CCIP fees are
   paid in the source chain's native coin, and any excess is refunded. The sender is ownerless and
   every destination parameter is immutable. `scripts/ccip-send.mjs` is a user-run buyer for this
   step: testnet only, and it sends nothing without `--yes`.
3. **Fund.** XorvCcipReceiver records the intent and funds the escrow with `fundDirect` once both
   the message and the dollars have arrived, in either order. If the message arrives first, the
   intent waits as Pending, and anyone may call `executePending` once the CCTP mint lands.
4. **Run.** The keeper sees the `JobFunded` whose buyer is the receiver and hands it to the broker,
   which opens the job only if it matches an open CCIP quote (same escrow job id, the quoted
   provider, at least the quoted amount). From there it runs and settles like any escrowed job:
   the attester releases on delivery, and the keeper closes the receiver's books.
5. **Settle from the source chain.** `XorvCcipSender.settle` sends a RELEASE message. The receiver
   honours it only from the same source chain and sender contract the job was posted through, and
   only for the same requester; it then calls `escrow.release` as the buyer of record, which the
   escrow allows at any time.
6. **Refund.** A refunded cross-chain job's USDC lands on the receiver, its buyer of record.
   `claimRefund` (permissionless, once per job) forwards it to the requester's address on Arc. An
   EOA has the same address on every EVM chain; a smart-account requester must exist on Arc too.

The receiver (`contracts/src/ccip/XorvCcipReceiver.sol`) is built defensively:

- **Allowlist.** `ccipReceive` is router-only and rejects any (source chain selector, sender)
  pair not on the owner's allowlist.
- **Failed messages are stored, not bounced.** The message runs in `try this.processMessage`; if it
  reverts, it is stored as Failed (`MessageFailed`) instead of failing the CCIP execution. Anyone
  may `retryFailedMessage`. The owner may mark a message resolved only if it still cannot be
  processed: it is run once more first, and if that succeeds the owner's call reverts, so the owner
  can never discard a message that would have funded, released or credited someone.
- **Every unit has an owner.** `pendingTotal` is the prices of Pending intents; `fundedTotal` is
  the prices of jobs funded and not yet closed out; `owedTotal` is credits for instructions that
  could not become a job (a duplicate job id, an invalid provider or price), payable with
  `withdrawOwed` to the requester. Intents are funded only from `balance - owedTotal`. Because CCTP
  and CCIP are independent, one intent's dollars may briefly fund another whose mint is still in
  flight; every POST_JOB is sent in the same transaction as its burn and completing a CCTP mint is
  permissionless, so in aggregate the balance catches up, and a `claimRefund` or `cancelPending` that
  finds it short reverts until it does.
- **The owner's sweep reaches only dust.** `sweep` can take at most
  `balance - (pendingTotal + fundedTotal + owedTotal)`: CCTP max-fee remainders or tokens sent by
  mistake. The owner's other powers are the sender allowlist and resolving unprocessable messages.
  Ownership moves in two steps and cannot be renounced.
- **A Pending intent can always be unwound.** `cancelPending` returns its dollars to the requester:
  the requester may call it at any time, anyone may once the deadline is too close to fund.

---

## XorvLedger: the public record

`packages/contracts/contracts/XorvLedger.sol` replaces the prototype's three HCS topics. Its
interface is fixed, because the protocol ABI and the indexer depend on it
(`packages/contracts/abi/XorvLedger.json`, pinned by `test/abi.test.ts`). On Arc it is deployed by
`scripts/deploy.sh` with the deployer as owner and `XORV_BROKER_ADDRESS` as its broker.

Its gas-shaped design carried over from Monad, where gas was billed on the limit. On Arc the
reasons are smaller but still hold:

- **Receipts are batched.** The broker queues receipts and sends one `recordJobs` call after
  `XORV_RECEIPT_BATCH_MS` (4 s) or as soon as `XORV_RECEIPT_BATCH_MAX` (20) are waiting, so the fixed
  cost of a transaction (intrinsic gas, cold account access, a signature, a round trip, a nonce) is
  paid once. Within a batch, the contract checks each (agent, payTo) pair against the Identity
  Registry only once.
- **One storage slot per job.** A job stores exactly what `rateJob` has to check, packed into one
  slot (`buyer`, `agentId`, `rated`), and everything else is in the `JobRecorded` event.
  Registrations and heartbeats store nothing and only emit events.
- **Heartbeats are sampled.** One beat in twenty is published (`XORV_HEARTBEAT_PUBLISH_EVERY`).
  Publishing every beat would be thousands of transactions a day per node: noise rather than
  evidence.

**`recordJobs` is all-or-nothing, so a bad receipt must not sink good ones.** On a revert, the
broker splits the batch in half and retries each half, down to single receipts
(`services/broker/src/chain.ts`, `sendBatch`). Other failures, such as a dead RPC or no gas money,
fail the batch as a whole, because splitting would only repeat the same error. If a single receipt
reverts with `PayToNotAgentWallet` (the agent NFT moved or its wallet was re-pointed after the
quote), it is recorded once more under `NO_AGENT`. A single receipt that reverts with
`DuplicateJob` is checked against `jobs(jobId)`: when the recorded buyer matches, it already landed
and counts as recorded. A batch that was broadcast but not confirmed is looked up before any of its
receipts is sent again.

`recordJobs` also refuses (`SelfDealing`) a receipt whose buyer is its `payTo`. A provider paying
itself buys nothing, so the broker refuses that payment before it settles (403 `self_payment`) and
the ledger refuses the receipt whoever writes it.

**A receipt is written only when there is something to attest to**: the job is terminal, its
payment is recorded, and, for an escrowed job, its money has gone somewhere (released or refunded).
Receipts are queued from a job-store subscription, so every path that finishes a job triggers one.
A failed write is retried by the sweep up to three times, and a buyer asking to rate earns the
receipt one more attempt. Each receipt binds the payment transaction (the release, for an escrowed
job) to `requestHash = keccak256(prompt)`, `resultHash = keccak256(result)`, the duration, the
outcome, the buyer, the payee and the agent. The payload stays off-chain, and the record stays
checkable.

**Audit writes never block the request path.** Registration waits at most 2.5 s for its ledger write
and then answers without it. An unchanged re-registration writes nothing. A failed write lands in
`lastPublishError` on `/api/network`. The one exception is the rating relay: the buyer is waiting to
hear whether it landed, so it reports failure.

### ERC-8004 identity binding: `payTo == agentWallet`

A provider may claim an ERC-8004 agent id when it registers (`xorv identity register` creates one
from the payout key: `register(agentURI)` makes the caller both owner and agent wallet in one
transaction). The claim is worth recording only if the agent's wallet **is** the payout address.
The broker checks `getAgentWallet(agentId)` with a 4-second timeout. If the lookup fails or the
wallet differs, the node registers without an identity and is told why; it still earns.
`XorvLedger` enforces the same rule on-chain for every receipt and registration
(`PayToNotAgentWallet`), and XorvReputation applies it before every outcome write.

A reassigned job's receipt is recorded **without an agent**: the ledger requires the agent's wallet
to be the address that was paid, and crediting either identity with the outcome would misattribute
it.

The broker serves the agent's registration file at `GET /agents/<providerId>.json` (`x402Support:
true`, `supportedTrust: ["reputation"]`, the jobs endpoint and the web app). `xorv identity register`
builds that URI locally from the provider id, so the node id never reaches the Identity Registry.
The URI stays stable, so it never needs a follow-up `setAgentURI` write.

### Ratings: EIP-712, gasless, one per job

```
GET  /api/jobs/:id/rating?value=87 → EIP-712 typed data + the feedback file's hash
     (409 instead when the job was paid by its own provider, has no agent to rate, or the
      agent made the ledger its operator: code ledger_authorized)
buyer signs it (Privy embedded wallet, MetaMask, a CLI or MCP key); no gas
POST /api/jobs/:id/rate {value, deadline, signature}
     → broker verifies the signer is the job's payer (ECDSA, then ERC-1271/6492 over RPC)
     → waits up to 15 s for the job's receipt to land (the ledger rates only recorded jobs),
       then re-checks the job against the landed receipt and re-reads the agent's operators
     → XorvLedger.rateJob(rating, sig) → ReputationRegistry.giveFeedback(agentId, value, 0, "starred", …)
```

- **The domain is `{name: "XorvLedger", version: "1", chainId, verifyingContract: ledger}`.** The
  signature check happens in the broker *and* in the contract, in the same order: ECDSA against the
  buyer first, then ERC-1271. The broker checks first so it never spends gas relaying a rating the
  contract would refuse.
- **One rating per job** is enforced on-chain (`AlreadyRated`). An in-flight set in the broker stops
  a double-submit from burning a second transaction.
- **Buyers never sign what they are handed verbatim.** The app, the MCP server and the MetaMask
  plugin each rebuild the typed data locally with `ratingTypedData` and compare the job, the value,
  the deadline and the ledger before signing.
- **The feedback file is reproducible.** Its keccak256 is inside the signed message and ends up
  on-chain, and it is served later from `/feedback/<jobId>.json`, built only from facts frozen once
  the job is terminal plus the value and deadline that travel with the signature.
- **Every rating reaches ERC-8004 with `clientAddress == XorvLedger`.** Filtering a summary by that
  client gives a provider score made only of paid jobs, each rated by the wallet that paid.
- **The payer must not be the provider.** `rateJob` reverts `SelfDealing` when the buyer is the
  agent's current wallet, owner or an approved operator (read from the Identity Registry at rating
  time), on the direct and the relayed path alike. A contract cannot see that two wallets belong to
  one party, so a second, unlinked wallet can still rate; each such rating costs the price of a job.

The ledger must never own or operate a provider's agent NFT, and neither may the verifier EOA or
XorvReputation: ERC-8004 rejects feedback from an agent's owner and operators. The broker reads
`isAuthorizedOrOwner` before it offers or relays a rating (409 `ledger_authorized`) and before it
writes verifier feedback (which then stays off-chain, with the reason in
`verification.feedbackError`). A failed lookup never blocks: the chain still has the last word.

---

## AI roles, and how each one fails

Three sponsor models sit in the core loop (`services/broker/src/ai/`,
[services/broker/README.md](services/broker/README.md)). They share one client (`ai/client.ts`) with
a hard per-role deadline raced against the request, strict validation of the JSON the model
returns, per-role counters, and key hygiene: a key goes only to its preset's base URL and is
scrubbed from any error text.

| Role | Runs | Deadline | When it fails |
|---|---|---|---|
| **Screener**, Hunyuan hy4 | every quote, before any provider sees the prompt | 8 s (`XORV_SCREENER_TIMEOUT_MS`; `XORV_SCREENER_REASONING` sets TokenHub's reasoning effort, default low) | `XORV_SCREENER_FAIL=open` (default): quote anyway, recorded as "not screened: …". `closed`: 503 until the screen is back. A **block** is a 422 and no quote exists. |
| **Router**, Qwen 3.8 Max | quotes with no adapter (or "auto") when more than one live option fits under the ceiling | 15 s for the whole tool loop (`XORV_ROUTER_TIMEOUT_MS`), 3 s per tool | Timeout, HTTP error, turn/read cap without a pick, or a pick that is not a live candidate under the ceiling (after one retry) → the deterministic matcher, recorded as `routing.fallback` with a templated reason. |
| **Verifier**, Kimi K3 | every completed, non-private job | 20 s | Never blocks: it runs after the buyer has the result. No score means no feedback. A failed `giveFeedback` is stored as `verification.feedbackError`. |

Why they are shaped this way:

- **What was screened is what runs.** The quote freezes the screened request, and the paid route
  runs only the quoted request, so a prompt cannot be swapped after screening.
- **The router is an agent that reads Arc, and its pick is checked.** Qwen 3.8 Max runs at most 4
  turns and 6 reads (`services/broker/src/ai/router.ts`): `list_candidates`, `erc8004_reputation`
  (ERC-8004 `getSummary` for the XorvLedger client and the verifier client, plus the Identity
  Registry's agent wallet), `recent_receipts` (XorvLedger events, indexer first),
  `indexer_provider_stats` (Envio aggregates) and `escrow_outcomes` (XorvReputation's counters,
  score and binding), then `select_provider`. Tool results are small JSON built by the broker
  (`router-tools.ts`, `router-data.ts`), each with its own timeout and cache. The pick must be a live
  candidate under the buyer's ceiling, so the model can choose among eligible providers but never
  outside them or above the price.
- **The trace is the broker's words, not the model's.** `routing.steps` records each call with
  validated ids, a templated summary and explorer links. A made-up id is recorded as "(not a
  candidate)". For a private job the model's reason is withheld, while the steps (public provider
  data) stay.
- **Envio ranks providers even without the router.** When no router runs, the matcher breaks price
  ties on reputation from the indexer (buyer ratings and Kimi scores, shrunk toward a neutral 50
  worth three ratings), refreshed in the background at most once a minute
  (`services/broker/src/ai/reputation-book.ts`), and from the broker's own jobs without an indexer.
- **The verifier's score is a separate signal.** It is written from the verifier EOA under tag
  `xorv-verified`, never mixed with buyer `starred` ratings or escrow `successRate` outcomes. The
  feedback file at `/verifications/<jobId>.json` hashes to the committed `feedbackHash`, and its
  hash is stored on the job before the transaction is sent. Private jobs are skipped, because the
  broker holds only ciphertext.
- **A missing key turns a role off, never the broker.** `GET /api/network` reports each role's
  state (`ai`, `aiRoles`) and why a role is off.

## Private jobs

A private job's answer is sealed on the provider's machine to an X25519 key derived from the buyer's
passkey (through Mera's PRF evaluation), stored by the broker as an envelope it cannot open, and
committed on-chain as the envelope's hash. The design, the three key namespaces, the vault and the
threat model are in [docs/PRIVATE_JOBS.md](docs/PRIVATE_JOBS.md). None of it depends on the chain.
Architecturally, it changes four things:

- `encryptTo` is validated at quote time, before anyone is reserved or paid.
- A plaintext result for a private job is discarded unstored and the job fails over, the same way as
  any other provider failure.
- Public views redact the prompt and title, and the event stream carries only status lines. The
  router's and screener's free-text reasons (which paraphrase the prompt) read "withheld for a
  private job"; the buyer's own quote response still carries them.
- The verifier is skipped.

---

## Reading the record back: indexer first, RPC second

Answering "the last 50 receipts" or "the best provider" by walking logs is slow and burns the RPC's
rate limit, and Arc's public RPC caps `eth_getLogs` at 10,000 blocks. So reads have two sources
(`services/broker/src/ledger-reader.ts`):

1. **The Envio indexer** (`XORV_INDEXER_URL`), which has the whole history and the derived
   aggregates and answers in one GraphQL request. It serves receipts, ratings, registrations and the
   leaderboard.
2. **A bounded backward RPC scan** (`readLedgerEvents` in `packages/protocol/src/ledger.ts`). It
   works in windows of at most 10,000 blocks from the latest block, 100,000 blocks by default, and
   never before `XORV_LEDGER_FROM_BLOCK`. It needs nothing but the contract address. Heartbeats
   are always read this way.

The indexer is an accelerator, never a dependency. If it is unset, slow or erroring, the broker
falls back and says so in the response (`source: "indexer" | "rpc" | "memory"`, plus
`indexerError`). Results are cached for 5 seconds, because the landing page and the network page
poll.

The indexer reads Arc through Envio HyperSync (`arc-testnet.hypersync.xyz`, `arc.hypersync.xyz`),
so it never touches the log cap. Besides the ledger's entities, it indexes the escrow, XorvReputation
and the CCIP receiver (`EscrowJob`, `EscrowOutcome`, `AgentBinding`, `ReputationContract`,
`CrossChainIntent`). It classifies each ERC-8004 feedback entry once, by the client that wrote it:
`BUYER_RATING` from the ledger, `XORV_VERIFIED` from the ledger's active broker or listed verifier
addresses, `ESCROW_OUTCOME` for `successRate` feedback from XorvReputation, and `OTHER` for
everything else. Anyone can call `giveFeedback`, so the writer decides what an entry is worth. See
[services/indexer/README.md](services/indexer/README.md).

## Keys and nonces: one queue per signer

The broker can have up to four EOAs, and by default they collapse onto the operator key:

| Key | Variable | Signs |
|---|---|---|
| Facilitator = escrow attester | `XORV_FACILITATOR_KEY`, else the operator | x402 settlements, escrow `fund`/`release`/`refund`/`cancel`/`reassign` |
| Operator | `XORV_OPERATOR_KEY` | XorvLedger writes, rating relays, `gatewayMint` |
| Verifier | `XORV_VERIFIER_KEY`, else the operator | Kimi's ERC-8004 feedback |
| Keeper | `XORV_KEEPER_KEY`, else the operator | deadline refunds, `claimRefund`, `markReleased` |

`scripts/deploy.sh` makes one address, `XORV_BROKER_ADDRESS`, both the escrow's attester and the
ledger's broker, so the facilitator and operator keys are the same key unless the owner later
rotates one (`XorvEscrow.setAttester`, `XorvLedger.setBroker`). The keeper must then have its own
`XORV_KEEPER_KEY`: with the defaults it would be the attester, and the keeper refuses to refund
from the attester's key.

Several of these can fire in the same millisecond, which is how two transactions end up racing for
one nonce. Every broadcast therefore goes through `withSignerLock` (`packages/protocol/src/evm.ts`), a
per-address queue shared across the process, and every account carries viem's `nonceManager`. A
settlement and a receipt batch from the same key get consecutive nonces instead of one failing.
Every key pays its gas in USDC; `pnpm broker:setup` and `pnpm usdc` report the balances, read-only.

## Addresses and ids

- Addresses are normalized with viem's `getAddress` at every boundary (registration, settle hook,
  receipts, the agent-wallet check) and compared case-insensitively (`sameAddress`). The indexer
  stores lowercase.
- On-chain ids are hashes of the broker's ids. The ledger uses `jobId = keccak256(utf8(brokerJobId))`
  and `providerId = keccak256(utf8(brokerProviderId))`; the escrow, Memo and the CCIP receiver use
  the escrow job id `keccak256(utf8("xorv:job:" + quoteId))`, which exists before the broker's job
  does. The broker keeps a map back, so ledger feeds link to job pages.
- `capabilities` on-chain is the compact string `"claude-code:10000,qwen:5000"` (adapter:price in
  micro-USD). The indexer parses it into `ProviderCapability` rows.

---

## Data flow, precisely

**Registration.** Node → `POST /api/providers/register {address, agentId?, capabilities}` (plus
the bearer token it holds, when it has one) → the address is checksummed, every price must be a
whole number of micro-USD, and a claimed agent is verified → registry keyed on the stable node id
(a live session is only taken over with its token: 409 `node_live` otherwise) → a bearer token comes
back → `registerProvider` on XorvLedger in the background. The node opens
`wss://…/ws/provider?token=…`. Every frame the node sends is validated before it is handled (8 MiB
cap). Binding the agent in XorvReputation (`bind(agentId)`) is a separate, permissionless call.

**Heartbeat.** Every 15 s, `POST /api/providers/:id/heartbeat` with the node's bearer token, carrying
load and per-capability availability. One in twenty is published as `ProviderHeartbeat`.

**Quote.** Screen → candidates (live providers holding a control socket × capabilities, filtered on
adapter, price ceiling, per-capability availability and free concurrency, minus providers failing
more than they complete; sorted by price, then success rate nudged by reputation, then load) →
route when the buyer left the adapter open → freeze, with the escrow job id and deadline when the
broker escrows. Expired quotes are pruned by the sweep, and at 10,000 open quotes the broker
answers 503.

**Payment.** `@x402/hono` middleware on `POST /api/jobs/:quoteId`, behind a guard that turns an
expired quote into a clean 404, a paid, settling or offline one (or one whose provider has no
control socket) into a 409, and a payment from the quoted provider's own `payTo` into a 403
`self_payment`, all before anything settles. An `onBeforeSettle` hook refuses self-payment again as
a backstop. Settlement runs inside `withSettlementMemo`, so the write carries the job's Memo tag.
The facilitator is in-process (`XORV_FACILITATOR=self`, the default, a viem EOA) or any facilitator
URL; a URL turns escrow off, because only the in-process facilitator holds the attester key.
`self` without a key is never silently downgraded: the paid route answers 503 with the fix.

**Dispatch.** `job.dispatch` down the socket. The node runs the adapter in a fresh directory under
the Xorv home, inside the sandbox, streams `job.event` and returns `job.result`, sealed first if the
job is private.

**Completion.** With escrow: the escrow is pointed at the provider that finished (if a reassignment
happened), then released with the result's hash; a job that failed everywhere is refunded by the
attester. With `exact`: the success counts for the provider that did the work, and the earnings are
credited to the provider that was paid (the quoted one), because that is where the USDC went. Then
the verifier runs and the receipt is queued.

---

## Testing

The root `pnpm test` runs every workspace suite. None of them needs a key, an RPC or testnet funds;
the one exception is `packages/protocol/test/escrow.anvil.test.ts`, which runs only when an `anvil`
binary is available.

| Suite | What it leans on |
|---|---|
| `packages/protocol` | viem over a fake JSON-RPC, a real x402 facilitator over a stub transport, the escrow scheme, Memo wrapping, Gateway intents, CCTP plans, known-answer crypto vectors |
| `packages/contracts` | Hardhat's in-process chain (EDR), the vendored ERC-8004 registries, `node:test` |
| `packages/cli` | fake agent binaries, a fake RPC, scripted model endpoints |
| `packages/mcp` | the real server over stdio, a mock broker that verifies signatures, a fake Privy client |
| `packages/mm-plugin` | the real `PluginCommand` base, a fake executor that signs the way MetaMask's JSON-RPC signer does |
| `services/broker` | the real Hono app, x402 resource server and WebSocket hub, with the chain, the escrow (an in-memory copy of the contract's state machine), the keeper and Circle's API stubbed |
| `apps/app` | real Mera against a fake synced authenticator, a mocked broker `fetch` |
| `apps/landing` | hand-built broker payloads, including malformed ones |

Outside the workspace: Foundry (`contracts/`: unit, invariant and Chainlink Local suites, plus opt-in
fork suites against Arc testnet; see [contracts/README.md](contracts/README.md#tests)) and the Envio
indexer (`services/indexer/test`).

What makes that possible:

- **The chain is behind interfaces.** The broker takes a `ChainLike`, an injectable
  `FacilitatorClient`, an `EscrowOps` and a keeper, so the integration suite
  (`services/broker/test/integration.test.ts`) boots a real HTTP server, the real Hono app, the real
  x402 resource server and the real WebSocket hub. A real viem account signs a real EIP-3009
  authorization, and only the broadcasts are stubbed. It covers upfront settlement,
  settlement-to-job matching for simultaneous buyers, replay refusal, reassignment and timeouts,
  cancel tokens, SSE, receipts and their retries, ratings, the escrow lifecycle, CCIP quotes and
  cross-chain jobs, the `arc` block on `/api/network`, the no-key boot and the AI roles.
  `test/private-jobs.test.ts` does the same for private jobs and `test/gateway.test.ts` for Gateway.
- **Contracts run against real code.** `packages/contracts` deploys the vendored ERC-8004 v2.0.0
  registries behind ERC1967 proxies the way upstream's own tests do. The Foundry suites use
  Chainlink Local for CCIP, and the fork suites run against Arc testnet's real USDC, ERC-8004
  registries, CCIP router and CCTP `TokenMessengerV2`.
- **Viem runs over stub transports.** Protocol and CLI tests drive viem through a fake JSON-RPC
  (`test/support/fake-rpc.ts`), so the gas headroom, the signer lock and the calldata are asserted
  on real encodings.
- **Sponsor models are scripted `fetch`es**, including one that ignores its abort signal, to prove
  the deadline holds.

**End to end, on a fork of Arc testnet.** Two harnesses ([e2e/README.md](e2e/README.md)) remove the
stubs at the chain boundary. Both fork Arc testnet with Arc Foundry's anvil, so Circle's real USDC
(also the gas token), Arc's Memo, the canonical ERC-8004 registries, CCTP and the CCIP router are
the contracts in play, deploy with the real `scripts/deploy.sh`, and run the built broker and a real
provider node.

- `pnpm e2e:arc` checks the Arc stack: x402 into the escrow with Memo tags, the release's ERC-8004
  outcome through XorvReputation, the ledger receipt and a gasless rating, a cancel, a CCIP job (the
  CCTP mint simulated by a USDC transfer, the CCIP delivery made by impersonating the real router),
  the refund keeper, a CCTP burn and Circle's live testnet Gateway API. Report:
  [e2e/last-run-arc.md](e2e/last-run-arc.md).
- `pnpm e2e` pays providers directly (`exact`) and exercises the CLI, the MCP server, a private job
  and the three AI roles against a local stand-in for the model APIs.

What the tests do not prove: that Arc's public RPC under load, Privy, MetaMask, Circle's attestation
services, a live CCIP lane or the three model APIs behave on the day as their documentation and our
stubs say. The testnet run (docs/E2E-TESTNET.md) covers the Arc half of that against the public RPC; Gateway, CCTP and CCIP on a live lane, and real model APIs, remain unrun.
