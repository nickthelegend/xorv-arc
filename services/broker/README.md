# @xorv/broker — AI roles, escrow, refund keeper, Gateway and CCIP on Arc

The broker matches jobs to provider nodes, takes x402 payments in USDC on Arc through its own
facilitator, settles XorvEscrow, runs the refund keeper, mints Circle Gateway top-ups, opens jobs
funded from other chains over Chainlink CCIP, and writes the XorvLedger audit trail. Three sponsor
models take a turn on every job. This page covers those parts; the design behind them is in
[ARCHITECTURE.md](../../ARCHITECTURE.md) and the trust boundaries in [SECURITY.md](../../SECURITY.md).

```
POST /api/quotes ─► Hunyuan screens the prompt ─► Qwen reads Arc and picks a provider ("Auto") ─► frozen quote
                                                  └► no router / fallback: matcher (price, then reputation)
POST /api/jobs/:quoteId (x402) ─► facilitator = escrow attester ─► Memo ─► XorvEscrow.fund ─► job dispatched
job completed ─► Memo ─► XorvEscrow.release ─► XorvReputation ─► ERC-8004 "successRate"
              ─► Kimi scores the result ─► ERC-8004 giveFeedback("xorv-verified") from the verifier EOA
every 15 s    ─► RefundKeeper: JobFunded logs ─► refund past the deadline · open CCIP-funded jobs · claimRefund
```

## AI roles

| Role | Model | Runs | What it decides | Where you see it |
|---|---|---|---|---|
| Screener | Tencent Hunyuan `hy4-preview` (TokenHub) | every quote, before a provider can see the prompt | `allow` / `block` + category + reason. A block is **HTTP 422** and no quote is issued | quote `screening`, job page "Screened by", `/api/network` |
| Router | Alibaba Qwen 3.8 Max `qwen3.8-max` (Model Studio, thinking on, tool calling) | quotes with no adapter or `"auto"`, when at least two live options fit under the ceiling | which **provider** (and adapter) runs the job, after reading its ERC-8004 reputation, XorvLedger receipts, Envio stats and escrow outcomes; why; how hard | quote `routing` with the agent trace (`steps`), the quote card and job page ("How Qwen 3.8 Max chose"), composer's **Auto** option |
| Verifier | Moonshot Kimi K3 `kimi-k3` (`reasoning_effort: "low"`) | every completed job that isn't private | score 0–100, pass, rationale, flags | job `verification`, the provider's ERC-8004 reputation, `/verifications/<jobId>.json` |

### How each role is kept honest

- **Screener** (`src/ai/screener.ts`) protects provider machines: credential or key
  exfiltration, malware, destructive commands, sandbox escape, prompt injection
  against the node. The quote freezes the screened request and the paid route only
  runs the quoted request, so a prompt can't be swapped after screening. If Hunyuan
  can't answer, `XORV_SCREENER_FAIL=open` (default) quotes anyway and the record
  says *"not screened: … allowed because XORV_SCREENER_FAIL=open"*; `closed`
  refuses to quote (503) until the screen is back.
