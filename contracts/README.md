# Xorv contracts on Arc

Foundry project for Xorv's on-chain layer on **Arc** (Circle's EVM L1, USDC is gas). A buyer pays per AI
job in USDC; the escrow pays the provider on delivery and refunds the buyer otherwise; every settlement
becomes ERC-8004 reputation on Arc; and buyer agents on Base / Ethereum can post and settle jobs through
Chainlink CCIP while Circle CCTP V2 moves their dollars.

| Contract | Chain | What it does |
|---|---|---|
| `src/XorvEscrow.sol` | Arc | Holds each job's USDC between "the buyer signed" and "the provider delivered". Funding by EIP-3009 `receiveWithAuthorization` (the broker relays the buyer's signature; the buyer needs no gas) or, for allowlisted contract buyers, `fundDirect`. Exits: `release`, `refund`, `cancel`, `reassign`. |
| `src/XorvReputation.sol` | Arc | The escrow's outcome sink. Binds a provider wallet to its ERC-8004 agent (`bind(agentId)`), keeps on-chain counters and a Laplace-smoothed score, and writes every release / provider-at-fault refund to Arc's **ERC-8004 Reputation Registry** (`giveFeedback(agentId, 100 or 0, 0, "successRate", "xorv-escrow", "", "", jobId)`). |
| `src/ccip/XorvCcipReceiver.sol` | Arc | Chainlink CCIP receiver. The escrow's buyer of record for cross-chain buyers: funds jobs from CCTP-minted USDC, releases on the original requester's instruction, forwards refunds. Defensive (failed messages stored and retryable). |
| `src/ccip/XorvCcipSender.sol` | Base / Ethereum (Sepolia on testnet) | `postJob`: CCTP V2 `depositForBurn` of `price + maxFee` to the Arc receiver (domain 26) and a CCIP POST_JOB message; `settle`: a CCIP RELEASE message. CCIP fees in the source chain's native coin. Ownerless, immutable. |
| `../packages/contracts/contracts/XorvLedger.sol` | Arc | Job receipts + buyer ratings relayed into ERC-8004 (Hardhat package; compiled and deployed from here via the `@xorv/ledger/` remapping). |

"CCTP moves the dollars, CCIP carries the instruction": USDC is not a CCIP token on Arc, so the sender burns
USDC with CCTP and sends the job with CCIP; the receiver acts once both have arrived, in either order.

## Roles and owner powers

**XorvEscrow.** *Attester* = the broker's settlement key: funds signed jobs, releases before the deadline,
refunds (provider at fault) or cancels (no blame), reassigns. *Buyer of record* may release at any time.
*Anyone* may refund after the deadline (money only goes to the buyer). The *owner* can: allow/disallow tokens
for new jobs, rotate the attester, set the outcome sink (`setRegistry`), set or clear the optional identity
gate (off by default), allow/remove direct funders (`setFunder`), set the per-job cap (`setMaxJobAmount`,
must be > 0), set a fee of at most 5% for future jobs, pause new funding, and sweep tokens above
`totalEscrowed`. The owner can **never** move escrowed funds: no admin withdrawal, pause never blocks
release/refund/cancel, fees are snapshotted per job, ownership is two-step and cannot be renounced.

**XorvReputation.** Only the escrow can report. The owner can only set the escrow address (two-step
ownership, no renounce). Holds no funds. `bind` is permissionless (the Identity Registry already proves the
wallet consented); only the wallet itself can move a still-valid binding to another agent; it refuses an
agent this contract owns/operates (ERC-8004 rejects self-feedback). Feedback is written only while
`getAgentWallet(agentId) == provider` (ERC-8004 clears the wallet when the agent NFT is transferred).

