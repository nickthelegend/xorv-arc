/**
 * Which of a job's transactions carry an Arc Memo tag, and what it should say.
 *
 * The broker routes every money movement for a job through Arc's Memo
 * contract — the escrow's fund, release, refund and reassign, and a direct
 * payment's x402 transfer — with `memoId` set to the job's escrow id
 * (`escrowJobId(quoteId)`) and a short text such as `xorv:release`. The job
 * page reads each transaction's receipt from Arc and decodes the `Memo` events
 * (protocol's `memoEventsIn`), so the tag shown is the one on chain, not the
 * broker's word for it. Pure: the I/O is in components/memo-tags.tsx.
 */

import type { Job } from "@/lib/api";

export interface MemoTx {
  /** What this transaction did for the job. */
  label: "fund" | "transfer" | "release" | "refund" | "reassign";
  tx: string;
}

const HASH = /^0x[0-9a-fA-F]{64}$/;

/** The job's transactions that should carry a Memo, in the order they happened. */
export function memoTxs(job: Pick<Job, "payment">): MemoTx[] {
  const p = job.payment;
  if (!p) return [];
  const out: MemoTx[] = [];
  const escrow = p.escrow ?? null;
  // A CCIP-funded job is funded by XorvCcipReceiver, not the broker's facilitator: no Memo on that one.
  if (!p.crossChain) out.push({ label: escrow ? "fund" : "transfer", tx: p.txHash });
  for (const tx of escrow?.reassignTxs ?? []) out.push({ label: "reassign", tx });
  if (escrow?.releaseTx) out.push({ label: "release", tx: escrow.releaseTx });
  if (escrow?.refundTx) out.push({ label: "refund", tx: escrow.refundTx });
  return out.filter((m) => HASH.test(m.tx));
}

/** Whether a decoded memoId is the job's escrow id (case-insensitive); null when there's no escrow id to compare. */
export function memoMatchesJob(memoId: string, escrowJobId: string | null | undefined): boolean | null {
  if (!escrowJobId || !HASH.test(escrowJobId)) return null;
  return memoId.toLowerCase() === escrowJobId.toLowerCase();
}