- **Router** (`src/ai/router.ts`) is a bounded, tool-using agent. It reads the
  prompt, then calls tools (`src/ai/router-tools.ts`, real sources wired in
  `src/ai/router-data.ts`) before it answers:

  | Tool | Reads |
  |---|---|
  | `list_candidates` | the live, matchable providers under the buyer's ceiling, in matcher order: providerId, label, adapter, model, price, agentId, liveness, success rate, mean buyer rating and Kimi score |
  | `erc8004_reputation(agentId)` | the ERC-8004 Reputation Registry's `getSummary` for the XorvLedger client (buyer ratings, tag `starred`) and the verifier client (`xorv-verified`), plus the Identity Registry's `getAgentWallet` against the payout address, over Arc RPC |
  | `recent_receipts(providerId)` | the provider's XorvLedger `JobRecorded` / `JobRated` events through the ledger reader (Envio first, bounded RPC scan otherwise) |
  | `indexer_provider_stats(providerId)` | the Envio `Provider` and `Agent` rows (jobs, success rate, avg rating, verified score, USDC earned); says so when `XORV_INDEXER_URL` is unset |
  | `escrow_outcomes(providerId)` | the provider's record in XorvReputation: escrows released vs refunded at fault, USDC earned, the smoothed score, and the ERC-8004 agent those outcomes are written to; says so when `XORV_REPUTATION_ADDRESS` is unset |
  | `select_provider({providerId, adapter?, reason, difficulty?})` | the answer |

  Bounds: at most 4 model turns and 6 lookups inside one 15 s budget; each tool
  has a 3 s timeout and a 30 s cache; the last turn offers only
  `select_provider`. Each turn is one non-streaming call with
  `enable_thinking: true` and `thinking_budget: 256` (Model Studio documents
  non-streaming output with thinking on for the commercial `qwen3.8-max`), and
  `tool_choice` stays `"auto"` because Qwen refuses `"required"` in thinking mode.
  The pick must be a live candidate under the ceiling (providerId, and adapter
  when given); a made-up one gets one retry. Timeout, provider error, no pick, or
  a pick that stays invalid → the deterministic matcher, recorded as
  `routing.fallback` with a templated reason ("… matched on price instead").

  The record keeps `by`, `model`, `adapter`, `reason` and `difficulty` and adds
  `providerId`, `providerLabel`, `agentId`, `turns`, `toolCalls`, `thinking` and
  `steps`: one per tool call, with the validated ids, a one-line summary in the
  broker's words ("read agent #12's ERC-8004 reputation on Arc (avg 92 from 5
  buyer ratings)") and explorer links. Nothing the model writes gets into `steps`
  (an id it made up is recorded as `(not a candidate)`), so a private job's public
  record shows the trace and still withholds the model's reason.
- **Matcher** (`src/registry.ts`), whenever the router doesn't choose (one
  option, router off, adapter named, fallback): cheapest first, then a rank of
  success rate nudged by reputation (±0.2, `REPUTATION_TIEBREAK_WEIGHT`).
  Reputation is buyer ratings plus Kimi scores, shrunk toward a neutral 50 worth
  three ratings, from the Envio indexer (`Provider.avgRating`,
  `Agent.verifiedScore`) when configured and from the broker's own jobs otherwise
  (`src/ai/reputation-book.ts`: one batched query a minute, never on the request
  path).
- **Verifier** (`src/ai/verifier.ts`) runs after the buyer already has the result
  and never blocks the job. Private jobs (`request.encryptTo`) are skipped: the
  broker only holds their ciphertext. Prompt and result are fenced as untrusted
  data; a result the model flags as `prompt_injection` never passes.

All three share `src/ai/client.ts`: calls over the protocol's `chatJson`
(OpenAI-compatible, JSON mode) and `chatTurn` (one tool-calling turn, for the
router), a hard deadline (screen 8 s, route 15 s for the whole loop, verify 20 s)
raced against the request, strict validation, per-role latency and failure
counters, and key hygiene: keys go only to each preset's base URL and are
scrubbed from any error text before it is logged or served.

The screen asks TokenHub for `reasoning_effort: "low"` (hy4-preview defaults to
`high`; `XORV_SCREENER_REASONING=high` or `provider` changes that).

### The verifier's on-chain feedback (ERC-8004)

When the provider holds a verified ERC-8004 agent (and did the work it was paid
for) and the broker has a verifier key, the score is written to Arc's Reputation
Registry from the verifier EOA (`src/ai/feedback.ts`, called from `src/app.ts`):

```
giveFeedback(agentId, score, 0, "xorv-verified", <adapter>, <XORV_PUBLIC_URL>/api/quotes,
             <XORV_PUBLIC_URL>/verifications/<jobId>.json, keccak256(file))
```

- The file at `GET /verifications/<jobId>.json` is canonical JSON with the model,
  score, rationale, flags, the job's request and result hashes and the x402
  `proofOfPayment`; its keccak256 is the committed `feedbackHash`. It is rebuilt
  from facts frozen when the job was scored, so it keeps hashing to what went
  on-chain. Its hash is stored on the job before the transaction is sent.
- Three Xorv signals reach ERC-8004 from three clients under three tags: buyer
  ratings through XorvLedger (`starred`), escrow outcomes through XorvReputation
  (`successRate`), and verifier scores from the verifier EOA (`xorv-verified`).
  They stay separable in the registry.
- Gas is paid in USDC, Arc's gas token. The write carries `estimateGas` + 15% and
  goes through the protocol's per-address signer lock, the same queue as the
  ledger writer and the facilitator. The estimate doubles as a free preflight for
  a feedback the registry would refuse.
