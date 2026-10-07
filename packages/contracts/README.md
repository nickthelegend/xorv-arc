# @xorv/contracts

`XorvLedger` is Xorv's public record on Arc. It replaces the Hedera prototype's HCS audit topics.

This package holds its source, its Hardhat 3 tests (run against the vendored ERC-8004 registries) and
the committed ABI. It is **deployed to Arc by Foundry**, together with XorvEscrow, XorvReputation and
the CCIP contracts: `contracts/script/Deploy.s.sol` compiles it from here through the `@xorv/ledger/`
remapping, and `scripts/deploy.sh testnet|mainnet` at the repo root runs it, verifies on Arc's
Blockscout (`XORV_VERIFY=1`) and writes `deployments/arc-<network>.json`. See
[`contracts/README.md`](../../contracts/README.md).

- **Providers.** The broker announces each provider node with `registerProvider`, then posts periodic
  capacity samples with `heartbeat`. Both write events only. When a provider has an ERC-8004 agent, its
  x402 `payTo` must be that agent's verified wallet (`IdentityRegistry.getAgentWallet`).
- **Receipts.** After an x402 payment settles and the job finishes, the broker writes a receipt with
  `recordJobs`. Receipts are batched. Each one binds the settlement tx to the job's request hash,
  result hash, duration, outcome, buyer, payee and agent.
- **Ratings.** The buyer can rate each recorded job once, with `rateJob`. The buyer can call it and pay
  the gas, or sign an EIP-712 `Rating` for free and let the broker relay it. A relayed signature is
  checked with ECDSA against the buyer first and then with ERC-1271, the order the ERC-8004 Identity
  Registry uses. So EOAs, EIP-7702 accounts (which have code, but whose key still signs) and ERC-1271
  smart accounts, including passkey (P-256) smart wallets, can all rate. The ledger
  forwards the rating to the ERC-8004 Reputation Registry as
  `giveFeedback(agentId, value, 0, "starred", tag2, endpoint, feedbackURI, feedbackHash)`.
- **Self-dealing.** The registry's own self-feedback rule only ever sees the ledger as the client, so
  the ledger applies it to the real parties. `recordJobs` reverts `SelfDealing(jobId)` for a receipt
  whose buyer is its `payTo`. `rateJob` reverts `SelfDealing(jobId)` when the buyer is the agent's
  current wallet, owner or an approved operator (per token or for all), read from the Identity
  Registry at rating time, on the direct and the relayed path alike.

Every rating reaches ERC-8004 with `clientAddress == XorvLedger`. So
`getSummary(agentId, [ledger], "starred", "")` is a provider score built only from paid, delivered
jobs, each rated by the wallet that paid, and never by the agent's own wallet, owner or operators. A
Sybil has to pay for every fake review, from a wallet that is not the agent's.

The interface (events, errors, `NO_AGENT`, `RATING_TYPEHASH`, EIP-712 domain `"XorvLedger"` / `"1"`) is
fixed by the port spec, because `packages/protocol` and the Envio indexer depend on it.
[`abi/XorvLedger.json`](abi/XorvLedger.json) is the committed copy of the ABI, and `test/abi.test.ts`
keeps it identical to the spec and to the build.

## Why this shape, on Arc

- **Gas is USDC.** Arc's native token is USDC, so the broker pays for every registration, receipt and
  relayed rating in dollars (at least the 20 gwei base-fee floor per unit of gas). Every Xorv
  transaction sets its limit from `eth_estimateGas` plus a small margin.
- **Batching.** The 21k intrinsic cost and the cold account accesses are paid once per transaction.
  The broker queues receipts and writes them with one `recordJobs` call. Within a batch, the ledger
  checks each (agent, payTo) pair against the Identity Registry only once.
- **State growth is the expensive part.** A new storage slot is the costliest thing a transaction does,
  while log data is cheap. So each job gets one packed slot (`buyer`, `agentId`, `rated`), which is
  exactly what `rateJob` has to check. Everything else lives in events, which the indexer reads.
  Registrations and heartbeats store nothing.
- **Real identity.** The canonical ERC-8004 v2.0.0 registries are live on both Arc chains. The ledger
  binds payments to them and never deploys its own.
- **Finality.** Arc finalises deterministically in under a second, so a receipt or rating is final
  once its transaction is in a block: there is no reorg window to wait out.

### Gas

