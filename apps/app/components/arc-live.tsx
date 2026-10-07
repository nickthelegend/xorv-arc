"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { PublicClient } from "viem";
import { explorerBlock, publicClientFor } from "@xorv/protocol/web";
import {
  ESCROW_RELEASE_GAS,
  INTERVAL_WINDOW,
  blockIntervalMs,
  finalityLag,
  formatGwei,
  releaseCostText,
} from "@/lib/arc-live";
import { ARC_LIVE_RPC_URL, IS_LOCAL_CHAIN, NETWORK, NETWORK_LABEL } from "@/lib/network";
import { Ext, Panel } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * Arc's heartbeat, read straight from an Arc RPC: the latest block, the block
 * interval measured from the chain's timestamps, whether `finalized` trails
 * `latest`, and the gas price in USDC.
 *
 * Polling, not a socket: one `eth_getBlockByNumber` a second while the tab is
 * visible (a hidden tab has nobody to show it to, and public RPCs are
 * rate-limited), the slower reads every ten. Shared by the rail and the
 * network page through one provider, so a tab makes one set of calls.
 */

export type LiveStatus = "connecting" | "live" | "paused" | "unavailable";

export interface ArcLive {
  status: LiveStatus;
  latest: bigint | null;
  /** Recent block numbers, newest last, with when this browser first saw each. */
  recent: Array<{ number: bigint; seenAt: number; txs: number }>;
  /** Mean ms per block over the last INTERVAL_WINDOW blocks, from block timestamps. */
  intervalMs: number | null;
  /** Blocks between `latest` and `finalized`; null when the RPC doesn't serve `finalized`. */
  finalityLag: number | null;
  gasPriceWei: bigint | null;
  baseFeeWei: bigint | null;
}

const EMPTY: ArcLive = {
  status: "connecting",
  latest: null,
  recent: [],
  intervalMs: null,
  finalityLag: null,
  gasPriceWei: null,
  baseFeeWei: null,
};

const LiveContext = createContext<ArcLive | null>(null);

function useArcLivePoll(rpcUrl: string): ArcLive {
  const [state, setState] = useState<ArcLive>(EMPTY);
  const client = useRef<PublicClient | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    let stopped = false;
    let fast: ReturnType<typeof setInterval> | null = null;
    let slow: ReturnType<typeof setInterval> | null = null;
    let failures = 0;
    client.current ??= publicClientFor(NETWORK, { rpcUrl });
    const pub = client.current;

    const tick = async (): Promise<void> => {
      try {
        const block = await pub.getBlock({ blockTag: "latest" });
        if (stopped) return;
        failures = 0;
        setState((prev) => {
          const known = prev.recent.some((b) => b.number === block.number);
          const recent = known
            ? prev.recent
            : [...prev.recent, { number: block.number, seenAt: Date.now(), txs: block.transactions.length }]
                .sort((a, b) => (a.number < b.number ? -1 : 1))
                .slice(-14);
          return {
            ...prev,
            status: "live",
            latest: prev.latest !== null && prev.latest > block.number ? prev.latest : block.number,
            recent,
            baseFeeWei: block.baseFeePerGas ?? prev.baseFeeWei,
          };
        });
      } catch {
        failures += 1;
        if (!stopped && failures >= 3) setState((prev) => ({ ...prev, status: "unavailable" }));
      }
    };

    const measure = async (): Promise<void> => {
      try {
        const [latest, gasPrice, finalized] = await Promise.all([
          pub.getBlock({ blockTag: "latest" }),
          pub.getGasPrice(),
          pub.getBlock({ blockTag: "finalized" }).then(
            (b) => b.number,
            () => null,
          ),
        ]);
        const from = latest.number > BigInt(INTERVAL_WINDOW) ? latest.number - BigInt(INTERVAL_WINDOW) : 0n;
        const older = from < latest.number ? await pub.getBlock({ blockNumber: from }) : null;
        if (stopped) return;
        setState((prev) => ({
          ...prev,
          gasPriceWei: gasPrice,
          finalityLag: finalityLag(latest.number, finalized),
          intervalMs: older
            ? blockIntervalMs({ number: older.number, timestamp: older.timestamp }, { number: latest.number, timestamp: latest.timestamp })
            : prev.intervalMs,
        }));
      } catch {
        /* the fast tick reports reachability; a failed measurement just keeps the last one */
      }
    };

    const start = (): void => {
      if (stopped || document.visibilityState !== "visible" || fast) return;
      void tick();
      void measure();
      fast = setInterval(() => void tick(), 1_000);
      slow = setInterval(() => void measure(), 10_000);
    };
    const stop = (): void => {
      if (fast) clearInterval(fast);
      if (slow) clearInterval(slow);
      fast = null;
      slow = null;
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") start();
      else {
        stop();
        setState((prev) => ({ ...prev, status: "paused" }));
      }
    };

    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [rpcUrl]);

  return state;
}

