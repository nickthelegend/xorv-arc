/**
 * `xorv identity bind` and the XorvReputation read-back, through viem's real
 * encode/decode path against a scripted chain.
 *
 * bind() decides which wallet's escrow history lands on which ERC-8004
 * agent, so the tests pin the calldata that is signed, where the contract
 * address comes from (flag > env > broker), and how each binding state reads.
 */

import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeEventTopics, encodeFunctionResult, zeroAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { xorvReputationAbi } from "@xorv/protocol";
import { stripAnsi } from "../src/ui.js";
import { bindAgent, formatScore, readReputation, resolveReputationAddress, type ReputationRecord } from "../src/reputation.js";
import { nodeReputation, reputationRows } from "../src/commands/identity.js";
import { fakeChain } from "./support/fake-chain.js";

const NETWORK = "eip155:5042002";
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(KEY);
const PAYOUT = account.address;
const REPUTATION = "0xbD31F44e13513761fC784D17D6ddDa63f9D5259F";
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

/** A chain whose XorvReputation answers views for one provider and accepts bind(). */
function reputationChain(state: {
  bound?: boolean;
  agentId?: bigint;
  live?: boolean;
  completed?: bigint;
  failed?: bigint;
  earned?: bigint;
  lastJobAt?: number;
  revert?: boolean;
}) {
  return fakeChain({
    chainId: 5042002,
    from: PAYOUT,
    call: ({ to, data }) => {
      expect(to.toLowerCase()).toBe(REPUTATION.toLowerCase());
      const { functionName } = decodeFunctionData({ abi: xorvReputationAbi, data });
      const completed = state.completed ?? 0n;
      const failed = state.failed ?? 0n;
      switch (functionName) {
        case "agentOf":
          return encodeFunctionResult({ abi: xorvReputationAbi, functionName, result: [state.bound ?? false, state.agentId ?? 0n] });
        case "isLive":
          return encodeFunctionResult({ abi: xorvReputationAbi, functionName, result: state.live ?? false });
        case "stats":
          return encodeFunctionResult({
            abi: xorvReputationAbi,
            functionName,
            result: [completed, failed, state.earned ?? 0n, state.lastJobAt ?? 0],
          });
        case "score":
          return encodeFunctionResult({ abi: xorvReputationAbi, functionName, result: ((completed + 1n) * 10_000n) / (completed + failed + 2n) });
        default:
          throw new Error(`unexpected call ${functionName}`);
      }
    },
    revert: () => state.revert ?? false,
    logs: (tx) => {
      const { args } = decodeFunctionData({ abi: xorvReputationAbi, data: tx.data! });
      return [
        {
          address: REPUTATION.toLowerCase(),
          topics: encodeEventTopics({ abi: xorvReputationAbi, eventName: "AgentBound", args: { wallet: PAYOUT, agentId: args![0] as bigint } }),
          data: "0x",
        },
      ];
    },
  });
}

