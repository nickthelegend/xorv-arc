# Xorv end-to-end run on the public Arc testnet

**PASS** — 46/46 checks, 10 steps, 36.2 s. Started 2026-10-13T17:04:58.213Z.

Produced by `pnpm e2e:testnet`. Every value below was read back from Arc testnet (chain 5042002) or the running processes;
every transaction hash is a real transaction, linked to the Arc explorer.

## Environment

| | |
|---|---|
| node | v26.5.0 |
| platform | darwin 25.5.0 |
| chain | Arc testnet (5042002) via https://rpc.testnet.arc.io, no fork |
| duration | 36.2 s |

## Parties

| | |
|---|---|
| broker operator (escrow attester, ledger broker, facilitator, verifier) | [0xE52CdC89762203459690B5B142EE6Fe3Dc5C1d2F](https://explorer.testnet.arc.io/address/0xE52CdC89762203459690B5B142EE6Fe3Dc5C1d2F) |
| keeper (deadline refunds) | [0x4E03441892e8EBe4F35018bE59C83a64bDE40319](https://explorer.testnet.arc.io/address/0x4E03441892e8EBe4F35018bE59C83a64bDE40319) |
| provider | [0x565B23e96fc888C791FC9eb71586aA5c36BEE91d](https://explorer.testnet.arc.io/address/0x565B23e96fc888C791FC9eb71586aA5c36BEE91d) |
| buyer (holds USDC only, sends no transaction) | [0xa07dc14797A8F968E2e9831666e751E63e5c171e](https://explorer.testnet.arc.io/address/0xa07dc14797A8F968E2e9831666e751E63e5c171e) |

## Contracts

| | |
|---|---|
| XorvLedger | [0x035c1f8CD3330EDd547230D578037Ebee4020Cbc](https://explorer.testnet.arc.io/address/0x035c1f8CD3330EDd547230D578037Ebee4020Cbc) |
| XorvEscrow | [0x2827Bb9B8109d602fa617f043A10E47Ef5aEc9eA](https://explorer.testnet.arc.io/address/0x2827Bb9B8109d602fa617f043A10E47Ef5aEc9eA) |
| XorvReputation | [0xe9cCAa186AA7D8dC8CD8c05F964a05E83296Fd89](https://explorer.testnet.arc.io/address/0xe9cCAa186AA7D8dC8CD8c05F964a05E83296Fd89) |
| XorvCcipReceiver | [0x61d6eC91320be18A4D0499b872307fA781f427B0](https://explorer.testnet.arc.io/address/0x61d6eC91320be18A4D0499b872307fA781f427B0) |

## Transactions

| | |
|---|---|
| fund the fresh provider with 0.05 USDC | [0xb82c6c4e3dd6fc2da8a83af01afbcb52d91716e7ced4a241ef30690ed9abff1a](https://explorer.testnet.arc.io/tx/0xb82c6c4e3dd6fc2da8a83af01afbcb52d91716e7ced4a241ef30690ed9abff1a) |
| ERC-8004 Identity Registry: register() | [0x02c03cc36be7531c976c45547e41b31c2661710826faf5b655e5d6a8c005719e](https://explorer.testnet.arc.io/tx/0x02c03cc36be7531c976c45547e41b31c2661710826faf5b655e5d6a8c005719e) |
| XorvReputation.bind(agent) | [0xedcd7496f2f56b4fed8319b14087b50c18c3f3293c136e460f05258c49a25641](https://explorer.testnet.arc.io/tx/0xedcd7496f2f56b4fed8319b14087b50c18c3f3293c136e460f05258c49a25641) |
| x402 funding: buyer -> XorvEscrow (sent by the facilitator) | [0x016e7aab3a3e222ce39b8d7492c30c9b9fb5d93a193de6c9a62fcc1b9ad389e6](https://explorer.testnet.arc.io/tx/0x016e7aab3a3e222ce39b8d7492c30c9b9fb5d93a193de6c9a62fcc1b9ad389e6) |
| escrow release -> provider (+ ERC-8004 feedback) | [0x7fa0318fc98d7cacd1a3ff17b4e9f9aba428de76f48ec3dcaa3dd1c18cdc68af](https://explorer.testnet.arc.io/tx/0x7fa0318fc98d7cacd1a3ff17b4e9f9aba428de76f48ec3dcaa3dd1c18cdc68af) |
| XorvLedger.recordJobs (receipt) | [0xbe8702c705bc8e34703ca73f4348a4087628c2358c55a4fa234df660afb4c8cf](https://explorer.testnet.arc.io/tx/0xbe8702c705bc8e34703ca73f4348a4087628c2358c55a4fa234df660afb4c8cf) |
| buyer rating (EIP-712, relayed by the broker) -> ERC-8004 feedback | [0xd9d6b9dc6da24c0754b8a521c1e90d8af2272ae3f341de35455d4a55babe3976](https://explorer.testnet.arc.io/tx/0xd9d6b9dc6da24c0754b8a521c1e90d8af2272ae3f341de35455d4a55babe3976) |
| AI job: x402 funding -> XorvEscrow | [0x274811a9f489a37c5ad2998a5d8e186ed769888f1e36305f8ae65a3f8a56fb16](https://explorer.testnet.arc.io/tx/0x274811a9f489a37c5ad2998a5d8e186ed769888f1e36305f8ae65a3f8a56fb16) |
| AI job: escrow release -> provider | [0xde04dd6256439d69a27ff3a3d532fa1cb3d4bfa48e97e434f133380d58af0486](https://explorer.testnet.arc.io/tx/0xde04dd6256439d69a27ff3a3d532fa1cb3d4bfa48e97e434f133380d58af0486) |
| verifier: ERC-8004 giveFeedback (xorv-verified) | [0xbb3c26af48715e04029179a6ee92126e08b2a8e8919fa2abf734db6dbe89e394](https://explorer.testnet.arc.io/tx/0xbb3c26af48715e04029179a6ee92126e08b2a8e8919fa2abf734db6dbe89e394) |

## Chain

| | |
|---|---|
| provider ERC-8004 agent | #897280 ([registry](https://explorer.testnet.arc.io/address/0x8004A818BFB912233c491871b3d84c89A494BD9e)) |

## Gas

| | |
|---|---|
| x402 funding gas | 227110 |
| release gas (with the ERC-8004 write) | 324990 |

## Balances

| | |
|---|---|
| buyer USDC spent | 0.041 |
| provider USDC net (earnings minus gas) | 0.034935 |
| operator USDC spent on gas | 0.042303 |
| transactions (excluding the faucet transfers) | 10 |

## Steps

| # | Step | Time | Result |
|---|---|---:|---|
| 1 | fund a fresh provider key (0.05 USDC) from the configured provider | 1.0 s | ok |
| 2 | preflight: built, public RPC reachable, deployment is live, parties funded | 1.4 s | ok |
| 3 | start the mock OpenAI-compatible model server | 0.0 s | ok |
| 4 | ERC-8004: the provider registers an agent (xorv identity register) and binds it in XorvReputation | 5.6 s | ok |
| 5 | start the broker against the public RPC (facilitator = attester, keeper, ledger receipts, AI roles on the mock) | 0.5 s | ok |
| 6 | provider: go live (xorv start, echo + qwen adapters, ERC-8004 agent) | 2.5 s | ok |
| 7 | x402 in USDC: the buyer pays into XorvEscrow (Memo-tagged); delivery releases to the provider | 7.7 s | ok |
| 8 | ERC-8004: the release wrote the outcome to the Reputation Registry through XorvReputation | 1.0 s | ok |
| 9 | XorvLedger receipts the release; the buyer's gasless rating becomes ERC-8004 feedback | 3.5 s | ok |
| 10 | AI job: screener + router + provider's qwen adapter + verifier (all on the mock model server), escrowed and released | 11.1 s | ok |

## Checks

### Preflight: built, public RPC reachable, deployment is live, parties funded

| | Check | Detail |
|---|---|---|
| ✅ | RPC chain id | 5042002 |
| ✅ | escrow attester is the broker operator | `0xE52CdC89762203459690B5B142EE6Fe3Dc5C1d2F` |
| ✅ | escrow reports to XorvReputation | `0xe9cCAa186AA7D8dC8CD8c05F964a05E83296Fd89` |
| ✅ | operator has testnet USDC | 276502 units |
| ✅ | provider has testnet USDC | 50000 units |
| ✅ | buyer has testnet USDC | 134000 units |
| ✅ | Arc Memo predeploy is live on the public RPC | `0x5294E9927c3306DcBaDb03fe70b92e01cCede505` |

### ERC-8004: the provider registers an agent (xorv identity register) and binds it in XorvReputation

| | Check | Detail |
|---|---|---|
| ✅ | agent wallet is the provider's payout address | `0x565B23e96fc888C791FC9eb71586aA5c36BEE91d` |
| ✅ | XorvReputation binds the provider to its agent | true #897280 |
| ✅ | binding is live | true |

### Start the broker against the public RPC (facilitator = attester, keeper, ledger receipts, AI roles on the mock)

| | Check | Detail |
|---|---|---|
| ✅ | broker chain id | 5042002 |
| ✅ | broker reports the escrow | `0x2827Bb9B8109d602fa617f043A10E47Ef5aEc9eA` |
| ✅ | Arc stack: gas token | USDC |
| ✅ | Arc stack: Memo tagging on | true |
| ✅ | Arc stack: XorvReputation | `0xe9cCAa186AA7D8dC8CD8c05F964a05E83296Fd89` |
| ✅ | Arc stack: refund keeper on | true |
| ✅ | ledger mode | write |

### Provider: go live (xorv start, echo + qwen adapters, ERC-8004 agent)

| | Check | Detail |
|---|---|---|
| ✅ | broker verified the provider's ERC-8004 agent | 897280 |

### X402 in USDC: the buyer pays into XorvEscrow (Memo-tagged); delivery releases to the provider

| | Check | Detail |
|---|---|---|
| ✅ | the quote names the escrow | `0x2827Bb9B8109d602fa617f043A10E47Ef5aEc9eA` |
| ✅ | the 402 offers escrow first | escrow |
| ✅ | job completed | completed |
| ✅ | funding moved exactly the price buyer -> XorvEscrow | [{"from":"0xa07dc14797A8F968E2e9831666e751E63e5c171e","to":"0x2827Bb9B8109d602fa617f043A10E47Ef5aEc9eA","value":"1000"}] |
| ✅ | funding sent by the facilitator (the buyer sent nothing) | `0xE52CdC89762203459690B5B142EE6Fe3Dc5C1d2F` |
| ✅ | buyer never sent a transaction (nonce 0) | 0 |
| ✅ | Arc Memo on the funding (memoId = job id, text xorv:fund) | [{"id":"0xa9f8948deac404e91b203c89264205c2fdc6fa857b7e0b71f15fed0ec7e980c4","t":"xorv:fund"}] |
| ✅ | JobReleased pays the provider | `0x565B23e96fc888C791FC9eb71586aA5c36BEE91d` |
| ✅ | JobReleased carries the result's hash | `0x84a8b37f7eaa6dc61fb6673b4399636b68bb8cb3fcd11867ee3769c817d506f0` |
| ✅ | Arc Memo on the release (text xorv:release) |  |
| ✅ | buyer paid exactly the price | 1000 |
| ✅ | provider received exactly the price | 1000 |

### ERC-8004: the release wrote the outcome to the Reputation Registry through XorvReputation

| | Check | Detail |
|---|---|---|
| ✅ | OutcomeRecorded(success, feedbackWritten) | {"jobId":"0xa9f8948deac404e91b203c89264205c2fdc6fa857b7e0b71f15fed0ec7e980c4","provider":"0x565B23e96fc888C791FC9eb71586aA5c36BEE91d","agentId":"897280","success":true,"amount":"1000","feedbackWritten":true} |
| ✅ | NewFeedback client is XorvReputation | `0xe9cCAa186AA7D8dC8CD8c05F964a05E83296Fd89` |
| ✅ | feedback value 100 (released) | 100 |
| ✅ | feedback tag1 | successRate |
| ✅ | feedback tag2 | xorv-escrow |
| ✅ | feedbackHash is the escrow job id | `0xa9f8948deac404e91b203c89264205c2fdc6fa857b7e0b71f15fed0ec7e980c4` |
| ✅ | XorvReputation stats: 1 completed, 0 failed, earned the price | 1/0/1000 |
| ✅ | broker serves the escrow record with the agent | {"configured":true,"reputation":"0xe9cCAa186AA7D8dC8CD8c05F964a05E83296Fd89","completed":1,"failed":0,"earnedUnits":"1000","scoreBps":6666,"agentId":"897280","reputationUrl":"https://explorer.testnet.arc.io/address/0xe9cCAa186AA7D8dC8CD8c05F964a05E83296Fd89","agentUrl":"https://explorer.testnet.arc.io/token/0x8004A818BFB912233c491871b3d84c89A494BD9e/instance/897280","erc8004Reputation":"0x8004B663056A597Dffe9eCcC1965A193B7388713"} |

### XorvLedger receipts the release; the buyer's gasless rating becomes ERC-8004 feedback

| | Check | Detail |
|---|---|---|
| ✅ | JobRecorded.paymentTx is the release | `0x7fa0318fc98d7cacd1a3ff17b4e9f9aba428de76f48ec3dcaa3dd1c18cdc68af` |
| ✅ | JobRecorded.agentId is the provider's agent | 897280 |
| ✅ | rating feedback client is XorvLedger | `0x035c1f8CD3330EDd547230D578037Ebee4020Cbc` |
| ✅ | rating value | 95 |
| ✅ | rating tag1 | starred |

### AI job: screener + router + provider's qwen adapter + verifier (all on the mock model server), escrowed and released

| | Check | Detail |
|---|---|---|
| ✅ | AI job completed | completed |
| ✅ | result came from the provider's qwen adapter (mock answer token) | ans-8aa220701f1373183591 |
| ✅ | verification score | 92 |

## Step log

**preflight: built, public RPC reachable, deployment is live, parties funded**

- block 67021324

**start the mock OpenAI-compatible model server**

- listening on http://127.0.0.1:60356

**ERC-8004: the provider registers an agent (xorv identity register) and binds it in XorvReputation**

- agent #897280

**start the broker against the public RPC (facilitator = attester, keeper, ledger receipts, AI roles on the mock)**

- listening on http://127.0.0.1:8812

**provider: go live (xorv start, echo + qwen adapters, ERC-8004 agent)**

- provider prv_oYybHMVhXz-Y connected

**x402 in USDC: the buyer pays into XorvEscrow (Memo-tagged); delivery releases to the provider**

- job job_LtLl0TgVygJV

**XorvLedger receipts the release; the buyer's gasless rating becomes ERC-8004 feedback**

- rate 0xd9d6b9dc6da24c0754b8a521c1e90d8af2272ae3f341de35455d4a55babe3976

**AI job: screener + router + provider's qwen adapter + verifier (all on the mock model server), escrowed and released**

- job job_5ozVsok6By-J; score 92
