import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, stringToHex, type Hex } from "viem";
import { ARC_TESTNET, MEMO_ABI, memoEventsIn, networkConfig, parseIrisMessages, planCctpWithdraw } from "@xorv/protocol/web";
import { GAS_RESERVE_UNITS, defaultWithdrawUnits, irisState, readPendingWithdrawal } from "@/lib/cctp-withdraw";
import { memoMatchesJob, memoTxs } from "@/lib/memo-tags";
import type { Job } from "@/lib/api";

const h = (b: string): Hex => `0x${b.repeat(32)}` as Hex;

describe("a provider's CCTP withdrawal", () => {
  it("keeps a little USDC back for Arc's gas when withdrawing everything", () => {
    expect(GAS_RESERVE_UNITS).toBe(50_000n);
    expect(defaultWithdrawUnits("1050000")).toBe(1_000_000n);
    expect(defaultWithdrawUnits("40000")).toBe(0n);
  });

  it("plans the burn on Arc to the chosen chain", () => {
    const cfg = networkConfig(ARC_TESTNET);
    const base = cfg.remotes.find((r) => r.name === "Base Sepolia")!;
    const plan = planCctpWithdraw(ARC_TESTNET, { destination: base, amount: 1_000_000n, recipient: "0x3333333333333333333333333333333333333333" });
    expect(plan.tokenMessenger).toBe(cfg.circle.tokenMessengerV2);
    expect(plan.args[1]).toBe(6);
    expect(plan.minFinalityThreshold).toBe(1000);
  });

  it("follows Iris from unseen to pending to complete", () => {
    expect(irisState(parseIrisMessages({}))).toEqual({ state: "unseen" });
    expect(irisState(parseIrisMessages({ messages: [{ status: "pending_confirmations", message: "0x", attestation: "PENDING" }] }))).toEqual({
      state: "pending",
      status: "pending_confirmations",
    });
    expect(irisState(parseIrisMessages({ messages: [{ status: "complete", message: "0xaa", attestation: "0xbb" }] }))).toEqual({
      state: "complete",
      message: "0xaa",
      attestation: "0xbb",
    });
  });

  it("survives a reload only with a well-formed pending record", () => {
    const ok = readPendingWithdrawal(JSON.stringify({ burnTx: h("ab"), chainId: 84532, amountUnits: "1000000", recipient: "0x3333333333333333333333333333333333333333", startedAt: 1 }));
    expect(ok).toMatchObject({ chainId: 84532, mintTx: null });
    expect(readPendingWithdrawal("{")).toBeNull();
    expect(readPendingWithdrawal(JSON.stringify({ burnTx: "0x12", chainId: 1 }))).toBeNull();
    expect(readPendingWithdrawal(null)).toBeNull();
  });
});

describe("a job's Arc Memo tags", () => {
  const payment = {
    asset: "usdc",
    assetAddress: "0x3600000000000000000000000000000000000000",
    amount: "1000",
    network: ARC_TESTNET,
    txHash: h("01"),
    payer: "0x9735aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5c96",
    payTo: "0xd5cdc9020acd286fe06c587694b38f4795df238c",
    settledAt: 0,
    explorerUrl: "",
  };

  it("lists the movements that should carry a tag", () => {
    expect(memoTxs({ payment: null })).toEqual([]);
    expect(memoTxs({ payment: { ...payment, scheme: "exact" } } as Pick<Job, "payment">)).toEqual([{ label: "transfer", tx: h("01") }]);
    const escrowed = {
      payment: {
        ...payment,
        scheme: "escrow",
        escrow: { address: "0x1", jobId: h("ee"), deadline: 0, state: "released", provider: "0x2", releaseTx: h("02"), reassignTxs: [h("03")], explorerUrl: "" },
      },
    } as Pick<Job, "payment">;
    expect(memoTxs(escrowed).map((m) => m.label)).toEqual(["fund", "reassign", "release"]);
    // Funded over CCIP: the receiver funded it, so only the broker's own settlement is tagged.
    const ccip = { payment: { ...escrowed.payment!, crossChain: { via: "ccip", receiver: "0x5", sourceChain: "Base", sourceChainSelector: "1", requester: "0x6", messageId: null, ccipExplorerUrl: null } } } as Pick<Job, "payment">;
    expect(memoTxs(ccip).map((m) => m.label)).toEqual(["reassign", "release"]);
  });

  it("decodes the Memo event from a receipt and checks it is this job's id", () => {
    const memo = networkConfig(ARC_TESTNET).circle.memo;
    const jobId = h("ee");
    const topics = encodeEventTopics({
      abi: MEMO_ABI,
      eventName: "Memo",
      args: { sender: "0x1111111111111111111111111111111111111111", target: "0x2222222222222222222222222222222222222222", memoId: jobId },
    });
    const data = encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes" }, { type: "uint256" }],
      [h("cc"), stringToHex("xorv:release"), 4n],
    );
    const events = memoEventsIn([{ address: memo, topics: topics as [Hex, ...Hex[]], data }], memo);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ memoId: jobId, text: "xorv:release" });
    expect(memoMatchesJob(events[0]!.memoId, jobId.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(memoMatchesJob(events[0]!.memoId, h("ff"))).toBe(false);
    expect(memoMatchesJob(events[0]!.memoId, null)).toBeNull();
  });
});