- `XORV_VERIFIER_KEY` defaults to `XORV_OPERATOR_KEY`. It **must never own or
  operate a provider's agent NFT** (the registry rejects self-feedback). If it is
  a separate key, add its address to the indexer's `ENVIO_XORV_VERIFIER_ADDRESSES`
  so Envio classifies its feedback as `XORV_VERIFIED` (it trusts only the ledger's
  broker EOA by default).
- Best-effort: a failed write is stored on the job as `verification.feedbackError`
  and counted in `/api/network`; the job itself is never touched.

### AI configuration

| Variable | Default | Meaning |
|---|---|---|
| `XORV_SCREENER` / `XORV_ROUTER` / `XORV_VERIFIER` | `auto` | `auto` = on exactly when the key is set; the provider name = on, warn at boot if the key is missing; `off` |
| `XORV_SCREENER_FAIL` | `open` | what a quote does when the screen can't answer |
| `XORV_SCREENER_TIMEOUT_MS` | `8000` | the screen's deadline (500–60000) |
| `XORV_SCREENER_REASONING` | `low` | TokenHub `reasoning_effort` for the screen: `low`, `high`, or `provider` (send none) |
| `XORV_ROUTER_TIMEOUT_MS` | `15000` | the router's whole budget: every turn and tool call (1000–120000) |
| `XORV_ROUTER_MAX_TURNS` / `XORV_ROUTER_MAX_TOOLS` | `4` / `6` | model turns and lookups per route (`select_provider` not counted) |
| `XORV_ROUTER_THINKING` / `XORV_ROUTER_THINKING_BUDGET` | `on` / `256` | Qwen thinking while routing, and its reasoning tokens per turn |
| `XORV_VERIFIER_KEY` | operator key | signs the verifier's `giveFeedback`; unset and no operator key = scores stay off-chain |
| `TOKENHUB_API_KEY` / `XORV_HUNYUAN_API_KEY` | — | Hunyuan (screener) |
| `DASHSCOPE_API_KEY` / `XORV_QWEN_API_KEY` | — | Qwen (router); keys are region-bound, default endpoint is the international one |
| `MOONSHOT_API_KEY` / `XORV_KIMI_API_KEY` | — | Kimi (verifier) |
| `XORV_{HUNYUAN,QWEN,KIMI}_BASE_URL`, `_MODEL` | preset defaults | endpoint and model overrides |

A missing key never stops the broker: the role is off and says why.
`pnpm --filter @xorv/broker setup` and the boot banner list each role;
`GET /api/network` reports enabled roles under `ai` (the protocol's `AiRoleInfo`,
`null` when off) and every role's full state under `aiRoles`: enabled, provider,
model, the reason it's off, latency, the screen's fail mode and reasoning effort,
the router's loop bounds (`agent`), and where verifier feedback goes.

What the models see: Hunyuan and Qwen read the buyer's prompt (Qwen at most its
first 6,000 characters), and Qwen reads the tool results above, which are public
data about the live providers; Kimi reads the prompt and the result of non-private
jobs. Nothing else leaves the broker.

## Payments, escrow and the refund keeper

**Facilitator.** Arc has no public x402 facilitator, so the broker hosts its own
by default (`XORV_FACILITATOR=self`, `src/facilitator.ts`), signing with
`XORV_FACILITATOR_KEY` or else `XORV_OPERATOR_KEY` and paying settlement gas in
USDC. With no key, the paid route answers 503 with the fix instead of settling
through someone else. A facilitator URL is still accepted, but turns escrow off.

**Escrow** (`src/escrow.ts`, lifecycle in `src/app.ts`). With
`XORV_ESCROW_ADDRESS` and a self-hosted facilitator, the facilitator's key is
XorvEscrow's attester, and every quote freezes an escrow job id and deadline. The
402 then offers the `escrow` scheme first (EIP-3009 `ReceiveWithAuthorization`
to the escrow, redeemed by `fund`) and `exact` after it, so a stock x402 client
that only speaks `exact` can still pay the provider directly. From there:

- delivered → the escrow is re-pointed to the provider that finished, if the job
  moved, then `release(jobId, keccak256(result))`; the XorvLedger receipt is
  written after the release, with the release as its payment;
- failed everywhere → `refund` from the attester (counts against the provider);
- cancelled by the buyer → `cancel` (no fault, no reputation entry), with the
  refund transaction in the response;
