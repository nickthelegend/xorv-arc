/**
 * The broker's Arc-native pieces that aren't payments themselves:
 *
 *  - `arcStackInfo`: what `/api/network` says about the Arc stack in use
 *    (USDC gas, Memo, ERC-8004 via XorvReputation, Gateway, CCTP, CCIP, keeper),
 *    so the app can show exactly what this broker runs on.
 *  - `escrowOutcomesReader`: a provider's settlement record in XorvReputation,
 *    for the router's `escrow_outcomes` tool and the provider page.
 *  - Circle Gateway: a buyer's unified USDC balance, the burn intent they sign,
 *    and the mint on Arc (Circle attests, the broker's operator key pays the
 *    gas in USDC). Pure intent logic is in @xorv/protocol (gateway.ts).
 */

import { getAddress, isAddress, keccak256, recoverTypedDataAddress, toHex, type Address, type Hex, type PrivateKeyAccount } from "viem";
import {
  BURN_INTENT_DOMAIN,
  BURN_INTENT_TYPES,
  GATEWAY_MINTER_ABI,
  GatewayInputError,
  buildBurnIntent,
  burnIntentFromJson,
  burnIntentRecipient,
  burnIntentToJson,
  explorerAddress,
  explorerTx,
  formatUsdc,
  gatewayFor,
  memoContractFor,
  networkConfig,
  publicClientFor,
  walletClientFor,
  withGasHeadroom,
  withSignerLock,
  type ArcStackInfo,
  type BurnIntent,
} from "@xorv/protocol";
import type { EscrowOutcomesRead } from "./ai/router-tools.js";

