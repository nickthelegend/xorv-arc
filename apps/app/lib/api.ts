/**
 * Typed access to the broker.
 *
 * Reads are free and public — providers, jobs, ledger events, the leaderboard.
 * Writes that move money or reputation are signed by the *buyer's* wallet in
 * the browser (see lib/x402-pay.ts and lib/rating.ts); the broker only relays
 * them. The shapes come from `@xorv/protocol` as `import type`, so a rename on
 * the broker side is a compile error here rather than a blank panel at runtime,
 * and nothing from the protocol package lands in the bundle for it.
 */

import {
  formatAgo,
  formatDuration,
  formatUsd as formatUsdMicros,
  type LedgerEvent,
  type LedgerEventKind,
  type NetworkInfo,
  type PublicJob,
  type PublicProvider,
  type QuoteResponse,
} from "@xorv/protocol/web";
import { normalizeLeaderboard, normalizeLedgerFeed, type Leaderboard, type LedgerFeed } from "@/lib/wire";
import {
  readGateway,
  readGatewayIntent,
  readGatewayMint,
  readProviderEscrow,
  type GatewayInfo,
  type GatewayMintResult,
  type GatewayTypedData,
  type ProviderEscrowRecord,
} from "@/lib/arc";

export { NETWORK } from "@/lib/network";
export { formatAgo, formatDuration };

export const BROKER_URL = (process.env.NEXT_PUBLIC_XORV_BROKER_URL?.trim() || (process.env.NEXT_PUBLIC_XORV_READ_ONLY === "1" ? "" : "http://localhost:8402")).replace(
  /\/+$/,
  "",
);

export type Job = PublicJob;
export type Provider = PublicProvider;
export type Quote = QuoteResponse;
export type { JobEvent, JobRouting, JobScreening, JobVerification, JobRating, PaymentRecord } from "@xorv/protocol/web";
export type { LedgerEvent, LedgerEventKind, NetworkInfo, Leaderboard, LedgerFeed };

async function get<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${path} → ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  return (await res.json()) as T;
}

export const api = {
  network: () => get<NetworkInfo>("/api/network"),
  providers: () => get<{ providers: Provider[] }>("/api/providers").then((r) => r.providers),
  provider: (id: string) =>
    get<{ provider: Provider }>(`/api/providers/${encodeURIComponent(id)}`).then((r) => r.provider),
  jobs: (limit = 25, providerId?: string) =>
    get<{ jobs: Job[] }>(`/api/jobs?limit=${limit}${providerId ? `&providerId=${encodeURIComponent(providerId)}` : ""}`).then((r) => r.jobs),
  job: (id: string) => get<{ job: Job }>(`/api/jobs/${encodeURIComponent(id)}`).then((r) => r.job),
  /** XorvLedger events — from the Envio indexer when the broker has one, else an RPC log scan. */
  ledger: <K extends LedgerEventKind>(kind: K, limit = 20) =>
    get<unknown>(`/api/ledger?kind=${kind}&limit=${limit}`).then((r) => normalizeLedgerFeed(r, kind)),
  leaderboard: () => get<unknown>("/api/leaderboard").then(normalizeLeaderboard),
  /** A provider's escrow settlement record (XorvReputation) and the ERC-8004 agent it feeds. */
  providerEscrow: (id: string): Promise<ProviderEscrowRecord> =>
    // A failed chain read comes back as a 502 with `{ configured, error }`: read the body either way.
    fetch(`${BROKER_URL}/api/providers/${encodeURIComponent(id)}/escrow`, { cache: "no-store", signal: AbortSignal.timeout(15_000) }).then(
      async (res) => {
        if (res.status === 404) throw new Error("unknown provider");
        return readProviderEscrow(await res.json().catch(() => null));
      },
    ),
  /** Circle Gateway on this broker; with `depositor`, that address's unified balance per chain. */
  gateway: (depositor?: string | null): Promise<GatewayInfo> =>
    fetch(`${BROKER_URL}/api/gateway${depositor ? `?depositor=${encodeURIComponent(depositor)}` : ""}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    }).then(async (res) => {
      const body = await res.json().catch(() => null);
      const info = readGateway(body);
      if (!res.ok) throw new Error(info.error ?? `Gateway lookup failed (${res.status}).`);
      return info;
    }),
  /** The EIP-712 burn intent that moves `amountUnits` of the depositor's Gateway balance on `sourceDomain` to them on Arc. */
  gatewayIntent: async (body: { depositor: string; sourceDomain: number; amountUnits: string; recipient?: string }) => {
    const res = await fetch(`${BROKER_URL}/api/gateway/intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json as { error?: string }).error ?? `The broker couldn't build the intent (${res.status}).`);
    return readGatewayIntent(json);
  },
  /** Circle attests the signed intent; the broker calls GatewayMinter.gatewayMint on Arc. */
  gatewayMint: async (body: { burnIntent: GatewayTypedData["message"]; signature: string }): Promise<GatewayMintResult> => {
    const res = await fetch(`${BROKER_URL}/api/gateway/mint`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json as { error?: string }).error ?? `The mint failed (${res.status}).`);
    return readGatewayMint(json);
  },
  /**
   * `encryptTo` makes it a private job: the buyer's passkey-derived inbox key (see lib/private).
   * `payVia: "ccip"` asks for the terms a buyer agent on Base/Ethereum funds the job with over Chainlink CCIP.
   */
  quote: async (body: {
    prompt: string;
    adapter: string | null;
    maxPriceUsdMicros: number;
    encryptTo?: string | null;
    payVia?: "ccip";
  }): Promise<Quote> => {
    const res = await fetch(`${BROKER_URL}/api/quotes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Quote & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `Broker returned ${res.status}.`);
    return json;
  },
};

/** micro-USD → "$0.0010", or an em dash for "not priced yet". Same digits as the CLI. */
export function formatUsd(micros: number | null | undefined): string {
  if (micros == null) return "—";
  return formatUsdMicros(micros);
}
