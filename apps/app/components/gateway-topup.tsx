"use client";

import { useCallback, useEffect, useState } from "react";
import { createPublicClient, http, type Address } from "viem";
import { ERC20_APPROVE_ABI, GATEWAY_WALLET_ABI, explorerTx, formatUsdc, shortHex, type RemoteChain } from "@xorv/protocol/web";
import { useWallet } from "@/components/wallet-provider";
import { api } from "@/lib/api";
import {
  checkGatewayIntent,
  fundingSources,
  gatewayTypedDataForSigning,
  parseUsdcAmount,
  suggestedTopUp,
  unitsToInput,
  type GatewayInfo,
  type GatewayMintResult,
} from "@/lib/arc";
import { errorMessage, isUserRejection } from "@/lib/errors";
import { APP_CHAIN, CHAIN_CONFIG, NETWORK, REMOTE_CHAINS, remoteByChainId, remoteViemChain } from "@/lib/network";
import { cn } from "@/lib/utils";

type Busy = "loading" | "intent" | "signing" | "minting" | null;

/**
 * "Top up from Circle Gateway": fund once on any chain, pay per job on Arc.
 *
 * Shown in the quote card when the buyer's Arc wallet holds less USDC than the
 * job costs. Their unified Gateway balance is read per chain
 * (`GET /api/gateway?depositor=`); they pick a source and an amount, the
 * broker builds a burn intent (`POST /api/gateway/intent`), the wallet signs
 * it — EIP-712 with no chainId in the domain, so no chain switch and no gas —
 * and the broker posts it to Circle and calls `GatewayMinter.gatewayMint` on
 * Arc (`POST /api/gateway/mint`). The intent names the buyer as recipient, so
 * the broker can't send the dollars anywhere else. Then the x402 payment goes
 * ahead as usual.
 */