**XorvCcipReceiver.** The owner can: allowlist (source chain selector, sender) pairs, resolve a failed
message *only if it still cannot be processed* (it is re-run first), and sweep USDC above
`pendingTotal + fundedTotal + owedTotal` (CCTP max-fee dust). Everything else is permissionless:
`executePending`, `cancelPending` (beneficiary any time; anyone once the deadline window closed),
`claimRefund` (once per refunded job, to the requester's Arc address), `markReleased`, `withdrawOwed`,
`retryFailedMessage`. A RELEASE is honoured only from the same source chain + sender contract the job was
posted through, and only for the same requester.

## Caps

- Per job: `maxJobAmount`, default **100 USDC** (`100e6`) at deploy (`XORV_MAX_JOB_AMOUNT`), enforced on both
  funding paths. Also bounded by `uint96`.
- Duration: a job's deadline must be 1 minute to 7 days out at funding (`MIN_JOB_DURATION`/`MAX_JOB_DURATION`).
  For a CCIP job the window is checked when it is funded on Arc: give standard CCTP transfers
  (~15-20 min from Ethereum/Base) enough deadline.
- Fee: at most 5% (`MAX_FEE_BPS`), 0 at deploy.

## Install and build

```bash
cd contracts
git submodule update --init       # lib/forge-std, lib/openzeppelin-contracts (OZ v5.4 for Xorv's own contracts)
npm install                       # standalone: @chainlink/contracts-ccip 2.0.0, @chainlink/contracts 1.5.0,
                                  # @chainlink/local 0.3.1, @openzeppelin/contracts@4.8.3 and @5.3.0 aliases
forge build
```

Arc Foundry (`arc-forge`, `arc-cast`, `arc-anvil`, https://docs.arc.io/arc/tutorials/install-arc-foundry)
is needed for anything that moves Arc's native USDC on a fork; stock Foundry is fine for the unit tests.

## Tests

```bash
forge test                                   # unit + Chainlink Local + invariants (fork suites skip)
ARC_FORK_TESTS=1 arc-forge test --network arc                           # everything, incl. Arc testnet fork
ARC_FORK_TESTS=1 arc-forge test --network arc --match-path 'test/fork/*' # only the fork suites
```

`--network arc` is required for the fork suites: without it, the fork can read Arc but any native-USDC
movement (an ERC-20 `transfer` of `0x3600…0000`, a `vm.deal`-funded transfer) reverts. With it, `vm.deal`
sets the native balance (18 decimals), which *is* the ERC-20 balance (6 decimals) — asserted in
`test_fork_nativeBalanceIsTheErc20Balance`. Stock `forge` (1.7.1) forks Arc fine but fails exactly the 4
tests that move USDC (same as Arc Foundry's forge without `--network arc`).

| Suite | Tests | What |
|---|---|---|
| `XorvEscrow.t.sol` (7 contracts) | 62 | funding by signature, direct funding, caps, settlement, outcome reporting & gas starvation, admin, fuzz |
| `XorvEscrow.invariant.t.sol` | 4 | solvency, accounting, conservation over random fund / fundDirect / release / refund / cancel / reassign / fee / warp |
| `XorvReputation.t.sol` | 18 | bind rules, feedback on release / attester refund / reassign, none on timeout or cancel, sold agent, broken registry |
| `XorvCcip.t.sol` (Chainlink Local) | 21 | post → funded; message before dollars → pending → `executePending`; unfundable → `cancelPending`; duplicate id → owed; non-allowlisted sender / selector refused; only router; RELEASE pays provider + writes ERC-8004; wrong requester / origin stored as failed, retry still fails; owner can't resolve a processable message; refund → `claimRefund` once; native fees and refund of excess; sweep only dust |
| `fork/XorvArcFork.t.sol` (Arc testnet fork) | 6 | real USDC EIP-712 domain; real EIP-3009 `ReceiveWithAuthorization` funding; release writes feedback 100 to the **real** ERC-8004 Reputation Registry (read back with `readFeedback`, `getClients`, `getSummary`), attester refund writes 0; gas measurement; release never skips the feedback at any gas limit |
| `fork/XorvCcipArcFork.t.sol` (Arc testnet fork) | 4 | real CCIP router: Base Sepolia + Ethereum Sepolia lanes, native-USDC fee quotes, only-router delivery that funds a real escrow job; **CCTP V2 withdraw**: a provider burns USDC on Arc with the real `TokenMessengerV2` to Base Sepolia (domain 6), `DepositForBurn` asserted |

Unit/Local: 105 passing. With `ARC_FORK_TESTS=1 … --network arc`: 115 passing.

## Verified on Arc testnet (read on chain / on a fork, 2026-10-07)

- USDC `0x3600…0000`: `name()` "USDC", `version()` "2", `decimals()` 6,
  `DOMAIN_SEPARATOR()` `0x361191522483d32a83e70ae7183b4b9629442c13a78bc9921d6f707911c8c6b0`
  = EIP-712 domain {name "USDC", version "2", chainId 5042002, verifyingContract 0x3600…0000}.
- ERC-8004 Identity `0x8004A818…D9e` ("AgentIdentity", v2.0.0) and Reputation `0x8004B663…713` (v2.0.0,
  `getIdentityRegistry()` = the Identity Registry): `register(string)`, `getAgentWallet`, `giveFeedback`,
  `getLastIndex`, `readFeedback`, `getClients`, `getSummary` all exercised.
- CCIP: Arc testnet router supports Base Sepolia and Ethereum Sepolia; Base Sepolia, Ethereum Sepolia, Base
  and Ethereum routers (and the Arc mainnet router) all report the Arc lane as supported.
- Arc fee market: base fee 20 gwei (the mempool floor), priority ~2.4 gwei.

## Gas (measured)

| What | Gas |
|---|---|
| `XorvReputation.recordOutcome`, first outcome + first feedback from this client (real ERC-8004) | **233,076** |
| …later feedback for the same agent | 67,577 |
| `XorvEscrow.REGISTRY_GAS_LIMIT` (budget forwarded to the sink) | 400,000 (was 150k: too small for ERC-8004) |
| `XorvEscrow.fund` (real USDC, EIP-3009) | 208,048 |
| `XorvEscrow.release` with first ERC-8004 feedback | 306,115 used; needs a ~480k gas *limit* (the escrow requires `REGISTRY_GAS_RESERVE` ≈ 416k left before the sink call, so an estimator can't starve the reputation write) |
| `XorvEscrow.refund` (attester, feedback 0) | 281,876 |
| Full deploy (6 txs: Ledger, Reputation, Escrow, setEscrow, CcipReceiver, setFunder) on an Arc fork | **9,221,076** gas = **0.2029 USDC** at the fork's 22 gwei effective price (~0.55 USDC worst case at the 60 gwei max fee) |
| CCIP fee Arc → Base Sepolia / Ethereum Sepolia (700k gas limit, native USDC) | 0.120 / 0.520 USDC |

## Deploy

Every external address lives in `script/ArcConfig.sol` (Arc testnet/mainnet: USDC, ERC-8004
identity/reputation/validation, CCIP router + selector, Memo, CCTP TokenMessengerV2 / MessageTransmitterV2,
Gateway Wallet / Minter; source chains: routers, selectors, USDC, TokenMessengerV2, CCTP domains).

```bash
# Arc testnet (from the repo root). Holds the shared deployer lock only for the broadcast.
XORV_BROKER_ADDRESS=0x… scripts/deploy.sh testnet
XORV_BROKER_ADDRESS=0x… XORV_VERIFY=1 scripts/deploy.sh testnet     # + Blockscout verification

# Arc mainnet: refuses without the confirmation; the broker must not be the deployer.
XORV_CONFIRM_MAINNET=1 XORV_BROKER_ADDRESS=0x… scripts/deploy.sh mainnet

# Rehearse on a local Arc testnet fork (arc-anvil, anvil dev keys) -> deployments/local-fork.json
ARC_ANVIL=arc-anvil ARC_CAST=arc-cast ARC_FORGE=arc-forge scripts/arc-fork.sh
ARC_FORK_STOP=1 scripts/arc-fork.sh          # stop the fork it started (by its recorded pid)
```

`scripts/deploy.sh` sources `DEPLOYER_ENV` (default `../.deployer/deployer.env`, `DEPLOYER_PRIVATE_KEY`) inside
the command without echoing it, runs `script/Deploy.s.sol` with `--slow --with-gas-price 60gwei
--priority-gas-price 2gwei` (Arc's mempool requires `maxFeePerGas >= 20 gwei`), writes the record to a
pending file and moves it to `deployments/arc-<network>.json` only after the broadcast succeeded, then prints
the gas used and its USDC cost. Verification uses `--verifier blockscout --verifier-url
https://explorer.testnet.arc.io/api/` (mainnet `https://explorer.arc.io/api/`).

Cross-chain buyers (after the Arc deploy):

```bash
cd contracts
# 1. sender on the source chain (needs that chain's native coin); reads the receiver from deployments/arc-testnet.json
SOURCE=base-sepolia forge script script/DeploySender.s.sol --rpc-url https://sepolia.base.org --broadcast
# 2. allowlist it on Arc (receiver owner)
NETWORK=testnet SOURCE=base-sepolia forge script script/AllowSender.s.sol --rpc-url https://rpc.testnet.arc.io \
  --broadcast --with-gas-price 60gwei --priority-gas-price 2gwei
```

(Source the deployer env and wrap broadcasts in the shared lock as `scripts/deploy.sh` does.)

## ABIs

```bash
forge build && node scripts/export-abi.mjs
```

writes `packages/protocol/src/xorv-escrow.abi.ts` (`XORV_ESCROW_ABI`) and
`packages/protocol/src/abi/{xorv-reputation,xorv-ccip-receiver,xorv-ccip-sender}.ts`.
