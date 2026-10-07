/**
 * Arc, live: the numbers the app's live strip shows, and the pure math behind
 * them.
 *
 * Arc has no consensus pipeline worth animating: a transaction in a block is
 * final (deterministic, sub-second finality, no reorgs), so "confirmed" and
 * "final" are the same event. What is worth showing, and measuring rather than
 * asserting, is:
 *
 *  - the latest block, and the block interval measured from the chain's own
 *    timestamps over a window of blocks (Arc timestamps have one-second
 *    resolution, so one block's timestamp says nothing; a hundred say a lot);
 *  - whether the RPC's `finalized` head trails `latest` at all (on Arc it
 *    should not: final on inclusion);
 *  - what gas costs, in USDC, because on Arc gas *is* USDC. The figure shown is
 *    the cost of a typical XorvEscrow release (~300k gas) at the current gas
 *    price, which is what the broker's attester pays per job.
 *
 * Everything here is pure and tested; the hook in components/arc-live.tsx does
 * the I/O.
 */

import { formatGasUsdc } from "@xorv/protocol/web";

/** Gas a typical XorvEscrow release uses, Memo-wrapped and with the reputation hook, rounded up. */
export const ESCROW_RELEASE_GAS = 300_000n;

/** How many blocks back the interval is measured over. */
export const INTERVAL_WINDOW = 120;

export interface BlockSample {
  number: bigint;
  /** Unix seconds, as the block header carries it. */
  timestamp: bigint;
}

/**
 * Mean milliseconds per block between two blocks, from their timestamps.
 * Null when the window is empty or the clock went backwards (a bad RPC).
 */
export function blockIntervalMs(older: BlockSample, newer: BlockSample): number | null {
  const blocks = newer.number - older.number;
  const seconds = newer.timestamp - older.timestamp;
  if (blocks <= 0n || seconds < 0n) return null;
  return Math.round((Number(seconds) * 1000) / Number(blocks));
}

/** Gas price (wei of native USDC, 18 decimals) × gas → the cost in the same wei. */
export function gasCostWei(gasPriceWei: bigint, gas: bigint = ESCROW_RELEASE_GAS): bigint {
  if (gasPriceWei < 0n || gas < 0n) return 0n;
  return gasPriceWei * gas;
}

/** Gas price in gwei, one decimal: "20.0 gwei". */
export function formatGwei(wei: bigint): string {
  const tenths = (wei * 10n + 500_000_000n) / 1_000_000_000n;
  return `${tenths / 10n}.${tenths % 10n} gwei`;
}

/** What a typical escrow release costs right now, as USDC text: "0.006 USDC". */
export function releaseCostText(gasPriceWei: bigint): string {
  return formatGasUsdc(gasCostWei(gasPriceWei));
}

/**
 * How far the `finalized` head trails `latest`, in blocks; null when the RPC
 * didn't answer for `finalized`. Zero (or the one block that landed between
 * the two reads) is Arc's deterministic finality, seen from outside.
 */
export function finalityLag(latest: bigint | null, finalized: bigint | null): number | null {
  if (latest === null || finalized === null) return null;
  const lag = latest - finalized;
  return lag < 0n ? 0 : Number(lag);
}
