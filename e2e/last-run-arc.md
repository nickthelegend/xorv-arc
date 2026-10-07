# Xorv end-to-end run

**PASS** — 68/68 checks, 16 steps, 85.2 s. Started 2026-10-07T19:20:51.436Z.

Produced by `pnpm e2e:arc` (see [README.md](README.md)). Every value below was read back from the
forked chain or the running processes during the run; transaction hashes are local to that fork.

## Environment

| | |
|---|---|
| node | v26.5.0 |
| platform | darwin 25.5.0 |
| fork | arc-anvil --network arc, forking https://rpc.testnet.arc.io |
| duration | 85.2 s |

## Parties

| | |
|---|---|
| deployer (owner of every contract) | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
| broker operator (escrow attester, ledger broker, facilitator) | `0xa8A496Aa14f2375d1BCb69EcAD7Eb1e3ee0f42E1` |
| keeper (deadline refunds, not the attester) | `0xA1c372E52a7a5992b1C7a387AF5051F979BA0d95` |
| provider | `0x3AC53ebe9dAaCEdc9FBDBB73076bb52ba190060e` |
| buyer (holds USDC only, sends no transaction) | `0x7D43FBc43504cCB3A760cB0acC0555eb783f04F7` |
| CCIP requester (a buyer agent on Base Sepolia) | `0x361354c4543DAC241144E2734d622ED43D150bf8` |

## Chain

| | |
|---|---|
| fork block | 66014325 |
| XorvLedger | `0x1B4379729ef3Ee706AaD789e8b35073EdcDB832B` |
| XorvEscrow | `0x1C75B3F897AD80a1A6fb32f864Cc845aabcC657E` |
| XorvReputation | `0xbD31F44e13513761fC784D17D6ddDa63f9D5259F` |
| XorvCcipReceiver | `0x5ea567E283a0EAbd8377153c6245223BdA5bAE46` |
| deploy gas / cost | 9221076 gas, 0.202863672 USDC |
| provider ERC-8004 agent | #897151 |

## Gas

| | |
|---|---|
| x402 funding gas | 227110 |
| release gas (with the ERC-8004 write) | 324990 |

## Steps

| # | Step | Time | Result |
|---|---|---:|---|
| 1 | preflight | 0.0 s | ok |
| 2 | fork Arc testnet (arc-anvil --network arc, :8810) | 4.4 s | ok |
| 3 | USDC: real FiatToken on Arc, also the gas token | 6.7 s | ok |
| 4 | deploy with scripts/deploy.sh local (XorvLedger, XorvReputation, XorvEscrow, XorvCcipReceiver) | 13.1 s | ok |
| 5 | ERC-8004: the provider registers an agent on Arc's Identity Registry and binds it in XorvReputation | 5.5 s | ok |
| 6 | start the broker (self-hosted facilitator = attester, refund keeper, CCIP watcher) | 2.9 s | ok |
| 7 | provider: go live (xorv start, echo, ERC-8004 agent) | 3.2 s | ok |
| 8 | x402 in USDC: the buyer pays into XorvEscrow (Memo-tagged), the release pays the provider | 8.1 s | ok |
| 9 | ERC-8004: the release wrote the outcome to Arc's Reputation Registry through XorvReputation | 0.0 s | ok |
| 10 | XorvLedger receipts the release; the buyer's gasless rating becomes ERC-8004 feedback | 4.9 s | ok |
| 11 | a buyer's cancel refunds the escrow in full, provider not at fault (Memo-tagged) | 2.5 s | ok |
| 12 | CCIP: the owner allowlists a XorvCcipSender on Base Sepolia (selector + sender) | 1.2 s | ok |
| 13 | CCIP: a buyer agent on Base Sepolia funds a quoted job; the broker runs it and releases it | 13.9 s | ok |
| 14 | refund keeper: an orphaned CCIP job past its deadline is refunded (no fault) and forwarded to the requester | 13.2 s | ok |
| 15 | CCTP V2: the provider withdraws its Arc earnings to Base Sepolia (real TokenMessengerV2) | 5.0 s | ok |
| 16 | Circle Gateway: the broker reads a unified balance from Circle's live testnet API | 0.5 s | ok |

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
| ✅ | escrow attester is the broker | `0xa8A496Aa14f2375d1BCb69EcAD7Eb1e3ee0f42E1` |
| ✅ | escrow reports outcomes to XorvReputation | `0xbD31F44e13513761fC784D17D6ddDa63f9D5259F` |
| ✅ | escrow lets the CCIP receiver fund jobs | true |
| ✅ | escrow per-job cap is 100 USDC | 100000000 |

