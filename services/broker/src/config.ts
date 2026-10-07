/**
 * Broker configuration, resolved once at boot.
 *
 * Everything that can be wrong about a deployment — a malformed key, a
 * leftover Hedera network id, a ledger address with a typo, a stablecoin
 * override that isn't an address — should fail here, with a message that
 * names the fix, not three seconds into someone's first paid job.
 *
 * Nothing here is *required*. A broker with no keys at all still boots: it
 * matches providers and serves the ledger read-only, with payments off (Arc
 * has no public x402 facilitator, so taking payments needs the self-hosted
 * one's key). Keys add capabilities (settlement, ledger writes, rating
 * relays, Gateway mints, the refund keeper); they are not the price of
 * starting the process — which is what lets the test suite and a first-time
 * demo run with no secrets.
 */

import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  DEFAULT_NETWORK,
  accountFromKey,
  networkConfig,
  normalizeAddress,
  type ArcNetwork,
} from "@xorv/protocol";
import type { Address, PrivateKeyAccount } from "viem";

// The repo keeps one .env at the root; the broker is two directories down
// (the same relative path works from both src/ and dist/).
const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../../.env"), quiet: true });
loadDotenv({ quiet: true });

/**
 * The AI role switches (src/ai/). `auto` — the default — turns a role on
 * exactly when its provider's key is set; naming the provider asks for it
 * explicitly (still off without a key, but loudly); `off` is off. Keys are
 * resolved when the roles are built, not here, so a missing one never stops
 * the broker from booting.
 */
export interface AiRoleConfig {
  router: "qwen" | "auto" | "off";
  screener: "hunyuan" | "auto" | "off";
  verifier: "kimi" | "auto" | "off";
  /**
   * What a quote does when the screen can't answer: `open` (default) lets it
   * through with a record saying it went unscreened; `closed` refuses it.
   */
  screenerFail?: "open" | "closed";
}

export interface BrokerConfig {
  /** CAIP-2 id; `eip155:5042002` (testnet) unless told otherwise. */
  network: ArcNetwork;
  /**
   * The broker's own EOA: ledger writes, rating relays and (unless
   * XORV_VERIFIER_KEY is set) verifier feedback. Null means read-only —
   * nothing is written on-chain.
   */
  operator: PrivateKeyAccount | null;
  /**
   * The EOA that submits buyers' EIP-3009 authorizations and pays their gas
   * (USDC on Arc) when the facilitator is self-hosted. Defaults to the operator; a
   * separate key is recommended so settlement and audit writes never queue
   * behind each other.
   */
  facilitatorAccount: PrivateKeyAccount | null;
  /**
   * The EOA that writes the Kimi verifier's scores to the ERC-8004
   * Reputation Registry (`giveFeedback`). XORV_VERIFIER_KEY, falling back to
   * the operator key; null (or unset) keeps scores off-chain. It must never
   * own or operate a provider's agent — the registry refuses self-feedback.
   */
  verifierAccount?: PrivateKeyAccount | null;
  /**
   * `self`, `hosted`, or a facilitator URL. Null when `XORV_FACILITATOR` is
   * unset, which means self-hosted (Arc has no public facilitator) — see
   * `resolveFacilitator` in facilitator.ts.
   */
  facilitatorMode: string | null;
  /** XorvLedger address; null runs the broker with no ledger at all. */
  ledgerAddress: Address | null;
  /**
   * XorvEscrow address; null pays providers directly (exact). With an escrow
   * the money waits in the contract until the job delivers and is refunded if
   * it doesn't. Needs the self-hosted facilitator: its key is the escrow's
   * attester, the only account that may fund, release and refund.
   */
  escrowAddress?: Address | null;
  /** Seconds from quote to the point anyone (a keeper) may refund the buyer. */
  escrowDeadlineSeconds?: number;
  /** The ledger's deploy block — the floor for RPC log scans. */
  ledgerFromBlock: bigint | null;
  /** Publish one heartbeat in this many per provider (0 = never). */
  heartbeatPublishEvery: number;
  /** How long a receipt may wait for company before its batch is sent. */
  receiptBatchMs: number;
  /** Send the batch as soon as it holds this many receipts. */
  receiptBatchMax: number;
  port: number;
  /**
   * The broker's public base URL. It is baked into on-chain strings — agent
   * registration URIs and feedback URIs — so it must be the address the rest
   * of the internet reaches, not localhost, in any real deployment.
   */
  publicUrl: string;
  /** The web app's base URL, for the "web" service in agent registration files. */
  appUrl: string | null;
  /** Envio GraphQL endpoint; when set it serves feeds and the leaderboard. */
  indexerUrl: string | null;
  corsOrigins: string[];
  feeBps: number;
  /** SQLite file for durable jobs and earnings; "off" disables persistence. */
  dbFile: string | null;
  /** MongoDB URI. When set, it becomes the restore source; SQLite stays the write guarantee. */
  mongoUri: string | null;
  mongoDb: string;
  ai: AiRoleConfig;
  /** XorvReputation: escrow settlements → ERC-8004. Null skips the escrow_outcomes reads. */
  reputationAddress?: Address | null;
  /** XorvCcipReceiver on Arc: jobs posted from Base/Ethereum over Chainlink CCIP. Null turns the watcher off. */
  ccipReceiverAddress?: Address | null;
  /** Signs the keeper's deadline refunds and CCIP book-keeping: XORV_KEEPER_KEY, else the operator. Never the attester. */
  keeperAccount?: PrivateKeyAccount | null;
  /** XorvCcipSender addresses on source chains, by chain id (XORV_CCIP_SENDERS="84532:0x…,11155111:0x…"). */
  ccipSenders?: Record<string, string>;
  /** Escrow deadline for a quote funded over CCIP (minutes of CCIP + CCTP transit). */
  ccipDeadlineSeconds?: number;
  /** Run the refund keeper: refund every escrowed job past its deadline (anyone may refund after the deadline; the broker does it so nobody has to). */
  keeper?: boolean;
}