`pnpm --filter @xorv/contracts gas` prints every call the broker pays for (deploy,
`registerProvider`, `heartbeat`, `recordJobs` × 1 / 5 / 20, `rateJob` direct, relayed with an EOA
signature and relayed through ERC-1271) on Hardhat's simulated chain, with Ethereum's gas schedule,
and fails if batching stops amortising or a call grows past a loose ceiling. Most of `rateJob`'s gas
is spent inside the registry's `giveFeedback`, which stores the value and both tags; the self-dealing
check adds two registry reads. Keep `tag2` under 32 bytes. For live Arc figures, `eth_estimateGas`
the same calls against `https://rpc.testnet.arc.io`; the cost in USDC is gas × the fee per gas, in
18-decimal native units.

## Use

```sh
pnpm --filter @xorv/contracts build        # compile (solc 0.8.24, cancun, optimizer 200)
pnpm --filter @xorv/contracts test         # tests against the real ERC-8004 code, plus gas and ABI checks
pnpm --filter @xorv/contracts typecheck
pnpm --filter @xorv/contracts abi          # regenerate abi/XorvLedger.json after a contract change
pnpm --filter @xorv/contracts gas          # the gas report on Hardhat's simulated chain
```

The tests need no keys and no network. They deploy the ERC-8004 registries from
[`contracts/vendor/erc8004`](contracts/vendor/erc8004/README.md): verbatim upstream v2.0.0, behind
ERC1967 proxies.

### Deploy and verify

Not from here: the Foundry script deploys XorvLedger to Arc with the rest of Xorv's contracts and
verifies it on Blockscout.

```sh
XORV_BROKER_ADDRESS=0x… scripts/deploy.sh testnet               # from the repo root; gas is paid in USDC
XORV_BROKER_ADDRESS=0x… XORV_VERIFY=1 scripts/deploy.sh testnet # + Blockscout verification
```

It writes `deployments/arc-testnet.json` (or `arc-mainnet.json`) at the repo root, whose
`contracts.XorvLedger` and `blockNumber` are the broker's `XORV_LEDGER_ADDRESS` /
`XORV_LEDGER_FROM_BLOCK`. Testnet USDC for the deployer: <https://faucet.circle.com>, "Arc Testnet".

`hardhat.config.ts` still names the two Arc networks, `arcTestnet` (5042002) and `arcMainnet` (5042),
for ad-hoc `hardhat run` / `hardhat console` against a live chain, with the key in
`XORV_DEPLOYER_KEY` (environment or `pnpm --filter @xorv/contracts exec hardhat keystore set
XORV_DEPLOYER_KEY`) and the RPCs overridable with `ARC_TESTNET_RPC_URL` / `ARC_MAINNET_RPC_URL`.

## Addresses

| | Arc testnet (5042002) | Arc mainnet (5042) |
|---|---|---|
| XorvLedger | `contracts.XorvLedger` in `deployments/arc-testnet.json` | `contracts.XorvLedger` in `deployments/arc-mainnet.json` |
| ERC-8004 Identity | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ERC-8004 Reputation | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| Explorer | <https://explorer.testnet.arc.io> | <https://explorer.arc.io> |

## Trust and limits

- **Owner.** Named at deployment, as a constructor argument. The owner can rotate the broker and
  transfer ownership (in one step, with no accept), and it cannot touch receipts or ratings. Setting
  either role to the zero address is refused. The owner is the recovery plan for a leaked broker key,
  so keep it on a key the broker's host doesn't hold (the Foundry deploy script refuses a mainnet
  deployment whose broker key is the deployer/owner key). To rotate a leaked or retired
  broker key, call `setBroker(<new broker>)` from the owner, then give the broker the new key and
  restart it. Receipts the old key wrote stay valid.
- **Broker.** The broker is the only writer of registrations, heartbeats and receipts, so a leaked
  broker key can forge receipts until the owner rotates it. Ratings still need the recorded buyer's
  signature.
- **The ledger must never own or operate a provider's agent NFT.** ERC-8004 rejects feedback from an
  agent's owner and operators, so doing this would block every rating for that agent. A test
  demonstrates it, and the broker detects it before offering or relaying a rating (409
  `ledger_authorized`).
- **Self-dealing the contract can't see.** The ledger refuses a provider paying itself, and ratings
  from the agent's own wallet, owner or operators. A second wallet that is merely related (one the
  provider funded) is beyond what a contract can see, and `rateJob` stays open to the buyer directly,
  so any off-chain check a relayer makes is advisory. A related wallet still costs the price of each
  job. Weigh ratings by
  distinct paying buyers; the indexer has the `buyer` of every `JobRecorded`.
- **Registry upgrades.** The 8004 team key (`0x5472…2603`) can upgrade the canonical ERC-8004
  registries.
