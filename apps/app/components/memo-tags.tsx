"use client";

import { useEffect, useState } from "react";
import { explorerAddress, explorerTx, memoEventsIn, publicClientFor, shortHex, type MemoEvent } from "@xorv/protocol/web";
import type { Job } from "@/lib/api";
import { useNetworkInfo } from "@/lib/hooks";
import { memoMatchesJob, memoTxs, type MemoTx } from "@/lib/memo-tags";
import { CHAIN_CONFIG, NETWORK, PUBLIC_RPC_URL } from "@/lib/network";
import { Ext, Panel } from "@/components/ui";
import { cn } from "@/lib/utils";

type Read = { status: "reading" } | { status: "missing" } | { status: "error" } | { status: "ok"; events: MemoEvent[] };

/**
 * The job's Arc Memo tags, read from the chain: for each money movement, the
 * `Memo` event in its receipt, its memoId (the job's escrow id) and its text.
 * Anyone reconciling Arc's USDC can find this job's movements by filtering
 * Memo events on that id, without Xorv's database.
 */
export function MemoTags({ job }: { job: Job }) {
  const info = useNetworkInfo();
  const txs = memoTxs(job);
  const memo = info?.arc?.memo.address ?? CHAIN_CONFIG.circle.memo;
  const reads = useMemoReads(txs, memo);
  if (txs.length === 0) return null;
  const escrowId = job.payment?.escrow?.jobId ?? null;
  const off = info?.arc ? !info.arc.memo.enabled : false;

  return (
    <Panel className="p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-medium text-fg">Memo tags</h2>
        <Ext href={explorerAddress(NETWORK, memo)}>
          <span className="text-[11px] text-fg-4">Arc Memo {shortHex(memo)} ↗</span>
        </Ext>
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-fg-4">
        {off
          ? "Memo tagging is off on this broker, so these transactions carry no tag."
          : "Each movement of this job's USDC is tagged on chain with the job's id, read here from the transaction receipts."}
      </p>
      {escrowId ? (
        <p className="mono mt-2 break-all text-[10.5px] text-fg-3">memoId {escrowId}</p>
      ) : null}
      <ul className="mt-2 space-y-1.5">
        {txs.map((m) => (
          <MemoRow key={`${m.label}:${m.tx}`} memo={m} read={reads[m.tx]} escrowId={escrowId} />
        ))}
      </ul>
    </Panel>
  );
}

function MemoRow({ memo, read, escrowId }: { memo: MemoTx; read: Read | undefined; escrowId: string | null }) {
  const event = read?.status === "ok" ? read.events[0] : undefined;
  const match = event ? memoMatchesJob(event.memoId, escrowId) : null;
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[12px]">
      <span className="text-fg-3">
        {memo.label} · <Ext href={explorerTx(NETWORK, memo.tx)}>{shortHex(memo.tx)} ↗</Ext>
      </span>
      <span className={cn("mono text-[11px]", event ? "text-fg-2" : "text-fg-4")}>
        {!read || read.status === "reading"
          ? "reading receipt…"
          : read.status === "error"
            ? "couldn't read the receipt"
            : read.status === "missing" || !event
              ? "no Memo event"
              : (
                  <>
                    &ldquo;{event.text || "(empty)"}&rdquo;
                    {match === true ? <span className="text-live"> · id ✓</span> : match === false ? <span className="text-fail"> · other id {shortHex(event.memoId)}</span> : ` · ${shortHex(event.memoId)}`}
                  </>
                )}
      </span>
    </li>
  );
}

/** Read each transaction's receipt once and decode its Memo events. */
function useMemoReads(txs: MemoTx[], memo: string): Record<string, Read> {
  const [reads, setReads] = useState<Record<string, Read>>({});
  const key = txs.map((t) => t.tx).join(",");
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const client = publicClientFor(NETWORK, { rpcUrl: PUBLIC_RPC_URL });
    for (const tx of key.split(",")) {
      client
        .getTransactionReceipt({ hash: tx as `0x${string}` })
        .then((receipt) => {
          if (!alive) return;
          const events = memoEventsIn(receipt.logs, memo as `0x${string}`);
          setReads((prev) => ({ ...prev, [tx]: events.length ? { status: "ok", events } : { status: "missing" } }));
        })
        .catch(() => {
          if (alive) setReads((prev) => ({ ...prev, [tx]: { status: "error" } }));
        });
    }
    return () => {
      alive = false;
    };
  }, [key, memo]);
  return reads;
}
