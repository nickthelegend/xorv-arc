"use client";

import { useEffect, useState } from "react";
import { createPublicClient, formatEther, http } from "viem";
import { explorerAddress, formatUsdc, shortHex, xorvCcipSenderAbi, type CcipQuoteTerms } from "@xorv/protocol/web";
import { api, type Quote } from "@/lib/api";
import { postJobArgs, postJobCast } from "@/lib/arc";
import { errorMessage } from "@/lib/errors";
import { NETWORK, remoteByChainId, remoteViemChain } from "@/lib/network";
import { cn } from "@/lib/utils";

/**
 * "Pay from Base/Ethereum (CCIP)" — for buyer agents that hold their USDC on
 * another chain.
 *
 * Asks the broker for a quote with `payVia: "ccip"` and shows exactly what the
 * agent does on its own chain: approve `price + maxFee` USDC to
 * XorvCcipSender, then `postJob(jobId, provider, price, deadline, maxFee,
 * minFinalityThreshold)` with the CCIP fee as value. CCTP moves the dollars to
 * XorvCcipReceiver on Arc, Chainlink CCIP carries the job, and the receiver
 * funds XorvEscrow; the job runs once the escrow shows it funded. This panel
 * sends nothing: it is the spec an agent follows (the MCP server and CLI do
 * the same from a terminal).
 */