function optional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function key(name: string): PrivateKeyAccount | null {
  const raw = optional(name);
  if (!raw) return null;
  try {
    return accountFromKey(raw);
  } catch (err) {
    throw new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function nonNegativeInt(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

function role<T extends string>(name: string, on: T): T | "auto" | "off" {
  const raw = (optional(name) ?? "auto").toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false") return "off";
  if (raw === "auto") return "auto";
  if (raw === on) return on;
  throw new Error(`${name} must be "${on}", "auto" or "off", got "${raw}"`);
}

function failMode(name: string): "open" | "closed" {
  const raw = (optional(name) ?? "open").toLowerCase();
  if (raw === "open" || raw === "closed") return raw;
  throw new Error(`${name} must be "open" or "closed", got "${raw}"`);
}

function onOff(name: string, fallback: boolean): boolean {
  const raw = optional(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (["on", "1", "true", "yes"].includes(raw)) return true;
  if (["off", "0", "false", "no"].includes(raw)) return false;
  throw new Error(`${name} must be "on" or "off", got "${raw}"`);
}

/** "84532:0xabc…,11155111:0xdef…" → { "84532": "0xAbc…", … }. */
export function parseSenders(raw: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const [chainId, address] = part.split(":").map((p) => p.trim());
    if (!chainId || !/^\d+$/.test(chainId) || !address) throw new Error(`XORV_CCIP_SENDERS: expected chainId:address, got "${part}"`);
    try {
      out[chainId] = normalizeAddress(address);
    } catch (err) {
      throw new Error(`XORV_CCIP_SENDERS: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

export function loadConfig(): BrokerConfig {
  const network = (optional("XORV_NETWORK") ?? DEFAULT_NETWORK) as ArcNetwork;
  // Throws on anything but Arc testnet/mainnet (a stale `eip155:10143`
  // included) and on a malformed XORV_STABLECOIN — both better found now.
  networkConfig(network);

  const operator = key("XORV_OPERATOR_KEY");
  const facilitatorAccount = key("XORV_FACILITATOR_KEY") ?? operator;
  const verifierAccount = key("XORV_VERIFIER_KEY") ?? operator;

  const ledgerRaw = optional("XORV_LEDGER_ADDRESS");
  let ledgerAddress: Address | null = null;
  if (ledgerRaw) {
    try {
      ledgerAddress = normalizeAddress(ledgerRaw);
    } catch (err) {
      throw new Error(`XORV_LEDGER_ADDRESS: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const escrowRaw = optional("XORV_ESCROW_ADDRESS");
  let escrowAddress: Address | null = null;
  if (escrowRaw) {
    try {
      escrowAddress = normalizeAddress(escrowRaw);
    } catch (err) {
      throw new Error(`XORV_ESCROW_ADDRESS: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const address = (name: string): Address | null => {
    const raw = optional(name);
    if (!raw) return null;
    try {
      return normalizeAddress(raw);
    } catch (err) {
      throw new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const reputationAddress = address("XORV_REPUTATION_ADDRESS");
  const ccipReceiverAddress = address("XORV_CCIP_RECEIVER_ADDRESS");
  const escrowDeadlineSeconds = nonNegativeInt("XORV_ESCROW_DEADLINE_S", 1_800);
  if (escrowDeadlineSeconds < 120) {
    // The contract refuses deadlines under a minute; under two leaves no room for a job.
    throw new Error(`XORV_ESCROW_DEADLINE_S must be at least 120, got ${escrowDeadlineSeconds}`);
  }
  const fromBlockRaw = optional("XORV_LEDGER_FROM_BLOCK");
  if (fromBlockRaw !== null && !/^\d+$/.test(fromBlockRaw)) {
    throw new Error(`XORV_LEDGER_FROM_BLOCK must be a block number, got "${fromBlockRaw}"`);
  }

  const port = Number(process.env.XORV_BROKER_PORT ?? 8402);
  const publicUrl = (
    optional("XORV_PUBLIC_URL") ??
    optional("XORV_BROKER_URL") ??
    `http://localhost:${process.env.XORV_BROKER_PORT ?? 8402}`
  ).replace(/\/+$/, "");

  return {
    network,
    operator,
    facilitatorAccount,
    verifierAccount,
    facilitatorMode: optional("XORV_FACILITATOR"),
    ledgerAddress,
    escrowAddress,
    escrowDeadlineSeconds,
    reputationAddress,
    ccipReceiverAddress,
    keeper: onOff("XORV_KEEPER", true),
    keeperAccount: key("XORV_KEEPER_KEY") ?? operator,
    ccipSenders: parseSenders(optional("XORV_CCIP_SENDERS")),
    ccipDeadlineSeconds: Math.max(600, nonNegativeInt("XORV_CCIP_DEADLINE_S", 7_200)),
    ledgerFromBlock: fromBlockRaw === null ? null : BigInt(fromBlockRaw),
    heartbeatPublishEvery: nonNegativeInt("XORV_HEARTBEAT_PUBLISH_EVERY", 20),
    receiptBatchMs: nonNegativeInt("XORV_RECEIPT_BATCH_MS", 4_000),
    receiptBatchMax: Math.max(1, nonNegativeInt("XORV_RECEIPT_BATCH_MAX", 20)),
    port,
    publicUrl,
    appUrl: optional("XORV_APP_URL")?.replace(/\/+$/, "") ?? null,
    indexerUrl: optional("XORV_INDEXER_URL"),
    corsOrigins: (process.env.XORV_CORS_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    feeBps: Number(process.env.XORV_FEE_BPS ?? 0),
    // A fresh file name, so a Hedera-era xorv.db (tinybar stats, 0.0.x
    // accounts) is never silently loaded into an Arc broker.
    dbFile: optional("XORV_DB") ?? path.resolve(here, "../../../data/xorv-arc.db"),
    mongoUri: optional("XORV_MONGO_URI"),
    // Same reasoning as dbFile: a new default database name.
    mongoDb: optional("XORV_MONGO_DB") ?? "xorv_arc",
    ai: {
      router: role("XORV_ROUTER", "qwen"),
      screener: role("XORV_SCREENER", "hunyuan"),
      verifier: role("XORV_VERIFIER", "kimi"),
      screenerFail: failMode("XORV_SCREENER_FAIL"),
    },
  };
}
