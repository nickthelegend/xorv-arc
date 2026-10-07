# Security

Xorv runs untrusted prompts on volunteers' machines and moves real money on Arc. This document
says what is protected, what isn't, and where the line is, because a security page that only lists
reassurances is worse than none.

---

## Reporting

Email **niveshgajengi@gmail.com**. Please don't open a public issue for something exploitable.

---

## The provider risk, stated plainly

**A Xorv provider executes prompts written by strangers, on their own machine, against their own
paid AI subscription or API key.** That is the product, and it is the risk.

### What Xorv does

**Before the job is sold.** When the broker runs the screen (on whenever `TOKENHUB_API_KEY` is set),
Hunyuan hy4 checks every quote request **before any provider sees the prompt**. It looks for
credential or key exfiltration, malware, destructive commands, sandbox escape and prompt injection
aimed at the node, and a block is a 422 with no quote. The quote freezes the screened request, so it
cannot be swapped afterwards. The screen is a filter, not a boundary: by default it fails *open*
(`XORV_SCREENER_FAIL=open`, recorded on the job as "not screened"), and a model can be talked past.
The sandbox below is the boundary.

**While the job runs.** Every job is spawned through `packages/cli/src/sandbox.ts`, which applies the
strongest containment the host can provide. `xorv doctor` names the active tier instead of just
saying "sandboxed".

| Tier | Where | What it enforces |
|---|---|---|
| `seatbelt` | macOS | Credential paths unreadable; writes confined to the job dir |
| `bwrap` | Linux with bubblewrap | Read-only root, private home, writes confined to the job dir |
| `container` | opt-in, any host | Full isolation: the job never sees the host filesystem |
| `limits` / `env` | fallback (and Windows) | Resource caps and a scrubbed environment; **no filesystem boundary** |

On every tier:

