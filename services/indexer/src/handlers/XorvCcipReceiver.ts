/**
 * XorvCcipReceiver handlers: jobs posted from Base / Ethereum over Chainlink CCIP. The
 * receiver funds XorvEscrow once CCTP's USDC has landed, so the same job id appears as an
 * EscrowJob whose buyer is the receiver.
 */

import { indexer } from "envio";
import { lower } from "../lib/util.js";

indexer.onEvent(
  { contract: "XorvCcipReceiver", event: "IntentReceived", fields: { block: ["timestamp"], transaction: ["hash"] } },
  async ({ event, context }) => {
    const p = event.params;
    const id = lower(p.jobId);
    if (await context.CrossChainIntent.get(id)) return;
    context.CrossChainIntent.set({
      id,
      messageId: lower(p.messageId),
      sourceChainSelector: p.sourceChainSelector,
      requester: lower(p.requester),
      provider: lower(p.provider),
      price: p.price,
      deadline: BigInt(p.deadline),
      status: "Received",
      receivedAt: event.block.timestamp,
      fundedAt: undefined,
      settledAt: undefined,
      receiveTx: lower(event.transaction.hash),
      settleTx: undefined,
    });
  },
);

/** Move an intent to `status`, keeping a terminal one where it is. */
function transition(status: "Pending" | "Funded" | "Released" | "Refunded" | "Cancelled") {
  return async ({ event, context }: { event: any; context: any }) => {
    const intent = await context.CrossChainIntent.get(lower(event.params.jobId));
    if (!intent || ["Released", "Refunded", "Cancelled"].includes(intent.status)) return;
    const at = event.block.timestamp;
    context.CrossChainIntent.set({
      ...intent,
      status,
      ...(status === "Funded" ? { fundedAt: at } : {}),
      ...(status === "Released" || status === "Refunded" || status === "Cancelled" ? { settledAt: at, settleTx: lower(event.transaction.hash) } : {}),
    });
  };
}

const FIELDS = { block: ["timestamp"], transaction: ["hash"] } as const;
indexer.onEvent({ contract: "XorvCcipReceiver", event: "IntentPending", fields: FIELDS }, transition("Pending"));
indexer.onEvent({ contract: "XorvCcipReceiver", event: "IntentFunded", fields: FIELDS }, transition("Funded"));
indexer.onEvent({ contract: "XorvCcipReceiver", event: "IntentReleased", fields: FIELDS }, transition("Released"));
indexer.onEvent({ contract: "XorvCcipReceiver", event: "RefundClaimed", fields: FIELDS }, transition("Refunded"));
indexer.onEvent({ contract: "XorvCcipReceiver", event: "IntentCancelled", fields: FIELDS }, transition("Cancelled"));
