# Xorv end-to-end run

**PASS** — 68/68 checks, 16 steps, 112.9 s. Started 2026-10-07T19:53:56.925Z.

Produced by `pnpm e2e:arc` (see [README.md](README.md)). Every value below was read back from the
forked chain or the running processes during the run; transaction hashes are local to that fork.

## Environment

| | |
|---|---|
| node | v26.5.0 |
| platform | darwin 25.5.0 |
| fork | arc-anvil --network arc, forking https://rpc.testnet.arc.io |
| duration | 112.9 s |

## Parties

| | |
|---|---|
| deployer (owner of every contract) | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
| broker operator (escrow attester, ledger broker, facilitator) | `0x8E0c4eAD49bBD90A847A1Ce056eE32d04a72650A` |
| keeper (deadline refunds, not the attester) | `0xDAb7D7234fB226c75c434ffEAfFcd48621365041` |
| provider | `0xBb37D5eE88CA52E6b586CDCE31BA0606a5438b01` |
| buyer (holds USDC only, sends no transaction) | `0xad3e986DeF06bbB540F46df9EcE5Ac769889b0e5` |
| CCIP requester (a buyer agent on Base Sepolia) | `0x9cae7D513a9ecf21d020Fc7D154dC190Db0073F8` |

## Chain

| | |
|---|---|
| fork block | 66018240 |
| XorvLedger | `0x1B4379729ef3Ee706AaD789e8b35073EdcDB832B` |
| XorvEscrow | `0x1C75B3F897AD80a1A6fb32f864Cc845aabcC657E` |
| XorvReputation | `0xbD31F44e13513761fC784D17D6ddDa63f9D5259F` |
| XorvCcipReceiver | `0x5ea567E283a0EAbd8377153c6245223BdA5bAE46` |
| deploy gas / cost | 9221076 gas, 0.202863672 USDC |
| provider ERC-8004 agent | #897151 |

## Gas

| | |
|---|---|
| x402 funding gas | 227066 |
| release gas (with the ERC-8004 write) | 324966 |

## Steps

| # | Step | Time | Result |
|---|---|---:|---|
| 1 | preflight | 0.0 s | ok |
| 2 | fork Arc testnet (arc-anvil --network arc, :8810) | 1.3 s | ok |
| 3 | USDC: real FiatToken on Arc, also the gas token | 12.6 s | ok |
| 4 | deploy with scripts/deploy.sh local (XorvLedger, XorvReputation, XorvEscrow, XorvCcipReceiver) | 36.0 s | ok |
| 5 | ERC-8004: the provider registers an agent on Arc's Identity Registry and binds it in XorvReputation | 5.7 s | ok |
| 6 | start the broker (self-hosted facilitator = attester, refund keeper, CCIP watcher) | 3.5 s | ok |
| 7 | provider: go live (xorv start, echo, ERC-8004 agent) | 2.8 s | ok |
| 8 | x402 in USDC: the buyer pays into XorvEscrow (Memo-tagged), the release pays the provider | 8.5 s | ok |
| 9 | ERC-8004: the release wrote the outcome to Arc's Reputation Registry through XorvReputation | 0.0 s | ok |
| 10 | XorvLedger receipts the release; the buyer's gasless rating becomes ERC-8004 feedback | 3.0 s | ok |
| 11 | a buyer's cancel refunds the escrow in full, provider not at fault (Memo-tagged) | 2.7 s | ok |
| 12 | CCIP: the owner allowlists a XorvCcipSender on Base Sepolia (selector + sender) | 1.1 s | ok |
| 13 | CCIP: a buyer agent on Base Sepolia funds a quoted job; the broker runs it and releases it | 15.1 s | ok |
| 14 | refund keeper: an orphaned CCIP job past its deadline is refunded (no fault) and forwarded to the requester | 14.1 s | ok |
| 15 | CCTP V2: the provider withdraws its Arc earnings to Base Sepolia (real TokenMessengerV2) | 6.0 s | ok |
| 16 | Circle Gateway: the broker reads a unified balance from Circle's live testnet API | 0.4 s | ok |

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
| ✅ | escrow attester is the broker | `0x8E0c4eAD49bBD90A847A1Ce056eE32d04a72650A` |
| ✅ | escrow reports outcomes to XorvReputation | `0xbD31F44e13513761fC784D17D6ddDa63f9D5259F` |
| ✅ | escrow lets the CCIP receiver fund jobs | true |
| ✅ | escrow per-job cap is 100 USDC | 100000000 |

