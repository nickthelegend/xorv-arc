/**
 * The CCIP instructions `xorv_ccip_quote` hands a buyer agent on Base or
 * Ethereum: pure, so the calldata and the steps are pinned without a server.
 */

import { describe, expect, it } from "vitest";
import { decodeFunctionData, type Hex } from "viem";
import { xorvCcipSenderAbi, type CcipQuoteTerms } from "@xorv/protocol";
import { ccipInstructions } from "../src/server.js";
import { requestCcipQuote, BuyError } from "../src/buy.js";
import type { BrokerClient } from "../src/broker.js";

const NETWORK = "eip155:5042002";
const SENDER = "0x00000000000000000000000000000000000000c5";
const PROVIDER = "0x00000000000000000000000000000000000000A1";
const JOB = `0x${"5e".repeat(32)}` as Hex;

const terms: CcipQuoteTerms = {
  receiver: "0x5ea567E283a0EAbd8377153c6245223BdA5bAE46",
  arcChainSelector: "3034092155422581607",
  jobId: JOB,
  provider: PROVIDER,
  price: "40000",
  deadline: 1_790_007_200,
  sources: [
    { name: "Base Sepolia", chainId: 84532, selector: "10344971235874465080", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", cctpDomain: 6 },
    { name: "Ethereum Sepolia", chainId: 11155111, selector: "16015286601757825753", usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", cctpDomain: 0 },
  ],
  senders: { "84532": SENDER },
};

describe("ccipInstructions", () => {
  it("gives approve → quotePostJob → postJob for a standard transfer, with the exact calldata", () => {
    const { lines, sources } = ccipInstructions(NETWORK, terms, { sourceChain: "84532" });
    expect(sources.map((s) => s.name)).toEqual(["Base Sepolia"]);
    const text = lines.join("\n");
    expect(text).toContain(`USDC.approve(${SENDER}, 40000)`);
    expect(text).toContain(`quotePostJob(${JOB}, ${PROVIDER}, 40000, 1790007200)`);
    const data = /calldata: (0x[0-9a-f]+)/.exec(text)![1] as Hex;
    expect(decodeFunctionData({ abi: xorvCcipSenderAbi, data })).toEqual({
      functionName: "postJob",
      args: [JOB, PROVIDER, 40_000n, 1_790_007_200, 0n, 2000],
    });
  });

  it("plans a fast transfer with threshold 1000 and a maxFee to fill in", () => {
    const text = ccipInstructions(NETWORK, terms, { sourceChain: "Base Sepolia", fast: true }).lines.join("\n");
    expect(text).toContain("40000 + maxFee");
    expect(text).toMatch(/maxFee, 1000\)/);
    expect(text).not.toContain("calldata");
  });

  it("lists every lane by default and says when it knows no sender on a chain", () => {
    const { lines, sources } = ccipInstructions(NETWORK, terms);
    expect(sources).toHaveLength(2);
    expect(lines.join("\n")).toMatch(/Ethereum Sepolia[\s\S]*knows none on this chain/);
  });

  it("refuses a source chain with no lane to Arc", () => {
    expect(() => ccipInstructions(NETWORK, terms, { sourceChain: "solana" })).toThrow(BuyError);
    expect(() => ccipInstructions(NETWORK, { ...terms, sources: terms.sources.slice(1) }, { sourceChain: "base-sepolia" })).toThrow(
      /no CCIP lane from "base-sepolia"/,
    );
  });
});

describe("requestCcipQuote", () => {
  const broker = (status: number, body: unknown): BrokerClient & { posted: unknown[] } => {
    const posted: unknown[] = [];
    return {
      url: "http://b",
      posted,
      getJson: async () => {
        throw new Error("unused");
      },
      getJob: async () => {
        throw new Error("unused");
      },
      postJson: async <T>(_path: string, payload: unknown) => {
        posted.push(payload);
        return { status, ok: status < 400, body: body as T };
      },
    };
  };

  it("asks the broker with payVia: ccip and returns the terms", async () => {
    const b = broker(200, { quoteId: "qte_1", ccip: terms });
    const quote = await requestCcipQuote(b, { prompt: "p", ceilingUsdMicros: 50_000 });
    expect(quote.ccip.jobId).toBe(JOB);
    expect(b.posted).toEqual([{ prompt: "p", adapter: null, maxPriceUsdMicros: 50_000, payVia: "ccip" }]);
  });

  it("turns a broker without cross-chain support into a readable refusal", async () => {
    await expect(requestCcipQuote(broker(400, { error: "this broker takes no cross-chain jobs" }), { prompt: "p", ceilingUsdMicros: 1 })).rejects.toThrow(
      /no cross-chain jobs/,
    );
    await expect(requestCcipQuote(broker(200, { quoteId: "q", ccip: null }), { prompt: "p", ceilingUsdMicros: 1 })).rejects.toThrow(
      /without CCIP terms/,
    );
  });
});
