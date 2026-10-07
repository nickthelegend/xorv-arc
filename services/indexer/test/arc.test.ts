/**
 * The Arc additions: XorvReputation's escrow outcomes (and the ERC-8004 feedback they write,
 * classified ESCROW_OUTCOME), and jobs posted over Chainlink CCIP.
 */

import { describe, expect, it } from "vitest";
import { Sim, addr, ccip, hash32, id32, reputation, xorvReputation, XORV_REPUTATION } from "./harness.js";

const PROVIDER = addr(0x0a);
const REQUESTER = addr(0x0b);
const STRANGER = addr(0x5e);
const BASE_SEPOLIA = 10344971235874465080n;

describe("XorvReputation: escrow settlement written to ERC-8004", () => {
  it("binds a payout wallet to its agent, and counts its successRate feedback as ESCROW_OUTCOME", async () => {
    const sim = new Sim();
    await sim.run(xorvReputation.agentBound(PROVIDER, 7n));
    expect(await sim.indexer.AgentBinding.getOrThrow(PROVIDER)).toMatchObject({ agentId: 7n, reputation: XORV_REPUTATION });

    // A release: the registry's NewFeedback (value 100) comes first, then OutcomeRecorded, in one tx.
    const job1 = id32("qte_r1");
    await sim.run(
      reputation.newFeedback({ agentId: 7n, client: XORV_REPUTATION, index: 1n, value: 100n, tag1: "successRate", tag2: "xorv-escrow", feedbackHash: job1 }),
      xorvReputation.outcome({ jobId: job1, provider: PROVIDER, agentId: 7n, success: true }),
    );
    // An at-fault refund: value 0.
    const job2 = id32("qte_r2");
    await sim.run(
      reputation.newFeedback({ agentId: 7n, client: XORV_REPUTATION, index: 2n, value: 0n, tag1: "successRate", tag2: "xorv-escrow", feedbackHash: job2 }),
      xorvReputation.outcome({ jobId: job2, provider: PROVIDER, agentId: 7n, success: false, amount: 0n }),
    );

    expect(await sim.indexer.Agent.getOrThrow("7")).toMatchObject({ escrowOutcomeCount: 2, escrowReleasedCount: 1, escrowSuccessRate: 0.5 });
    const feedback = await sim.indexer.Feedback.getOrThrow(`7-${XORV_REPUTATION}-1`);
    expect(feedback.kind).toBe("ESCROW_OUTCOME");
    expect(await sim.indexer.EscrowOutcome.getOrThrow(job1)).toMatchObject({ provider: PROVIDER, agentId: 7n, success: true, feedbackWritten: true });
    expect(await sim.indexer.EscrowOutcome.getOrThrow(job2)).toMatchObject({ success: false });
  });

  it("does not let any client pass off successRate feedback as an escrow outcome", async () => {
    const sim = new Sim();
    await sim.run(reputation.newFeedback({ agentId: 9n, client: STRANGER, index: 1n, value: 100n, tag1: "successRate" }));
    expect((await sim.indexer.Feedback.getOrThrow(`9-${STRANGER}-1`)).kind).toBe("OTHER");
    expect((await sim.indexer.Agent.getOrThrow("9")).escrowOutcomeCount).toBe(0);
  });
});

describe("XorvCcipReceiver: jobs posted over Chainlink CCIP", () => {
  it("follows an intent from receipt to release, and another to a forwarded refund", async () => {
    const sim = new Sim();
    const a = id32("ccip_a");
    const receiveTx = await sim.run(ccip.received({ jobId: a, messageId: hash32(0xa1), selector: BASE_SEPOLIA, requester: REQUESTER, provider: PROVIDER }));
    expect(await sim.indexer.CrossChainIntent.getOrThrow(a)).toMatchObject({ status: "Received", requester: REQUESTER, sourceChainSelector: BASE_SEPOLIA, receiveTx });
    await sim.run(ccip.funded(a, PROVIDER));
    expect((await sim.indexer.CrossChainIntent.getOrThrow(a)).status).toBe("Funded");
    const settleTx = await sim.run(ccip.released(a));
    expect(await sim.indexer.CrossChainIntent.getOrThrow(a)).toMatchObject({ status: "Released", settleTx });

    const b = id32("ccip_b");
    await sim.run(ccip.received({ jobId: b, messageId: hash32(0xb1), selector: BASE_SEPOLIA, requester: REQUESTER, provider: PROVIDER }));
    await sim.run(ccip.funded(b, PROVIDER));
    await sim.run(ccip.refundClaimed(b, REQUESTER));
    await sim.run(ccip.released(b)); // nothing moves a settled intent
    expect((await sim.indexer.CrossChainIntent.getOrThrow(b)).status).toBe("Refunded");
  });
});
