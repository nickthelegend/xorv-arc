"use client";

import type { ReactNode } from "react";
import { explorerAddress, explorerToken, shortHex, type ArcStackInfo, type NetworkInfo } from "@xorv/protocol/web";
import { NETWORK } from "@/lib/network";
import { Ext, Panel } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * The Arc stack this broker actually runs on, read from `/api/network` → `arc`.
 *
 * One row per piece, each with the contract it is, linked to the explorer, and
 * one line on what it does in Xorv. A piece this broker hasn't configured says
 * so rather than showing an address it doesn't use: the panel is a statement
 * about this deployment, not about Arc in general.
 */
export function ArcStackPanel({ info }: { info: NetworkInfo }) {
  const arc: ArcStackInfo | undefined = info.arc;
  if (!arc) {
    return (
      <Panel className="p-5">
        <h2 className="text-[13px] font-medium text-fg">Arc stack</h2>
        <p className="mt-1.5 text-[12.5px] text-fg-4">This broker doesn&rsquo;t report its Arc stack (an older build).</p>
      </Panel>
    );
  }
  const addr = (a: string, label?: string) => (
    <Ext href={explorerAddress(NETWORK, a)}>
      {label ? `${label} ` : ""}
      {shortHex(a)} ↗
    </Ext>
  );

  return (
    <Panel className="p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-medium text-fg">Arc stack</h2>
        <span className="text-[11.5px] text-fg-4">what this broker runs on · every address links to the explorer</span>
      </div>
      <p className="measure mt-1.5 text-[12.5px] leading-relaxed text-fg-3">
        Circle&rsquo;s stablecoin chain, end to end: the job is priced, paid, escrowed, settled, tagged and scored in USDC
        on Arc, and the dollars can come from, or go home to, other chains through Circle and Chainlink.
      </p>

      <ul className="mt-4 border-t border-[var(--line)]">
        <Item
          name="USDC gas"
          state="on"
          what="Arc meters gas in USDC, so buyers and providers hold one token. The facilitator and the escrow's attester pay it; a buyer never does."
        >
          <Ext href={explorerToken(NETWORK, info.usdc.address)}>USDC {shortHex(info.usdc.address)} ↗</Ext>
        </Item>

        <Item
          name="Deterministic finality"
          state="on"
          what={`${capitalize(arc.finality)}: a payment's receipt is final, so a job starts the moment its escrow funds, with no confirmations to wait out.`}
        >
          <span className="text-fg-3">see the live strip above</span>
        </Item>

        <Item
          name="Memo"
          state={arc.memo.enabled ? "on" : "off"}
          what="Every escrow fund, release and refund, and every direct x402 transfer, goes through Arc's Memo with the job's id as memoId, so any USDC movement can be traced to its job on chain."
        >
          <Ext href={arc.memo.url || explorerAddress(NETWORK, arc.memo.address)}>Memo {shortHex(arc.memo.address)} ↗</Ext>
        </Item>

        <Item
          name="ERC-8004 + XorvReputation"
          state={arc.reputation ? "on" : "off"}
          offText="not configured"
          what="Each provider is an ERC-8004 agent. XorvReputation counts escrow releases and at-fault refunds and writes them to the agent as feedback tagged successRate: reputation from settlement, not reviews."
        >
          <span className="flex flex-wrap justify-end gap-x-2">
            {arc.reputation ? <Ext href={arc.reputation.url}>XorvReputation {shortHex(arc.reputation.address)} ↗</Ext> : null}
            {addr(info.erc8004.identity, "identity")}
            {addr(info.erc8004.reputation, "registry")}
          </span>
        </Item>

        <Item
          name="Circle Gateway"
          state={arc.gateway.enabled ? "on" : "off"}
          offText="read-only"
          what={`Fund once on any chain, pay per job on Arc: a buyer short on Arc signs one burn intent (no gas, no chain switch) and the broker mints their Gateway USDC on Arc. Sources: ${arc.gateway.sources
            .map((s) => s.name)
            .join(", ")}.`}
        >
          <span className="flex flex-wrap justify-end gap-x-2">
            {addr(arc.gateway.wallet, "wallet")}
            {addr(arc.gateway.minter, "minter")}
          </span>
        </Item>

        <Item
          name="CCTP V2"
          state="on"
          what={`Providers take earnings home: burn USDC on Arc (domain ${arc.cctp.domain}), Circle attests, native USDC is minted on ${arc.cctp.destinations
            .map((d) => d.name)
            .join(" or ")}. No bridge liquidity, no wrapped token.`}
        >
          {addr(arc.cctp.tokenMessengerV2, "TokenMessengerV2")}
        </Item>

        <Item
          name="Chainlink CCIP"
          state={arc.ccip.receiver ? "on" : "off"}
          offText="no receiver"
          what={`Buyer agents on ${arc.ccip.sources.map((s) => s.name).join(" or ") || "other chains"} post a job with XorvCcipSender.postJob: CCTP moves the USDC, CCIP carries the job, and XorvCcipReceiver funds the escrow here. Refunds go back to the requester.`}
        >
          <span className="flex flex-wrap justify-end gap-x-2">
            {arc.ccip.receiver ? <Ext href={arc.ccip.receiver.url}>receiver {shortHex(arc.ccip.receiver.address)} ↗</Ext> : null}
            {addr(arc.ccip.router, "router")}
          </span>
          <span className="mono mt-0.5 block text-[10.5px] text-fg-4">selector {arc.ccip.chainSelector}</span>
        </Item>

        <Item
          name="Refund keeper"
          state={arc.keeper.enabled ? "on" : "off"}
          what={
            info.escrow
              ? `Refunds every escrowed job still held past its deadline (${Math.round(info.escrow.deadlineSeconds / 60)} min after the quote). Anyone may call refund; this broker does it so nobody has to.`
              : "Refunds escrowed jobs past their deadline. This broker pays providers directly, so there is nothing to refund."
          }
        >
          {arc.keeper.address ? addr(arc.keeper.address) : <span className="text-fg-4">—</span>}
        </Item>
      </ul>
    </Panel>
  );
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function Item({
  name,
  state,
  offText = "off",
  what,
  children,
}: {
  name: string;
  state: "on" | "off";
  offText?: string;
  what: string;
  children: ReactNode;
}) {
  return (
    <li className="grid gap-x-6 gap-y-1 border-b border-[var(--line)] py-3 last:border-b-0 sm:grid-cols-[1fr_auto]">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-[12.5px] text-fg-2">
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", state === "on" ? "bg-live" : "bg-fg-4")} aria-hidden />
          {name}
          {state === "off" ? <span className="text-[11px] text-fg-4">· {offText}</span> : null}
        </p>
        <p className="mt-0.5 pl-3.5 text-[11.5px] leading-relaxed text-fg-4">{what}</p>
      </div>
      <div className={cn("mono pl-3.5 text-[11.5px] text-fg-3 sm:pl-0 sm:text-right", state === "off" && "opacity-60")}>{children}</div>
    </li>
  );
}
