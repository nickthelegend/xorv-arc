/**
 * Circle CCTP V2: providers withdraw their Arc earnings to any chain.
 *
 * A provider is paid in USDC on Arc (escrow release or a direct x402
 * transfer). To take it home they burn it on Arc with
 * `TokenMessengerV2.depositForBurn(amount, destinationDomain, mintRecipient, …)`,
 * Circle's Iris service attests the burn, and anyone calls
 * `MessageTransmitterV2.receiveMessage(message, attestation)` on the
 * destination to mint native USDC there. No bridge liquidity, no wrapped
 * token: Circle burns and mints the same USDC.
 *
 * Fast transfers (`minFinalityThreshold` 1000) attest in seconds for a small
 * fee capped by `maxFee`; standard (2000) waits for finality and is free.
 * Arc's own finality is sub-second, so the wait is on the attestation only.
 *
 * Pure helpers (ABIs, calldata, Iris URLs and parsing). The CLI's
 * `xorv withdraw` and the app's withdraw panel do the I/O.
 */

import { getAddress, pad, type Address, type Hex } from "viem";
import { networkConfig, type RemoteChain } from "./chains.js";

export const TOKEN_MESSENGER_V2_ABI = [
  {
    type: "function",
    name: "depositForBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "DepositForBurn",
    inputs: [
      { name: "burnToken", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "depositor", type: "address", indexed: true },
      { name: "mintRecipient", type: "bytes32", indexed: false },
      { name: "destinationDomain", type: "uint32", indexed: false },
      { name: "destinationTokenMessenger", type: "bytes32", indexed: false },
      { name: "destinationCaller", type: "bytes32", indexed: false },
      { name: "maxFee", type: "uint256", indexed: false },
      { name: "minFinalityThreshold", type: "uint32", indexed: true },
      { name: "hookData", type: "bytes", indexed: false },
    ],
    anonymous: false,
  },
] as const;

export const MESSAGE_TRANSMITTER_V2_ABI = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const;

export const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** CCTP V2 finality thresholds. */
export const CCTP_FAST = 1000;
export const CCTP_STANDARD = 2000;

/** A withdrawal plan: what to approve and burn on Arc, and where it lands. */
export interface CctpWithdrawPlan {
  destination: RemoteChain;
  amount: bigint;
  recipient: Address;
  maxFee: bigint;
  minFinalityThreshold: number;
  tokenMessenger: Address;
  usdc: Address;
  /** The depositForBurn arguments, in order. */
  args: readonly [bigint, number, Hex, Address, Hex, bigint, number];
}

/** An address as CCTP's bytes32 mint recipient / caller. */
export function addressToBytes32(a: Address): Hex {
  return pad(getAddress(a), { size: 32 }).toLowerCase() as Hex;
}

/**
 * Plan a burn on Arc that mints `amount` (minus at most `maxFee`) to
 * `recipient` on `destination`. `fast` uses the fast-transfer threshold; its
 * `maxFee` defaults to 1% of the amount, at least 0.01 USDC (Circle charges
 * its published fee, never more than the cap).
 */
export function planCctpWithdraw(
  network: string,
  opts: { destination: RemoteChain; amount: bigint; recipient: Address; fast?: boolean; maxFee?: bigint },
): CctpWithdrawPlan {
  if (opts.amount <= 0n) throw new Error("withdraw amount must be positive");
  const cfg = networkConfig(network);
  const fast = opts.fast ?? true;
  const maxFee = opts.maxFee ?? (fast ? bigMax(opts.amount / 100n, 10_000n) : 0n);
  if (maxFee >= opts.amount) throw new Error("maxFee must be below the amount");
  const threshold = fast ? CCTP_FAST : CCTP_STANDARD;
  return {
    destination: opts.destination,
    amount: opts.amount,
    recipient: getAddress(opts.recipient),
    maxFee,
    minFinalityThreshold: threshold,
    tokenMessenger: cfg.circle.tokenMessengerV2,
    usdc: cfg.usdc.address,
    args: [
      opts.amount,
      opts.destination.cctpDomain,
      addressToBytes32(opts.recipient),
      cfg.usdc.address,
      `0x${"0".repeat(64)}` as Hex,
      maxFee,
      threshold,
    ] as const,
  };
}

function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** Iris v2: the messages (and attestations) a burn transaction produced. */
export function irisMessagesUrl(network: string, sourceDomain: number, txHash: Hex): string {
  return `${networkConfig(network).circle.irisApiUrl}/v2/messages/${sourceDomain}?transactionHash=${txHash}`;
}

export interface IrisMessage {
  status: "pending_confirmations" | "complete" | string;
  message: Hex | null;
  attestation: Hex | null;
}

/** Parse Iris's `/v2/messages` answer; `[]` when it hasn't seen the burn yet. */
export function parseIrisMessages(json: unknown): IrisMessage[] {
  const list = (json as { messages?: unknown[] } | null)?.messages;
  if (!Array.isArray(list)) return [];
  return list.map((m) => {
    const o = m as Record<string, unknown>;
    const hex = (v: unknown): Hex | null => (typeof v === "string" && v.startsWith("0x") && v !== "0x" ? (v as Hex) : null);
    return { status: String(o.status ?? "unknown"), message: hex(o.message), attestation: o.attestation === "PENDING" ? null : hex(o.attestation) };
  });
}