### ERC-8004: the provider registers an agent on Arc's Identity Registry and binds it in XorvReputation

| | Check | Detail |
|---|---|---|
| ✅ | agent wallet is the provider's payout address | `0x3AC53ebe9dAaCEdc9FBDBB73076bb52ba190060e` |
| ✅ | XorvReputation binds the provider to its agent | true #897151 |
| ✅ | binding is live | true |

### Start the broker (self-hosted facilitator = attester, refund keeper, CCIP watcher)

| | Check | Detail |
|---|---|---|
| ✅ | broker reports the escrow | `0x1C75B3F897AD80a1A6fb32f864Cc845aabcC657E` |
| ✅ | Arc stack: gas token | USDC |
| ✅ | Arc stack: Memo tagging on | true |
| ✅ | Arc stack: XorvReputation | `0xbD31F44e13513761fC784D17D6ddDa63f9D5259F` |
| ✅ | Arc stack: CCIP receiver | `0x5ea567E283a0EAbd8377153c6245223BdA5bAE46` |
| ✅ | Arc stack: refund keeper on | true |

### Provider: go live (xorv start, echo, ERC-8004 agent)

| | Check | Detail |
|---|---|---|
| ✅ | broker verified the provider's ERC-8004 agent | 897151 |

### X402 in USDC: the buyer pays into XorvEscrow (Memo-tagged), the release pays the provider

| | Check | Detail |
|---|---|---|
| ✅ | the quote names the escrow | `0x1C75B3F897AD80a1A6fb32f864Cc845aabcC657E` |
| ✅ | the 402 offers escrow first | escrow |
| ✅ | job completed | completed |
| ✅ | funding moved exactly the price buyer → XorvEscrow | [{"from":"0x7D43FBc43504cCB3A760cB0acC0555eb783f04F7","to":"0x1C75B3F897AD80a1A6fb32f864Cc845aabcC657E","value":"1000"}] |
| ✅ | funding sent by the facilitator (the buyer sent nothing) | `0xa8A496Aa14f2375d1BCb69EcAD7Eb1e3ee0f42E1` |
| ✅ | buyer never sent a transaction (nonce 0) | 0 |
| ✅ | Arc Memo on the funding: memoId = job id, target = escrow, text xorv:fund | [{"id":"0x4480ddb2f2f64efce234a667ff23e04772764dbfe5128b3672fc3899b88ee7f5","t":"xorv:fund"}] |
| ✅ | JobReleased pays the provider | `0x3AC53ebe9dAaCEdc9FBDBB73076bb52ba190060e` |
| ✅ | JobReleased carries the result's hash | `0x0b39927718dc1ff60b7406c0ffae6b85b37a595241c75b04b4451ae2320af9ec` |
| ✅ | Arc Memo on the release: memoId = job id, text xorv:release |  |
| ✅ | buyer paid exactly the price | 1000 |
| ✅ | provider received exactly the price | 1000 |

### ERC-8004: the release wrote the outcome to Arc's Reputation Registry through XorvReputation

