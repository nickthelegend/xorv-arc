import { describe, expect, it } from "vitest";
import {
  formatUsdMicros,
  formatUsdcUnits,
  parseLeaderboard,
  parseNetwork,
  parseReceipts,
  safeUrl,
} from "@/lib/feeds";
import { shortHex } from "@/lib/chain";

const BUYER = "0x1111111111111111111111111111111111111111";
const PROVIDER = "0x2222222222222222222222222222222222222222";
const PAYMENT_TX = `0x${"ab".repeat(32)}`;
const RECEIPT_TX = `0x${"cd".repeat(32)}`;
const JOB_HASH = `0x${"ef".repeat(32)}`;
const ESCROW = "0x3333333333333333333333333333333333333333";
const REPUTATION = "0x4444444444444444444444444444444444444444";
const MEMO = "0x5294E9927c3306DcBaDb03fe70b92e01cCede505";

/** A receipt exactly as the broker's `legacyReceipt` serves it. */
function receipt(overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
  return {
    id: "1200:3",
    sequence: "1200:3",
    blockNumber: 1200,
    txHash: RECEIPT_TX,
    explorerUrl: `https://explorer.testnet.arc.io/tx/${RECEIPT_TX}`,
    at: 1_790_000_000_000,
    brokerJobId: "job_Ab3dEf9h",
    payload: {
      v: 2,
      kind: "job.receipt",
      at: 1_790_000_000_000,
      data: {
        jobId: JOB_HASH,
        agentId: "42",
        buyer: BUYER,
        payTo: PROVIDER,
        amount: "250000",
        paymentTx: PAYMENT_TX,
        requestHash: JOB_HASH,
        resultHash: JOB_HASH,
        durationMs: 8400,
        ok: true,
        brokerJobId: "job_Ab3dEf9h",
        payer: BUYER,
        providerAddress: PROVIDER,
        providerAccountId: PROVIDER,
        asset: "0x3600000000000000000000000000000000000000",
        transactionId: PAYMENT_TX,
        paymentUrl: `https://explorer.testnet.arc.io/tx/${PAYMENT_TX}`,
        ...data,
      },
    },
    ...overrides,
  };
}

describe("parseReceipts", () => {
  it("flattens a broker receipt and keeps the payload's explorer links", () => {
    const feed = parseReceipts({ ledger: { address: PROVIDER }, source: "indexer", receipts: [receipt()] });
    expect(feed.configured).toBe(true);
    expect(feed.source).toBe("indexer");
    expect(feed.receipts).toEqual([
      {
        id: "1200:3",
        jobId: "job_Ab3dEf9h",
        buyer: BUYER,
        payTo: PROVIDER,
        amountUnits: "250000",
        ok: true,
        durationMs: 8400,
        at: 1_790_000_000_000,
        explorerUrl: `https://explorer.testnet.arc.io/tx/${RECEIPT_TX}`,
        paymentUrl: `https://explorer.testnet.arc.io/tx/${PAYMENT_TX}`,
      },
    ]);
  });

  it("falls back to the pre-port keys when the new ones are missing", () => {
    const old = {
      sequence: 7,
      payload: { data: { jobId: JOB_HASH, payer: BUYER, providerAccountId: PROVIDER, amount: 5000, transactionId: PAYMENT_TX } },
    };
    const [row] = parseReceipts({ source: "rpc", receipts: [old] }).receipts;
    expect(row).toMatchObject({ id: "7", jobId: JOB_HASH, buyer: BUYER, payTo: PROVIDER, amountUnits: "5000" });
    // No payment URL in the payload means no link — the page does not build one.
    expect(row?.paymentUrl).toBeNull();
  });

  it("drops the payment link for a job recorded unpaid", () => {
    const [row] = parseReceipts({
      source: "rpc",
      receipts: [receipt({}, { paymentTx: null, transactionId: null, paymentUrl: null })],
    }).receipts;
    expect(row?.paymentUrl).toBeNull();
    const [zero] = parseReceipts({
      source: "rpc",
      receipts: [receipt({}, { paymentTx: `0x${"0".repeat(64)}`, transactionId: null })],
    }).receipts;
    expect(zero?.paymentUrl).toBeNull();
  });

  it("refuses non-http links from the payload", () => {
    const [row] = parseReceipts({
      source: "rpc",
      receipts: [receipt({ explorerUrl: "javascript:alert(1)" }, { paymentUrl: "data:text/html,hi" })],
    }).receipts;
    expect(row?.explorerUrl).toBeNull();
    expect(row?.paymentUrl).toBeNull();
  });

  it("tells an unconfigured broker apart from an empty ledger", () => {
    expect(parseReceipts({ ledger: null, topic: null, source: "none", receipts: [] })).toEqual({
      configured: false,
      source: "none",
      receipts: [],
    });
    expect(parseReceipts({ ledger: { address: PROVIDER }, source: "rpc", receipts: [] }).configured).toBe(true);
  });

  it("survives garbage without inventing rows", () => {
    expect(parseReceipts(null).receipts).toEqual([]);
    expect(parseReceipts({ receipts: "nope" }).receipts).toEqual([]);
    expect(parseReceipts({ source: "rpc", receipts: [null, 3, "x"] }).receipts).toEqual([]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 10 }, (_, i) => receipt({ id: `1:${i}` }));
    expect(parseReceipts({ source: "rpc", receipts: many }, 4).receipts).toHaveLength(4);
  });
});

