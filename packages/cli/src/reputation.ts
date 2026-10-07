/**
 * XorvReputation — escrow settlements written to the provider's ERC-8004 agent.
 *
 * XorvEscrow reports every release (the job delivered) and every at-fault
 * refund to XorvReputation, which keeps per-provider counters and, once the
 * provider's wallet is *bound* to its ERC-8004 agent, writes the outcome to the
 * canonical Reputation Registry (`giveFeedback(agentId, 100 | 0, …,
 * "successRate", "xorv-escrow", …)`). That is reputation nobody can inflate
 * without paying for each job.
 *
 * Binding is `bind(agentId)`: permissionless, because the Identity Registry
 * already proves the wallet consented (`getAgentWallet(agentId)` is the wallet
 * that gets bound). The CLI sends it from the payout key, which is also the
 * only key that may later re-bind the wallet to a different agent.
 *
 * Where the contract is: `--reputation <addr>`, then `XORV_REPUTATION_ADDRESS`,
 * then the broker's `/api/network` (`arc.reputation.address`).
 */

import {
  explorerTx,
  isEvmAddress,
  normalizeAddress,
  publicClientFor,
  walletClientFor,
  withGasHeadroom,
  xorvReputationAbi,
  type ClientOptions,
  type NetworkInfo,
} from "@xorv/protocol";
import { parseEventLogs, type Address, type Hex, type PrivateKeyAccount } from "viem";

/** XorvReputation's view of one provider wallet. */
export interface ReputationRecord {
  /** The XorvReputation contract read. */
  contract: Address;
  provider: Address;
  /** Whether the wallet has been bound to an agent at all. */
  bound: boolean;
  /** The bound agent id (decimal string), or null. */
  agentId: string | null;
  /** True when outcomes are being written to ERC-8004 right now (the binding still holds). */
  live: boolean;
  completed: number;
  failed: number;
  /** USDC smallest units earned through the escrow. */
  earnedUnits: string;
  /** Unix seconds of the last settled job, or null. */
  lastJobAt: number | null;
  /** Laplace-smoothed success rate in basis points (5000 with no history). */
  scoreBps: number;
}

/** Where the XorvReputation address came from, for the output line that names it. */
export type ReputationSource = "flag" | "env" | "broker";

/**
 * Find the XorvReputation contract: flag, then env, then the broker.
 *
 * Returns null (never throws) when the broker is unreachable or has none: the
 * callers that only *show* reputation must keep working without it. A
 * malformed flag or env value does throw — a typo'd address is a mistake to
 * name, not to silently replace with the broker's.
 */
export async function resolveReputationAddress(opts: {
  flag?: string;
  env?: NodeJS.ProcessEnv;
  brokerUrl?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ address: Address; source: ReputationSource } | null> {
  const flag = opts.flag?.trim();
  if (flag) return { address: checked(flag, "--reputation"), source: "flag" };
  const env = (opts.env ?? process.env).XORV_REPUTATION_ADDRESS?.trim();
  if (env) return { address: checked(env, "XORV_REPUTATION_ADDRESS"), source: "env" };
  if (!opts.brokerUrl) return null;
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${opts.brokerUrl.replace(/\/+$/, "")}/api/network`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    });
    if (!res.ok) return null;
    const info = (await res.json()) as Partial<NetworkInfo>;
    const addr = info.arc?.reputation?.address;
    return addr && isEvmAddress(addr) && BigInt(addr) !== 0n ? { address: normalizeAddress(addr), source: "broker" } : null;
  } catch {
    return null;
  }
}

function checked(value: string, where: string): Address {
  if (!isEvmAddress(value) || BigInt(value) === 0n) throw new Error(`${where} must be a 0x address, got "${value}"`);
  return normalizeAddress(value);
}

/** Read `agentOf`, `isLive`, `stats` and `score` for one provider wallet. */
export async function readReputation(opts: {
  network: string;
  reputation: Address;
  provider: string;
  client?: ClientOptions;
}): Promise<ReputationRecord> {
  const client = publicClientFor(opts.network, opts.client);
  const provider = normalizeAddress(opts.provider);
  const base = { address: opts.reputation, abi: xorvReputationAbi } as const;
  const [agentOf, live, stats, score] = await Promise.all([
    client.readContract({ ...base, functionName: "agentOf", args: [provider] }),
    client.readContract({ ...base, functionName: "isLive", args: [provider] }),
    client.readContract({ ...base, functionName: "stats", args: [provider] }),
    client.readContract({ ...base, functionName: "score", args: [provider] }),
  ]);
  const [bound, agentId] = agentOf;
  const [completed, failed, earned, lastJobAt] = stats;
  return {
    contract: opts.reputation,
    provider,
    bound,
    agentId: bound ? agentId.toString() : null,
    live,
    completed: Number(completed),
    failed: Number(failed),
    earnedUnits: earned.toString(),
    lastJobAt: lastJobAt === 0 ? null : Number(lastJobAt),
    scoreBps: Number(score),
  };
}

/** `score` in basis points as a percentage: 5000 → "50.0%". */
export function formatScore(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

/**
 * Send `XorvReputation.bind(agentId)` from `account` and wait for it.
 *
 * Gas is estimated first, so a bind the contract would refuse (no agent
 * wallet, the contract operates the agent, the wallet is bound elsewhere and
 * the sender is not the wallet) fails here with the contract's reason and
 * nothing is sent.
 */
export async function bindAgent(opts: {
  network: string;
  account: PrivateKeyAccount;
  reputation: Address;
  agentId: string;
  client?: ClientOptions;
}): Promise<{ txHash: Hex; wallet: Address | null }> {
  const wallet = walletClientFor(opts.network, opts.account, opts.client);
  const args = [BigInt(opts.agentId)] as const;
  const estimate = await wallet.estimateContractGas({
    address: opts.reputation,
    abi: xorvReputationAbi,
    functionName: "bind",
    args,
    account: opts.account,
  });
  const txHash = await wallet.writeContract({
    address: opts.reputation,
    abi: xorvReputationAbi,
    functionName: "bind",
    args,
    gas: withGasHeadroom(estimate),
  });
  const receipt = await wallet.waitForTransactionReceipt({ hash: txHash, checkReplacement: false, timeout: 60_000 });
  if (receipt.status !== "success") {
    throw new Error(`bind() reverted — ${explorerTx(opts.network, txHash)}`);
  }
  const bound = parseEventLogs({ abi: xorvReputationAbi, eventName: "AgentBound", logs: receipt.logs }).find(
    (log) => log.address.toLowerCase() === opts.reputation.toLowerCase(),
  );
  return { txHash, wallet: bound ? normalizeAddress(bound.args.wallet) : null };
}
