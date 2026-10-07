# Xorv end-to-end run

**FAIL** — 0 of 11 checks failed; stopped at "start the broker (self-hosted facilitator = attester, refund keeper, CCIP watcher)": timed out after 60000ms waiting for the broker to answer /health (last error: fetch failed). 88.9 s, started 2026-10-07T18:36:39.748Z.

Produced by `pnpm e2e:arc` (see [README.md](README.md)). Every value below was read back from the
forked chain or the running processes during the run; transaction hashes are local to that fork.

## Error

```
timed out after 60000ms waiting for the broker to answer /health (last error: fetch failed)
```

## Environment

| | |
|---|---|
| node | v26.5.0 |
| platform | darwin 25.5.0 |
| fork | arc-anvil --network arc, forking https://rpc.testnet.arc.io |
| duration | 88.9 s |

## Parties

| | |
|---|---|
| deployer (owner of every contract) | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
| broker operator (escrow attester, ledger broker, facilitator) | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |
| keeper (deadline refunds, not the attester) | `0x0f1B20c8321dbD20Ec834a10362bC62493F75cC7` |
| provider | `0x4a55750d3AEb1E629fA16f77407Ed1b720593Aff` |
| buyer (holds USDC only, sends no transaction) | `0xEe9c59Fbab84112831dd872Be62400B49b6a0569` |
| CCIP requester (a buyer agent on Base Sepolia) | `0x3526eA94a2f33dD087bd6E7fe56D2d74adc60D3B` |

## Chain

| | |
|---|---|
| fork block | 66009092 |
| XorvLedger | `0x1B4379729ef3Ee706AaD789e8b35073EdcDB832B` |
| XorvEscrow | `0x1C75B3F897AD80a1A6fb32f864Cc845aabcC657E` |
| XorvReputation | `0xbD31F44e13513761fC784D17D6ddDa63f9D5259F` |
| XorvCcipReceiver | `0x5ea567E283a0EAbd8377153c6245223BdA5bAE46` |
| deploy gas / cost | 9221076 gas, 0.202863672 USDC |
| provider ERC-8004 agent | #897150 |

## Steps

| # | Step | Time | Result |
|---|---|---:|---|
| 1 | preflight | 0.0 s | ok |
| 2 | fork Arc testnet (arc-anvil --network arc, :8810) | 4.1 s | ok |
| 3 | USDC: real FiatToken on Arc, also the gas token | 6.4 s | ok |
| 4 | deploy with scripts/deploy.sh local (XorvLedger, XorvReputation, XorvEscrow, XorvCcipReceiver) | 12.3 s | ok |
| 5 | ERC-8004: the provider registers an agent on Arc's Identity Registry and binds it in XorvReputation | 5.5 s | ok |
| 6 | start the broker (self-hosted facilitator = attester, refund keeper, CCIP watcher) | 60.4 s | FAILED |

## Checks

### USDC: real FiatToken on Arc, also the gas token

| | Check | Detail |
|---|---|---|
| ✅ | USDC EIP-712 name | USDC |
| ✅ | USDC EIP-712 version | 2 |
| ✅ | buyer USDC (ERC-20 view) | 5000000 |
| ✅ | buyer native balance is the same USDC with 18 decimals | 5000000000000000000 |

### Deploy with scripts/deploy.sh local (XorvLedger, XorvReputation, XorvEscrow, XorvCcipReceiver)

| | Check | Detail |
|---|---|---|
| ✅ | escrow attester is the broker | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |
| ✅ | escrow reports outcomes to XorvReputation | `0xbD31F44e13513761fC784D17D6ddDa63f9D5259F` |
| ✅ | escrow lets the CCIP receiver fund jobs | true |
| ✅ | escrow per-job cap is 100 USDC | 100000000 |

### ERC-8004: the provider registers an agent on Arc's Identity Registry and binds it in XorvReputation

| | Check | Detail |
|---|---|---|
| ✅ | agent wallet is the provider's payout address | `0x4a55750d3AEb1E629fA16f77407Ed1b720593Aff` |
| ✅ | XorvReputation binds the provider to its agent | true #897150 |
| ✅ | binding is live | true |

## Step log

**preflight**

- run directory /Volumes/Extreme SSD/Projects/arc/xorv-arc/e2e/.runs/arc-MvTUC8

**fork Arc testnet (arc-anvil --network arc, :8810)**

- serving http://127.0.0.1:8810, forked at block 66009092

**deploy with scripts/deploy.sh local (XorvLedger, XorvReputation, XorvEscrow, XorvCcipReceiver)**

- ledger 0x1B4379729ef3Ee706AaD789e8b35073EdcDB832B, escrow 0x1C75B3F897AD80a1A6fb32f864Cc845aabcC657E, reputation 0xbD31F44e13513761fC784D17D6ddDa63f9D5259F, ccip receiver 0x5ea567E283a0EAbd8377153c6245223BdA5bAE46
- deploy gas 9221076 (0.202863672 USDC)

**ERC-8004: the provider registers an agent on Arc's Identity Registry and binds it in XorvReputation**

- agent #897150 (register 0x3bb03fa7343c688fca8f6d22ab2f976fec50691bf6ed4d85324a6bb41e0b4f01)

**start the broker (self-hosted facilitator = attester, refund keeper, CCIP watcher)**

- timed out after 60000ms waiting for the broker to answer /health (last error: fetch failed)