describe("parseNetwork", () => {
  it("reads the fields the section shows", () => {
    const net = parseNetwork({
      network: "eip155:5042002",
      chainId: 5042002,
      explorerUrl: "https://explorer.testnet.arc.io",
      usdc: { address: "0x3600000000000000000000000000000000000000", url: "https://explorer.testnet.arc.io/token/0x3600000000000000000000000000000000000000" },
      ledger: { address: PROVIDER, url: `https://explorer.testnet.arc.io/address/${PROVIDER}`, mode: "write" },
      escrow: { address: ESCROW, url: `https://explorer.testnet.arc.io/address/${ESCROW}`, deadlineSeconds: 1800 },
      arc: {
        gasToken: "USDC",
        finality: "deterministic, sub-second",
        memo: { address: MEMO, url: `https://explorer.testnet.arc.io/address/${MEMO}`, enabled: true },
        reputation: { address: REPUTATION, url: "javascript:alert(1)" },
      },
      erc8004: { identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e", reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713" },
      indexer: { url: "https://indexer.example/v1/graphql" },
      ai: { router: { by: "qwen", model: "qwen3.8-max" }, screener: null, verifier: { by: "kimi", model: "kimi-k3" } },
      stats: { providersLive: 3, jobsCompleted: 12, paidUsdMicros: 1_420_000, heldUsdMicros: 250_000 },
    });
    expect(net).toMatchObject({
      network: "eip155:5042002",
      chainId: 5042002,
      ledger: { address: PROVIDER },
      escrow: { address: ESCROW, url: `https://explorer.testnet.arc.io/address/${ESCROW}` },
      memo: { address: MEMO, url: `https://explorer.testnet.arc.io/address/${MEMO}` },
      // A non-http link from the broker is dropped; the address still shows.
      reputation: { address: REPUTATION, url: null },
      indexer: true,
      ai: { router: "qwen3.8-max", screener: null, verifier: "kimi-k3" },
      stats: { providersLive: 3, jobsCompleted: 12, paidUsdMicros: 1_420_000, heldUsdMicros: 250_000, refundedUsdMicros: 0 },
    });
  });

  it("returns null ledger and stats when the broker has neither", () => {
    const net = parseNetwork({ network: "eip155:5042002", ledger: null, escrow: null, indexer: null });
    expect(net?.ledger).toBeNull();
    expect(net?.escrow).toBeNull();
    expect(net?.reputation).toBeNull();
    expect(net?.memo).toBeNull();
    expect(net?.stats).toBeNull();
    expect(net?.indexer).toBe(false);
    expect(parseNetwork("not json")).toBeNull();
  });
});

describe("parseLeaderboard", () => {
  it("reads leaderboard rows and says where they came from", () => {
    const feed = parseLeaderboard({
      source: "indexer",
      providers: [
        {
          rank: 1,
          label: "nivesh-macbook",
          address: PROVIDER,
          addressUrl: `https://explorer.testnet.arc.io/address/${PROVIDER}`,
          agentId: "42",
          agentUrl: "https://explorer.testnet.arc.io/token/0x8004A818BFB912233c491871b3d84c89A494BD9e/instance/42",
          live: true,
          jobsTotal: 9,
          jobsOk: 8,
          jobsFailed: 1,
          successRate: 8 / 9,
          earnedUsdMicros: 2_000_000,
          avgRating: 91.5,
          ratingsCount: 4,
        },
      ],
    });
    expect(feed.source).toBe("indexer");
    expect(feed.providers[0]).toMatchObject({ rank: 1, label: "nivesh-macbook", agentId: "42", live: true, jobsOk: 8 });
  });

  it("is empty, not broken, on a bad payload", () => {
    expect(parseLeaderboard({ providers: null })).toEqual({ source: null, providers: [] });
  });
});

describe("formatting", () => {
  it("formats USDC units exactly, trimmed to the precision the amount has", () => {
    expect(formatUsdcUnits("250000")).toBe("0.25");
    expect(formatUsdcUnits("2500")).toBe("0.0025");
    expect(formatUsdcUnits("1")).toBe("0.000001");
    expect(formatUsdcUnits("12000000")).toBe("12.00");
    expect(formatUsdcUnits("not a number")).toBe("—");
    expect(formatUsdMicros(1_420_000)).toBe("1.42");
  });

  it("shortens hashes the way the protocol does", () => {
    expect(shortHex(PAYMENT_TX)).toBe("0xabab…abab");
    expect(shortHex("0x1234")).toBe("0x1234");
  });

  it("only lets http(s) URLs through", () => {
    expect(safeUrl("https://explorer.arc.io/tx/0x1")).toBe("https://explorer.arc.io/tx/0x1");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl(42)).toBeNull();
  });
});