### ERC-8004: the provider registers an agent on Arc's Identity Registry and binds it in XorvReputation

| | Check | Detail |
|---|---|---|
| ✅ | agent wallet is the provider's payout address | `0xBb37D5eE88CA52E6b586CDCE31BA0606a5438b01` |
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
| ✅ | funding moved exactly the price buyer → XorvEscrow | [{"from":"0xad3e986DeF06bbB540F46df9EcE5Ac769889b0e5","to":"0x1C75B3F897AD80a1A6fb32f864Cc845aabcC657E","value":"1000"}] |
| ✅ | funding sent by the facilitator (the buyer sent nothing) | `0x8E0c4eAD49bBD90A847A1Ce056eE32d04a72650A` |
| ✅ | buyer never sent a transaction (nonce 0) | 0 |
| ✅ | Arc Memo on the funding: memoId = job id, target = escrow, text xorv:fund | [{"id":"0x9df182e99afb5b0190ee51ac4a1922986e73a59d3600a1a48eb1b988c2ceb988","t":"xorv:fund"}] |
| ✅ | JobReleased pays the provider | `0xBb37D5eE88CA52E6b586CDCE31BA0606a5438b01` |
| ✅ | JobReleased carries the result's hash | `0x0b39927718dc1ff60b7406c0ffae6b85b37a595241c75b04b4451ae2320af9ec` |
| ✅ | Arc Memo on the release: memoId = job id, text xorv:release |  |
| ✅ | buyer paid exactly the price | 1000 |
| ✅ | provider received exactly the price | 1000 |

### ERC-8004: the release wrote the outcome to Arc's Reputation Registry through XorvReputation

| | Check | Detail |
|---|---|---|
| ✅ | OutcomeRecorded(success, feedbackWritten) | {"jobId":"0x9df182e99afb5b0190ee51ac4a1922986e73a59d3600a1a48eb1b988c2ceb988","provider":"0xBb37D5eE88CA52E6b586CDCE31BA0606a5438b01","agentId":"897151","success":true,"amount":"1000","feedbackWritten":true} |
| ✅ | NewFeedback client is XorvReputation | `0xbD31F44e13513761fC784D17D6ddDa63f9D5259F` |
| ✅ | feedback value 100 (released) | 100 |
| ✅ | feedback tag1 | successRate |
| ✅ | feedback tag2 | xorv-escrow |
| ✅ | feedbackHash is the escrow job id | `0x9df182e99afb5b0190ee51ac4a1922986e73a59d3600a1a48eb1b988c2ceb988` |
| ✅ | XorvReputation stats: 1 completed, 0 failed, earned the price | 1/0/1000 |
| ✅ | broker serves the escrow record with the agent | {"configured":true,"reputation":"0xbD31F44e13513761fC784D17D6ddDa63f9D5259F","completed":1,"failed":0,"earnedUnits":"1000","scoreBps":6666,"agentId":"897151","reputationUrl":"https://explorer.testnet.arc.io/address/0xbD31F44e13513761fC784D17D6ddDa63f9D5259F","agentUrl":"https://explorer.testnet.arc.io/token/0x8004A818BFB912233c491871b3d84c89A494BD9e/instance/897151","erc8004Reputation":"0x8004B663056A597Dffe9eCcC1965A193B7388713"} |

### XorvLedger receipts the release; the buyer's gasless rating becomes ERC-8004 feedback

| | Check | Detail |
|---|---|---|
| ✅ | JobRecorded.paymentTx is the release | `0xf0b3f27394822f5b2ef0f8d3f5f9af90d0d1b519ee957e8cd66e92f120c1ebd8` |
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
| ✅ | payer is the requester | `0x9cae7D513a9ecf21d020Fc7D154dC190Db0073F8` |
| ✅ | CCIP message id | `0xa827d8734cea30600cbae8abbc8efe457fc5952eacbf1db21c852112dddbf6a6` |
| ✅ | receiver intent status Released | 3 |
| ✅ | requester spent nothing on Arc | 0 |

### Refund keeper: an orphaned CCIP job past its deadline is refunded (no fault) and forwarded to the requester

