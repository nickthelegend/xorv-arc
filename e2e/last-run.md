# Xorv end-to-end run

**PASS** — 195/195 checks, 22 steps, 56.3 s. Started 2026-10-07T19:52:52.841Z.

Produced by `pnpm e2e` (see [README.md](README.md)). Every value below was read back from the
forked chain or the running processes during the run; transaction hashes are local to that fork.

## Environment

| | |
|---|---|
| node | v26.5.0 |
| platform | darwin 25.5.0 |
| duration | 56.3 s |
| logs | (removed after a passing run) |

## Parties

| | |
|---|---|
| operator (broker EOA: ledger writes, rating relay, Kimi feedback) | `0x3b73fE6136c126dbe050fCBB3209C8DF390a8aC5` |
| facilitator (submits EIP-3009 authorizations, pays settlement gas) | `0x15112b01aE20d2e945ede61bB69D88D2bD17Fc9e` |
| provider (payout address = ERC-8004 agent wallet) | `0x676938bD7E2564F5dD45a49db88C3eCD0E4b70bF` |
| buyer (holds USDC only, sends no transaction) | `0xA7b217971B8Ba3B4747D383C391f7C67d5C245A1` |
| provider ERC-8004 agent id | 897151 |
| provider id (broker) | prv_YfC31lqDHLwj |

## Chain

| | |
|---|---|
| fork RPC | http://127.0.0.1:8814 |
| forked from | https://rpc.testnet.arc.io at block 66018114 |
| chain id | 5042002 |
| USDC (Circle FiatToken, forked) | `0x3600000000000000000000000000000000000000` |
| ERC-8004 Identity Registry (forked) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ERC-8004 Reputation Registry (forked) | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| XorvLedger | `0x1B4379729ef3Ee706AaD789e8b35073EdcDB832B` |

## Processes

| | |
|---|---|
| broker | http://127.0.0.1:58591 |

## Jobs

| | |
|---|---|
| CLI job | job_sYs5E8UGJE6T |
| MCP job | job_zVxGMdtl_Yot |
| private job | job_eAqikkLWyfSf |

## Transactions

| | |
|---|---|
| cli job settlement | `0x930c348ed891ef67cd539f83f13af5fbb3801ea2464e23e882bd7fd7fe441c97` |
| mcp job settlement | `0x536381b30f2d53e4447489b6eeab483cc56fe3c82c0df65aea55d6f192bfc1f1` |
| private job settlement | `0x44c8acf373025d31051673401d621730892a6889c282d86042634509ee770538` |
| ProviderRegistered | `0xc65785786282ad11721467bd749c3cf909ad2dd533711cf4a6209dc6e4ea870c` |
| cli job receipt (JobRecorded) | `0xc13aadcd85591815290e0734bfa366773aabdeeac03d30a4f853dda5b633bba1` |
| mcp job receipt (JobRecorded) | `0x012326f0b11992a721b644b4ec4610abb669ef8a1479c4c6b7bd955242cddbd8` |
| private job receipt (JobRecorded) | `0xdc5a09db44a9aa100e44f6c9dcbabf7a666f98e617e0e78ae9a3c436f45c9b9f` |
| cli job rating (JobRated) | `0x186dbdd79b55e614ba95e833cc572f6dfcb704687eed13c46597ab8b48353834` |
| mcp job rating (JobRated) | `0xfbb69a9494c30fdefea15328a48fa3de095ed056aa3451147438ee21601b53c1` |
| cli job Kimi feedback (NewFeedback) | `0x2d540e1d2797671d1f81f84e9cf966c2360d44ea2289d92e066c19fa832dab2f` |
| mcp job Kimi feedback (NewFeedback) | `0x5ff04d158e7954f1a3f4fd17afe1ef810746e72e198af7b4dd80b4afe5990ade` |
| cli job rating (NewFeedback) | `0x186dbdd79b55e614ba95e833cc572f6dfcb704687eed13c46597ab8b48353834` |
| mcp job rating (NewFeedback) | `0xfbb69a9494c30fdefea15328a48fa3de095ed056aa3451147438ee21601b53c1` |

## AI roles (mock)

| | |
|---|---|
| Hunyuan screen calls | 4 |
| Qwen router calls | 3 |
| Kimi verifier calls | 2 |
| provider qwen adapter streams | 2 |

