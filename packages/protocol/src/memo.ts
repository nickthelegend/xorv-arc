/**
 * Arc's Memo transaction extension: tag a payment with the job it pays for.
 *
 * Arc predeploys a `Memo` contract (`0x5294…e505` on testnet and mainnet) that
 * wraps any contract call: `memo(target, data, memoId, memoData)` runs `data`
 * against `target` through Arc's CallFrom precompile, so the target still sees
 * the original EOA as `msg.sender`, and then emits
 * `Memo(sender, target, callDataHash, memoId, memo, memoIndex)`.
 *
 * Xorv routes its own money movements through it: the facilitator's escrow
 * `fund`, the attester's `release` / `refund` / `cancel` / `reassign`, and the
 * x402 `transferWithAuthorization` of a direct payment. `memoId` is the job's
 * bytes32 id (the same id XorvEscrow and XorvLedger key the job by), and
 * `memoData` is a short UTF-8 tag such as `xorv:release:<broker job id>`. Anyone
 * reconciling Arc's USDC flows can look a transfer up by job without Xorv's
 * database, by filtering `Memo` events on `memoId`.
 *
 * The Memo contract must be called by an EOA directly (no smart accounts);
 * Xorv's settlement keys are EOAs. This module is pure and browser-safe.
 */

import {
  decodeEventLog,
  encodeFunctionData,
  hexToString,
  isHex,
  keccak256,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
  type Log,
} from "viem";

/** The Memo contract's ABI (verified source on the Arc explorer, 2026-10-07). */
export const MEMO_ABI = [
  {
    type: "function",
    name: "memo",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "data", type: "bytes" },
      { name: "memoId", type: "bytes32" },
      { name: "memoData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "memoIndex",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "event",
    name: "BeforeMemo",
    inputs: [{ name: "memoIndex", type: "uint256", indexed: true }],
    anonymous: false,
  },
  {
    type: "event",
    name: "Memo",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "target", type: "address", indexed: true },
      { name: "callDataHash", type: "bytes32", indexed: false },
      { name: "memoId", type: "bytes32", indexed: true },
      { name: "memo", type: "bytes", indexed: false },
      { name: "memoIndex", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  { type: "error", name: "MemoFailed", inputs: [{ name: "returnData", type: "bytes" }] },
] as const;

/** A memo to attach: the id indexed on chain, and the text carried with it. */
export interface MemoTag {
  memoId: Hex;
  text: string;
}

/** Longest memo text Xorv writes; the rest is cut. Log bytes cost gas. */
export const MAX_MEMO_TEXT = 96;

/** The memo for a job movement: `memoId` is the job's bytes32 id. */
export function jobMemo(jobId: Hex, action: string, label?: string): MemoTag {
  const text = `xorv:${action}${label ? `:${label}` : ""}`.slice(0, MAX_MEMO_TEXT);
  return { memoId: jobId, text };
}

/** The bytes32 memo id for a broker job id string (same derivation as XorvLedger's jobId). */
export function memoIdForJob(brokerJobId: string): Hex {
  return keccak256(stringToHex(brokerJobId));
}

/** A contract write, as the writers in this repo describe it. */
export interface PlainWrite {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  gas: bigint;
}

/**
 * Re-point a write through Memo: same effect on `write.address`, with `tag`
 * emitted alongside. The gas field is kept; callers estimate the wrapped call.
 */
export function wrapWithMemo(memo: Address, write: PlainWrite, tag: MemoTag): PlainWrite {
  const data = encodeFunctionData({ abi: write.abi, functionName: write.functionName, args: write.args ?? [] } as never);
  return {
    address: memo,
    abi: MEMO_ABI as unknown as Abi,
    functionName: "memo",
    args: [write.address, data, tag.memoId, stringToHex(tag.text)],
    gas: write.gas,
  };
}

/** A decoded `Memo` event. */
export interface MemoEvent {
  sender: Address;
  target: Address;
  memoId: Hex;
  text: string;
  memoIndex: bigint;
  callDataHash: Hex;
}

/** Decode the Memo events in a receipt's logs (others are skipped). */
export function memoEventsIn(logs: readonly Pick<Log, "address" | "data" | "topics">[], memo: Address): MemoEvent[] {
  const out: MemoEvent[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== memo.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: MEMO_ABI, data: log.data, topics: log.topics as never });
      if (ev.eventName !== "Memo") continue;
      const a = ev.args as { sender: Address; target: Address; memoId: Hex; memo: Hex; memoIndex: bigint; callDataHash: Hex };
      let text = "";
      try {
        text = isHex(a.memo) ? hexToString(a.memo) : "";
      } catch {
        text = "";
      }
      out.push({ sender: a.sender, target: a.target, memoId: a.memoId, text, memoIndex: a.memoIndex, callDataHash: a.callDataHash });
    } catch {
      // not a Memo event
    }
  }
  return out;
}
