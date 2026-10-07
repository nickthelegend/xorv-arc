/**
 * Circle Gateway: one USDC balance across chains, spent on Arc in about a second.
 *
 * A buyer deposits USDC once into Circle's GatewayWallet on any chain Gateway
 * runs on (Base, Ethereum, Arbitrum, Avalanche, OP, Polygon, and Arc itself).
 * When a job needs paying on Arc and their Arc wallet is short, they sign one
 * EIP-712 **burn intent** — no gas, no chain switch: "burn `value` of my
 * Gateway balance on domain N and mint it on Arc to me". The broker posts the
 * signed intent to Circle's Gateway API, which answers with an attestation,
 * and calls `GatewayMinter.gatewayMint(attestation, signature)` on Arc, paying
 * the gas in USDC. The dollars are in the buyer's Arc wallet before the job's
 * x402 payment is signed.
 *
 * The broker can't redirect a cent: the recipient is in the intent the buyer
 * signed, Circle's operator signs the attestation, and gatewayMint mints only
 * to the recipient it names (no destination caller is set).
 *
 * This module is pure (no I/O): building and checking intents. The broker
 * owns the HTTP calls and the mint (`services/broker/src/arc.ts`).
 * Adapted from polaris-arc's Gateway server.
 */

import { getAddress, isHex, pad, slice, type Address, type Hex } from "viem";
import { ARC_MAINNET, networkConfig } from "./chains.js";

export interface GatewaySource {
  domain: number;
  name: string;
  usdc: Address;
}

export interface GatewayNetwork {
  apiUrl: string;
  wallet: Address;
  minter: Address;
  arcDomain: number;
  arcUsdc: Address;
  sources: GatewaySource[];
}