export function CcipPayPanel({
  prompt,
  adapter,
  maxPriceUsdMicros,
  enabled,
}: {
  prompt: string;
  adapter: string | null;
  maxPriceUsdMicros: number | null;
  /** The broker has a CCIP receiver configured. */
  enabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function request(): Promise<void> {
    if (!prompt.trim() || !maxPriceUsdMicros) return;
    setBusy(true);
    setError(null);
    try {
      const q = await api.quote({ prompt, adapter, maxPriceUsdMicros, payVia: "ccip" });
      if (!q.ccip) throw new Error("The broker answered without CCIP terms (no escrow or no receiver configured).");
      setQuote(q);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 text-left">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-1 text-[12px] text-fg-3 transition-colors hover:text-fg-2"
      >
        <span>
          Pay from Base / Ethereum over Chainlink CCIP <span className="text-fg-4">· for agents on Base/Ethereum</span>
        </span>
        <span aria-hidden className={cn("transition-transform duration-200", open && "rotate-180")}>
          ⌄
        </span>
      </button>
      {open ? (
        <div className="mt-2 rounded-xl border border-[var(--line)] bg-white/[0.015] px-3.5 py-3 text-[11.5px] leading-relaxed text-fg-3">
          <p>
            A buyer agent whose USDC lives on another chain funds this exact job from there: CCTP moves the dollars to Arc,
            Chainlink CCIP carries the job to <span className="mono text-fg-2">XorvCcipReceiver</span>, which funds the escrow.
            A refund goes back to the requester. Asking for terms reserves the provider until the escrow deadline; nothing is
            charged.
          </p>
          {!enabled ? (
            <p className="mt-2 text-fg-4">This broker has no CCIP receiver configured, so it takes no cross-chain jobs.</p>
          ) : !quote ? (
            <button
              type="button"
              onClick={() => void request()}
              disabled={busy || !prompt.trim() || !maxPriceUsdMicros}
              className="mt-2.5 rounded-md border border-[var(--line-2)] px-2.5 py-1.5 text-[12px] text-fg-2 transition-colors hover:border-[var(--line-3)] hover:text-fg disabled:opacity-40"
            >
              {busy ? "Asking the broker…" : prompt.trim() ? "Get CCIP terms for this prompt" : "Write a prompt first"}
            </button>
          ) : (
            <CcipTerms quote={quote} terms={quote.ccip!} />
          )}
          {error ? <p className="mt-2 break-words text-fail">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function CcipTerms({ quote, terms }: { quote: Quote; terms: CcipQuoteTerms }) {
  const [chainId, setChainId] = useState(terms.sources[0]?.chainId ?? 0);
  const source = terms.sources.find((s) => s.chainId === chainId) ?? terms.sources[0];
  const remote = source ? remoteByChainId(source.chainId) : undefined;
  const sender = source ? terms.senders[String(source.chainId)] ?? null : null;
  const args = postJobArgs(terms);
  const fee = useCcipFee(sender, remote?.chainId ?? null, terms);

  return (
    <div className="mt-3 space-y-2.5">
      <div className="flex flex-wrap gap-1.5">
        {terms.sources.map((s) => (
          <button
            key={s.chainId}
            type="button"
            onClick={() => setChainId(s.chainId)}
            className={cn(
              "rounded-md border px-2 py-1 text-[11.5px] transition-colors",
              s.chainId === chainId ? "border-[var(--line-3)] bg-white/[0.05] text-fg" : "border-[var(--line)] text-fg-3 hover:text-fg-2",
            )}
          >
            {s.name}
          </button>
        ))}
      </div>
      <dl className="mono grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-fg-4">provider</dt>
        <dd className="truncate text-fg-2">
          {quote.provider.label} · {shortHex(terms.provider)}
        </dd>
        <dt className="text-fg-4">price</dt>
        <dd className="text-fg-2">
          {formatUsdc(terms.price)} ({terms.price} units)
        </dd>
        <dt className="text-fg-4">deadline</dt>
        <dd className="text-fg-2">
          {terms.deadline} · {new Date(terms.deadline * 1000).toLocaleTimeString()}
        </dd>
        <dt className="text-fg-4">receiver (Arc)</dt>
        <dd className="truncate">
          <a href={explorerAddress(NETWORK, terms.receiver)} target="_blank" rel="noreferrer" className="text-fg-2 underline-offset-2 hover:underline">
            {terms.receiver}
          </a>
        </dd>
        <dt className="text-fg-4">Arc selector</dt>
        <dd className="text-fg-2">{terms.arcChainSelector}</dd>
        {source ? (
          <>
            <dt className="text-fg-4">lane</dt>
            <dd className="text-fg-2">
              {source.name} (selector {source.selector}, CCTP domain {source.cctpDomain}) → Arc
            </dd>
            <dt className="text-fg-4">USDC there</dt>
            <dd className="truncate text-fg-2">{source.usdc}</dd>
            <dt className="text-fg-4">sender</dt>
            <dd className="truncate text-fg-2">
              {sender ? (
                remote ? (
                  <a href={`${remote.explorerUrl}/address/${sender}`} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                    XorvCcipSender {sender}
                  </a>
                ) : (
                  `XorvCcipSender ${sender}`
                )
              ) : (
                <span className="text-fg-4">this broker knows no XorvCcipSender on {source.name}</span>
              )}
            </dd>
            {sender ? (
              <>
                <dt className="text-fg-4">CCIP fee</dt>
                <dd className="text-fg-2">{fee === undefined ? "reading quotePostJob…" : fee === null ? "couldn't read" : `${formatEther(fee)} ETH (quotePostJob, now)`}</dd>
              </>
            ) : null}
          </>
        ) : null}
      </dl>
      <div>
        <p className="mb-1 text-fg-4">1 · approve on {source?.name ?? "the source chain"}</p>
        <pre className="mono overflow-x-auto rounded-lg border border-[var(--line)] bg-black/60 p-2.5 text-[10.5px] leading-relaxed text-fg-2">
          {`USDC.approve(${sender ?? "<XorvCcipSender>"}, ${args.approve})  // price + maxFee`}
        </pre>
      </div>
      <div>
        <p className="mb-1 text-fg-4">2 · post the job (payable: the CCIP fee)</p>
        <pre className="mono overflow-x-auto rounded-lg border border-[var(--line)] bg-black/60 p-2.5 text-[10.5px] leading-relaxed text-fg-2">
          {`XorvCcipSender.postJob(\n  ${args.jobId},  // jobId (escrow)\n  ${args.provider},  // provider\n  ${args.price},  // price, USDC units\n  ${args.deadline},  // deadline, unix s\n  ${args.maxFee},  // maxFee (CCTP standard transfer)\n  ${args.minFinalityThreshold}  // minFinalityThreshold\n)`}
        </pre>
      </div>
      {sender && remote ? (
        <pre className="mono overflow-x-auto rounded-lg border border-[var(--line)] bg-black/60 p-2.5 text-[10.5px] leading-relaxed text-fg-3">
          {postJobCast(terms, sender, remote.rpcUrl)}
        </pre>
      ) : null}
      <p className="text-fg-4">
        Then watch <span className="mono">/jobs/…</span> for quote <span className="mono">{quote.quoteId}</span>: the job runs once
        XorvEscrow shows it funded, and its page links the CCIP message.
      </p>
    </div>
  );
}

/** `XorvCcipSender.quotePostJob` on the source chain, read live; undefined while reading, null on failure. */
function useCcipFee(sender: string | null, chainId: number | null, terms: CcipQuoteTerms): bigint | null | undefined {
  const [fee, setFee] = useState<{ key: string; value: bigint | null } | null>(null);
  const key = `${sender}:${chainId}:${terms.jobId}`;
  useEffect(() => {
    if (!sender || chainId === null) return;
    const remote = remoteByChainId(chainId);
    if (!remote) return;
    let alive = true;
    const client = createPublicClient({ chain: remoteViemChain(remote), transport: http(remote.rpcUrl) });
    client
      .readContract({
        address: sender as `0x${string}`,
        abi: xorvCcipSenderAbi,
        functionName: "quotePostJob",
        args: [terms.jobId as `0x${string}`, terms.provider as `0x${string}`, BigInt(terms.price), terms.deadline],
      })
      .then(
        (value) => alive && setFee({ key, value: value as bigint }),
        () => alive && setFee({ key, value: null }),
      );
    return () => {
      alive = false;
    };
  }, [key, sender, chainId, terms]);
  if (!sender || chainId === null) return null;
  return fee?.key === key ? fee.value : undefined;
}
