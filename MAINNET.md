# Xorv on Arc mainnet

Everything here is a config switch away from testnet: the same contracts, script and services, with
`mainnet` in place of `testnet`. **Nothing has been broadcast to mainnet** (this phase is testnet
only; the contracts are live on testnet, see `deployments/arc-testnet.json`).

## 1. Deploy the contracts (one command)

```bash
# from the repo root; Arc Foundry's forge on PATH (or ARC_FORGE=/path/to/forge)
XORV_CONFIRM_MAINNET=1 \
XORV_BROKER_ADDRESS=0x<broker operator address> \
DEPLOYER_ENV=/Volumes/Extreme\ SSD/Projects/arc/.deployer/deployer.env \
  bash scripts/deploy.sh mainnet          # add XORV_VERIFY=1 to verify on explorer.arc.io (Blockscout)
```

What it does (`contracts/script/Deploy.s.sol`, addresses from `contracts/script/ArcConfig.sol`):

| Step | Contract | Wired to |
|---|---|---|
| 1 | `XorvLedger` | ERC-8004 Identity `0x8004A169…a432` / Reputation `0x8004BAa1…9b63`; broker = `XORV_BROKER_ADDRESS`; owner = deployer |
| 2 | `XorvReputation` | the same ERC-8004 registries; owner = deployer |
| 3 | `XorvEscrow` | owner = deployer, attester = `XORV_BROKER_ADDRESS`, registry = XorvReputation, token = USDC `0x3600…0000`, cap `XORV_MAX_JOB_AMOUNT` (default 100 USDC per job) |
| 4 | `reputation.setEscrow(escrow)` | |
| 5 | `XorvCcipReceiver` | Chainlink CCIP router `0xB7979118…3A18` (selector 6370580034781731079), the escrow, USDC |
| 6 | `escrow.setFunder(receiver, true)` | the receiver may fund jobs it received over CCIP |

The script refuses mainnet without `XORV_CONFIRM_MAINNET=1`, refuses a broker that is the deployer,
holds the shared deployer lock (`/Volumes/Extreme SSD/Projects/arc/.deployer/lock`) only around the
broadcast, sends EIP-1559 fees that clear Arc's 20 gwei floor (`ARC_MAX_FEE`, default 60 gwei;
`ARC_PRIORITY_FEE`, default 2 gwei), and writes `deployments/arc-mainnet.json` only after the
broadcast succeeded. It never prints the key.

Then, for cross-chain jobs (optional; each needs gas on that chain):

```bash
cd contracts
set -a; . /Volumes/Extreme\ SSD/Projects/arc/.deployer/deployer.env; set +a   # never echoed
# deploy a XorvCcipSender on Base (CCTP V2 burns to the Arc receiver, CCIP carries the job)
XORV_CONFIRM_MAINNET=1 SOURCE=base ARC_RECEIVER=<XorvCcipReceiver> \
  forge script script/DeploySender.s.sol --rpc-url https://mainnet.base.org --broadcast
# allowlist it on Arc (receiver owner)
XORV_CONFIRM_MAINNET=1 NETWORK=mainnet SOURCE=base ARC_RECEIVER=<XorvCcipReceiver> SENDER=<XorvCcipSender> \
  forge script script/AllowSender.s.sol --network arc --rpc-url https://rpc.mainnet.arc.io \
  --broadcast --with-gas-price 60gwei --priority-gas-price 2gwei
```

Wrap each broadcast in the shared deployer lock, as `scripts/deploy.sh` does.
(`contracts/README.md` has the exact variables for both scripts.)

### Gas, measured

On a fork of Arc testnet, with the real deploy script (`pnpm e2e:arc` / `scripts/arc-fork.sh`):

| | Gas |
|---|---:|
| XorvLedger | 1,963,305 |
| XorvReputation | 1,169,182 |
| XorvEscrow | 2,626,182 |
| setEscrow | 47,693 |
| XorvCcipReceiver | 3,366,818 |
| setFunder | 47,896 |
| **Deploy total** | **9,221,076** |

Arc's base fee sits at its 20 gwei floor, so the deploy costs **≈ 0.20 USDC** (0.2029 USDC measured at
22 gwei effective); budget **0.6 USDC** to cover the 60 gwei max fee the script allows. Mainnet uses the
same fee floor.

Per job, on the same fork: escrow funding through Arc's Memo ≈ 210k gas, release with the ERC-8004
reputation write ≈ 300k (first outcome for a provider; ≈ 140k after), a XorvLedger receipt in a batch
≈ 40–100k, a relayed rating ≈ 280k. A job therefore costs the broker about **0.01 USDC of gas**.