- a write that fails is retried by the 15-second sweep; one that reverts because
  someone else already settled the job (the buyer's own release, the keeper's
  deadline refund) is recorded with who settled it (`settledBy`).

Every escrow write goes through Arc's Memo predeploy with `memoId` = the escrow
job id and text `xorv:<function>`; a direct `exact` transfer is tagged
`xorv:pay:<quote id>`. `XORV_MEMO=off` turns tagging off on a chain without the
predeploy.

**Refund keeper** (`src/keeper.ts`). With an escrow configured and
`XORV_KEEPER` on (the default), every sweep reads new `JobFunded` logs (in
windows inside Arc's 10,000-block `eth_getLogs` cap, starting from
`XORV_LEDGER_FROM_BLOCK` or about 70,000 blocks back) and:

- refunds every funded job past its deadline, including jobs this broker does not
  remember, from `XORV_KEEPER_KEY` (else the operator key). It **refuses to use
  the attester's key**, because an attester refund marks the provider at fault;
  with that key it stays read-only and says why at boot;
- hands each `JobFunded` whose buyer is XorvCcipReceiver to the broker, which
  opens the matching CCIP quote's job;
- after a cross-chain job settles, calls the receiver's `claimRefund` (forwards
  the refund to the requester) or `markReleased` (closes the receiver's books).

| Variable | Default | Meaning |
|---|---|---|
| `XORV_FACILITATOR` | `self` | `self`, or a facilitator URL (escrow off) |
| `XORV_FACILITATOR_KEY` | operator key | the facilitator and escrow attester |
| `XORV_ESCROW_ADDRESS` | — | XorvEscrow; unset pays providers directly |
| `XORV_ESCROW_DEADLINE_S` | `1800` | seconds from quote until anyone may refund the buyer (at least 120) |
| `XORV_REPUTATION_ADDRESS` | — | XorvReputation, for `escrow_outcomes` and `/api/providers/:id/escrow` |
| `XORV_KEEPER` / `XORV_KEEPER_KEY` | `on` / operator key | the refund keeper and its key (never the attester's) |
| `XORV_MEMO` | `on` | Arc Memo tagging |

`GET /api/providers/:id/escrow` returns the provider's XorvReputation record
(`completed`, `failed`, `earnedUnits`, `scoreBps`, the bound `agentId` when its
outcomes are live) with explorer links, or `{configured: false}`.

## Circle Gateway

A buyer with a Circle Gateway balance on any supported chain tops up their Arc
wallet without a chain switch or gas (`src/arc.ts`; pure intent logic in
`@xorv/protocol`'s `gateway.ts`):

| Route | Does |
|---|---|
| `GET /api/gateway` | whether minting is available, the GatewayWallet and GatewayMinter, the source chains; with `?depositor=0x…`, the unified balance per chain from Circle's API |
| `POST /api/gateway/intent` | `{depositor, recipient?, amountUnits, sourceDomain}` → the EIP-712 `BurnIntent` to sign (fresh salt, `maxFee` from Circle's fee table), at most 1,000 USDC |
| `POST /api/gateway/mint` | `{burnIntent, signature}` → checks every field (to Arc, Circle's minter, USDC, signer = depositor, no destination caller, no hook, fee within Xorv's table), recovers the signer locally, asks Circle's `/v1/transfer` for the attestation, and calls `GatewayMinter.gatewayMint` on Arc from the operator key |

The broker can't redirect the money: the recipient is in the intent the buyer
signed, and `gatewayMint` mints only to it. A bad signature never reaches Circle
or costs gas. A retry of the same signed intent returns the first mint. Without
an operator key, minting answers 503. The routes are rate-limited to 20 a minute
per client; mints are counted as `xorv_gateway_mints_total`.

## Chainlink CCIP quotes

`POST /api/quotes` with `payVia: "ccip"` (and `XORV_CCIP_RECEIVER_ADDRESS` set,
else 400) returns the normal quote plus a `ccip` block for a buyer agent on Base or
Ethereum:

```
ccip: { receiver, arcChainSelector, jobId, provider, price, deadline,
        sources: [{ name, chainId, selector, usdc, cctpDomain }], senders: { <chainId>: <XorvCcipSender> } }
```

The buyer calls `XorvCcipSender.postJob(jobId, provider, price, deadline, maxFee,
minFinalityThreshold)` on the source chain (`scripts/ccip-send.mjs` does it on
testnet): CCTP V2 burns the USDC to the receiver on Arc and CCIP carries the job.
The quote is held for that payment (nobody can pay it over x402 meanwhile) until
its escrow deadline, `XORV_CCIP_DEADLINE_S` (default 7200, at least 600). When the
keeper sees the receiver fund the escrow, the broker opens the job only if the
funding matches the quote (same escrow job id, the quoted provider, at least the
quoted amount); the payment record carries `crossChain` (source chain, requester,
CCIP message id and explorer link). A funding that matches no quote is left for
the keeper to refund after its deadline.

| Variable | Default | Meaning |
|---|---|---|
| `XORV_CCIP_RECEIVER_ADDRESS` | — | XorvCcipReceiver on Arc; unset = no cross-chain jobs |
| `XORV_CCIP_SENDERS` | — | `chainId:address,…` of XorvCcipSender deployments, returned in `ccip.senders` |
| `XORV_CCIP_DEADLINE_S` | `7200` | escrow deadline for a CCIP-funded quote |

Counters: `xorv_ccip_quotes_total`, `xorv_ccip_jobs_total`.

## `GET /api/network`: the `arc` block

Besides the network, USDC, facilitator, operator, ledger, ERC-8004, escrow and AI
state, `/api/network` describes the Arc stack this broker runs on (`ArcStackInfo`
in `@xorv/protocol`):

| Field | Holds |
|---|---|
| `gasToken`, `finality` | `"USDC"`, `"deterministic, sub-second"` |
| `memo` | the Memo contract, explorer link, and whether tagging is on |
| `reputation` | XorvReputation and its explorer link, or null |
| `gateway` | GatewayWallet, GatewayMinter, source chains, and whether minting is available |
| `cctp` | `TokenMessengerV2`, Arc's CCTP domain (26), the withdrawal destinations |
| `ccip` | the CCIP router, Arc's chain selector, the receiver (or null), the source chains |
| `keeper` | whether the refund keeper is on, and its address |

## Tests

No network and no keys: `pnpm --filter @xorv/broker test`.

- `test/integration.test.ts` boots the real HTTP server, Hono app, x402 resource
  server and WebSocket hub, with a real viem account signing real EIP-3009
  authorizations and only the broadcasts stubbed. Besides the paid path,
  failures, cancelling, streaming, heartbeats, ratings and the public surface, it
  has an "AI roles" block (the real quote and completion paths), an "XorvEscrow"
  block against `MemoryEscrow`, an in-memory copy of the contract's state machine
  (escrow first in `accepts`, release with the result hash and a receipt of the
  release, refund on failure, re-pointing on reassignment, cancel with no mark, a
  refund someone else made, a stock `exact` client), and an "Arc" block (the
  `arc` block on `/api/network`, CCIP quotes, a CCIP-funded job run to release, a
  forwarded refund, a funding that matches no quote) with a fake keeper.
- `test/ai.test.ts`: each role against a stubbed provider (happy path, malformed
  JSON, timeouts including a `fetch` that ignores its abort signal, HTTP errors,
  out-of-range scores, key redaction, the env settings, the feedback file and its
  hash, and a real viem broadcast of `giveFeedback` against a stub RPC checking
  the `estimateGas` + 15% limit and the calldata).
- `test/router.test.ts`: a scripted Qwen through the tool loop (parallel reads,
  each tool's data mapping and summary, invalid picks and the retry, timeouts, the
  turn and lookup caps, a private prompt kept out of the trace), the data sources
  over stubbed chain, ledger and indexer, the reputation book and the matcher
  tie-break.
- `test/gateway.test.ts`: the burn intent (Base Sepolia → Arc, minted to the
  buyer, capped fee), refusal without an operator key, a signature that isn't the
  depositor's refused before Circle is called, decimal balances read without
  floating point.
- `test/config.test.ts` (including the Arc contracts, keeper and CCIP senders),
  `test/private-jobs.test.ts`, `test/chain.test.ts`, `test/ledger-reader.test.ts`,
  `test/registry.test.ts`, `test/jobs.test.ts`, `test/hub.test.ts`,
  `test/guards.test.ts`, `test/store.test.ts`, `test/store-mongo.test.ts`.

The `RefundKeeper` class itself is exercised against a real chain by
`pnpm e2e:arc` ([e2e/README.md](../../e2e/README.md)), which also runs the broker
against real escrow, Memo, ERC-8004, CCIP-receiver, CCTP and Gateway code.
