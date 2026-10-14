# Judge walkthrough (about 10 minutes)

Live: https://xorv-arc.vercel.app (Arc testnet)


Everything below is on **Arc testnet (5042002)**. Nothing is on mainnet. Read
[README.md](../README.md#arc-stack) first for what has and has not been run live.

## 1. Check the chain, no setup (3 minutes)

1. Contracts, all on `explorer.testnet.arc.io` (XorvEscrow and XorvReputation have verified source; XorvCcipReceiver and XorvLedger are deployed but their source is not yet verified on the explorer):
   [XorvEscrow](https://explorer.testnet.arc.io/address/0x2827Bb9B8109d602fa617f043A10E47Ef5aEc9eA),
   [XorvReputation](https://explorer.testnet.arc.io/address/0xe9cCAa186AA7D8dC8CD8c05F964a05E83296Fd89),
   [XorvLedger](https://explorer.testnet.arc.io/address/0x035c1f8CD3330EDd547230D578037Ebee4020Cbc),
   [XorvCcipReceiver](https://explorer.testnet.arc.io/address/0x61d6eC91320be18A4D0499b872307fA781f427B0).
2. [docs/E2E-TESTNET.md](E2E-TESTNET.md): 10 real transactions with links. Open the x402 funding transaction: the
   buyer's USDC moves into XorvEscrow, sent by the broker's facilitator (the buyer's nonce is 0), with an Arc Memo
   tagged `xorv:fund`. Open the release: USDC to the provider and an ERC-8004 `NewFeedback` from XorvReputation.
3. The ERC-8004 Reputation Registry rows the run wrote are listed under "Checks" in that file.

## 2. Look at the app (3 minutes)

[docs/screens/testnet/](screens/testnet/) has the pages against the live deployment (desktop and 390 px). The one to
open is `judge-network-arc-stack.png`: each Arc piece says whether it was exercised live. Gateway, CCTP and CCIP say
they were not.

## 3. Run it yourself (4 minutes, no keys, no funds)

```bash
pnpm install && pnpm build
ARC_ANVIL=arc-anvil ARC_FORGE=arc-forge pnpm demo     # a fork of Arc testnet; app on http://localhost:8822
```

Post a job in the app, pay from the demo account, and follow the escrow timeline and the Memo tags on the job page.
The provider in the demo sells an `echo` test capability, so the answer is canned: the point is the payment path.

## What to discount

- The AI roles (screener, router, verifier) were run against a mock model server; no real model was called.
- Circle Gateway, CCTP V2 withdrawals and Chainlink CCIP jobs were not run live, because they need another chain.
- Deadline refunds, cancel and reassign were not run on testnet.
- The contracts are unaudited and not deployed to mainnet.