## 2. USDC needed

| Who | Testnet (faucet) | Mainnet |
|---|---:|---:|
| Deployer (contracts) | 0.6 | 0.6 |
| Broker operator = facilitator = escrow attester (gas for funding, releases, receipts, Gateway mints) | 2 | 2 |
| Keeper key (deadline refunds; must not be the attester) | 0.5 | 0.5 |
| Demo buyer (job prices are $0.001–$0.04, plus a Gateway top-up demo) | 2 | 2 |
| Demo provider (ERC-8004 `register` + `bind`, a CCTP withdraw) | 0.5 | 0.5 |
| **Total for deploy + a short demo** | **≈ 5.6 USDC** | **≈ 5.6 USDC** |

Plus, optional: a CCIP job from Base needs the job price + CCTP fee in USDC on Base and the CCIP fee
in ETH there (≈ $0.10–0.50); a Gateway demo needs a USDC deposit on a source chain.

## 3. Services

| Service | Run | Env (Vercel frontend / local broker) |
|---|---|---|
| **Broker** (`services/broker`, Docker image in `Dockerfile`) | `pnpm broker:start` or `docker compose up` | `XORV_NETWORK=eip155:5042`, `XORV_OPERATOR_KEY` (broker address), `XORV_FACILITATOR=self`, `XORV_KEEPER_KEY`, `XORV_LEDGER_ADDRESS`, `XORV_LEDGER_FROM_BLOCK`, `XORV_ESCROW_ADDRESS`, `XORV_REPUTATION_ADDRESS`, `XORV_CCIP_RECEIVER_ADDRESS`, `XORV_CCIP_SENDERS` (if any), `XORV_PUBLIC_URL` (its public https URL; baked into agent and feedback URIs), `XORV_APP_URL`, `XORV_CORS_ORIGINS`, optional `XORV_INDEXER_URL`, AI keys (`DASHSCOPE_API_KEY`, `MOONSHOT_API_KEY`, `TOKENHUB_API_KEY`), optional `XORV_MONGO_URI` |
| **Refund keeper** | inside the broker (every 15 s sweep) | `XORV_KEEPER=on`, `XORV_KEEPER_KEY` |
| **Web app** (`apps/app`, Vercel) | `pnpm --filter xorv-app build` | `NEXT_PUBLIC_XORV_NETWORK=eip155:5042`, `NEXT_PUBLIC_XORV_BROKER_URL`, `NEXT_PUBLIC_XORV_RPC_URL=https://rpc.mainnet.arc.io`, `NEXT_PUBLIC_PRIVY_APP_ID`, server-side `XORV_BROKER_URL`, `XORV_NETWORK` (see `apps/app/.env.example`) |
| **Landing** (`apps/landing`, Vercel) | `pnpm --filter xorv-landing build` | `NEXT_PUBLIC_XORV_BROKER_URL`, `NEXT_PUBLIC_XORV_APP_URL` (see `apps/landing/.env.example`) |
| **Indexer** (optional, Envio Cloud) | `services/indexer`, config `config.mainnet.yaml` | `ENVIO_XORV_LEDGER_ADDRESS`, `ENVIO_XORV_LEDGER_START_BLOCK`, `ENVIO_XORV_ESCROW_ADDRESS`, `ENVIO_XORV_ESCROW_START_BLOCK`, `ENVIO_XORV_REPUTATION_ADDRESS`, `ENVIO_XORV_CCIP_RECEIVER_ADDRESS` |
| **Provider nodes** | `xorv init && xorv identity register && xorv identity bind && xorv start` | `XORV_NETWORK=eip155:5042`, `XORV_BROKER_URL` |

## 4. Owner powers (keep them minimal)

- **XorvEscrow owner**: set the attester, the reputation sink, the identity gate (off), allowed
  tokens, the fee (≤ 5 %, 0 by default), funders, the per-job cap; pause new jobs (never blocks a
  release or refund); `sweep` only what is above `totalEscrowed`. It can never move escrowed money,
  and `renounceOwnership` is disabled. Ownership is two-step.
- **XorvReputation owner**: point it at an escrow. Nothing else.
- **XorvCcipReceiver owner**: allowlist (source selector, sender) pairs, resolve a message that
  still fails after a retry, sweep CCTP fee dust above every committed balance.
- **XorvLedger owner**: rotate the broker key, transfer ownership.

Move ownership to a hardware wallet or multisig after the deploy (`transferOwnership` +
`acceptOwnership` on the escrow, reputation and receiver).
