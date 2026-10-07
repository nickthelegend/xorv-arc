"use client";

import { explorerAddress, explorerBlock, shortHex } from "@xorv/protocol/web";
import type { Job } from "@/lib/api";
import { NETWORK, NETWORK_LABEL } from "@/lib/network";
import { formatGas, formatGasUsdc, formatMs, settledMs, vsEthereumSlot } from "@/lib/speed";
import { Ext, Panel, Row } from "@/components/ui";

/**
 * The speed receipt: how fast this job's money actually moved, measured by the
 * broker from submitting each transaction to holding its receipt. On Arc that
 * receipt is final (deterministic, sub-second finality, no reorgs), so there is
 * one honest timer per transaction, not a "confirmed" and a later "final".
 * Gas is paid in USDC, by the facilitator or the escrow's attester, never the
 * buyer. Every figure says where it was measured: on a local fork they are the
 * fork's timings and the page says so; it never presents them as Arc's.
 */
export function SpeedReceipt({ job }: { job: Job }) {
  const timing = job.payment?.timing;
  if (!timing) return null;
  const held = job.payment?.escrow;
  const settle = held?.settleTiming ?? null;
  const local = timing.chain === "local";
  const paidMs = settledMs(timing);
  const settleMs = settle ? settledMs(settle) : null;
  const times = local ? null : vsEthereumSlot(paidMs);

  return (
    <Panel className="p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-medium text-fg">{local ? "Speed receipt" : "Arc speed receipt"}</h2>
        <span className="text-[11px] text-fg-4">{local ? "local fork · not Arc's timing" : `measured on ${NETWORK_LABEL}`}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-3">
        <Timer label={local ? "payment executed" : "payment final"} ms={paidMs} />
        {settle ? (
          <Timer label={held?.state === "refunded" ? "refund final" : "release final"} ms={settleMs} />
        ) : (
          <div>
            <p className="tnum text-[24px] font-semibold tracking-[-0.02em] text-fg">{formatGasUsdc(timing.gasPaidWei)}</p>
            <p className="text-[11.5px] text-fg-3">gas, paid in USDC</p>
          </div>
        )}
      </div>
      <div className="mt-3 border-t border-[var(--line)] pt-1">
        <Row label="block">
          {local ? (
            <span className="mono">#{timing.blockNumber.toLocaleString("en-US")}</span>
          ) : (
            <Ext href={explorerBlock(NETWORK, timing.blockNumber)}>#{timing.blockNumber.toLocaleString("en-US")}</Ext>
          )}
        </Row>
        <Row label="gas">
          <span className="tnum">
            {formatGas(timing.gasUsed)} · {formatGasUsdc(timing.gasPaidWei)}
          </span>
        </Row>
        <Row label="gas paid by">
          {local ? (
            <span className="mono">
              {held ? "the escrow's attester" : "the facilitator"} {shortHex(timing.gasPayer)}
            </span>
          ) : (
            <Ext href={explorerAddress(NETWORK, timing.gasPayer)}>
              {held ? "the escrow's attester" : "the facilitator"} {shortHex(timing.gasPayer)}
            </Ext>
          )}
        </Row>
        <Row label="buyer paid in gas">
          <span className="text-live">0 USDC</span>
        </Row>
        {settle ? (
          <Row label={held?.state === "refunded" ? "refund gas" : "release gas"}>
            <span className="tnum">
              {formatGas(settle.gasUsed)} · {formatGasUsdc(settle.gasPaidWei)}
              {settle.sendMode === "sync" ? " · receipt in the send" : ""}
            </span>
          </Row>
        ) : null}
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-fg-4">
        {local
          ? "Timed by the broker on a local anvil fork of Arc (no consensus, so the fork's numbers are not Arc's). Arc itself finalizes each block deterministically in under a second; see the live strip on the Network page."
          : `Timed by the broker, from sending the transaction to holding its receipt${settle?.sendMode === "sync" ? " (escrow writes get it back in the send itself, via eth_sendRawTransactionSync)" : ""}. On Arc a receipt is final: no confirmations to wait for, no reorgs.`}
        {times ? ` For scale: one Ethereum block takes 12 s, ${times}× longer than this payment took to become final.` : ""}
      </p>
    </Panel>
  );
}

function Timer({ label, ms }: { label: string; ms: number | null }) {
  return (
    <div>
      <p className="tnum text-[24px] font-semibold tracking-[-0.02em] text-fg">{ms !== null ? formatMs(ms) : "—"}</p>
      <p className="text-[11.5px] text-fg-3">{label}</p>
    </div>
  );
}
