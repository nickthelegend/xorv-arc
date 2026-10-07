/**
 * Formatting for the Arc speed receipt.
 *
 * The numbers come from the broker: how long each settlement took on its own
 * clock, from submitting the transaction to holding the confirmed receipt, and
 * the block, gas and gas payer read back from that receipt. On Arc a receipt
 * is final (deterministic finality, no reorgs), so there is one timer per
 * transaction, not two. Nothing here is estimated. The one fixed figure is
 * Ethereum's 12-second slot, a protocol constant, shown for scale.
 */
import { formatGasUsdc as formatNativeUsdc } from "@xorv/protocol/web";

/** Ethereum mainnet produces one block per 12-second slot (protocol constant). */
export const ETHEREUM_SLOT_MS = 12_000;

/** "612 ms", or "1.24 s" from a second up. */
export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Gas paid, in wei of Arc's native USDC (18 decimals), as short USDC text:
 * "0.00421 USDC", "<0.000001 USDC". Arc meters gas in USDC, so this is dollars.
 */
export function formatGasUsdc(wei: string | bigint): string {
  return formatNativeUsdc(typeof wei === "bigint" ? wei : BigInt(wei));
}

/** "84,213" */
export function formatGas(gas: string): string {
  return BigInt(gas).toLocaleString("en-US");
}

/**
 * The settlement time to show: on Arc, holding the receipt *is* finality, so
 * this is `confirmMs`; `finalMs` (the RPC's finalized head reaching the block)
 * stands in only when the confirm timer wasn't measured.
 */
export function settledMs(timing: { confirmMs: number | null; finalMs?: number | null }): number | null {
  return timing.confirmMs ?? timing.finalMs ?? null;
}

/**
 * How many times faster than one Ethereum block, rounded down, when that is
 * worth saying (2× or more); null otherwise.
 */
export function vsEthereumSlot(ms: number | null): number | null {
  if (ms === null || ms <= 0) return null;
  const times = Math.floor(ETHEREUM_SLOT_MS / ms);
  return times >= 2 ? times : null;
}