export function GatewayTopUp({ shortUnits, onFunded }: { shortUnits: bigint; onFunded: (mint: GatewayMintResult) => void }) {
  const wallet = useWallet();
  const address = wallet.address;
  const [info, setInfo] = useState<GatewayInfo | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<number | null>(null);
  const [amount, setAmount] = useState(() => unitsToInput(suggestedTopUp(shortUnits)));
  const [fee, setFee] = useState<string | null>(null);
  const [minted, setMinted] = useState<GatewayMintResult | null>(null);
  const [showDeposit, setShowDeposit] = useState(false);

  const load = useCallback(async () => {
    if (!address) return;
    setBusy("loading");
    setError(null);
    try {
      const next = await api.gateway(address);
      setInfo(next);
      const best = fundingSources(next)[0];
      setSource((prev) => prev ?? best?.domain ?? null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }, [address]);

  useEffect(() => {
    // Deferred a tick so the effect itself sets no state (the fetch does, when it answers).
    const first = setTimeout(() => void load(), 0);
    return () => clearTimeout(first);
  }, [load]);

  const sources = info ? fundingSources(info) : [];
  const selected = sources.find((s) => s.domain === source) ?? null;
  const units = parseUsdcAmount(amount);
  const tooMuch = Boolean(selected && units && units > BigInt(selected.balanceUnits));

  async function topUp(): Promise<void> {
    if (!address || !selected || !units) return;
    setError(null);
    try {
      setBusy("intent");
      const intent = await api.gatewayIntent({
        depositor: address,
        recipient: address,
        sourceDomain: selected.domain,
        amountUnits: units.toString(),
      });
      checkGatewayIntent(intent.typedData, {
        depositor: address,
        recipient: address,
        amountUnits: units,
        sourceDomain: selected.domain,
        arcDomain: CHAIN_CONFIG.circle.cctpDomain,
      });
      setFee(intent.maxFee);
      setBusy("signing");
      const signer = await wallet.getSigner();
      const signature = await signer.signTypedData(gatewayTypedDataForSigning(intent.typedData) as never);
      setBusy("minting");
      const mint = await api.gatewayMint({ burnIntent: intent.typedData.message, signature });
      setMinted(mint);
      await wallet.refreshBalances();
      onFunded(mint);
    } catch (err) {
      setError(isUserRejection(err) ? "Cancelled in the wallet. Nothing moved." : errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-[var(--line-2)] bg-white/[0.015] p-4 text-left">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[13px] font-medium text-fg">Top up from Circle Gateway</p>
        <span className="tnum text-[11.5px] text-fg-4">short {formatUsdc(shortUnits)} on Arc</span>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-fg-3">
        Fund once on any chain, pay per job on Arc. Sign one burn intent — no gas, no chain switch — and Circle mints that
        much of your Gateway balance to this wallet on Arc in about a second.
      </p>

      {minted ? (
        <p className="mt-3 text-[12px] leading-relaxed text-live">
          Minted {minted.amount} in USDC to {shortHex(minted.recipient)} on Arc ·{" "}
          <a href={minted.explorerUrl ?? explorerTx(NETWORK, minted.mintTxHash)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
            gatewayMint {shortHex(minted.mintTxHash)} ↗
          </a>
          <span className="text-fg-3"> — now pay below.</span>
        </p>
      ) : !info ? (
        <p className="mt-3 text-[12px] text-fg-4">{busy === "loading" ? "Reading your Gateway balance…" : error ?? "—"}</p>
      ) : !info.available && !info.wallet ? (
        <p className="mt-3 text-[12px] text-fg-4">{info.error ?? "Circle Gateway is off on this broker."}</p>
      ) : (
        <>
          <ul className="mt-3 space-y-1">
            {info.balances.length === 0 ? (
              <li className="text-[12px] text-fg-4">No Gateway balance on any chain yet.</li>
            ) : (
              info.balances.map((b) => {
                const usable = BigInt(b.balanceUnits) > 0n;
                return (
                  <li key={b.domain}>
                    <label
                      className={cn(
                        "flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-1.5 text-[12px] transition-colors",
                        source === b.domain ? "border-[var(--line-3)] bg-white/[0.04] text-fg" : "border-[var(--line)] text-fg-3",
                        !usable && "cursor-not-allowed opacity-50",
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="gateway-source"
                          disabled={!usable}
                          checked={source === b.domain}
                          onChange={() => setSource(b.domain)}
                          className="accent-white"
                        />
                        {b.name}
                        <span className="mono text-[10.5px] text-fg-4">domain {b.domain}</span>
                      </span>
                      <span className="tnum">{b.balance}</span>
                    </label>
                  </li>
                );
              })
            )}
          </ul>

          {sources.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 rounded-lg border border-[var(--line)] px-2.5 py-1.5 text-[12px] text-fg-3 focus-within:border-[var(--line-2)]">
                <span className="text-fg-4">amount</span>
                <span aria-hidden>$</span>
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                  aria-label="Top-up amount in USDC"
                  className="tnum w-[64px] bg-transparent text-fg outline-none"
                />
              </label>
              <button
                type="button"
                onClick={() => void topUp()}
                disabled={busy !== null || !selected || !units || tooMuch || !info.available}
                className="ml-auto rounded-lg bg-white px-3.5 py-1.5 text-[12.5px] font-medium text-black transition-all hover:bg-white/90 active:scale-[0.985] disabled:opacity-40"
              >
                {busy === "intent"
                  ? "Building the intent…"
                  : busy === "signing"
                    ? "Sign the burn intent…"
                    : busy === "minting"
                      ? "Circle attests, minting on Arc…"
                      : `Sign & mint ${units ? formatUsdc(units) : ""} on Arc`}
              </button>
            </div>
          ) : null}
          {tooMuch ? <p className="mt-1.5 text-[11.5px] text-fail">More than your Gateway balance on {selected?.name}.</p> : null}
          {!info.available ? (
            <p className="mt-1.5 text-[11.5px] text-fg-4">This broker can read Gateway balances but has no key to pay the mint&rsquo;s gas.</p>
          ) : null}
          <p className="mt-2 text-[11px] leading-relaxed text-fg-4">
            {fee ? `Circle's fee is at most ${fee}, taken from your Gateway balance. ` : "Circle charges a small fee from your Gateway balance (shown before you sign). "}
            The broker pays the gas for the mint on Arc.
          </p>
        </>
      )}

      {error && info ? <p className="mt-2 break-words text-[12px] text-fail">{error}</p> : null}

      {!minted ? (
        <div className="mt-3 border-t border-[var(--line)] pt-2.5">
          <button
            type="button"
            onClick={() => setShowDeposit((v) => !v)}
            className="text-[11.5px] text-fg-3 underline-offset-4 transition-colors hover:text-fg hover:underline"
          >
            {showDeposit ? "Hide" : "No Gateway balance? Deposit to Gateway"}
          </button>
          {showDeposit && info?.wallet ? <GatewayDeposit gatewayWallet={info.wallet as Address} onDeposited={() => void load()} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Deposit into Circle's GatewayWallet on a source chain: approve USDC, then
 * `GatewayWallet.deposit(usdc, amount)`. That is a transaction on *that*
 * chain, so the wallet switches to it and pays its gas (ETH). The balance
 * shows up in Gateway once the source chain finalizes the deposit — minutes
 * on Base, longer on Ethereum.
 */
function GatewayDeposit({ gatewayWallet, onDeposited }: { gatewayWallet: Address; onDeposited: () => void }) {
  const wallet = useWallet();
  const [chainId, setChainId] = useState(REMOTE_CHAINS[0]?.chainId ?? 0);
  const [amount, setAmount] = useState("1");
  const [busy, setBusy] = useState<"approving" | "depositing" | null>(null);
  const [tx, setTx] = useState<{ chain: RemoteChain; hash: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const remote = remoteByChainId(chainId) ?? REMOTE_CHAINS[0]!;
  const units = parseUsdcAmount(amount);

  async function deposit(): Promise<void> {
    if (!units || !wallet.address) return;
    setError(null);
    try {
      const chain = remoteViemChain(remote);
      const client = await wallet.getWalletClient(chain);
      const pub = createPublicClient({ chain, transport: http(remote.rpcUrl) });
      const allowance = await pub.readContract({
        address: remote.usdc,
        abi: ERC20_APPROVE_ABI,
        functionName: "allowance",
        args: [wallet.address, gatewayWallet],
      });
      if (allowance < units) {
        setBusy("approving");
        const approve = await client.writeContract({
          address: remote.usdc,
          abi: ERC20_APPROVE_ABI,
          functionName: "approve",
          args: [gatewayWallet, units],
          chain,
          account: client.account,
        });
        await pub.waitForTransactionReceipt({ hash: approve, timeout: 180_000 });
      }
      setBusy("depositing");
      const hash = await client.writeContract({
        address: gatewayWallet,
        abi: GATEWAY_WALLET_ABI,
        functionName: "deposit",
        args: [remote.usdc, units],
        chain,
        account: client.account,
      });
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (r.status !== "success") throw new Error(`deposit reverted (${shortHex(hash)})`);
      setTx({ chain: remote, hash });
      onDeposited();
    } catch (err) {
      setError(isUserRejection(err) ? "Cancelled in the wallet." : errorMessage(err));
    } finally {
      setBusy(null);
      // Back to Arc for the payment itself.
      void wallet.getWalletClient(APP_CHAIN).catch(() => undefined);
    }
  }

  return (
    <div className="mt-2 space-y-2 text-[11.5px] leading-relaxed text-fg-4">
      <p>
        Deposit once on a source chain: <span className="mono text-fg-3">approve</span> its USDC to GatewayWallet{" "}
        <span className="mono text-fg-3">{shortHex(gatewayWallet)}</span>, then <span className="mono text-fg-3">deposit(usdc, amount)</span>.
        This one switches your wallet to that chain and needs a little ETH there for gas; the balance appears here once that
        chain finalizes it.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={chainId}
          onChange={(e) => setChainId(Number(e.target.value))}
          className="rounded-lg border border-[var(--line)] bg-black px-2 py-1.5 text-[12px] text-fg outline-none"
        >
          {REMOTE_CHAINS.map((r) => (
            <option key={r.chainId} value={r.chainId}>
              {r.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 rounded-lg border border-[var(--line)] px-2 py-1.5 text-[12px] text-fg-3">
          $
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            aria-label="Deposit amount in USDC"
            className="tnum w-[52px] bg-transparent text-fg outline-none"
          />
        </label>
        <button
          type="button"
          onClick={() => void deposit()}
          disabled={!units || busy !== null}
          className="rounded-lg border border-[var(--line-2)] px-3 py-1.5 text-[12px] text-fg transition-colors hover:border-[var(--line-3)] disabled:opacity-40"
        >
          {busy === "approving" ? "Approving…" : busy === "depositing" ? "Depositing…" : `Deposit on ${remote.name} (switches chain)`}
        </button>
      </div>
      {tx ? (
        <p className="text-fg-3">
          Deposited ·{" "}
          <a href={`${tx.chain.explorerUrl}/tx/${tx.hash}`} target="_blank" rel="noreferrer" className="underline underline-offset-2">
            {shortHex(tx.hash)} ↗
          </a>{" "}
          — Gateway credits it after {tx.chain.name} finalizes it.
        </p>
      ) : null}
      {error ? <p className="break-words text-fail">{error}</p> : null}
    </div>
  );
}
