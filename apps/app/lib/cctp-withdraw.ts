/**
 * A provider's CCTP V2 withdrawal, as the app drives it: the pure parts.
 *
 * Burn on Arc (approve TokenMessengerV2, then `depositForBurn`), wait for
 * Circle's Iris to attest the burn, then anyone with a wallet on the
 * destination calls `MessageTransmitterV2.receiveMessage(message, attestation)`
 * to mint native USDC there. The ABIs and the plan come from
 * `@xorv/protocol` (cctp.ts); this file holds the decisions the UI makes
 * around them, so they are tested without a wallet.
 */

import type { Hex } from "viem";
import type { IrisMessage } from "@xorv/protocol/web";

/**
 * USDC kept back on Arc when withdrawing "everything": the burn and its
 * approval pay gas from the same balance (Arc's gas token is USDC).
 */
export const GAS_RESERVE_UNITS = 50_000n; // $0.05

/** The default withdrawal: the whole ERC-20 balance minus the gas reserve, or 0. */
export function defaultWithdrawUnits(balanceUnits: string | bigint): bigint {
  const balance = BigInt(balanceUnits);
  return balance > GAS_RESERVE_UNITS ? balance - GAS_RESERVE_UNITS : 0n;
}

export type IrisState =
  | { state: "unseen" }
  | { state: "pending"; status: string }
  | { state: "complete"; message: Hex; attestation: Hex };

/** Where a burn stands at Iris, from its `/v2/messages` answer (already parsed). */
export function irisState(messages: IrisMessage[]): IrisState {
  const first = messages[0];
  if (!first) return { state: "unseen" };
  if (first.status === "complete" && first.message && first.attestation) {
    return { state: "complete", message: first.message, attestation: first.attestation };
  }
  return { state: "pending", status: first.status };
}

/** A withdrawal in flight, kept in the browser so a reload can pick it up again. */
export interface PendingWithdrawal {
  burnTx: Hex;
  /** Destination EVM chain id. */
  chainId: number;
  amountUnits: string;
  recipient: string;
  startedAt: number;
  mintTx?: Hex | null;
}

export function readPendingWithdrawal(raw: string | null): PendingWithdrawal | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<PendingWithdrawal>;
    if (typeof o.burnTx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(o.burnTx)) return null;
    if (typeof o.chainId !== "number" || typeof o.amountUnits !== "string" || typeof o.recipient !== "string") return null;
    return {
      burnTx: o.burnTx as Hex,
      chainId: o.chainId,
      amountUnits: o.amountUnits,
      recipient: o.recipient,
      startedAt: typeof o.startedAt === "number" ? o.startedAt : 0,
      mintTx: typeof o.mintTx === "string" ? (o.mintTx as Hex) : null,
    };
  } catch {
    return null;
  }
}

export function pendingWithdrawalKey(address: string): string {
  return `xorv:cctp-withdraw:${address.toLowerCase()}`;
}