| | Check | Detail |
|---|---|---|
| ✅ | OutcomeRecorded(success, feedbackWritten) | {"jobId":"0x4480ddb2f2f64efce234a667ff23e04772764dbfe5128b3672fc3899b88ee7f5","provider":"0x3AC53ebe9dAaCEdc9FBDBB73076bb52ba190060e","agentId":"897151","success":true,"amount":"1000","feedbackWritten":true} |
| ✅ | NewFeedback client is XorvReputation | `0xbD31F44e13513761fC784D17D6ddDa63f9D5259F` |
| ✅ | feedback value 100 (released) | 100 |
| ✅ | feedback tag1 | successRate |
| ✅ | feedback tag2 | xorv-escrow |
| ✅ | feedbackHash is the escrow job id | `0x4480ddb2f2f64efce234a667ff23e04772764dbfe5128b3672fc3899b88ee7f5` |
| ✅ | XorvReputation stats: 1 completed, 0 failed, earned the price | 1/0/1000 |
| ✅ | broker serves the escrow record with the agent | {"configured":true,"reputation":"0xbD31F44e13513761fC784D17D6ddDa63f9D5259F","completed":1,"failed":0,"earnedUnits":"1000","scoreBps":6666,"agentId":"897151","reputationUrl":"https://explorer.testnet.arc.io/address/0xbD31F44e13513761fC784D17D6ddDa63f9D5259F","agentUrl":"https://explorer.testnet.arc.io/token/0x8004A818BFB912233c491871b3d84c89A494BD9e/instance/897151","erc8004Reputation":"0x8004B663056A597Dffe9eCcC1965A193B7388713"} |

### XorvLedger receipts the release; the buyer's gasless rating becomes ERC-8004 feedback

| | Check | Detail |
|---|---|---|
| ✅ | JobRecorded.paymentTx is the release | `0xcfd19e95dc25cef7b108376510444061861e294f1c20d6cd79fd8d8b64174ed2` |
| ✅ | JobRecorded.agentId is the provider's agent | 897151 |
| ✅ | rating feedback client is XorvLedger | `0x1B4379729ef3Ee706AaD789e8b35073EdcDB832B` |
| ✅ | rating value | 95 |
| ✅ | rating tag1 | starred |

### A buyer's cancel refunds the escrow in full, provider not at fault (Memo-tagged)

| | Check | Detail |
|---|---|---|
| ✅ | JobRefunded, provider not at fault | false |
| ✅ | Arc Memo on the refund (xorv:cancel) |  |
| ✅ | buyer made whole | 4999000 |

### CCIP: the owner allowlists a XorvCcipSender on Base Sepolia (selector + sender)

| | Check | Detail |
|---|---|---|
| ✅ | allowlisted | true |

### CCIP: a buyer agent on Base Sepolia funds a quoted job; the broker runs it and releases it

| | Check | Detail |
|---|---|---|
| ✅ | CCIP terms name the receiver | `0x5ea567E283a0EAbd8377153c6245223BdA5bAE46` |
| ✅ | CCIP terms carry Arc's selector | 3034092155422581607 |
| ✅ | Base Sepolia is a CCIP source |  |
| ✅ | escrow JobFunded by the receiver (buyer of record) | `0x5ea567E283a0EAbd8377153c6245223BdA5bAE46` |
| ✅ | job payment is cross-chain via CCIP | ccip |
| ✅ | source chain | Base Sepolia |
| ✅ | payer is the requester | `0x361354c4543DAC241144E2734d622ED43D150bf8` |
| ✅ | CCIP message id | `0xa0ba6e640b19c5e5e21fa97da9faeacf7b939c688d26383540cad037cd698be0` |
| ✅ | receiver intent status Released | 3 |
| ✅ | requester spent nothing on Arc | 0 |

### Refund keeper: an orphaned CCIP job past its deadline is refunded (no fault) and forwarded to the requester

| | Check | Detail |
|---|---|---|
| ✅ | escrow status Refunded | 3 |
| ✅ | refunded by the keeper key | `0xA1c372E52a7a5992b1C7a387AF5051F979BA0d95` |
| ✅ | deadline refund is not the provider's fault | false |
| ✅ | requester got the price back on Arc | 2000 |

