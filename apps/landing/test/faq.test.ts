import { describe, expect, it } from "vitest";
import { FAQ } from "@/lib/faq";

/*
 * The FAQ makes claims about what the chain records, and a judge can check
 * them against XorvLedger, XorvEscrow and XorvReputation on Arc. When a
 * provider fails mid-job the broker reassigns the job (jobs.ts `reassign` sets
 * it back to "assigned", which is not terminal), so no XorvLedger receipt is
 * written for the failure: the job gets one receipt for its final outcome,
 * without an agent identity. The failure does count in the broker's matcher,
 * and `XorvEscrow.reassign` reports it to XorvReputation as a failed outcome.
 */

function answer(question: RegExp): string {
  const item = FAQ.find((entry) => question.test(entry.q));
  if (!item) throw new Error(`no FAQ entry matches ${question}`);
  return item.a;
}

describe("FAQ", () => {
  it("does not claim a reassigned job's failure is recorded on-chain", () => {
    const a = answer(/fails or disappears mid-job/);
    expect(a).not.toMatch(/recorded on-chain as a failed receipt/i);
    expect(a).toMatch(/exactly one receipt/i);
    expect(a).toMatch(/without an agent identity/i);
    expect(a).toMatch(/matcher/);
    // XorvEscrow.reassign reports the original provider's failure on-chain.
    expect(a).toMatch(/XorvReputation/);
    // Arc's escrow does refund; the pre-escrow "no refund path" line must not survive.
    expect(a).not.toMatch(/no refund path/i);
    expect(a).toMatch(/refunds the buyer in full/i);
  });

  it("names Arc's gas token honestly", () => {
    const a = answer(/gas token/);
    expect(a).toMatch(/USDC is the gas token/);
  });

  it("carries nothing over from the pre-Arc deployment", () => {
    // Spelled in pieces so a repo-wide grep for leftover names finds the
    // copy, not this guard.
    const stale = new RegExp(["mo" + "nad", "\\bM" + "ON\\b", "A" + "USD", "nan" + "sen", "clean" + "verse"].join("|"), "i");
    for (const { q, a } of FAQ) {
      expect(`${q} ${a}`).not.toMatch(stale);
    }
  });
});
