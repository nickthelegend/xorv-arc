/**
 * `xorv withdraw` — CCTP V2 out of Arc, through viem's real encode/decode path
 * against scripted chains (Arc and the destination) and a scripted Iris.
 *
 * Money is burned in the middle of this flow, so the tests pin what each
 * signed transaction does (approve only when short, the exact depositForBurn
 * arguments), how the attestation wait reads Iris, and that every way the
 * mint can fail still hands back the message, the attestation and the exact
 * command to finish.
 */

import { describe, expect, it } from "vitest";
import { concat, decodeFunctionData, encodeFunctionResult, numberToHex, pad, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CCTP_FAST,
  CCTP_STANDARD,
  ERC20_APPROVE_ABI,
  ERC20_ABI,
  MESSAGE_TRANSMITTER_V2_ABI,
  TOKEN_MESSENGER_V2_ABI,
  networkConfig,
  planCctpWithdraw,
} from "@xorv/protocol";
import {
  GAS_RESERVE_UNITS,
  burnOnArc,
  castReceiveCommand,
  formatUnitsPlain,
  messageDestinationDomain,
  resolveDestination,
  runWithdraw,
  waitForAttestation,
  withdrawAmount,
  withdrawJson,
  type WithdrawEvent,
} from "../src/commands/withdraw.js";
import { fakeChain } from "./support/fake-chain.js";

const NETWORK = "eip155:5042002";
const cfg = networkConfig(NETWORK);
const USDC = cfg.usdc.address;
const TOKEN_MESSENGER = cfg.circle.tokenMessengerV2;
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const DEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const account = privateKeyToAccount(KEY);
const PAYOUT = account.address;
const RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const baseSepolia = resolveDestination(NETWORK, "base-sepolia");

/** A CCTP V2 message header (+ a stub body) from Arc (26) to `destDomain`. */
function cctpMessage(destDomain: number): Hex {
  return concat([
    numberToHex(1, { size: 4 }),
    numberToHex(26, { size: 4 }),
    numberToHex(destDomain, { size: 4 }),
    pad("0x01", { size: 32 }),
    pad(TOKEN_MESSENGER, { size: 32 }),
    pad(baseSepolia.tokenMessengerV2, { size: 32 }),
    pad("0x00", { size: 32 }),
    numberToHex(CCTP_FAST, { size: 4 }),
    numberToHex(CCTP_FAST, { size: 4 }),
    "0xdeadbeef",
  ]).toLowerCase() as Hex;
}
const MESSAGE = cctpMessage(6);
const ATTESTATION = `0x${"ab".repeat(65)}` as Hex;

/** Arc: answers USDC balanceOf / allowance and accepts approve + depositForBurn. */
function arc(opts: { balance?: bigint; allowance?: bigint; revertBurn?: boolean } = {}) {
  return fakeChain({
    chainId: 5042002,
    from: PAYOUT,
    call: ({ to, data }) => {
      expect(to.toLowerCase()).toBe(USDC.toLowerCase());
      const fn = data.slice(0, 10);
      if (fn === "0x70a08231") return encodeFunctionResult({ abi: ERC20_ABI, functionName: "balanceOf", result: opts.balance ?? 0n });
      const { functionName } = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data });
      expect(functionName).toBe("allowance");
      return encodeFunctionResult({ abi: ERC20_APPROVE_ABI, functionName: "allowance", result: opts.allowance ?? 0n });
    },
    revert: (tx) => Boolean(opts.revertBurn && tx.to?.toLowerCase() === TOKEN_MESSENGER.toLowerCase()),
  });
}

/** The destination chain: accepts receiveMessage. */
function destination(chainId = 84532) {
  return fakeChain({ chainId, from: privateKeyToAccount(DEST_KEY).address });
}

/** Iris, scripted as a list of answers (the last one repeats). */
function iris(answers: Array<{ status: number; body?: unknown } | Error>) {
  const urls: string[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request) => {
    urls.push(String(url));
    const answer = answers[Math.min(i, answers.length - 1)]!;
    i += 1;
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer.body ?? { error: "Message hash not found" }), { status: answer.status });
  }) as typeof fetch;
  return { fetchImpl, urls };
}
const pending = { status: 200, body: { messages: [{ status: "pending_confirmations", message: "0x", attestation: "PENDING" }] } };
const complete = (message: Hex = MESSAGE) => ({ status: 200, body: { messages: [{ status: "complete", message, attestation: ATTESTATION }] } });
const noSleep = async () => {};