/** One poller per tab, shared by the rail's heartbeat and the network page's strip. */
export function ArcLiveProvider({ children }: { children: ReactNode }) {
  const live = useArcLivePoll(ARC_LIVE_RPC_URL);
  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}

/** The live Arc readings, or the empty state outside the provider (tests, server render). */
export function useArcLive(): ArcLive {
  return useContext(LiveContext) ?? EMPTY;
}

function statusText(status: LiveStatus): string {
  return status === "live" ? "live" : status === "paused" ? "paused (tab hidden)" : status === "unavailable" ? "RPC unavailable" : "connecting…";
}

/** The rail's footer line: Arc's latest block (final on inclusion), and where this app's own contracts run. */
export function LiveHeartbeat() {
  const { latest, intervalMs, status } = useArcLive();
  return (
    <div className="mt-1.5 space-y-0.5">
      <p className="mono text-[11px] text-fg-4">
        {NETWORK_LABEL} ·{" "}
        {latest !== null ? (
          <>
            final #{latest.toLocaleString("en-US")}
            {intervalMs !== null ? ` · ${intervalMs} ms blocks` : ""}
          </>
        ) : (
          statusText(status)
        )}
      </p>
      {IS_LOCAL_CHAIN ? <p className="mono text-[11px] text-fg-4">payments: local fork</p> : null}
    </div>
  );
}

/**
 * The network page's Arc strip: blocks arriving, each final the moment it
 * exists; the measured interval; the finalized head's lag; and gas in USDC,
 * priced as the release of one escrowed job.
 */
export function ArcLiveStrip() {
  const live = useArcLive();
  const { status, recent, intervalMs, gasPriceWei, baseFeeWei } = live;
  const lag = live.finalityLag;

  return (
    <Panel className="p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-medium text-fg">Arc, live: final on inclusion</h2>
        <span className="flex items-center gap-1.5 text-[11.5px] text-fg-4">
          <span className={cn("h-1.5 w-1.5 rounded-full", status === "live" ? "breathe bg-live" : "bg-fg-4")} />
          {statusText(status)} · read-only from {NETWORK_LABEL}
        </span>
      </div>
      <p className="measure mt-1.5 text-[12.5px] leading-relaxed text-fg-3">
        Arc finalizes deterministically: a transaction in a block is final, with no reorg window to wait out, so a
        receipt is the end of the story. Gas is metered in USDC, the same dollars a job is priced in.
        {IS_LOCAL_CHAIN
          ? " This deployment's own payments run on a local fork of Arc, so their timings are the fork's; this strip is the real network."
          : ""}
      </p>

      <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-4">
        <Figure
          value={intervalMs !== null ? `${intervalMs} ms` : "—"}
          label={`block interval · mean of last ${INTERVAL_WINDOW}`}
        />
        <Figure
          value={lag === null ? "—" : lag === 0 ? "0 blocks" : `${lag} block${lag === 1 ? "" : "s"}`}
          label="finalized head behind latest"
        />
        <Figure value={gasPriceWei !== null ? formatGwei(gasPriceWei) : "—"} label={baseFeeWei !== null ? `gas price · base ${formatGwei(baseFeeWei)}` : "gas price"} />
        <Figure
          value={gasPriceWei !== null ? releaseCostText(gasPriceWei) : "—"}
          label={`one escrow release (~${(Number(ESCROW_RELEASE_GAS) / 1000).toFixed(0)}k gas)`}
        />
      </div>

      <ol className="mt-4 flex flex-wrap gap-1.5" aria-label="Recent Arc blocks">
        {recent.length === 0 ? <li className="text-[12px] text-fg-4">waiting for the next block…</li> : null}
        {recent.map((block) => (
          <li
            key={String(block.number)}
            className="mono rounded-md border border-live/50 bg-live/10 px-2 py-1 text-[11px] text-live"
            title={`#${block.number} · ${block.txs} tx · final`}
          >
            <Ext href={explorerBlock(NETWORK, block.number)}>…{String(block.number).slice(-5)}</Ext>
            <span className="ml-1 opacity-70">{block.txs}tx</span>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-[11px] text-fg-4">
        Every chip is final the moment it appears. Interval from block timestamps (1 s resolution, so it is measured
        over a window); cost = gas price × gas, paid in USDC by whoever sends the transaction — for a job, the
        broker&rsquo;s attester, never the buyer.
      </p>
    </Panel>
  );
}

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <p className="tnum text-[20px] font-semibold tracking-[-0.02em] text-fg">{value}</p>
      <p className="text-[11.5px] text-fg-4">{label}</p>
    </div>
  );
}