const brokerFetch = (body: unknown, status = 200) =>
  (async (url: string | URL | Request) => {
    expect(String(url)).toBe("https://broker.example.test/api/network");
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

describe("where XorvReputation is", () => {
  it("prefers --reputation, then XORV_REPUTATION_ADDRESS, then the broker's /api/network", async () => {
    const env = { XORV_REPUTATION_ADDRESS: OTHER.toLowerCase() };
    const fetchImpl = brokerFetch({ arc: { reputation: { address: REPUTATION, url: "x" } } });
    expect(await resolveReputationAddress({ flag: REPUTATION.toLowerCase(), env, brokerUrl: "https://broker.example.test", fetchImpl })).toEqual({
      address: REPUTATION,
      source: "flag",
    });
    expect(await resolveReputationAddress({ env, brokerUrl: "https://broker.example.test", fetchImpl })).toEqual({ address: OTHER, source: "env" });
    expect(await resolveReputationAddress({ env: {}, brokerUrl: "https://broker.example.test/", fetchImpl })).toEqual({
      address: REPUTATION,
      source: "broker",
    });
  });

  it("is unknown (null, not an error) when the broker has none or can't be reached", async () => {
    expect(await resolveReputationAddress({ env: {}, brokerUrl: "https://broker.example.test", fetchImpl: brokerFetch({ arc: { reputation: null } }) })).toBeNull();
    expect(await resolveReputationAddress({ env: {}, brokerUrl: "https://broker.example.test", fetchImpl: brokerFetch({}, 500) })).toBeNull();
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await resolveReputationAddress({ env: {}, brokerUrl: "https://broker.example.test", fetchImpl: down })).toBeNull();
    expect(await resolveReputationAddress({ env: {} })).toBeNull();
  });

  it("names a malformed flag or env value instead of falling back", async () => {
    await expect(resolveReputationAddress({ flag: "0x123" })).rejects.toThrow(/--reputation must be a 0x address/);
    await expect(resolveReputationAddress({ env: { XORV_REPUTATION_ADDRESS: "nope" } })).rejects.toThrow(/XORV_REPUTATION_ADDRESS/);
  });
});

describe("readReputation", () => {
  it("reads agentOf, isLive, stats and score for the payout wallet", async () => {
    const node = reputationChain({ bound: true, agentId: 7n, live: true, completed: 8n, failed: 2n, earned: 1_250_000n, lastJobAt: 1_790_000_000 });
    const rec = await readReputation({ network: NETWORK, reputation: REPUTATION, provider: PAYOUT.toLowerCase(), client: { transport: node.transport } });
    expect(rec).toEqual({
      contract: REPUTATION,
      provider: PAYOUT,
      bound: true,
      agentId: "7",
      live: true,
      completed: 8,
      failed: 2,
      earnedUnits: "1250000",
      lastJobAt: 1_790_000_000,
      scoreBps: 7500,
    });
    // Every view was asked about the payout wallet, nobody else.
    for (const call of node.calls.filter((c) => c.method === "eth_call")) {
      const { args } = decodeFunctionData({ abi: xorvReputationAbi, data: (call.params[0] as { data: Hex }).data });
      expect(args).toEqual([PAYOUT]);
    }
  });

  it("reads an unbound wallet with no history as unbound, 50%", async () => {
    const node = reputationChain({});
    const rec = await readReputation({ network: NETWORK, reputation: REPUTATION, provider: PAYOUT, client: { transport: node.transport } });
    expect(rec).toMatchObject({ bound: false, agentId: null, live: false, completed: 0, failed: 0, lastJobAt: null, scoreBps: 5000 });
    expect(formatScore(rec.scoreBps)).toBe("50.0%");
  });

  it("is reported by nodeReputation as an error, not a throw, when the chain can't be read", async () => {
    const node = fakeChain({ chainId: 5042002, from: PAYOUT, call: () => { throw new Error("boom"); } });
    const out = await nodeReputation({
      network: NETWORK,
      provider: PAYOUT,
      brokerUrl: null,
      flag: REPUTATION,
      client: { transport: node.transport },
    });
    expect(out && "error" in out ? out.error : "").toMatch(/could not read XorvReputation/);
    expect(await nodeReputation({ network: NETWORK, provider: PAYOUT, brokerUrl: null })).toBeNull();
  });
});

describe("bindAgent", () => {
  it("sends bind(agentId) to XorvReputation on Arc from the payout key", async () => {
    const node = reputationChain({});
    const { txHash, wallet } = await bindAgent({ network: NETWORK, account, reputation: REPUTATION, agentId: "42", client: { transport: node.transport } });
    expect(node.sent).toHaveLength(1);
    const [tx] = node.decoded();
    expect(tx!.to?.toLowerCase()).toBe(REPUTATION.toLowerCase());
    expect(tx!.chainId).toBe(5042002);
    // 100k estimate + 15% headroom.
    expect(tx!.gas).toBe(115_000n);
    const { functionName, args } = decodeFunctionData({ abi: xorvReputationAbi, data: tx!.data! });
    expect(functionName).toBe("bind");
    expect(args).toEqual([42n]);
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(wallet).toBe(PAYOUT);
    // Estimated from the payout address before anything was signed.
    const estimate = node.calls.find((c) => c.method === "eth_estimateGas")!;
    expect((estimate.params[0] as { from: string }).from.toLowerCase()).toBe(PAYOUT.toLowerCase());
  });

  it("fails loudly with the Arc explorer link when bind reverts", async () => {
    const node = reputationChain({ revert: true });
    await expect(
      bindAgent({ network: NETWORK, account, reputation: REPUTATION, agentId: "42", client: { transport: node.transport } }),
    ).rejects.toThrow(/bind\(\) reverted.*explorer\.testnet\.arc\.io\/tx\/0x/);
  });
});

describe("reputationRows", () => {
  const rec = (over: Partial<ReputationRecord> = {}): ReputationRecord => ({
    contract: REPUTATION,
    provider: PAYOUT,
    bound: true,
    agentId: "7",
    live: true,
    completed: 3,
    failed: 1,
    earnedUnits: "40000",
    lastJobAt: 1_790_000_000,
    scoreBps: 6666,
    ...over,
  });
  const rows = (r: ReputationRecord, agentId: string | null = "7") =>
    Object.fromEntries(reputationRows(NETWORK, r, agentId, 1_790_000_060_000).map(([k, v]) => [k, stripAnsi(v)]));

  it("shows a live binding with its counters, score and explorer link", () => {
    const r = rows(rec());
    expect(r.reputation).toContain(`https://explorer.testnet.arc.io/address/${REPUTATION}`);
    expect(r.binding).toMatch(/agent #7 · live/);
    expect(r.jobs).toBe("3 completed · 1 failed");
    expect(r.score).toMatch(/^66\.7%/);
    expect(r.earned).toMatch(/\$0\.0400/);
    expect(r["last job"]).toMatch(/1m|60s|ago/);
  });

  it("tells an unbound node to bind, and a mis-bound one which agent it is on", () => {
    expect(rows(rec({ bound: false, agentId: null, live: false })).binding).toMatch(/not bound.*xorv identity bind/);
    expect(rows(rec({ bound: false, agentId: null, live: false }), null).binding).toMatch(/xorv identity register, then bind/);
    expect(rows(rec({ agentId: "9" })).binding).toMatch(/bound to agent #9, not this node's #7/);
    expect(rows(rec({ live: false })).binding).toMatch(/no longer matches/);
  });

  it("says so when there is no history yet", () => {
    expect(rows(rec({ completed: 0, failed: 0, lastJobAt: null, scoreBps: 5000 })).jobs).toBe("no escrow settlements yet");
    expect(rows(rec({ lastJobAt: null }))["last job"]).toBe("—");
  });

  it("never treats the zero address as a contract", async () => {
    await expect(resolveReputationAddress({ flag: zeroAddress })).rejects.toThrow(/must be a 0x address/);
    const fetchImpl = brokerFetch({ arc: { reputation: { address: zeroAddress, url: "x" } } });
    expect(await resolveReputationAddress({ env: {}, brokerUrl: "https://broker.example.test", fetchImpl })).toBeNull();
  });
});