## Steps

| # | Step | Time | Result |
|---|---|---:|---|
| 1 | preflight | 0.0 s | ok |
| 2 | start the mock OpenAI-compatible model server | 0.0 s | ok |
| 3 | fork Arc testnet (arc-anvil --network arc, chain id 5042002) | 3.8 s | ok |
| 4 | check the forked contracts are the real ones | 4.3 s | ok |
| 5 | fund the parties with USDC (Arc's gas token too) | 2.4 s | ok |
| 6 | deploy with scripts/deploy.sh local (XorvLedger and the Arc contracts) | 11.8 s | ok |
| 7 | start the broker (services/broker, self-hosted facilitator, AI roles on the mock) | 1.1 s | ok |
| 8 | provider: register an ERC-8004 identity (xorv identity register) | 4.7 s | ok |
| 9 | provider: go live (xorv start) | 2.6 s | ok |
| 10 | Hunyuan screen refuses an abusive prompt before any quote | 0.0 s | ok |
| 11 | buyer: xorv run --json (Qwen routes, x402 pays, qwen adapter answers) | 8.8 s | ok |
| 12 | Kimi verifies the result and writes ERC-8004 feedback | 0.0 s | ok |
| 13 | buyer rates the job through the broker API (EIP-712, gasless) | 2.7 s | ok |
| 14 | agent buyer: the MCP server over stdio (xorv_run_job, xorv_rate_job) | 8.8 s | ok |
| 15 | private job through the broker API (sealed to the buyer's inbox key) | 3.0 s | ok |
| 16 | on-chain: x402 settlements (real USDC, facilitator pays gas, Arc Memo tags the job) | 0.0 s | ok |
| 17 | on-chain: XorvLedger events | 0.0 s | ok |
| 18 | on-chain: ERC-8004 reputation (canonical Reputation Registry) | 0.0 s | ok |
| 19 | the broker's own views agree with the chain | 0.0 s | ok |
| 20 | the provider's own log is a record of its jobs | 0.0 s | ok |
| 21 | provider: xorv identity show and xorv earnings agree with the chain | 2.3 s | ok |
| 22 | the private answer never touched the broker's disk | 0.0 s | ok |

## Checks

### Check the forked contracts are the real ones

| | Check | Detail |
|---|---|---|
| ✅ | USDC EIP-712 name | USDC |
| ✅ | USDC EIP-712 version | 2 |
| ✅ | USDC decimals | 6 |
| ✅ | ERC-8004 Identity Registry version | 2.0.0 |
| ✅ | ERC-8004 Reputation Registry version | 2.0.0 |
| ✅ | Reputation Registry is wired to the Identity Registry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |

### Fund the parties with USDC (Arc's gas token too)

| | Check | Detail |
|---|---|---|
| ✅ | buyer USDC balance after funding | 5000000 |
| ✅ | native balance is the same USDC (18 decimals) | 5000000000000000000 |

### Deploy with scripts/deploy.sh local (XorvLedger and the Arc contracts)

| | Check | Detail |
|---|---|---|
| ✅ | ledger.identity() is the canonical Identity Registry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ✅ | ledger.reputation() is the canonical Reputation Registry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| ✅ | ledger.broker() is the operator | `0x3b73fE6136c126dbe050fCBB3209C8DF390a8aC5` |

### Start the broker (services/broker, self-hosted facilitator, AI roles on the mock)

| | Check | Detail |
|---|---|---|
| ✅ | broker network | eip155:5042002 |
| ✅ | broker chain id | 5042002 |
| ✅ | broker prices in the forked USDC | `0x3600000000000000000000000000000000000000` |
| ✅ | facilitator is self-hosted | self |
| ✅ | facilitator EOA | `0x15112b01aE20d2e945ede61bB69D88D2bD17Fc9e` |
| ✅ | payments are available | true |
| ✅ | ledger address | `0x1B4379729ef3Ee706AaD789e8b35073EdcDB832B` |
| ✅ | ledger mode | write |
| ✅ | screener | hunyuan |
| ✅ | router | qwen |
| ✅ | verifier | kimi |
| ✅ | verifier writes ERC-8004 feedback from the operator | `0x3b73fE6136c126dbe050fCBB3209C8DF390a8aC5` |

### Provider: register an ERC-8004 identity (xorv identity register)

| | Check | Detail |
|---|---|---|
| ✅ | agent owner is the provider's payout address | `0x676938bD7E2564F5dD45a49db88C3eCD0E4b70bF` |
| ✅ | agent wallet is the provider's payout address | `0x676938bD7E2564F5dD45a49db88C3eCD0E4b70bF` |
| ✅ | agentURI is the broker's registration file | http://127.0.0.1:58591/agents/prv_YfC31lqDHLwj.json |
| ✅ | agentURI does not publish the node id | false |

### Provider: go live (xorv start)

| | Check | Detail |
|---|---|---|
| ✅ | provider id is the one the CLI put in the agent URI | prv_YfC31lqDHLwj |
| ✅ | broker verified the agent id against the Identity Registry | 897151 |
| ✅ | registration file names the agent | 897151 |
| ✅ | registration file names the canonical Identity Registry | eip155:5042002:0x8004A818BFB912233c491871b3d84c89A494BD9e |

### Hunyuan screen refuses an abusive prompt before any quote

| | Check | Detail |
|---|---|---|
| ✅ | quote refused with 422 | 422 |
| ✅ | screening verdict | block |
| ✅ | screened by | hunyuan |

### Buyer: xorv run --json (Qwen routes, x402 pays, qwen adapter answers)

| | Check | Detail |
|---|---|---|
| ✅ | job completed | completed |
| ✅ | payer is the buyer | `0xA7b217971B8Ba3B4747D383C391f7C67d5C245A1` |
| ✅ | screened by Hunyuan and allowed | hunyuan:allow |
| ✅ | routed by Qwen | qwen |
| ✅ | router's pick (over the cheaper echo) is the quoted adapter | qwen/qwen |
| ✅ | router picked the quoted provider | prv_YfC31lqDHLwj |
| ✅ | router's trace: listed candidates, read the provider, then selected | list_candidates → erc8004_reputation → recent_receipts → indexer_provider_stats → escrow_outcomes → select_provider |
| ✅ | quote freezes $0.04 = 40000 USDC units | 40000 |
| ✅ | payTo is the provider, not the broker | `0x676938bD7E2564F5dD45a49db88C3eCD0E4b70bF` |
| ✅ | result came from the provider's qwen adapter (mock answer token) | ans-25a9ef0a374d7f5a405d |
| ✅ | resultHash = keccak256(result) | `0x5d99e642042ab0db12fb19cca3897412baf1e28d801b203edcf9e4c2ee40478a` |
| ✅ | settlement tx reported | `0x930c348ed891ef67cd539f83f13af5fbb3801ea2464e23e882bd7fd7fe441c97` |
| ✅ | XorvLedger receipt tx reported | `0xc13aadcd85591815290e0734bfa366773aabdeeac03d30a4f853dda5b633bba1` |

### Kimi verifies the result and writes ERC-8004 feedback

| | Check | Detail |
|---|---|---|
| ✅ | verified by Kimi | kimi |
| ✅ | verification score | 92 |

### Buyer rates the job through the broker API (EIP-712, gasless)

| | Check | Detail |
|---|---|---|
| ✅ | rating signer is the payer | `0xA7b217971B8Ba3B4747D383C391f7C67d5C245A1` |
| ✅ | rating is for the provider's agent | 897151 |
| ✅ | typed data domain is this XorvLedger | `0x1B4379729ef3Ee706AaD789e8b35073EdcDB832B` |
| ✅ | a stranger's signature is refused | 401 |
| ✅ | served feedback file hashes to the committed feedbackHash | `0x2de826ac929e8c5b956c90c4116cb615797678ecd5a53b14ab233dd93c6f5f93` |

### Agent buyer: the MCP server over stdio (xorv_run_job, xorv_rate_job)

| | Check | Detail |
|---|---|---|
| ✅ | MCP server lists xorv_run_job and xorv_rate_job | xorv_list_providers, xorv_network_status, xorv_quote, xorv_ccip_quote, xorv_get_job, xorv_wallet, xorv_run_job, xorv_rate_job |
| ✅ | MCP result is the echo of the prompt |  |
| ✅ | MCP reports the XorvLedger receipt |  |
| ✅ | xorv_wallet shows the buyer's address and on-chain USDC balance | USDC: $4.96 |

### Private job through the broker API (sealed to the buyer's inbox key)

| | Check | Detail |
|---|---|---|
| ✅ | private job completed | completed |
| ✅ | job is flagged private | true |
| ✅ | prompt is redacted from the public job |  |
| ✅ | the broker holds a sealed envelope | alg x25519-hkdf-sha256-aes256gcm |
| ✅ | the buyer's inbox key opens it to the provider's answer | ans-c058c6aab3d0ee1102ca |
| ✅ | another inbox key cannot open it | DECRYPT_FAILED |
| ✅ | it is bound to its job id | DECRYPT_FAILED |
| ✅ | the plaintext answer is nowhere in the broker's API |  |
| ✅ | the plaintext answer never reached the Kimi verifier |  |
| ✅ | the private job was not verified (no readable result) |  |
| ✅ | resultHash commits to the envelope | `0x1c67257ec242d37ffe90278ba2029d96f4e308d3ff79a204e2d5a4ac2a9ff03d` |

### On-chain: x402 settlements (real USDC, facilitator pays gas, Arc Memo tags the job)

| | Check | Detail |
|---|---|---|
| ✅ | cli: settlement succeeded | success |
| ✅ | cli: sent (and gas paid) by the facilitator | `0x15112b01aE20d2e945ede61bB69D88D2bD17Fc9e` |
| ✅ | cli: USDC Transfer buyer → provider for exactly 40000 | 0xA7b217971B8Ba3B4747D383C391f7C67d5C245A1→0x676938bD7E2564F5dD45a49db88C3eCD0E4b70bF 40000 |
| ✅ | cli: EIP-3009 authorization used by the buyer |  |
| ✅ | cli: Arc Memo tags the transfer with the job (xorv:pay) | ["xorv:pay:qte_aehh0pcePFso"] |
| ✅ | cli: job.payment.amount | 40000 |
| ✅ | mcp: settlement succeeded | success |
| ✅ | mcp: sent (and gas paid) by the facilitator | `0x15112b01aE20d2e945ede61bB69D88D2bD17Fc9e` |
| ✅ | mcp: USDC Transfer buyer → provider for exactly 1000 | 0xA7b217971B8Ba3B4747D383C391f7C67d5C245A1→0x676938bD7E2564F5dD45a49db88C3eCD0E4b70bF 1000 |
| ✅ | mcp: EIP-3009 authorization used by the buyer |  |
| ✅ | mcp: Arc Memo tags the transfer with the job (xorv:pay) | ["xorv:pay:qte_SRb0ZzBIyayS"] |
| ✅ | mcp: job.payment.amount | 1000 |
| ✅ | private: settlement succeeded | success |
| ✅ | private: sent (and gas paid) by the facilitator | `0x15112b01aE20d2e945ede61bB69D88D2bD17Fc9e` |
| ✅ | private: USDC Transfer buyer → provider for exactly 40000 | 0xA7b217971B8Ba3B4747D383C391f7C67d5C245A1→0x676938bD7E2564F5dD45a49db88C3eCD0E4b70bF 40000 |
| ✅ | private: EIP-3009 authorization used by the buyer |  |
| ✅ | private: Arc Memo tags the transfer with the job (xorv:pay) | ["xorv:pay:qte_J9jcHxtTsN5z"] |
| ✅ | private: job.payment.amount | 40000 |
| ✅ | buyer USDC balance | 4919000 |
| ✅ | provider USDC received | 81000 |
| ✅ | buyer never sent a transaction (nonce 0) | 0 |

### On-chain: XorvLedger events

| | Check | Detail |
|---|---|---|
| ✅ | ProviderRegistered for the provider | `0xc65785786282ad11721467bd749c3cf909ad2dd533711cf4a6209dc6e4ea870c` |
| ✅ | ProviderRegistered.payTo | `0x676938bD7E2564F5dD45a49db88C3eCD0E4b70bF` |
| ✅ | ProviderRegistered.agentId | 897151 |
| ✅ | ProviderRegistered.label | e2e-provider |
| ✅ | ProviderRegistered.capabilities | echo:1000,qwen:40000 |
| ✅ | a sampled ProviderHeartbeat was published | `0x6f646d82b25f50815cac7bee938afb0327d67131c33a19e96482de8702976f47` |
| ✅ | cli: JobRecorded | `0xc13aadcd85591815290e0734bfa366773aabdeeac03d30a4f853dda5b633bba1` |
| ✅ | cli: JobRecorded.agentId | 897151 |
| ✅ | cli: JobRecorded.buyer | `0xA7b217971B8Ba3B4747D383C391f7C67d5C245A1` |
| ✅ | cli: JobRecorded.payTo | `0x676938bD7E2564F5dD45a49db88C3eCD0E4b70bF` |
| ✅ | cli: JobRecorded.amount | 40000 |
| ✅ | cli: JobRecorded.paymentTx is the settlement | `0x930c348ed891ef67cd539f83f13af5fbb3801ea2464e23e882bd7fd7fe441c97` |
| ✅ | cli: JobRecorded.requestHash = keccak256(prompt) | `0xd07e77fcf9f7b555cfbfabb02b99a8c4da649ad390acd3f36dcc5caaa7223e2a` |
| ✅ | cli: JobRecorded.resultHash = keccak256(result) | `0x5d99e642042ab0db12fb19cca3897412baf1e28d801b203edcf9e4c2ee40478a` |
| ✅ | cli: JobRecorded.ok | true |
| ✅ | cli: the broker's receiptTxHash is that transaction | `0xc13aadcd85591815290e0734bfa366773aabdeeac03d30a4f853dda5b633bba1` |
| ✅ | mcp: JobRecorded | `0x012326f0b11992a721b644b4ec4610abb669ef8a1479c4c6b7bd955242cddbd8` |
| ✅ | mcp: JobRecorded.agentId | 897151 |
| ✅ | mcp: JobRecorded.buyer | `0xA7b217971B8Ba3B4747D383C391f7C67d5C245A1` |
| ✅ | mcp: JobRecorded.payTo | `0x676938bD7E2564F5dD45a49db88C3eCD0E4b70bF` |
| ✅ | mcp: JobRecorded.amount | 1000 |
| ✅ | mcp: JobRecorded.paymentTx is the settlement | `0x536381b30f2d53e4447489b6eeab483cc56fe3c82c0df65aea55d6f192bfc1f1` |
| ✅ | mcp: JobRecorded.requestHash = keccak256(prompt) | `0xf8506866bfdffe71d9a02ccda553e217a038acca947c2d55bfcf1ad040f4c54c` |
| ✅ | mcp: JobRecorded.resultHash = keccak256(result) | `0x0fc2a94ab935358182436fa217f650ed46fce4e89f10d1b0b9debcc957b4093a` |
| ✅ | mcp: JobRecorded.ok | true |
| ✅ | mcp: the broker's receiptTxHash is that transaction | `0x012326f0b11992a721b644b4ec4610abb669ef8a1479c4c6b7bd955242cddbd8` |
| ✅ | private: JobRecorded | `0xdc5a09db44a9aa100e44f6c9dcbabf7a666f98e617e0e78ae9a3c436f45c9b9f` |
| ✅ | private: JobRecorded.agentId | 897151 |
| ✅ | private: JobRecorded.buyer | `0xA7b217971B8Ba3B4747D383C391f7C67d5C245A1` |
| ✅ | private: JobRecorded.payTo | `0x676938bD7E2564F5dD45a49db88C3eCD0E4b70bF` |
| ✅ | private: JobRecorded.amount | 40000 |
| ✅ | private: JobRecorded.paymentTx is the settlement | `0x44c8acf373025d31051673401d621730892a6889c282d86042634509ee770538` |
| ✅ | private: JobRecorded.requestHash = keccak256(prompt) | `0xd7e121b98b0c46201cf6b8afac1241e63f814ef5cbbf7c1878b3ba1b9f78ad75` |
| ✅ | private: JobRecorded.resultHash = keccak256(result) | `0x1c67257ec242d37ffe90278ba2029d96f4e308d3ff79a204e2d5a4ac2a9ff03d` |
| ✅ | private: JobRecorded.ok | true |
| ✅ | private: the broker's receiptTxHash is that transaction | `0xdc5a09db44a9aa100e44f6c9dcbabf7a666f98e617e0e78ae9a3c436f45c9b9f` |
| ✅ | private: the on-chain resultHash is keccak256 of the sealed envelope | `0x1c67257ec242d37ffe90278ba2029d96f4e308d3ff79a204e2d5a4ac2a9ff03d` |
| ✅ | cli: JobRated | `0x186dbdd79b55e614ba95e833cc572f6dfcb704687eed13c46597ab8b48353834` |
| ✅ | cli: JobRated.value | 87 |
| ✅ | cli: JobRated.buyer | `0xA7b217971B8Ba3B4747D383C391f7C67d5C245A1` |
| ✅ | cli: JobRated.agentId | 897151 |
| ✅ | cli: ledger.jobs() marks it rated |  |
| ✅ | mcp: JobRated | `0xfbb69a9494c30fdefea15328a48fa3de095ed056aa3451147438ee21601b53c1` |
| ✅ | mcp: JobRated.value | 64 |
| ✅ | mcp: JobRated.buyer | `0xA7b217971B8Ba3B4747D383C391f7C67d5C245A1` |
| ✅ | mcp: JobRated.agentId | 897151 |
| ✅ | mcp: ledger.jobs() marks it rated |  |
| ✅ | cli: the relay tx the broker returned is the JobRated tx | `0x186dbdd79b55e614ba95e833cc572f6dfcb704687eed13c46597ab8b48353834` |
| ✅ | private: not rated |  |

### On-chain: ERC-8004 reputation (canonical Reputation Registry)

| | Check | Detail |
|---|---|---|
| ✅ | cli: Kimi's NewFeedback (tag1 "xorv-verified") | `0x2d540e1d2797671d1f81f84e9cf966c2360d44ea2289d92e066c19fa832dab2f` |
| ✅ | cli: verifier feedback client is the verifier EOA | `0x3b73fE6136c126dbe050fCBB3209C8DF390a8aC5` |
| ✅ | cli: verifier feedback value | 92 |
| ✅ | cli: verifier feedback tag2 is the adapter | qwen |
| ✅ | cli: verifier feedbackURI | http://127.0.0.1:58591/verifications/job_sYs5E8UGJE6T.json |
| ✅ | cli: served verification file hashes to the on-chain feedbackHash | `0xbaffbbd3773b6104cdc516ecec2f58657d38ca19832bad9f8eb93439a52fab3f` |
| ✅ | mcp: Kimi's NewFeedback (tag1 "xorv-verified") | `0x5ff04d158e7954f1a3f4fd17afe1ef810746e72e198af7b4dd80b4afe5990ade` |
| ✅ | mcp: verifier feedback client is the verifier EOA | `0x3b73fE6136c126dbe050fCBB3209C8DF390a8aC5` |
| ✅ | mcp: verifier feedback value | 92 |
| ✅ | mcp: verifier feedback tag2 is the adapter | echo |
| ✅ | mcp: verifier feedbackURI | http://127.0.0.1:58591/verifications/job_zVxGMdtl_Yot.json |
| ✅ | mcp: served verification file hashes to the on-chain feedbackHash | `0x40358db176398986c7f565adcfb10f66e9a64987ed9a24ef5c06a2a0595a1368` |
| ✅ | private: no verifier feedback | 2 xorv-verified entries |
| ✅ | cli: the buyer's rating as NewFeedback (tag1 "starred") | `0x186dbdd79b55e614ba95e833cc572f6dfcb704687eed13c46597ab8b48353834` |
| ✅ | cli: rating feedback client is XorvLedger | `0x1B4379729ef3Ee706AaD789e8b35073EdcDB832B` |
| ✅ | cli: rating feedback value | 87 |
| ✅ | cli: rating endpoint is the broker's jobs service | http://127.0.0.1:58591/api/quotes |
| ✅ | cli: served feedback file hashes to the on-chain feedbackHash | `0x2de826ac929e8c5b956c90c4116cb615797678ecd5a53b14ab233dd93c6f5f93` |
| ✅ | mcp: the buyer's rating as NewFeedback (tag1 "starred") | `0xfbb69a9494c30fdefea15328a48fa3de095ed056aa3451147438ee21601b53c1` |
| ✅ | mcp: rating feedback client is XorvLedger | `0x1B4379729ef3Ee706AaD789e8b35073EdcDB832B` |
| ✅ | mcp: rating feedback value | 64 |
| ✅ | mcp: rating endpoint is the broker's jobs service | http://127.0.0.1:58591/api/quotes |
| ✅ | mcp: served feedback file hashes to the on-chain feedbackHash | `0x222e074cc49e072bbc9bd50889884e12b57b644bac65e177091f5a14d22abc58` |
| ✅ | cli: rating feedbackHash is what the buyer signed | `0x2de826ac929e8c5b956c90c4116cb615797678ecd5a53b14ab233dd93c6f5f93` |
| ✅ | getSummary([ledger], "starred").count | 2 |
| ✅ | getSummary([ledger], "starred") is the registry's mean of those NewFeedback values | 75 (0 decimals) |
| ✅ | getSummary([verifier], "xorv-verified").count | 2 |
| ✅ | getSummary([verifier], "xorv-verified") is the registry's mean of those NewFeedback values | 92 (0 decimals) |
| ✅ | getClients lists XorvLedger and the verifier | 0x3b73fE6136c126dbe050fCBB3209C8DF390a8aC5, 0x1B4379729ef3Ee706AaD789e8b35073EdcDB832B |

### The broker's own views agree with the chain

| | Check | Detail |
|---|---|---|
| ✅ | ledger feed source (RPC scan of the fork) | rpc |
| ✅ | ledger feed links all three receipts to their jobs | job_eAqikkLWyfSf, job_zVxGMdtl_Yot, job_sYs5E8UGJE6T |
| ✅ | ledger feed has both ratings | 2 |
| ✅ | leaderboard lists the provider |  |
| ✅ | no ledger publish errors | null |
| ✅ | no receipts left queued | 0 |

### The provider's own log is a record of its jobs

| | Check | Detail |
|---|---|---|
| ✅ | cli: logged once, as done | 1 |
| ✅ | mcp: logged once, as done | 1 |
| ✅ | private: logged once, as done | 1 |
| ✅ | the status footer is printed once, not once a second | 1 |

### Provider: xorv identity show and xorv earnings agree with the chain

| | Check | Detail |
|---|---|---|
| ✅ | identity show exits 0 | 0 |
| ✅ | identity show: agent id | 897151 |
| ✅ | identity show: owner and agent wallet are the payout address |  |
| ✅ | earnings exits 0 | 0 |
| ✅ | earnings: cli job recorded as ok | 40000 units |
| ✅ | earnings: cli amount is the settled USDC | 40000 |
| ✅ | earnings: cli carries its settlement tx | `0x930c348ed891ef67cd539f83f13af5fbb3801ea2464e23e882bd7fd7fe441c97` |
| ✅ | earnings: mcp job recorded as ok | 1000 units |
| ✅ | earnings: mcp amount is the settled USDC | 1000 |
| ✅ | earnings: mcp carries its settlement tx | `0x536381b30f2d53e4447489b6eeab483cc56fe3c82c0df65aea55d6f192bfc1f1` |
| ✅ | earnings: private job recorded as ok | 40000 units |
| ✅ | earnings: private amount is the settled USDC | 40000 |
| ✅ | earnings: private carries its settlement tx | `0x44c8acf373025d31051673401d621730892a6889c282d86042634509ee770538` |
| ✅ | earnings total is what the provider received on chain | 81000 |

### The private answer never touched the broker's disk

| | Check | Detail |
|---|---|---|
| ✅ | broker database exists | 4096 bytes |
| ✅ | the private job is in the broker's database |  |
| ✅ | the answer is not (in the database or its WAL) |  |

## Step log

**preflight**

- run directory /Volumes/Extreme SSD/Projects/arc/xorv-arc/e2e/.runs/2026-10-07T19-52-52-842Z-nHycPN
- forking https://rpc.testnet.arc.io at its latest block

**start the mock OpenAI-compatible model server**

- listening on http://127.0.0.1:58402 (/qwen/v1, /kimi/v1, /hunyuan/v1)

**fork Arc testnet (arc-anvil --network arc, chain id 5042002)**

- serving http://127.0.0.1:8814, forked at block 66018114

**fund the parties with USDC (Arc's gas token too)**

- buyer $5.00; broker keys and the provider hold USDC for gas

**deploy with scripts/deploy.sh local (XorvLedger and the Arc contracts)**

- XorvLedger at 0x1B4379729ef3Ee706AaD789e8b35073EdcDB832B (from block 66018120); escrow 0x1C75B3F897AD80a1A6fb32f864Cc845aabcC657E (not used by this run)

**start the broker (services/broker, self-hosted facilitator, AI roles on the mock)**

- listening on http://127.0.0.1:58591

**provider: register an ERC-8004 identity (xorv identity register)**

- registered as agent #897151

**provider: go live (xorv start)**

- provider prv_YfC31lqDHLwj connected, agent #897151
- ProviderRegistered in 0xc65785786282ad11721467bd749c3cf909ad2dd533711cf4a6209dc6e4ea870c

**Hunyuan screen refuses an abusive prompt before any quote**

- the safety screen refused this prompt: asks the agent to read and send out the provider's keys

**buyer: xorv run --json (Qwen routes, x402 pays, qwen adapter answers)**

- job job_sYs5E8UGJE6T completed in 5.1s; paid in 0x930c348ed891ef67cd539f83f13af5fbb3801ea2464e23e882bd7fd7fe441c97

**Kimi verifies the result and writes ERC-8004 feedback**

- score 92/100 by kimi-k3; giveFeedback 0x2d540e1d2797671d1f81f84e9cf966c2360d44ea2289d92e066c19fa832dab2f

**buyer rates the job through the broker API (EIP-712, gasless)**

- rateJob relayed in 0x186dbdd79b55e614ba95e833cc572f6dfcb704687eed13c46597ab8b48353834

**agent buyer: the MCP server over stdio (xorv_run_job, xorv_rate_job)**

- job job_zVxGMdtl_Yot
- Relayed on-chain: https://explorer.testnet.arc.io/tx/0xfbb69a9494c30fdefea15328a48fa3de095ed056aa3451147438ee21601b53c1

**private job through the broker API (sealed to the buyer's inbox key)**

- job job_eAqikkLWyfSf completed; settlement 0x44c8acf373025d31051673401d621730892a6889c282d86042634509ee770538
- receipt 0xdc5a09db44a9aa100e44f6c9dcbabf7a666f98e617e0e78ae9a3c436f45c9b9f

**on-chain: x402 settlements (real USDC, facilitator pays gas, Arc Memo tags the job)**

- cli: 0x930c348ed891ef67cd539f83f13af5fbb3801ea2464e23e882bd7fd7fe441c97 — 40000 0xA7b217971B8Ba3B4747D383C391f7C67d5C245A1→0x676938bD7E2564F5dD45a49db88C3eCD0E4b70bF; gas 110592
- mcp: 0x536381b30f2d53e4447489b6eeab483cc56fe3c82c0df65aea55d6f192bfc1f1 — 1000 0xA7b217971B8Ba3B4747D383C391f7C67d5C245A1→0x676938bD7E2564F5dD45a49db88C3eCD0E4b70bF; gas 110580
- private: 0x44c8acf373025d31051673401d621730892a6889c282d86042634509ee770538 — 40000 0xA7b217971B8Ba3B4747D383C391f7C67d5C245A1→0x676938bD7E2564F5dD45a49db88C3eCD0E4b70bF; gas 110600

**on-chain: XorvLedger events**

- 1 ProviderRegistered, 1 ProviderHeartbeat, 3 JobRecorded, 2 JobRated

**on-chain: ERC-8004 reputation (canonical Reputation Registry)**

- xorv-verified/qwen 92 from 0x3b73fE6136c126dbe050fCBB3209C8DF390a8aC5 (0x2d540e1d2797671d1f81f84e9cf966c2360d44ea2289d92e066c19fa832dab2f); starred/qwen 87 from 0x1B4379729ef3Ee706AaD789e8b35073EdcDB832B (0x186dbdd79b55e614ba95e833cc572f6dfcb704687eed13c46597ab8b48353834); xorv-verified/echo 92 from 0x3b73fE6136c126dbe050fCBB3209C8DF390a8aC5 (0x5ff04d158e7954f1a3f4fd17afe1ef810746e72e198af7b4dd80b4afe5990ade); starred/echo 64 from 0x1B4379729ef3Ee706AaD789e8b35073EdcDB832B (0xfbb69a9494c30fdefea15328a48fa3de095ed056aa3451147438ee21601b53c1)

**the broker's own views agree with the chain**

- /api/ledger?kind=receipts: 3 receipts from rpc
