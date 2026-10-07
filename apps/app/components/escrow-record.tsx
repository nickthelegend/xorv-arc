"use client";

import { useCallback } from "react";
import { explorerAddress, explorerAgent, formatUsdc, shortHex } from "@xorv/protocol/web";
import { api } from "@/lib/api";
import { formatScoreBps, type ProviderEscrowRecord } from "@/lib/arc";
import { usePoll } from "@/lib/hooks";
import { NETWORK } from "@/lib/network";
import { Ext, Panel, Row } from "@/components/ui";

/**
 * A provider's escrow record, read from XorvReputation on Arc through the
 * broker: how many escrowed jobs released to it, how many were refunded
 * because it was at fault, what it earned, and the smoothed score those
 * outcomes produce. XorvEscrow reports every settlement to XorvReputation,
 * which writes it to the provider's ERC-8004 agent as feedback tagged
 * `successRate` — reputation from what the money did, with nobody's opinion
 * in it. Buyer ratings are a separate, opinionated signal.
 */
export function EscrowRecordPanel({ providerId, agentId }: { providerId: string; agentId: string | null }) {
  const { data, error } = usePoll<ProviderEscrowRecord>(useCallback(() => api.providerEscrow(providerId), [providerId]), 20_000);

  return (
    <Panel className="p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-medium text-fg">Escrow record</h2>
        <span className="text-[11.5px] text-fg-4">XorvReputation on Arc → ERC-8004</span>
      </div>
      <p className="measure mt-1.5 text-[12.5px] leading-relaxed text-fg-3">
        Every escrowed job ends one of two ways on chain: released to the provider, or refunded to the buyer. Refunds
        the provider caused count against it; the rest is written to its ERC-8004 agent as{" "}
        <span className="mono text-fg-2">successRate</span> feedback.
      </p>

      {!data ? (
        <p className="mt-3 text-[12px] text-fg-4">{error ? "Can't reach the broker right now." : "Reading XorvReputation…"}</p>
      ) : !data.configured ? (
        <p className="mt-3 text-[12px] text-fg-4">
          This broker has no XorvReputation configured, so settlements aren&rsquo;t scored on chain here.
        </p>
      ) : data.error !== null ? (
        <p className="mt-3 break-words text-[12px] text-warn">Couldn&rsquo;t read XorvReputation: {data.error}</p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Figure value={String(data.completed)} label="released" />
            <Figure value={String(data.failed)} label="refunded at fault" />
            <Figure value={formatUsdc(data.earnedUnits)} label="earned via escrow" />
            <Figure value={data.completed + data.failed > 0 ? formatScoreBps(data.scoreBps) : "—"} label="smoothed score" />
          </div>
          <div className="mt-4 border-t border-[var(--line)] pt-1">
            <Row label="written to">
              {data.agentId ? (
                <Ext href={data.agentUrl || explorerAgent(NETWORK, data.agentId)}>ERC-8004 agent #{data.agentId} ↗</Ext>
              ) : (
                <span className="text-fg-3">
                  not bound — run <span className="mono text-fg-2">xorv identity bind</span>
                  {agentId ? ` (agent #${agentId} isn't bound to XorvReputation yet)` : ""}
                </span>
              )}
            </Row>
            <Row label="contract">
              <Ext href={data.reputationUrl || explorerAddress(NETWORK, data.reputation)}>XorvReputation {shortHex(data.reputation)} ↗</Ext>
            </Row>
          </div>
        </>
      )}
    </Panel>
  );
}

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <p className="tnum text-[19px] font-semibold tracking-[-0.02em] text-fg">{value}</p>
      <p className="text-[11.5px] text-fg-4">{label}</p>
    </div>
  );
}
