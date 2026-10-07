/**
 * XorvReputation handlers: payout-wallet -> agent bindings and the escrow outcomes the
 * contract writes to ERC-8004. The matching NewFeedback (tag "successRate") is indexed by
 * the ReputationRegistry handler and classified ESCROW_OUTCOME; this records the escrow
 * side (job id, amount, whether the write reached the registry).
 */

import { indexer } from "envio";
import type { Context } from "../lib/entities.js";
import { lower } from "../lib/util.js";

async function seen(context: Context, address: string, at: number): Promise<void> {
  const id = lower(address);
  if (!(await context.ReputationContract.get(id))) context.ReputationContract.set({ id, firstSeenAt: at });
}

indexer.onEvent(
  { contract: "XorvReputation", event: "AgentBound", fields: { block: ["timestamp"], transaction: ["hash"] } },
  async ({ event, context }) => {
    await seen(context, event.srcAddress, event.block.timestamp);
    context.AgentBinding.set({
      id: lower(event.params.wallet),
      agentId: event.params.agentId,
      reputation: lower(event.srcAddress),
      boundAt: event.block.timestamp,
      txHash: lower(event.transaction.hash),
    });
  },
);

indexer.onEvent(
  { contract: "XorvReputation", event: "OutcomeRecorded", fields: { block: ["timestamp"], transaction: ["hash"] } },
  async ({ event, context }) => {
    await seen(context, event.srcAddress, event.block.timestamp);
    const p = event.params;
    const binding = await context.AgentBinding.get(lower(p.provider));
    context.EscrowOutcome.set({
      id: lower(p.jobId),
      provider: lower(p.provider),
      agentId: binding ? p.agentId : undefined,
      success: p.success,
      amount: p.amount,
      feedbackWritten: p.feedbackWritten,
      blockTimestamp: event.block.timestamp,
      txHash: lower(event.transaction.hash),
    });
  },
);