/** The slice of XorvReputation the broker reads. */
export const XORV_REPUTATION_READ_ABI = [
  {
    type: "function",
    name: "stats",
    stateMutability: "view",
    inputs: [{ name: "provider", type: "address" }],
    outputs: [
      { name: "completed", type: "uint64" },
      { name: "failed", type: "uint64" },
      { name: "earned", type: "uint256" },
      { name: "lastJobAt", type: "uint40" },
    ],
  },
  {
    type: "function",
    name: "score",
    stateMutability: "view",
    inputs: [{ name: "provider", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "agentOf",
    stateMutability: "view",
    inputs: [{ name: "provider", type: "address" }],
    outputs: [
      { name: "bound", type: "bool" },
      { name: "agentId", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "isLive",
    stateMutability: "view",
    inputs: [{ name: "provider", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export interface ArcStackOptions {
  network: string;
  reputationAddress: string | null;
  ccipReceiverAddress: string | null;
  keeper: { enabled: boolean; address: string | null };
  gatewayEnabled: boolean;
}

export function arcStackInfo(opts: ArcStackOptions): ArcStackInfo {
  const cfg = networkConfig(opts.network);
  const memo = memoContractFor(opts.network);
  const g = gatewayFor(opts.network);
  return {
    gasToken: "USDC",
    finality: "deterministic, sub-second",
    memo: { address: cfg.circle.memo, url: explorerAddress(opts.network, cfg.circle.memo), enabled: memo !== null },
    reputation: opts.reputationAddress
      ? { address: opts.reputationAddress, url: explorerAddress(opts.network, opts.reputationAddress) }
      : null,
    gateway: {
      wallet: g.wallet,
      minter: g.minter,
      sources: g.sources.map((s) => ({ domain: s.domain, name: s.name })),
      enabled: opts.gatewayEnabled,
    },
    cctp: {
      tokenMessengerV2: cfg.circle.tokenMessengerV2,
      domain: cfg.circle.cctpDomain,
      destinations: cfg.remotes.map((r) => ({ name: r.name, chainId: r.chainId, domain: r.cctpDomain })),
    },
    ccip: {
      router: cfg.ccip.router,
      chainSelector: cfg.ccip.chainSelector,
      receiver: opts.ccipReceiverAddress
        ? { address: opts.ccipReceiverAddress, url: explorerAddress(opts.network, opts.ccipReceiverAddress) }
        : null,
      sources: cfg.remotes
        .filter((r) => r.ccipSelector)
        .map((r) => ({ name: r.name, chainId: r.chainId, selector: r.ccipSelector as string })),
    },
    keeper: opts.keeper,
  };
}

/** A provider's escrow settlement record from XorvReputation, cached briefly. */
export function escrowOutcomesReader(
  network: string,
  reputation: string | null,
  opts: { cacheMs?: number } = {},
): ((address: string) => Promise<EscrowOutcomesRead>) | undefined {
  if (!reputation) return undefined;
  const address = getAddress(reputation);
  const cacheMs = opts.cacheMs ?? 15_000;
  const cache = new Map<string, { at: number; value: EscrowOutcomesRead }>();
  return async (provider: string) => {
    const key = provider.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < cacheMs) return hit.value;
    const client = publicClientFor(network);
    const who = getAddress(provider);
    const [stats, score, agent, live] = await Promise.all([
      client.readContract({ address, abi: XORV_REPUTATION_READ_ABI, functionName: "stats", args: [who] }),
      client.readContract({ address, abi: XORV_REPUTATION_READ_ABI, functionName: "score", args: [who] }),
      client.readContract({ address, abi: XORV_REPUTATION_READ_ABI, functionName: "agentOf", args: [who] }),
      client.readContract({ address, abi: XORV_REPUTATION_READ_ABI, functionName: "isLive", args: [who] }),
    ]);
    const value: EscrowOutcomesRead = {
      configured: true,
      reputation: address,
      completed: Number(stats[0]),
      failed: Number(stats[1]),
      earnedUnits: stats[2].toString(),
      scoreBps: Number(score),
      agentId: agent[0] && live ? agent[1].toString() : null,
    };
    cache.set(key, { at: Date.now(), value });
    return value;
  };
}

// ---------------------------------------------------------------------------
// Circle Gateway
// ---------------------------------------------------------------------------

/** An error the HTTP layer turns into a JSON answer with this status. */
export class ArcHttpError extends Error {
  constructor(
    readonly status: 400 | 409 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface GatewayDeps {
  network: string;
  /** Pays gatewayMint's gas (USDC); null = minting unavailable (read-only broker). */
  relayer: PrivateKeyAccount | null;
  /** Replace the network Circle's Gateway API is called over (tests). */
  fetch?: typeof fetch;
}

export interface GatewayBalance {
  domain: number;
  name: string;
  balanceUnits: string;
  balance: string;
}

export interface GatewayMintResult {
  status: "minted";
  recipient: Address;
  amountUnits: string;
  amount: string;
  feeUnits: string | null;
  transferId: string | null;
  mintTxHash: Hex;
  explorerUrl: string;
}

/**
 * Circle Gateway as the broker serves it. A retry of the same signed intent
 * (same salt) returns the first mint instead of asking Circle twice.
 */
export function createGateway(deps: GatewayDeps) {
  const g = gatewayFor(deps.network);
  const minted = new Map<string, GatewayMintResult>();
  const doFetch = deps.fetch ?? fetch;

  async function api(path: string, body: unknown): Promise<Record<string, unknown>> {
    let last: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await doFetch(`${g.apiUrl}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
          signal: AbortSignal.timeout(10_000),
        });
        const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (!res.ok) {
          const message = typeof json?.message === "string" ? json.message : `Circle Gateway answered ${res.status}`;
          if (res.status >= 500 && attempt < 2) {
            last = new Error(message);
            await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
            continue;
          }
          throw new ArcHttpError(res.status >= 500 ? 502 : 400, res.status >= 500 ? "gateway_unavailable" : "gateway_rejected", message);
        }
        return json ?? {};
      } catch (err) {
        if (err instanceof ArcHttpError) throw err;
        last = err;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    throw new ArcHttpError(502, "gateway_unavailable", `Circle Gateway is unreachable: ${last instanceof Error ? last.message : String(last)}`);
  }

  return {
    info: g,
    available: deps.relayer !== null,

    /** A depositor's unified balance per source chain. */
    async balances(depositorRaw: string): Promise<{ depositor: Address; totalUnits: string; total: string; balances: GatewayBalance[] }> {
      if (!isAddress(depositorRaw)) throw new ArcHttpError(400, "invalid_request", "depositor must be an address");
      const depositor = getAddress(depositorRaw);
      const json = (await api("/v1/balances", {
        token: "USDC",
        sources: g.sources.map((s) => ({ domain: s.domain, depositor })),
      })) as { balances?: Array<{ domain: number; balance: string }> };
      const balances = (json.balances ?? []).map((b) => {
        // The API answers in USDC with decimals ("12.5"); keep base units.
        const units = usdcUnitsFromDecimal(b.balance);
        return {
          domain: b.domain,
          name: g.sources.find((s) => s.domain === b.domain)?.name ?? `domain ${b.domain}`,
          balanceUnits: units.toString(),
          balance: formatUsdc(units),
        };
      });
      const total = balances.reduce((t, b) => t + BigInt(b.balanceUnits), 0n);
      return { depositor, totalUnits: total.toString(), total: formatUsdc(total), balances };
    },

    /** The typed data a buyer signs to move `amountUnits` of their Gateway balance to their Arc wallet. */
    intent(body: Record<string, unknown>) {
      const depositor = typeof body.depositor === "string" && isAddress(body.depositor) ? getAddress(body.depositor) : null;
      const recipient =
        typeof body.recipient === "string" && isAddress(body.recipient) ? getAddress(body.recipient) : depositor;
      if (!depositor) throw new ArcHttpError(400, "invalid_request", "depositor must be the address that deposited into Gateway");
      let value: bigint;
      try {
        value = BigInt(String(body.amountUnits));
      } catch {
        throw new ArcHttpError(400, "invalid_request", "amountUnits must be USDC base units (6 decimals)");
      }
      const salt = keccak256(toHex(`${depositor}:${recipient}:${value}:${Date.now()}:${Math.random()}`));
      let intent: BurnIntent;
      try {
        intent = buildBurnIntent(g, { sourceDomain: Number(body.sourceDomain), depositor, recipient: recipient!, value, salt });
      } catch (err) {
        if (err instanceof GatewayInputError) throw new ArcHttpError(400, "invalid_request", err.message);
        throw err;
      }
      return {
        typedData: { domain: BURN_INTENT_DOMAIN, types: BURN_INTENT_TYPES, primaryType: "BurnIntent" as const, message: burnIntentToJson(intent) },
        maxFeeUnits: intent.maxFee.toString(),
        maxFee: formatUsdc(intent.maxFee),
      };
    },

    /** Circle attests the signed intent; the broker mints on Arc. */
    async mint(body: Record<string, unknown>): Promise<GatewayMintResult> {
      if (!deps.relayer) {
        throw new ArcHttpError(503, "gateway_unavailable", "this broker has no operator key to pay gatewayMint's gas");
      }
      let intent: BurnIntent;
      try {
        intent = burnIntentFromJson(g, body.burnIntent);
      } catch (err) {
        if (err instanceof GatewayInputError) throw new ArcHttpError(400, "invalid_request", err.message);
        throw err;
      }
      const signature = typeof body.signature === "string" && body.signature.startsWith("0x") ? (body.signature as Hex) : null;
      if (!signature) throw new ArcHttpError(400, "invalid_request", "signature must be the buyer's signature of the burn intent");
      const seen = minted.get(intent.spec.salt);
      if (seen) return seen;
      // A bad signature never reaches Circle or costs gas.
      const signer = await recoverTypedDataAddress({
        domain: BURN_INTENT_DOMAIN,
        types: BURN_INTENT_TYPES,
        primaryType: "BurnIntent",
        message: intent,
        signature,
      }).catch(() => null);
      if (!signer || signer.toLowerCase() !== `0x${intent.spec.sourceSigner.slice(26)}`.toLowerCase()) {
        throw new ArcHttpError(400, "invalid_signature", "the burn intent isn't signed by its depositor");
      }
      const res = (await api("/v1/transfer", [{ burnIntent: burnIntentToJson(intent), signature }])) as {
        transferId?: string;
        attestation?: Hex;
        signature?: Hex;
        fees?: { total?: string };
      };
      if (!res.attestation || !res.signature) throw new ArcHttpError(502, "gateway_unavailable", "Circle Gateway returned no attestation");
      const relayer = deps.relayer;
      const wallet = walletClientFor(deps.network, relayer);
      const hash = await withSignerLock(relayer.address, async () => {
        const request = {
          address: g.minter,
          abi: GATEWAY_MINTER_ABI,
          functionName: "gatewayMint" as const,
          args: [res.attestation as Hex, res.signature as Hex] as const,
          account: relayer,
        };
        const gas = withGasHeadroom(await wallet.estimateContractGas(request));
        return wallet.writeContract({ ...request, gas, chain: wallet.chain });
      });
      const receipt = await wallet.waitForTransactionReceipt({ hash, timeout: 30_000 });
      if (receipt.status !== "success") throw new ArcHttpError(502, "mint_failed", `gatewayMint reverted (${hash})`);
      const out: GatewayMintResult = {
        status: "minted",
        recipient: burnIntentRecipient(intent),
        amountUnits: intent.spec.value.toString(),
        amount: formatUsdc(intent.spec.value),
        feeUnits: res.fees?.total ? usdcUnitsFromDecimal(res.fees.total).toString() : null,
        transferId: res.transferId ?? null,
        mintTxHash: hash,
        explorerUrl: explorerTx(deps.network, hash),
      };
      minted.set(intent.spec.salt, out);
      return out;
    },
  };
}

export type Gateway = ReturnType<typeof createGateway>;

/** "12.5" → 12500000n, without going through a float. */
export function usdcUnitsFromDecimal(text: string): bigint {
  const m = /^(\d+)(?:\.(\d{0,6})\d*)?$/.exec(String(text).trim());
  if (!m) return 0n;
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}