/** Where a Gateway balance can sit, testnet (developers.circle.com/gateway, supported chains). */
export const GATEWAY_TESTNET_SOURCES: readonly GatewaySource[] = [
  { domain: 6, name: "Base Sepolia", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  { domain: 0, name: "Ethereum Sepolia", usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
  { domain: 3, name: "Arbitrum Sepolia", usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" },
  { domain: 1, name: "Avalanche Fuji", usdc: "0x5425890298aed601595a70AB815c96711a31Bc65" },
  { domain: 2, name: "OP Sepolia", usdc: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7" },
  { domain: 7, name: "Polygon Amoy", usdc: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582" },
  { domain: 26, name: "Arc Testnet", usdc: "0x3600000000000000000000000000000000000000" },
];

/** And on mainnet. */
export const GATEWAY_MAINNET_SOURCES: readonly GatewaySource[] = [
  { domain: 6, name: "Base", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  { domain: 0, name: "Ethereum", usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  { domain: 3, name: "Arbitrum", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
  { domain: 1, name: "Avalanche", usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E" },
  { domain: 2, name: "OP Mainnet", usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" },
  { domain: 7, name: "Polygon PoS", usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" },
  { domain: 26, name: "Arc", usdc: "0x3600000000000000000000000000000000000000" },
];

/** Gateway on an Arc network. */
export function gatewayFor(network: string): GatewayNetwork {
  const cfg = networkConfig(network);
  return {
    apiUrl: cfg.circle.gatewayApiUrl,
    wallet: cfg.circle.gatewayWallet,
    minter: cfg.circle.gatewayMinter,
    arcDomain: cfg.circle.cctpDomain,
    arcUsdc: cfg.usdc.address,
    sources: [...(cfg.caip2 === ARC_MAINNET ? GATEWAY_MAINNET_SOURCES : GATEWAY_TESTNET_SOURCES)],
  };
}

/** Circle's gas fee per source domain, USDC base units (developers.circle.com/gateway/references/fees). */
const BASE_FEE: Record<number, bigint> = { 0: 1_000_000n, 6: 10_000n, 26: 3_500n, 3: 10_000n, 2: 10_000n, 1: 20_000n, 7: 10_000n };

/**
 * The most the buyer lets Gateway take for a transfer of `value` from `domain`:
 * the source's gas fee with a quarter of headroom, plus the 0.005% transfer
 * fee rounded up, plus a cent. Circle charges the actual fee, never more.
 */
export function gatewayMaxFee(domain: number, value: bigint): bigint {
  const base = BASE_FEE[domain] ?? 1_000_000n;
  return (base * 5n) / 4n + (value * 5n + 99_999n) / 100_000n + 10_000n;
}

export const BURN_INTENT_TYPES = {
  TransferSpec: [
    { name: "version", type: "uint32" },
    { name: "sourceDomain", type: "uint32" },
    { name: "destinationDomain", type: "uint32" },
    { name: "sourceContract", type: "bytes32" },
    { name: "destinationContract", type: "bytes32" },
    { name: "sourceToken", type: "bytes32" },
    { name: "destinationToken", type: "bytes32" },
    { name: "sourceDepositor", type: "bytes32" },
    { name: "destinationRecipient", type: "bytes32" },
    { name: "sourceSigner", type: "bytes32" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "value", type: "uint256" },
    { name: "salt", type: "bytes32" },
    { name: "hookData", type: "bytes" },
  ],
  BurnIntent: [
    { name: "maxBlockHeight", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "spec", type: "TransferSpec" },
  ],
} as const;

export const BURN_INTENT_DOMAIN = { name: "GatewayWallet", version: "1" } as const;

/** The GatewayMinter call the broker makes with Circle's attestation. */
export const GATEWAY_MINTER_ABI = [
  {
    type: "function",
    name: "gatewayMint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "attestationPayload", type: "bytes" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

/** GatewayWallet.deposit, for a buyer funding their unified balance on a chain (approve USDC first). */
export const GATEWAY_WALLET_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "availableBalance",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "depositor", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const MAX_UINT256 = (1n << 256n) - 1n;
/** Per transfer ceiling: Xorv jobs cost cents, so a top-up never needs more. */
export const GATEWAY_MAX_VALUE = 1_000_000_000n; // 1,000 USDC
const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const b32 = (a: Address): Hex => pad(getAddress(a), { size: 32 }).toLowerCase() as Hex;
const addrOf = (b: Hex): Address => getAddress(slice(b, 12));

export interface BurnIntent {
  maxBlockHeight: bigint;
  maxFee: bigint;
  spec: {
    version: number;
    sourceDomain: number;
    destinationDomain: number;
    sourceContract: Hex;
    destinationContract: Hex;
    sourceToken: Hex;
    destinationToken: Hex;
    sourceDepositor: Hex;
    destinationRecipient: Hex;
    sourceSigner: Hex;
    destinationCaller: Hex;
    value: bigint;
    salt: Hex;
    hookData: Hex;
  };
}

/** An input error, with the parameter it is about. */
export class GatewayInputError extends Error {
  constructor(
    message: string,
    readonly param: string,
  ) {
    super(message);
    this.name = "GatewayInputError";
  }
}

/** The burn intent that moves `value` of `depositor`'s Gateway balance on `sourceDomain` to `recipient` on Arc. Pure. */
export function buildBurnIntent(
  g: GatewayNetwork,
  input: { sourceDomain: number; depositor: Address; recipient: Address; value: bigint; salt: Hex },
): BurnIntent {
  const source = g.sources.find((s) => s.domain === input.sourceDomain);
  if (!source) throw new GatewayInputError(`sourceDomain must be one of ${g.sources.map((s) => s.domain).join(", ")}`, "sourceDomain");
  if (input.value <= 0n || input.value > GATEWAY_MAX_VALUE) throw new GatewayInputError("amount must be more than 0 and at most 1,000 USDC", "amount");
  return {
    maxBlockHeight: MAX_UINT256,
    maxFee: gatewayMaxFee(input.sourceDomain, input.value),
    spec: {
      version: 1,
      sourceDomain: input.sourceDomain,
      destinationDomain: g.arcDomain,
      // GatewayWallet and GatewayMinter have the same address on every chain of a network.
      sourceContract: b32(g.wallet),
      destinationContract: b32(g.minter),
      sourceToken: b32(source.usdc),
      destinationToken: b32(g.arcUsdc),
      sourceDepositor: b32(input.depositor),
      destinationRecipient: b32(input.recipient),
      sourceSigner: b32(input.depositor),
      destinationCaller: ZERO32,
      value: input.value,
      salt: input.salt,
      hookData: "0x",
    },
  };
}

/** The intent as JSON (uint256 as decimal strings), the shape the Gateway API and wallets take. */
export function burnIntentToJson(i: BurnIntent) {
  return { maxBlockHeight: i.maxBlockHeight.toString(), maxFee: i.maxFee.toString(), spec: { ...i.spec, value: i.spec.value.toString() } };
}

/** The EIP-712 typed data a buyer signs for an intent. */
export function burnIntentTypedData(i: BurnIntent) {
  return { domain: BURN_INTENT_DOMAIN, types: BURN_INTENT_TYPES, primaryType: "BurnIntent" as const, message: i };
}

/** The recipient on Arc an intent mints to. */
export function burnIntentRecipient(i: BurnIntent): Address {
  return addrOf(i.spec.destinationRecipient);
}

/** The depositor (and signer) of an intent. */
export function burnIntentDepositor(i: BurnIntent): Address {
  return addrOf(i.spec.sourceDepositor);
}

/**
 * Read an intent back from JSON, checking every field Xorv relies on: to Arc,
 * through Circle's minter, as Arc's USDC, signer = depositor, no destination
 * caller, no hook, and a fee no higher than Xorv would have asked for.
 */
export function burnIntentFromJson(g: GatewayNetwork, raw: unknown): BurnIntent {
  const bad = (what: string): never => {
    throw new GatewayInputError(`burnIntent: ${what}`, "burnIntent");
  };
  const o = (raw ?? {}) as Record<string, unknown>;
  const s = (o.spec ?? {}) as Record<string, unknown>;
  const big = (v: unknown, name: string): bigint => {
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "bigint") return bad(`${name} must be a decimal string`);
    try {
      return BigInt(v);
    } catch {
      return bad(`${name} must be a decimal string`);
    }
  };
  const h32 = (v: unknown, name: string): Hex =>
    typeof v === "string" && isHex(v) && v.length === 66 ? (v.toLowerCase() as Hex) : bad(`${name} must be bytes32`);
  const intent: BurnIntent = {
    maxBlockHeight: big(o.maxBlockHeight, "maxBlockHeight"),
    maxFee: big(o.maxFee, "maxFee"),
    spec: {
      version: Number(s.version),
      sourceDomain: Number(s.sourceDomain),
      destinationDomain: Number(s.destinationDomain),
      sourceContract: h32(s.sourceContract, "sourceContract"),
      destinationContract: h32(s.destinationContract, "destinationContract"),
      sourceToken: h32(s.sourceToken, "sourceToken"),
      destinationToken: h32(s.destinationToken, "destinationToken"),
      sourceDepositor: h32(s.sourceDepositor, "sourceDepositor"),
      destinationRecipient: h32(s.destinationRecipient, "destinationRecipient"),
      sourceSigner: h32(s.sourceSigner, "sourceSigner"),
      destinationCaller: h32(s.destinationCaller, "destinationCaller"),
      value: big(s.value, "value"),
      salt: h32(s.salt, "salt"),
      hookData: typeof s.hookData === "string" && isHex(s.hookData) ? (s.hookData as Hex) : "0x",
    },
  };
  const expected = buildBurnIntent(g, {
    sourceDomain: intent.spec.sourceDomain,
    depositor: addrOf(intent.spec.sourceDepositor),
    recipient: addrOf(intent.spec.destinationRecipient),
    value: intent.spec.value,
    salt: intent.spec.salt,
  });
  for (const k of ["version", "destinationDomain", "sourceContract", "destinationContract", "sourceToken", "destinationToken", "sourceSigner", "destinationCaller", "hookData"] as const) {
    if (String(intent.spec[k]).toLowerCase() !== String(expected.spec[k]).toLowerCase()) {
      bad(`${k} isn't Xorv's (Arc, Circle's GatewayMinter, USDC, signer = depositor, no destination caller)`);
    }
  }
  if (intent.maxFee > expected.maxFee) bad("maxFee is above what Xorv allows for this transfer");
  return intent;
}