describe("resolveDestination", () => {
  it("finds a CCTP destination by name in any spelling, or by chain id", () => {
    expect(resolveDestination(NETWORK, "Base Sepolia").chainId).toBe(84532);
    expect(resolveDestination(NETWORK, "base_sepolia").cctpDomain).toBe(6);
    expect(resolveDestination(NETWORK, "11155111").name).toBe("Ethereum Sepolia");
    expect(resolveDestination("eip155:5042", "base").chainId).toBe(8453);
  });

  it("lists the destinations when --to is missing or unknown", () => {
    expect(() => resolveDestination(NETWORK, undefined)).toThrow(/--to is required: one of Base Sepolia \(84532\), Ethereum Sepolia \(11155111\)/);
    expect(() => resolveDestination(NETWORK, "solana")).toThrow(/can't withdraw to "solana".*Base Sepolia/);
    // A mainnet chain is not a testnet destination.
    expect(() => resolveDestination(NETWORK, "8453")).toThrow(/can't withdraw/);
  });
});

describe("withdrawAmount", () => {
  it("defaults to the whole balance minus the gas reserve (gas on Arc is the same USDC)", () => {
    expect(GAS_RESERVE_UNITS).toBe(50_000n);
    expect(withdrawAmount({ balanceUnits: 12_345_678n })).toBe(12_295_678n);
  });

  it("takes an explicit amount in USDC, up to 6 decimals", () => {
    expect(withdrawAmount({ requested: "2.5", balanceUnits: 10_000_000n })).toBe(2_500_000n);
    expect(withdrawAmount({ requested: "$0.000001", balanceUnits: 10_000_000n })).toBe(1n);
    expect(() => withdrawAmount({ requested: "1.1234567", balanceUnits: 10_000_000n })).toThrow(/at most 6 decimals/);
    expect(() => withdrawAmount({ requested: "abc", balanceUnits: 10_000_000n })).toThrow(/--amount/);
    expect(() => withdrawAmount({ requested: "0", balanceUnits: 10_000_000n })).toThrow(/more than zero/);
  });

  it("refuses an amount that leaves nothing for gas, and says the most it can be", () => {
    expect(() => withdrawAmount({ requested: "10", balanceUnits: 10_000_000n })).toThrow(/withdraw at most 9\.95/);
    expect(() => withdrawAmount({ balanceUnits: 40_000n })).toThrow(/nothing to withdraw/);
  });

  it("prints plain decimals to paste back into --amount", () => {
    expect(formatUnitsPlain(9_950_000n)).toBe("9.95");
    expect(formatUnitsPlain(3_000_000n)).toBe("3");
    expect(formatUnitsPlain(1n)).toBe("0.000001");
  });
});

describe("the CCTP message and the finishing command", () => {
  it("reads the destination domain from the message header", () => {
    expect(messageDestinationDomain(MESSAGE)).toBe(6);
    expect(messageDestinationDomain(cctpMessage(0))).toBe(0);
  });

  it("prints a cast send against the destination's MessageTransmitterV2", () => {
    expect(castReceiveCommand(baseSepolia, MESSAGE, ATTESTATION, "MY_KEY")).toBe(
      `cast send ${baseSepolia.messageTransmitterV2} "receiveMessage(bytes,bytes)" ${MESSAGE} ${ATTESTATION} ` +
        `--rpc-url https://sepolia.base.org --private-key $MY_KEY`,
    );
  });
});

describe("burnOnArc", () => {
  const plan = planCctpWithdraw(NETWORK, { destination: baseSepolia, amount: 5_000_000n, recipient: RECIPIENT });

  it("approves TokenMessengerV2 when the allowance is short, then burns with the planned arguments", async () => {
    const node = arc({ allowance: 0n });
    const seen: Array<[Hex | null, bigint]> = [];
    const { approveTx, burnTx } = await burnOnArc({
      network: NETWORK,
      account,
      plan,
      client: { transport: node.transport },
      onApprove: (tx, allowance) => seen.push([tx, allowance]),
    });
    const [approve, burn] = node.decoded();
    expect(node.sent).toHaveLength(2);
    expect(approveTx).not.toBeNull();
    expect(seen).toEqual([[approveTx, 0n]]);

    expect(approve!.to?.toLowerCase()).toBe(USDC.toLowerCase());
    expect(approve!.chainId).toBe(5042002);
    expect(decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: approve!.data! })).toEqual({
      functionName: "approve",
      args: [TOKEN_MESSENGER, 5_000_000n],
    });

    expect(burn!.to?.toLowerCase()).toBe(TOKEN_MESSENGER.toLowerCase());
    const { functionName, args } = decodeFunctionData({ abi: TOKEN_MESSENGER_V2_ABI, data: burn!.data! });
    expect(functionName).toBe("depositForBurn");
    expect(args).toEqual([
      5_000_000n,
      6,
      pad(RECIPIENT.toLowerCase() as Hex, { size: 32 }),
      USDC,
      `0x${"0".repeat(64)}`,
      50_000n, // fast: 1% of 5 USDC
      CCTP_FAST,
    ]);
    expect(burnTx).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("skips the approval when the allowance already covers the amount", async () => {
    const node = arc({ allowance: 10_000_000n });
    const { approveTx } = await burnOnArc({ network: NETWORK, account, plan, client: { transport: node.transport } });
    expect(approveTx).toBeNull();
    expect(node.sent).toHaveLength(1);
    expect(node.decoded()[0]!.to?.toLowerCase()).toBe(TOKEN_MESSENGER.toLowerCase());
  });

  it("burns a standard transfer with no fee at threshold 2000", async () => {
    const node = arc({ allowance: 10_000_000n });
    const standard = planCctpWithdraw(NETWORK, { destination: baseSepolia, amount: 5_000_000n, recipient: RECIPIENT, fast: false });
    await burnOnArc({ network: NETWORK, account, plan: standard, client: { transport: node.transport } });
    const { args } = decodeFunctionData({ abi: TOKEN_MESSENGER_V2_ABI, data: node.decoded()[0]!.data! });
    expect(args?.[5]).toBe(0n);
    expect(args?.[6]).toBe(CCTP_STANDARD);
  });

  it("fails with the Arc explorer link when the burn reverts", async () => {
    const node = arc({ allowance: 10_000_000n, revertBurn: true });
    await expect(burnOnArc({ network: NETWORK, account, plan, client: { transport: node.transport } })).rejects.toThrow(
      /depositForBurn\(\) reverted.*explorer\.testnet\.arc\.io\/tx\//,
    );
  });
});

describe("waitForAttestation", () => {
  const BURN = `0x${"12".repeat(32)}` as Hex;

  it("polls Iris for Arc's domain (26) until the message is complete, reporting each status once", async () => {
    const { fetchImpl, urls } = iris([{ status: 404 }, pending, pending, complete()]);
    const statuses: string[] = [];
    const out = await waitForAttestation({ network: NETWORK, burnTx: BURN, fetchImpl, timeoutMs: 60_000, sleep: noSleep, onStatus: (s) => statuses.push(s) });
    expect(out).toMatchObject({ status: "complete", message: MESSAGE, attestation: ATTESTATION });
    expect(urls[0]).toBe(`https://iris-api-sandbox.circle.com/v2/messages/26?transactionHash=${BURN}`);
    expect(urls).toHaveLength(4);
    expect(statuses).toEqual(["not indexed yet", "pending_confirmations", "complete"]);
  });

  it("rides out an Iris outage and gives up (null) at the timeout", async () => {
    let t = 0;
    const { fetchImpl } = iris([new TypeError("fetch failed"), { status: 503 }]);
    const statuses: string[] = [];
    const out = await waitForAttestation({
      network: NETWORK,
      burnTx: BURN,
      fetchImpl,
      timeoutMs: 10_000,
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      onStatus: (s) => statuses.push(s),
    });
    expect(out).toBeNull();
    expect(statuses).toEqual(["iris unreachable (fetch failed)", "iris answered 503"]);
  });
});

describe("runWithdraw", () => {
  const plan = planCctpWithdraw(NETWORK, { destination: baseSepolia, amount: 5_000_000n, recipient: RECIPIENT });
  const input = { network: NETWORK, account, destination: baseSepolia, plan, wait: true, mintKeyEnv: "XORV_DEST_KEY", timeoutMs: 60_000 };

  it("burns, waits for the attestation and mints on the destination with the destination key", async () => {
    const node = arc({ allowance: 0n });
    const dest = destination();
    const events: WithdrawEvent[] = [];
    const out = await runWithdraw(input, {
      client: { transport: node.transport },
      destClient: { transport: dest.transport },
      fetchImpl: iris([pending, complete()]).fetchImpl,
      sleep: noSleep,
      env: { XORV_DEST_KEY: DEST_KEY },
      onEvent: (e) => events.push(e),
    });
    expect(out.finish).toEqual({ kind: "minted" });
    expect(events.map((e) => e.kind)).toEqual(["approve", "burn", "attestation", "attestation", "mint"]);
    expect(out.burnExplorer).toBe(`https://explorer.testnet.arc.io/tx/${out.burnTx}`);

    const [mint] = dest.decoded();
    expect(dest.sent).toHaveLength(1);
    expect(mint!.chainId).toBe(84532);
    expect(mint!.to?.toLowerCase()).toBe(baseSepolia.messageTransmitterV2.toLowerCase());
    expect(decodeFunctionData({ abi: MESSAGE_TRANSMITTER_V2_ABI, data: mint!.data! })).toEqual({
      functionName: "receiveMessage",
      args: [MESSAGE, ATTESTATION],
    });
    expect(out.mintExplorer).toBe(`https://sepolia.basescan.org/tx/${out.mintTx}`);
    expect(withdrawJson(out)).toMatchObject({ status: "minted", amount: "5000000", maxFee: "50000", burnTransaction: out.burnTx, cast: null });
  });

  it("without a destination key, keeps the attestation and prints the exact cast command", async () => {
    const node = arc({ allowance: 10_000_000n });
    const out = await runWithdraw(input, {
      client: { transport: node.transport },
      fetchImpl: iris([complete()]).fetchImpl,
      sleep: noSleep,
      env: {},
    });
    expect(out.finish).toEqual({ kind: "no-key", cast: castReceiveCommand(baseSepolia, MESSAGE, ATTESTATION, "XORV_DEST_KEY") });
    expect(out.attestation).toEqual({ message: MESSAGE, attestation: ATTESTATION });
    expect(out.mintTx).toBeNull();
  });

  it("falls back to the cast command when the destination RPC is the wrong chain, sending nothing there", async () => {
    const node = arc({ allowance: 10_000_000n });
    const wrong = destination(1);
    const out = await runWithdraw(
      { ...input, mintKeyEnv: "BASE_KEY" },
      {
        client: { transport: node.transport },
        destClient: { transport: wrong.transport },
        fetchImpl: iris([complete()]).fetchImpl,
        sleep: noSleep,
        env: { BASE_KEY: DEST_KEY },
      },
    );
    expect(out.finish.kind).toBe("unreachable");
    expect("cast" in out.finish && out.finish.cast).toContain("--private-key $BASE_KEY");
    expect("detail" in out.finish && out.finish.detail).toMatch(/is chain 1, not Base Sepolia/);
    expect(wrong.sent).toHaveLength(0);
  });

  it("with --no-wait, returns after the burn with the Iris URL to check", async () => {
    const node = arc({ allowance: 10_000_000n });
    const { fetchImpl, urls } = iris([complete()]);
    const out = await runWithdraw({ ...input, wait: false }, { client: { transport: node.transport }, fetchImpl });
    expect(out.finish).toEqual({ kind: "no-wait" });
    expect(urls).toHaveLength(0);
    expect(out.irisUrl).toBe(`https://iris-api-sandbox.circle.com/v2/messages/26?transactionHash=${out.burnTx}`);
  });

  it("resumes an earlier burn without sending anything on Arc", async () => {
    const node = arc();
    const burn = `0x${"34".repeat(32)}` as Hex;
    const out = await runWithdraw(
      { ...input, plan: undefined, resumeTx: burn },
      { client: { transport: node.transport }, fetchImpl: iris([complete()]).fetchImpl, sleep: noSleep, env: {} },
    );
    expect(node.sent).toHaveLength(0);
    expect(out.burnTx).toBe(burn);
    expect(out.finish.kind).toBe("no-key");
  });

  it("refuses to mint a message bound for a different domain than --to", async () => {
    const node = arc();
    await expect(
      runWithdraw(
        { ...input, plan: undefined, resumeTx: `0x${"34".repeat(32)}` },
        { client: { transport: node.transport }, fetchImpl: iris([complete(cctpMessage(0))]).fetchImpl, sleep: noSleep, env: {} },
      ),
    ).rejects.toThrow(/CCTP domain 0, not Base Sepolia/);
  });

  it("reports a timeout without losing the burn", async () => {
    const node = arc({ allowance: 10_000_000n });
    let t = 0;
    const out = await runWithdraw(
      { ...input, timeoutMs: 5_000 },
      {
        client: { transport: node.transport },
        fetchImpl: iris([pending]).fetchImpl,
        sleep: async (ms) => {
          t += ms;
        },
        now: () => t,
      },
    );
    expect(out.finish).toEqual({ kind: "timeout" });
    expect(out.burnTx).toMatch(/^0x/);
  });
});