| | Check | Detail |
|---|---|---|
| ✅ | escrow status Refunded | 3 |
| ✅ | refunded by the keeper key | `0xDAb7D7234fB226c75c434ffEAfFcd48621365041` |
| ✅ | deadline refund is not the provider's fault | false |
| ✅ | requester got the price back on Arc | 2000 |

### CCTP V2: the provider withdraws its Arc earnings to Base Sepolia (real TokenMessengerV2)

| | Check | Detail |
|---|---|---|
| ✅ | DepositForBurn to domain 6 (Base Sepolia) | 6 |
| ✅ | burned amount | 1000000 |
| ✅ | mint recipient is the provider | `0x000000000000000000000000bb37d5ee88ca52e6b586cdce31ba0606a5438b01` |
| ✅ | provider's USDC debited by the amount (plus gas, paid in USDC) | 1003690 |

### Circle Gateway: the broker reads a unified balance from Circle's live testnet API

| | Check | Detail |
|---|---|---|
| ✅ | a fresh buyer's unified balance is 0 | 0 |
| ✅ | Circle answered per source domain | 7 |
| ✅ | burn intent targets Arc (domain 26) | 26 |

## Step log

**preflight**

- run directory /Volumes/Extreme SSD/Projects/arc/xorv-arc/e2e/.runs/arc-6altg3

**fork Arc testnet (arc-anvil --network arc, :8810)**

- serving http://127.0.0.1:8810, forked at block 66018240

**deploy with scripts/deploy.sh local (XorvLedger, XorvReputation, XorvEscrow, XorvCcipReceiver)**

- ledger 0x1B4379729ef3Ee706AaD789e8b35073EdcDB832B, escrow 0x1C75B3F897AD80a1A6fb32f864Cc845aabcC657E, reputation 0xbD31F44e13513761fC784D17D6ddDa63f9D5259F, ccip receiver 0x5ea567E283a0EAbd8377153c6245223BdA5bAE46
- deploy gas 9221076 (0.202863672 USDC)

**ERC-8004: the provider registers an agent on Arc's Identity Registry and binds it in XorvReputation**

- agent #897151 (register 0x7c62bb222184b1a55fdfb6a8795075bf1ccf1e9507f507b2cbdeb39e7cd6aed0)

**start the broker (self-hosted facilitator = attester, refund keeper, CCIP watcher)**

- listening on http://127.0.0.1:8812

**provider: go live (xorv start, echo, ERC-8004 agent)**

- provider prv_BTCsXhJxNd44 connected

**x402 in USDC: the buyer pays into XorvEscrow (Memo-tagged), the release pays the provider**

- fund 0xb34d7e8e01c7318555b05f140ea12a526c58502e9aa5bc979e2182787492edc1, release 0xf0b3f27394822f5b2ef0f8d3f5f9af90d0d1b519ee957e8cd66e92f120c1ebd8

**XorvLedger receipts the release; the buyer's gasless rating becomes ERC-8004 feedback**

- rate 0xde035e3f7c21b02204f5d8bf2834d4a1c27d1a87b6bd927eb3fa4035a0bc60a8

**a buyer's cancel refunds the escrow in full, provider not at fault (Memo-tagged)**

- refund 0xa0ae9ff5803f95926eb5c18f491cc740dafcae85e9c7c3d150da03c210b38e65

**CCIP: a buyer agent on Base Sepolia funds a quoted job; the broker runs it and releases it**

- ccipReceive 0x7ab71d25556bf7fc4cc98ae023b0640926bd4fb203a48d1a8347ce32dd9f47b3, release 0x00cda84e1a206a675bf00abd101afb7d2811b612d931d8da2263427b0ae51352

**refund keeper: an orphaned CCIP job past its deadline is refunded (no fault) and forwarded to the requester**

- refund 0x113fb36418af3559f5fd9ae5f60f6e3a94361c08d9b82309c380dab0d1ada83f

**CCTP V2: the provider withdraws its Arc earnings to Base Sepolia (real TokenMessengerV2)**

- burn 0x4c6a4bff50ed7ae0c5a859251e13d4c574c79d9bc7c3e65c0ed5a2318601b2a8; the mint on Base Sepolia needs Circle's attestation, which a fork can't get

**Circle Gateway: the broker reads a unified balance from Circle's live testnet API**

- spending a real Gateway balance needs testnet USDC deposited on a source chain (user-run)