### CCTP V2: the provider withdraws its Arc earnings to Base Sepolia (real TokenMessengerV2)

| | Check | Detail |
|---|---|---|
| ✅ | DepositForBurn to domain 6 (Base Sepolia) | 6 |
| ✅ | burned amount | 1000000 |
| ✅ | mint recipient is the provider | `0x0000000000000000000000003ac53ebe9daacedc9fbdbb73076bb52ba190060e` |
| ✅ | provider's USDC debited by the amount (plus gas, paid in USDC) | 1003690 |

### Circle Gateway: the broker reads a unified balance from Circle's live testnet API

| | Check | Detail |
|---|---|---|
| ✅ | a fresh buyer's unified balance is 0 | 0 |
| ✅ | Circle answered per source domain | 7 |
| ✅ | burn intent targets Arc (domain 26) | 26 |

## Step log

**preflight**

- run directory /Volumes/Extreme SSD/Projects/arc/xorv-arc/e2e/.runs/arc-9IcgvQ

**fork Arc testnet (arc-anvil --network arc, :8810)**

- serving http://127.0.0.1:8810, forked at block 66014325

**deploy with scripts/deploy.sh local (XorvLedger, XorvReputation, XorvEscrow, XorvCcipReceiver)**

- ledger 0x1B4379729ef3Ee706AaD789e8b35073EdcDB832B, escrow 0x1C75B3F897AD80a1A6fb32f864Cc845aabcC657E, reputation 0xbD31F44e13513761fC784D17D6ddDa63f9D5259F, ccip receiver 0x5ea567E283a0EAbd8377153c6245223BdA5bAE46
- deploy gas 9221076 (0.202863672 USDC)

**ERC-8004: the provider registers an agent on Arc's Identity Registry and binds it in XorvReputation**

- agent #897151 (register 0x59c17301263eada4d4a8c2805ca44844ef7cc5c9ee20bc66c47ffe3bc7dc24e3)

**start the broker (self-hosted facilitator = attester, refund keeper, CCIP watcher)**

- listening on http://127.0.0.1:8812

**provider: go live (xorv start, echo, ERC-8004 agent)**

- provider prv_kdJLv_C7H8ek connected

**x402 in USDC: the buyer pays into XorvEscrow (Memo-tagged), the release pays the provider**

- fund 0xfaacfc40173a11086465e476b144b342d56ecca64ed497bda32542071e1f02f3, release 0xcfd19e95dc25cef7b108376510444061861e294f1c20d6cd79fd8d8b64174ed2

**XorvLedger receipts the release; the buyer's gasless rating becomes ERC-8004 feedback**

- rate 0x586f5f850d403b22a7bff6883388e11933223c5dd65b34b448fed203c7c42f82

**a buyer's cancel refunds the escrow in full, provider not at fault (Memo-tagged)**

- refund 0x83a9ea2e1c4ee3aa9d6fc41b6fb6bdfb11549fc7fd432aef3b4b8c61cfda3b64

**CCIP: a buyer agent on Base Sepolia funds a quoted job; the broker runs it and releases it**

- ccipReceive 0x6d9f419a6c348bbd427b1a53c5af1d7ca930c32bc654b7998883c6fcec47c164, release 0xf2b7f0107feaabdf4e527664270f681da5802236cc83302e98df8dc9d0a2076b

**refund keeper: an orphaned CCIP job past its deadline is refunded (no fault) and forwarded to the requester**

- refund 0xcd26148e9ed16bac7d6950134c4394e0b10a43b56dc3822fb6ffb7d3c8c1fe38

**CCTP V2: the provider withdraws its Arc earnings to Base Sepolia (real TokenMessengerV2)**

- burn 0xedc12156da6dafb2e491b1807d310bff2586efed53d34b1608dbccf64eb91a64; the mint on Base Sepolia needs Circle's attestation, which a fork can't get

**Circle Gateway: the broker reads a unified balance from Circle's live testnet API**

- spending a real Gateway balance needs testnet USDC deposited on a source chain (user-run)
