/**
 * The broker's Arc endpoints, as the app reads them, and the small pure pieces
 * the Arc panels share.
 *
 *  - `/api/providers/:id/escrow`: a provider's settlement record in
 *    XorvReputation (escrow releases vs. at-fault refunds), and the ERC-8004
 *    agent those outcomes are written to.
 *  - `/api/gateway`: a buyer's unified Circle Gateway balance per chain, the
 *    burn intent they sign, and the mint on Arc.
 *  - `POST /api/quotes` with `payVia: "ccip"`: the terms a buyer agent on Base
 *    or Ethereum passes to `XorvCcipSender.postJob`.
 *
 * Everything that arrives from the network is read defensively (a broker
 * without the feature sends less, never something else), and nothing here
 * touches React or `window`, so it is tested directly.
 */

import { formatUsdc, type CcipQuoteTerms } from "@xorv/protocol/web";

type Loose = Record<string, unknown>;
const isObject = (v: unknown): v is Loose => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);
const units = (v: unknown): string => (typeof v === "string" && /^\d+$/.test(v) ? v : typeof v === "number" && Number.isInteger(v) && v >= 0 ? String(v) : "0");

/** Only links the browser should follow: absolute http(s) URLs. */
function link(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Provider escrow record (XorvReputation → ERC-8004)
// ---------------------------------------------------------------------------

export type ProviderEscrowRecord =
  | { configured: false }
  | {
      configured: true;
      /** The read failed (RPC down); the rest is absent. */
      error: string;
    }
  | {
      configured: true;
      error: null;
      reputation: string;
      reputationUrl: string | null;
      /** Escrows released to this provider. */
      completed: number;
      /** Escrows refunded because this provider was at fault. */
      failed: number;
      earnedUnits: string;
      /** Smoothed success score, basis points (10000 = 100%). */
      scoreBps: number;
      /** The ERC-8004 agent outcomes are written to; null when not bound (or not live). */
      agentId: string | null;
      agentUrl: string | null;
    };

export function readProviderEscrow(raw: unknown): ProviderEscrowRecord {
  if (!isObject(raw) || raw.configured !== true) return { configured: false };
  const error = str(raw.error);
  const reputation = str(raw.reputation);
  if (error || !reputation) return { configured: true, error: error ?? "the broker returned no XorvReputation address" };
  return {
    configured: true,
    error: null,
    reputation,
    reputationUrl: link(raw.reputationUrl),
    completed: num(raw.completed) ?? 0,
    failed: num(raw.failed) ?? 0,
    earnedUnits: units(raw.earnedUnits),
    scoreBps: Math.max(0, Math.min(10_000, num(raw.scoreBps) ?? 0)),
    agentId: str(raw.agentId) ?? (typeof raw.agentId === "number" ? String(raw.agentId) : null),
    agentUrl: link(raw.agentUrl),
  };
}

/** 9234 → "92.3%". */
export function formatScoreBps(bps: number): string {
  return `${(Math.round(bps / 10) / 10).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Circle Gateway
// ---------------------------------------------------------------------------

export interface GatewayBalanceRow {
  domain: number;
  name: string;
  balanceUnits: string;
  balance: string;
}

export interface GatewayInfo {
  /** The broker can mint (it has an operator key to pay gatewayMint's gas). */
  available: boolean;
  wallet: string | null;
  minter: string | null;
  sources: Array<{ domain: number; name: string }>;
  /** Present when asked with `?depositor=`. */
  depositor: string | null;
  totalUnits: string | null;
  balances: GatewayBalanceRow[];
  error: string | null;
}

export function readGateway(raw: unknown): GatewayInfo {
  const o = isObject(raw) ? raw : {};
  const sources = Array.isArray(o.sources)
    ? o.sources.flatMap((s) => (isObject(s) && num(s.domain) !== null && str(s.name) ? [{ domain: num(s.domain)!, name: str(s.name)! }] : []))
    : [];
  const balances = Array.isArray(o.balances)
    ? o.balances.flatMap((b) =>
        isObject(b) && num(b.domain) !== null
          ? [
              {
                domain: num(b.domain)!,
                name: str(b.name) ?? `domain ${num(b.domain)}`,
                balanceUnits: units(b.balanceUnits),
                balance: str(b.balance) ?? formatUsdc(units(b.balanceUnits)),
              },
            ]
          : [],
      )
    : [];
  return {
    available: o.available === true,
    wallet: str(o.wallet),
    minter: str(o.minter),
    sources,
    depositor: str(o.depositor),
    totalUnits: typeof o.totalUnits === "string" ? units(o.totalUnits) : null,
    balances,
    error: str(o.error),
  };
}

/**
 * Gateway balances that can fund a top-up, largest first. A balance held on
 * Arc's own domain counts too: minting it to the wallet is how it is spent.
 */
export function fundingSources(info: GatewayInfo): GatewayBalanceRow[] {
  return info.balances
    .filter((b) => BigInt(b.balanceUnits) > 0n)
    .sort((a, b) => (BigInt(b.balanceUnits) > BigInt(a.balanceUnits) ? 1 : -1));
}

/** How many USDC units the wallet is short of `needUnits` (0 when it isn't). */
export function shortfallUnits(haveUnits: string | bigint, needUnits: string | bigint): bigint {
  const have = BigInt(haveUnits);
  const need = BigInt(needUnits);
  return need > have ? need - have : 0n;
}

/**
 * A top-up amount the visitor typed ("1", "0.25", "$2.50") → USDC units, or
 * null when it isn't a positive amount with at most 6 decimals.
 */
export function parseUsdcAmount(text: string): bigint | null {
  const t = text.replace(/[$,\s]/g, "");
  const m = /^(\d+)(?:\.(\d{0,6}))?$/.exec(t);
  if (!m) return null;
  const value = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  return value > 0n ? value : null;
}

/** USDC units → the plain decimal a text field shows ("1.25"). */
export function unitsToInput(value: bigint): string {
  const whole = value / 1_000_000n;
  const frac = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * A sensible top-up: the shortfall rounded up to the next whole cent-and-a-bit
 * (at least $0.10), so one top-up covers the job even after Gateway's fee.
 */
export function suggestedTopUp(short: bigint): bigint {
  const floor = 100_000n; // $0.10
  const padded = short + short / 10n + 10_000n; // +10% and a cent
  const rounded = ((padded + 9_999n) / 10_000n) * 10_000n;
  return rounded > floor ? rounded : floor;
}

export interface GatewayTypedData {
  domain: { name: string; version: string };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: "BurnIntent";
  message: {
    maxBlockHeight: string;
    maxFee: string;
    spec: Record<string, string | number>;
  };
}

/** The `/api/gateway/intent` answer, checked enough to sign and to show the fee. */
export function readGatewayIntent(raw: unknown): { typedData: GatewayTypedData; maxFeeUnits: string; maxFee: string } {
  const o = isObject(raw) ? raw : {};
  const td = isObject(o.typedData) ? o.typedData : null;
  if (
    !td ||
    td.primaryType !== "BurnIntent" ||
    !isObject(td.domain) ||
    td.domain.name !== "GatewayWallet" ||
    !isObject(td.types) ||
    !isObject(td.message) ||
    !isObject(td.message.spec)
  ) {
    throw new Error(str(o.error) ?? "The broker didn't return a Gateway burn intent to sign.");
  }
  return {
    typedData: td as unknown as GatewayTypedData,
    maxFeeUnits: units(o.maxFeeUnits),
    maxFee: str(o.maxFee) ?? formatUsdc(units(o.maxFeeUnits)),
  };
}

/**
 * Check the intent the broker built says what the visitor asked for — from
 * their own Gateway balance, to their own Arc wallet, this amount, from this
 * chain — before asking them to sign it. The broker can't redirect a cent
 * (the recipient is in what they sign), but a mismatch is still a bug worth
 * refusing over rather than signing.
 */
export function checkGatewayIntent(
  td: GatewayTypedData,
  expect: { depositor: string; recipient: string; amountUnits: bigint; sourceDomain: number; arcDomain: number },
): void {
  const spec = td.message.spec;
  const addr = (b32: unknown) => (typeof b32 === "string" && b32.length === 66 ? `0x${b32.slice(26)}`.toLowerCase() : "");
  const fail = (what: string): never => {
    throw new Error(`Refusing to sign: the burn intent's ${what} isn't what you asked for.`);
  };
  if (addr(spec.sourceDepositor) !== expect.depositor.toLowerCase()) fail("depositor");
  if (addr(spec.sourceSigner) !== expect.depositor.toLowerCase()) fail("signer");
  if (addr(spec.destinationRecipient) !== expect.recipient.toLowerCase()) fail("recipient");
  if (String(spec.value) !== expect.amountUnits.toString()) fail("amount");
  if (Number(spec.sourceDomain) !== expect.sourceDomain) fail("source chain");
  if (Number(spec.destinationDomain) !== expect.arcDomain) fail("destination (Arc)");
}

/**
 * The typed data as viem signs it: the uint fields as bigints (viem's types
 * want them; the JSON-safe wrapper for Privy turns them back into strings, and
 * the digest is the same either way).
 */
export function gatewayTypedDataForSigning(td: GatewayTypedData) {
  const spec = td.message.spec;
  return {
    domain: td.domain,
    types: td.types,
    primaryType: td.primaryType,
    message: {
      maxBlockHeight: BigInt(td.message.maxBlockHeight),
      maxFee: BigInt(td.message.maxFee),
      spec: {
        ...spec,
        version: Number(spec.version),
        sourceDomain: Number(spec.sourceDomain),
        destinationDomain: Number(spec.destinationDomain),
        value: BigInt(String(spec.value)),
      },
    },
  };
}

export interface GatewayMintResult {
  recipient: string;
  amountUnits: string;
  amount: string;
  mintTxHash: string;
  explorerUrl: string | null;
}

export function readGatewayMint(raw: unknown): GatewayMintResult {
  const o = isObject(raw) ? raw : {};
  const tx = str(o.mintTxHash);
  if (o.status !== "minted" || !tx) throw new Error(str(o.error) ?? "Circle Gateway didn't mint.");
  return {
    recipient: str(o.recipient) ?? "",
    amountUnits: units(o.amountUnits),
    amount: str(o.amount) ?? formatUsdc(units(o.amountUnits)),
    mintTxHash: tx,
    explorerUrl: link(o.explorerUrl),
  };
}

// ---------------------------------------------------------------------------
// Chainlink CCIP (jobs posted from Base / Ethereum)
// ---------------------------------------------------------------------------

/** CCTP V2's standard transfer: waits for the source chain's finality, no fee. */
export const CCTP_STANDARD_THRESHOLD = 2000;

/** The exact `postJob` call a buyer agent makes on the source chain, in order. */
export function postJobArgs(terms: CcipQuoteTerms, opts: { maxFee?: bigint; minFinalityThreshold?: number } = {}) {
  const maxFee = opts.maxFee ?? 0n;
  return {
    jobId: terms.jobId as `0x${string}`,
    provider: terms.provider as `0x${string}`,
    price: BigInt(terms.price),
    deadline: terms.deadline,
    maxFee,
    minFinalityThreshold: opts.minFinalityThreshold ?? CCTP_STANDARD_THRESHOLD,
    /** What to approve the sender for first: `price + maxFee` USDC on the source chain. */
    approve: BigInt(terms.price) + maxFee,
  };
}

/** A `cast send` line for the call, for agents that live in a shell. */
export function postJobCast(terms: CcipQuoteTerms, sender: string, rpcUrl: string, opts: { maxFee?: bigint; minFinalityThreshold?: number } = {}): string {
  const a = postJobArgs(terms, opts);
  return [
    `cast send ${sender} \\`,
    `  "postJob(bytes32,address,uint256,uint40,uint256,uint32)" \\`,
    `  ${a.jobId} ${a.provider} ${a.price} ${a.deadline} ${a.maxFee} ${a.minFinalityThreshold} \\`,
    `  --value <quotePostJob fee> --rpc-url ${rpcUrl}`,
  ].join("\n");
}