- **The environment is an allowlist, not the operator's shell.** A job receives `PATH`, `HOME`,
  locale and proxy settings. It does not receive `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, the
  sponsor-model keys (`DASHSCOPE_API_KEY`, `MOONSHOT_API_KEY`, `TOKENHUB_API_KEY`), or a variable some
  vendor invents next year. The `qwen`, `kimi` and `hunyuan` adapters read their keys in-process and
  spawn nothing. `qwen-code` gets the Qwen key as `OPENAI_*` in its own child environment only, never
  on argv.
- **Resource limits** cap CPU seconds, file size and process count.
- **A fresh directory per job**, deleted when the job ends. Job ids are sanitised before being used
  as path components.
- **`XORV_SAFE_MODE=1`** disables tools entirely and leaves pure text generation.
- **Timeouts kill the process group**, not just the direct child.

Under `seatbelt` and `bwrap`, a job cannot read **the Xorv home wherever `XORV_HOME` points** (plus
`~/.xorv`, where an older key may sit), `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.npmrc`,
`~/.docker`, `~/.kube`, the macOS Keychain or browser profiles. Writes outside the job directory
fail.

#### The keychain, and why the node reads it for you

Claude Code authenticates by shelling out to `/usr/bin/security`. The obvious profile, letting the
agent reach its own credentials, leaves the Keychain readable, and a readable Keychain is not one
secret but all of them. So the node reads the agent's own token once at startup, outside the sandbox,
and injects only that token into each job (`packages/cli/src/credentials.ts`). The job runs with the
Keychain denied outright.

### What Xorv does not do

**A job can still read the agent session it is running.** The token is in the job's environment
because the agent needs it. That is the capacity being rented, not a boundary that can be closed
while the product works.

**Below `seatbelt`/`bwrap` there is no filesystem boundary at all.** On Windows, and on a Linux host
without bubblewrap, `doctor` reports `limits` or `env` and warns. For a real boundary on any host:

```bash
XORV_SANDBOX=container xorv start
```

The threat model to hold in your head is "someone I have never met gets to run code as me, for a
tenth of a cent".

### Address-only providers: nothing worth stealing

A provider never signs anything to get paid: the buyer signs, and the broker's facilitator submits
(or the escrow releases). So `xorv init` can take **just a payout address** (for example the Privy
wallet from the web app, or a hardware wallet) and store no key at all. A prompt that escapes the
sandbox on an address-only node finds no payout key. Such a node loses only the commands that need
a key: `xorv run`, `xorv identity register` and `xorv withdraw`.

### Terms of service

Most consumer AI subscriptions are licensed to an individual, and reselling that capacity may breach
them. Xorv is infrastructure and does not decide this for you. The `qwen`, `kimi` and `hunyuan`
adapters use pay-as-you-go API keys, and `openai-compatible` can serve your own local models.

---

## Keys

On Arc, USDC is the gas token, so every key that sends transactions holds a little USDC and
nothing else. There is no second asset to keep topped up.

| Key | Where it lives | What it can do | Notes |
|---|---|---|---|
| Provider payout key | `~/.xorv/config.json` (mode `0600`, dir `0700`), or `XORV_PRIVATE_KEY`; **optional** | Receives payments; registers the ERC-8004 identity; withdraws over CCTP | A hot key if present: it must work with no human there. Prefer address-only. Rotate with `xorv wallet new`. The CLI never prints it, and `xorv config --json` redacts it. |
| Buyer key for `xorv run` | `XORV_PAYER_KEY` / `XORV_PRIVATE_KEY` | Signs USDC authorizations | Never taken as a flag (argv shows up in `ps`). Use a different key from the payout key. Signs typed data only; never sends a transaction. |
| Facilitator key = **escrow attester** | `XORV_FACILITATOR_KEY` (defaults to the operator key) | Submits buyers' authorizations and pays their gas; funds, releases, refunds at fault, cancels and reassigns escrowed jobs | The most powerful broker key: see [The escrow's attester](#the-escrows-attester) below. Holds gas USDC, never buyers' money. |
| Broker operator key | `XORV_OPERATOR_KEY` | XorvLedger writes (it is the ledger's `broker`), rating relays, `gatewayMint` gas, and by default the verifier and the keeper | Unset = read-only ledger and no Gateway minting. A leak lets someone forge receipts until the owner rotates the broker (`setBroker`). Ratings still need the buyer's signature. |
| Keeper key | `XORV_KEEPER_KEY` (defaults to the operator key) | Deadline refunds, `claimRefund`, `markReleased` | **Must not be the attester.** An attester refund marks the provider at fault; a deadline refund must not. If the two are the same key, the keeper logs why and stays read-only. Every call it makes is permissionless, so a leak costs only its gas USDC. |
| Verifier key | `XORV_VERIFIER_KEY` (defaults to the operator key) | Writes Kimi's ERC-8004 feedback | Must never own or operate a provider's agent NFT (the registry refuses self-feedback). The broker checks `isAuthorizedOrOwner` first and keeps the feedback off-chain, with the reason, when an agent has authorized it. If separate, list it in the indexer's `ENVIO_XORV_VERIFIER_ADDRESSES`. |
| Deployer = **owner of every contract** | `DEPLOYER_PRIVATE_KEY` in the file `DEPLOYER_ENV` points at, sourced by `scripts/deploy.sh` inside the command and never echoed | Owns XorvLedger, XorvReputation, XorvEscrow and XorvCcipReceiver | Owner powers are listed below; none moves escrowed funds. On mainnet the deploy script refuses a broker address equal to the deployer, and refuses to run at all without `XORV_CONFIRM_MAINNET=1`. Keep it offline after the deploy; transfer ownership (two-step) to a hardware or multisig wallet for a real deployment. |
| App demo payer | `apps/app/.env.local`, server-only (`XORV_DEMO_PAYER_KEY`) | Pays for visitors without a wallet, and signs ratings for jobs it paid | Testnet only (refused on mainnet), never `NEXT_PUBLIC_`. Capped per job (`XORV_DEMO_MAX_USDC_UNITS`) and per rolling 24 h (`XORV_DEMO_DAILY_USDC_UNITS`, default $5), rate-limited per IP and per deployment, one payment attempt per quote, and it rates only for the browser that paid (an HttpOnly, HMAC-signed demo receipt, 30 minutes, once per job). The counters are per server instance. |
| Sponsor-model API keys | broker and provider environment | Call Qwen, Kimi, Hunyuan | Sent only to each preset's own base URL, and scrubbed from any error text before it is logged or served (`services/broker/src/ai/client.ts`). |
| Privy app secret | MCP server environment | Drives the Privy server wallet | With `privy:setup --owner-key`, the secret alone can neither sign nor loosen the policy (see below). |

`scripts/deploy.sh` sets one address, `XORV_BROKER_ADDRESS`, as both the escrow's attester and the
ledger's broker. A broker that runs a separate facilitator key therefore needs the owner to point
the escrow at it (`setAttester`), and the keeper needs its own key either way.

### Wallets that sign for buyers, and the policies around them

- **Privy embedded wallet (web app).** The key lives with Privy, and each signature shows Privy's
  confirmation. It signs only typed data here, because the facilitator, the rating relay and the
  Gateway mint pay all gas. The CCTP withdraw panel is the exception: a provider withdrawing sends
  its own approve and burn on Arc.
- **Privy server wallet (MCP agent buyer).** The key never exists on the MCP host. `pnpm privy:setup`
  attaches a policy that Privy evaluates in its enclave on every request. It allows **only**
  `eth_signTypedData_v4` for USDC on this Arc chain: `TransferWithAuthorization` with
  `value ≤ cap` (optionally only to listed payees), `ReceiveWithAuthorization` with `value ≤ cap`
  whose `to` is XorvEscrow (when the escrow address is known), plus typed data for the XorvLedger
  domain (ratings). Anything else is denied, including transactions, other tokens and other chains,
  even if the MCP host is compromised. **Limit:** Privy's typed-data policies cap *each signature*.
  Its rolling spend limits apply to transactions, not EIP-712. So the cumulative bound is enforced
  by the MCP server (`XORV_MAX_PRICE` per job, `XORV_SESSION_BUDGET_USD` per process, reserved before
  signing), and a compromised host could collect many in-policy signatures. Keep the cap small.
- **MetaMask Agent Wallet (`mm xorv`).** The plugin never sees a key, session or seed phrase. It
  asks `ctx.walletExecutor` for typed-data signatures with a readable intent, so MetaMask's own
  policy, Guard Mode allowlists, threat scanning and 2FA apply on top of the plugin's checks. It
  pays with x402 `exact` only, declares `wallet-submit` only on the two commands that sign, and
  never submits a transaction. **Limit:** the plugin checks the signer with plain ECDSA recovery,
  so ERC-1271 smart-contract wallets fail with `XORV_SIGNER_MISMATCH`.

---

## Payment safety

On EVM an x402 payment is an **EIP-3009 authorization**: a signature that lets the token execute one
transfer of `value` from the buyer to `to`, once, within a validity window. Xorv uses two forms:

- `exact`: `TransferWithAuthorization` to the provider. Whoever holds it can submit it.
- `escrow`: `ReceiveWithAuthorization` to XorvEscrow. The token requires the caller to be the payee,
  so only the escrow can redeem it, through `fund`.

Everything below follows from that.

- **Replay.** The USDC contract records each nonce (`authorizationState`) and refuses a second use,
  so a captured payment header cannot be settled twice. `exact` nonces are random 32-byte values.
  An `escrow` nonce is `keccak256(abi.encode(FUNDING_NONCE_TYPEHASH, chainId, escrow, jobId,
  deadline))`, which the escrow recomputes, so one signature funds exactly one job with one refund
  deadline; the buyer's client derives it itself rather than accepting one from the broker. On the
  broker, a quote is single-use (`409 this quote has already been paid`), and a `paying` guard stops
  two concurrent payments for one quote from both settling.
- **Expiry.** `validBefore = now + 300 s`, the same window as the quote's TTL. An authorization
  that is never used expires unspent.
- **Interception only pays the intended payee.** The authorization fixes `to` and `value`, so
  whoever submits it can only move the quoted amount to the quoted provider or into the quoted
  escrow job. That is also why the facilitator key cannot redirect a payment in flight.
- **Quote pinning, checked before signing.** A quote freezes the provider, address, agent, USDC
  amount and, with escrow, the escrow job id and deadline; both x402 requirement lookups read from
  it. Every Xorv buyer (web app, `xorv run`, MCP, `mm xorv`) refuses a 402 whose payee, amount,
  asset or network differs from the quote (`quoteMatchPolicy`), signs an `escrow` row only if it pays
  exactly the escrow the quote named for exactly the quoted provider, caps each payment, and pays at
  the broker URL it was configured with, never at a URL the broker returns. The CLI, MCP and
  MetaMask plugin also refuse to pay the buyer's own address.
- **Self-payment is refused by the broker, the escrow and the ledger.** A payment whose payer is
  the quoted provider's `payTo` gets 403 `self_payment` before anything settles (and an
  `onBeforeSettle` hook refuses it again). XorvEscrow refuses a job whose buyer is its provider, and
  `XorvLedger` reverts `SelfDealing` on such a receipt, whoever writes it.
- **A provider that can't be reached is never paid.** The paid route answers 409 before payment when
  the quoted provider holds no control socket.
- **The broker is never the payee.** `payTo` is the provider's own address or the escrow. A
  compromised broker could quote a different provider, but it cannot redirect money to itself
  without the buyer's client noticing what it is signing for.
- **The facilitator checks before it broadcasts**: the scheme and network, the signature (ECDSA or
  ERC-1271), the payee, the amount and the validity window, with `estimateGas` + 15% as a preflight
  for a transfer that would revert.
- **Upfront settlement.** The payment lands on Arc (in the escrow or with the provider) before the
  job is created or dispatched, so a provider never works for a payment that fails to settle.

### What payment safety does *not* cover

- **With `exact` there is no refund path.** The money reaches the provider before the job runs. A
  failed job is reassigned to another provider at no extra charge (up to three in total), and the
  failure counts against the original provider's success rate, but a buyer's cancel only stops the
  work. The app, `xorv run` and the MCP server pay into escrow whenever the quote names one; the
  MetaMask plugin and stock x402 clients pay `exact`.
- **With `escrow`, the provider carries the deadline risk.** The attester can release only until the
  deadline (30 minutes after the quote by default, 2 hours for a CCIP job); after it, only the buyer
  can release and anyone can refund the buyer. A broker that is down at the deadline leaves the
  provider unpaid for finished work.

---

## The new trust boundaries on Arc

### The escrow's owner

`XorvEscrow`'s owner can allow tokens for new jobs, rotate the attester, set the outcome sink, set
or clear the optional identity gate (off at deploy), allow or remove direct funders, set the per-job
cap (`maxJobAmount`, 100 USDC at deploy, never zero), set a fee of at most 5% for jobs funded
afterwards, pause new funding and sweep tokens above `totalEscrowed`. The owner **cannot** move
escrowed funds: there is no admin withdrawal, the sweep never reaches `totalEscrowed`, fees are
snapshotted per job at funding, `pause` never blocks a release, refund or cancel, and ownership moves
in two steps and cannot be renounced. A deadline must be 1 minute to 7 days out at funding, so no
buyer's money is parked longer than a week.

Two owner powers still matter for trust. Rotating the attester hands the attester's powers to a new
key. Setting the outcome sink changes where reputation is written (a sink that reverts or runs out
of gas is caught, so it can never block a payment).

### The escrow's attester

The attester (the broker's facilitator key) is trusted with every funded job until its deadline. It
can release a job to its current provider, refund it with a mark against the provider, cancel it
with no mark, and **reassign it to any address that is not the buyer or the current provider**.
So a stolen attester key can redirect funded, unreleased jobs to an address it controls, one job at
a time, each bounded by `maxJobAmount`. It cannot touch a job after its deadline except to refund
the buyer, and it cannot create jobs without buyers' signatures (or an allowlisted funder). Keep the
cap small, keep the key on the broker host only, and rotate it with `setAttester` if in doubt.

### The refund keeper

The keeper's calls (`refund` after the deadline, `claimRefund`, `markReleased`) are permissionless
and can only move money to the buyer, the requester or nowhere. The one rule is that the keeper key
must not be the attester, because the escrow treats an attester refund as the provider's fault and
writes a 0 to its ERC-8004 reputation. The keeper refuses to refund from the attester's key. With
the defaults (every key falling back to the operator) the keeper is therefore read-only until
`XORV_KEEPER_KEY` is set. Anyone else can run the same refunds: `isRefundable(jobId)` and
`refund(jobId)` are public.

### XorvReputation

Only the escrow can report outcomes. The owner can only set the escrow address (two-step ownership,
no renounce), and the contract holds no funds. `bind` is permissionless but maps only an agent's
verified wallet to that agent, and only the wallet itself can move a still-valid binding to another
agent. Feedback is written only while the agent's wallet still equals the provider. A failed
`giveFeedback` is caught and never reaches the escrow.

### Chainlink CCIP: sender and receiver

- **The sender is ownerless.** Every destination parameter of `XorvCcipSender` is immutable, so it
  can only send to the one Arc receiver it was built for.
- **The receiver accepts only allowlisted origins.** `ccipReceive` is router-only and rejects any
  (source chain selector, sender contract) pair the owner has not allowed. A RELEASE is honoured only
  from the same source chain and sender the job was posted through, and only for the same requester,
  who is always the source-chain `msg.sender` of the sender contract.
- **The receiver's owner** can change the allowlist, resolve a failed message only when it still
  cannot be processed (it is re-run first, and a message that now succeeds cannot be discarded), and
  sweep USDC above `pendingTotal + fundedTotal + owedTotal`, which is only CCTP max-fee dust or tokens
  sent by mistake. An owner who allowlists a hostile sender contract could post jobs that spend
  dollars already in the receiver; the allowlist is the receiver's real trust root.
- **Everything else is permissionless**: `executePending`, `cancelPending` (the requester at any
  time, anyone once the deadline is too close to fund), `claimRefund`, `markReleased`,
  `withdrawOwed`, `retryFailedMessage`.
- **Requesters are addresses on Arc.** Refunds and credits go to the requester's address on Arc.
  An EOA has the same address everywhere; a smart-account requester must also exist on Arc, or its
  refund is stranded at an address it does not control.
- **The two halves arrive independently.** CCTP and CCIP are separate systems. Until both have
  arrived the intent waits as Pending, and in the short run one intent's dollars may fund another
  whose mint is still in flight. Completing a CCTP mint is permissionless, so the balance always
  catches up; a refund that finds it short reverts until it does.
- **`scripts/ccip-send.mjs` is testnet only** and sends nothing without `--yes`.

### Circle Gateway: the relayer can't redirect funds

The broker's operator key pays the gas for `GatewayMinter.gatewayMint` on Arc, but it never holds
the money. The buyer signs the burn intent, which names the recipient; Circle's operator signs the
attestation; and `gatewayMint` mints only to the recipient in the intent. Before anything reaches
Circle, the broker checks the intent field by field (destination Arc, Circle's minter, Arc's USDC,
signer = depositor, no destination caller, no hook, a fee no higher than Xorv's table) and recovers
the signer locally, so a forged or malformed intent costs neither an API call nor gas. A transfer is
capped at 1,000 USDC, and the routes are rate-limited per IP. The worst a hostile caller can do is
spend the operator's gas on valid intents its own wallet signed.

### Arc Memo

Memo tags are public metadata: the escrow job id and a short text such as `xorv:release` or
`xorv:pay:<quote id>`. Nothing private goes in them. The Memo contract must be called by an EOA
directly (it runs the call through Arc's CallFrom precompile so the target still sees that EOA as
`msg.sender`), so the attester, keeper and facilitator must be plain EOAs, not smart accounts.

### CCTP withdrawals

A withdrawal is signed by the provider's own key or wallet: an approve and a `depositForBurn` on
Arc, then `receiveMessage` on the destination, which anyone may send. The broker is not involved.
The recipient and destination domain are in the burn, and Circle attests exactly that.

---

## The on-chain record, and how far to trust it

- **XorvLedger's broker is the only writer** of registrations, heartbeats and receipts. A receipt
  is the broker's attestation, backed by a payment transaction (for escrowed jobs, the release)
  that anyone can check. The identity binding (`payTo == agentWallet`) and the one-rating-per-job
  rule are enforced by the contract, not asserted by the broker.
- **Escrow outcomes are the strongest signal.** XorvReputation writes `successRate` feedback only
  from an escrow settlement that moved real USDC, so faking one costs the price of a job, and an
  at-fault refund requires the attester.
- **Ratings are payment-backed**: one per recorded job, signed by the wallet that paid (ECDSA, then
  ERC-1271), relayed with `clientAddress == XorvLedger`. The ledger refuses a rating from the
  agent's own wallet, owner or operators (`SelfDealing`). **Self-dealing is still possible** from a
  second wallet with no on-chain link to the provider. Faking a rating costs the price of a job.
  Weigh scores by distinct paying buyers (the indexer has every receipt's buyer).
- **Verifier scores are a separate signal** (`xorv-verified`, from the verifier EOA). They are an
  AI's opinion of a result, and the prompt and result are fenced as untrusted data so the result
  cannot instruct the grader.
- **ERC-8004 registries are upgradeable** by their maintainers' key. Xorv binds to the canonical
  deployments on Arc and does not control them.
- **Everything on-chain is public and permanent.** Receipts and releases carry `keccak256` hashes
  of the prompt and the result, never the text. `requestHash` is unsalted, so a short, guessable
  prompt can be confirmed by guessing.

## Private jobs

A private job's result is sealed on the provider's machine to a key derived from the buyer's passkey
(Mera PRF), and the broker stores only the envelope. **The prompt is not private from the network**:
the broker, the Hunyuan screen, the Qwen router and the provider all read it. Public views withhold
the router's and screener's free-text reasons, because they paraphrase the prompt. Script running
on the app's origin can read keys while they are unlocked. A broker could serve an older genuine
version of the history vault. PRF support and an https domain are required. The full threat model,
and the tests that enforce each property, are in [docs/PRIVATE_JOBS.md §5](docs/PRIVATE_JOBS.md#5-threat-model).

## What the AI roles see

Hunyuan and Qwen read the buyer's prompt (Qwen at most its first 6,000 characters). Kimi reads the
prompt and the result of **non-private** jobs. Nothing else leaves the broker. Each role is off
unless its key is configured, and `GET /api/network` says which ones are on.

---

## Broker exposure

The broker is designed to face the internet:

- **Per-IP rate limits** on the free endpoints: quotes 30/min (a quote reserves a provider and costs
  nothing), registrations 10/min, rating relays 10/min (each costs the operator gas), Gateway routes
  20/min (a mint costs the operator gas), vault writes 20/min, and 10 new vaults per client per hour.
- A 256 KB body limit is applied before parsing, and a body without `Content-Length` (chunked) is
  counted as it streams. Prompts are capped at 20k characters. Expired quotes are pruned by the
  sweep, and at 10,000 open quotes new ones get 503.
- Proxy headers (`X-Forwarded-For`) are trusted **only** when `XORV_TRUST_PROXY=1`, and then the
  client address is read `XORV_TRUSTED_HOPS` entries from the right (default 1): the entries a
  client writes itself are never the ones used.
- **Registration cannot hijack a node.** Re-registering a node id whose session is live needs that
  session's bearer token (409 `node_live` otherwise), and an existing token is never returned to a
  caller who did not present it. Node ids never go on-chain (agent URIs name the provider id).
- Provider callbacks are authenticated by bearer token **and** checked against job ownership, so one
  provider cannot post results or heartbeats for another. Bearer tokens never appear in a public
  response. Every WebSocket frame a node sends is validated before it is handled, frames are capped
  at 8 MiB, and a handler that throws is caught, so a malformed frame cannot exit the broker.
- **A cross-chain funding runs only against its quote.** The broker opens a CCIP-funded job only
  when the escrow job id matches an open CCIP quote, the provider is the quoted one and the amount is
  at least the quoted price. Anything else is left for the keeper to refund after its deadline.
- **Vaults are bounded on disk.** Vault ciphertext lives in the store, not the heap: at most 176 KiB
  per vault and 1 GiB across all vaults (128 MiB when running without a durable store), after which
  new vaults get 507 while existing ones can still be rewritten.
- **Cancelling needs the buyer's one-time cancel token**, which is returned only in the payment
  response and stored as a hash. Job ids are public, so they are not capabilities.
- A rating is verified in the broker before any gas is spent, and an in-flight guard stops a
  double-submit from burning a second relay.
- CORS allows exactly the x402 request headers (including `PAYMENT-SIGNATURE`) and exposes
  `PAYMENT-REQUIRED` / `PAYMENT-RESPONSE`, for the configured origins.
- The node's own HTTP face (what an optional tunnel exposes) is read-only and binds to loopback.

### Known limitations

- **Public jobs are public.** `/api/jobs` serves the prompt and result of every non-private job.
  Use a private job for the answer; nothing hides the prompt from the network.
- **Rate limiting is per-process.** Running more than one broker needs shared state. The app's demo
  routes count per server instance too: a best-effort bound on a testnet float.
- **Success rate is computed from provider-reported outcomes.** A provider that returns garbage
  quickly still "succeeds" and, under escrow, is released. Kimi's verification and buyer ratings
  exist to catch this, but both are opt-in signals.
- **Registration without identity is allowed.** Anyone can register a label and a payout address.
  Only providers with a verified ERC-8004 agent get receipts, ratings and escrow outcomes bound to an
  identity.
- **The screen fails open by default.** Set `XORV_SCREENER_FAIL=closed` to refuse unscreened quotes.
- **The attester is a hot key** with the powers described above, bounded per job by the escrow cap.

Before running with real money at stake, move contract ownership to a hardware or multisig wallet,
give the facilitator (attester), operator and keeper separate keys, keep `maxJobAmount` small, and
read [MAINNET.md](MAINNET.md).
