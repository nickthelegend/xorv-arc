/**
 * The pure halves of Xorv's Arc integrations: Memo tagging, Circle Gateway
 * burn intents and CCTP V2 withdrawals. The chain halves are exercised on an
 * Arc fork (see e2e/ and contracts/).
 */

import { describe, expect, it } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  hexToString,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { ARC_MAINNET, ARC_TESTNET, remoteChain } from "../src/chains.js";
import { MEMO_ABI, jobMemo, memoEventsIn, memoIdForJob, wrapWithMemo } from "../src/memo.js";
import {
  BURN_INTENT_DOMAIN,
  BURN_INTENT_TYPES,
  GatewayInputError,
  buildBurnIntent,
  burnIntentFromJson,
  burnIntentRecipient,
  burnIntentToJson,
  gatewayFor,
  gatewayMaxFee,
} from "../src/gateway.js";
import { CCTP_FAST, CCTP_STANDARD, addressToBytes32, irisMessagesUrl, parseIrisMessages, planCctpWithdraw } from "../src/cctp.js";
import { XORV_ESCROW_ABI } from "../src/xorv-escrow.abi.js";

const MEMO = "0x5294E9927c3306DcBaDb03fe70b92e01cCede505" as Address;
const ESCROW = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const JOB = keccak256(stringToHex("xorv:job:qte_1"));

describe("Arc Memo", () => {
  it("wraps an escrow release so the escrow is still the target and the job id is the memo id", () => {
    const wrapped = wrapWithMemo(
      MEMO,
      { address: ESCROW, abi: XORV_ESCROW_ABI as never, functionName: "release", args: [JOB, keccak256("0x01")], gas: 1n },
      jobMemo(JOB, "release", "job_abc"),
    );
    expect(wrapped.address).toBe(MEMO);
    expect(wrapped.functionName).toBe("memo");
    const [target, data, memoId, memoData] = wrapped.args as [Address, Hex, Hex, Hex];
    expect(target).toBe(ESCROW);
    expect(memoId).toBe(JOB);
    expect(hexToString(memoData)).toBe("xorv:release:job_abc");
    const inner = decodeFunctionData({ abi: XORV_ESCROW_ABI, data });
    expect(inner.functionName).toBe("release");
    expect(inner.args?.[0]).toBe(JOB);
  });

  it("keeps memo text short", () => {
    expect(jobMemo(JOB, "fund", "x".repeat(500)).text.length).toBeLessThanOrEqual(96);
  });

  it("derives the memo id of a broker job like XorvLedger does", () => {
    expect(memoIdForJob("job_abc")).toBe(keccak256(stringToHex("job_abc")));
  });

  it("decodes Memo events from a receipt and skips everything else", () => {
    const topics = encodeEventTopics({
      abi: MEMO_ABI,
      eventName: "Memo",
      args: { sender: "0x1111111111111111111111111111111111111111", target: ESCROW, memoId: JOB },
    }) as Hex[];
    const data = encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes" }, { type: "uint256" }],
      [keccak256("0x02"), stringToHex("xorv:fund"), 7n],
    );
    const events = memoEventsIn(
      [
        { address: MEMO, topics: topics as never, data },
        { address: ESCROW, topics: topics as never, data },
      ],
      MEMO,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ target: ESCROW, memoId: JOB, text: "xorv:fund", memoIndex: 7n });
  });
});

describe("Circle Gateway burn intents", () => {
  const g = gatewayFor(ARC_TESTNET);
  const buyer = privateKeyToAccount(`0x${"11".repeat(32)}`);

  it("targets Arc (domain 26) through Circle's GatewayMinter on both networks", () => {
    expect(g).toMatchObject({ arcDomain: 26, minter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B", apiUrl: "https://gateway-api-testnet.circle.com" });
    expect(gatewayFor(ARC_MAINNET).minter).toBe("0x2222222d7164433c4C09B0b0D809a9b52C04C205");
    expect(g.sources.map((s) => s.domain)).toContain(6);
  });

  it("builds an intent the buyer signs, minting only to the recipient they named", async () => {
    const intent = buildBurnIntent(g, { sourceDomain: 6, depositor: buyer.address, recipient: buyer.address, value: 2_500_000n, salt: keccak256("0x03") });
    expect(intent.spec.destinationDomain).toBe(26);
    expect(intent.spec.destinationCaller).toBe(`0x${"0".repeat(64)}`);
    expect(burnIntentRecipient(intent)).toBe(buyer.address);
    expect(intent.maxFee).toBe(gatewayMaxFee(6, 2_500_000n));
    const signature = await buyer.signTypedData({ domain: BURN_INTENT_DOMAIN, types: BURN_INTENT_TYPES, primaryType: "BurnIntent", message: intent });
    const signer = await recoverTypedDataAddress({ domain: BURN_INTENT_DOMAIN, types: BURN_INTENT_TYPES, primaryType: "BurnIntent", message: intent, signature });
    expect(signer).toBe(buyer.address);
  });

  it("round-trips through JSON and refuses a tampered destination or fee", () => {
    const intent = buildBurnIntent(g, { sourceDomain: 0, depositor: buyer.address, recipient: buyer.address, value: 1_000_000n, salt: keccak256("0x04") });
    const json = burnIntentToJson(intent);
    expect(burnIntentFromJson(g, JSON.parse(JSON.stringify(json)))).toEqual(intent);
    expect(() => burnIntentFromJson(g, { ...json, spec: { ...json.spec, destinationDomain: 6 } })).toThrow(GatewayInputError);
    expect(() => burnIntentFromJson(g, { ...json, maxFee: (intent.maxFee + 1n).toString() })).toThrow(/maxFee/);
    expect(() => buildBurnIntent(g, { sourceDomain: 99, depositor: buyer.address, recipient: buyer.address, value: 1n, salt: keccak256("0x05") })).toThrow(/sourceDomain/);
    expect(() => buildBurnIntent(g, { sourceDomain: 6, depositor: buyer.address, recipient: buyer.address, value: 0n, salt: keccak256("0x05") })).toThrow(/amount/);
  });
});

describe("CCTP V2 withdrawals", () => {
  const provider = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as Address;

  it("plans a fast burn on Arc to Base Sepolia, minting to the provider", () => {
    const base = remoteChain(ARC_TESTNET, "base sepolia")!;
    const plan = planCctpWithdraw(ARC_TESTNET, { destination: base, amount: 5_000_000n, recipient: provider });
    expect(plan.tokenMessenger).toBe("0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA");
    expect(plan.args[1]).toBe(6);
    expect(plan.args[2]).toBe(addressToBytes32(provider));
    expect(plan.args[3]).toBe("0x3600000000000000000000000000000000000000");
    expect(plan.minFinalityThreshold).toBe(CCTP_FAST);
    expect(plan.maxFee).toBe(50_000n);
  });

  it("plans a free standard transfer, and refuses nonsense", () => {
    const eth = remoteChain(ARC_TESTNET, 11155111)!;
    const plan = planCctpWithdraw(ARC_TESTNET, { destination: eth, amount: 1_000_000n, recipient: provider, fast: false });
    expect(plan).toMatchObject({ maxFee: 0n, minFinalityThreshold: CCTP_STANDARD });
    expect(() => planCctpWithdraw(ARC_TESTNET, { destination: eth, amount: 0n, recipient: provider })).toThrow();
    expect(() => planCctpWithdraw(ARC_TESTNET, { destination: eth, amount: 100n, recipient: provider, maxFee: 100n })).toThrow(/maxFee/);
  });

  it("reads Iris attestations", () => {
    expect(irisMessagesUrl(ARC_TESTNET, 26, "0xabc")).toBe("https://iris-api-sandbox.circle.com/v2/messages/26?transactionHash=0xabc");
    expect(parseIrisMessages({ messages: [{ status: "pending_confirmations", message: "0x", attestation: "PENDING" }] })).toEqual([
      { status: "pending_confirmations", message: null, attestation: null },
    ]);
    expect(parseIrisMessages({ messages: [{ status: "complete", message: "0x01", attestation: "0x02" }] })[0]).toMatchObject({ message: "0x01", attestation: "0x02" });
    expect(parseIrisMessages(null)).toEqual([]);
  });
});
