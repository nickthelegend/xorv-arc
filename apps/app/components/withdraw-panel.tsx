"use client";

import { useEffect, useState } from "react";
import { createPublicClient, http } from "viem";
import {
  ERC20_APPROVE_ABI,
  MESSAGE_TRANSMITTER_V2_ABI,
  TOKEN_MESSENGER_V2_ABI,
  explorerTx,
  formatUsdc,
  irisMessagesUrl,
  parseIrisMessages,
  planCctpWithdraw,
  publicClientFor,
  sameAddress,
  shortHex,
  type RemoteChain,
} from "@xorv/protocol/web";
import { useOptionalWallet } from "@/components/wallet-provider";
import { parseUsdcAmount, unitsToInput } from "@/lib/arc";
import {
  defaultWithdrawUnits,
  irisState,
  pendingWithdrawalKey,
  readPendingWithdrawal,
  type IrisState,
  type PendingWithdrawal,
} from "@/lib/cctp-withdraw";
import { errorMessage, isUserRejection } from "@/lib/errors";
import { APP_CHAIN, CHAIN_CONFIG, NETWORK, PUBLIC_RPC_URL, REMOTE_CHAINS, remoteByChainId, remoteViemChain } from "@/lib/network";
import { Ext, Panel, Row } from "@/components/ui";
import { cn } from "@/lib/utils";

type Stage = "idle" | "approving" | "burning" | "attesting" | "minting" | "done";

/**
 * "Withdraw to another chain": a provider takes its Arc earnings home over
 * Circle CCTP V2.
 *
 *  1. On Arc, from the payout wallet: approve TokenMessengerV2, then
 *     `depositForBurn` (the plan comes from protocol's `planCctpWithdraw`).
 *  2. Circle's Iris attests the burn — seconds for a fast transfer.
 *  3. On the destination, `MessageTransmitterV2.receiveMessage` mints native
 *     USDC to the recipient. Anyone may submit it; this panel offers to do it
 *     from the same wallet after switching it to that chain (it needs a little
 *     ETH there for gas), clearly labelled as best effort.
 *
 * Shown in full only to the provider's own payout wallet; everyone else sees
 * what it does and who can use it.
 */
export function WithdrawPanel({ payout }: { payout: string }) {
  const wallet = useOptionalWallet();
  const mine = Boolean(wallet?.address && sameAddress(wallet.address, payout));

  return (
    <Panel className="p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-medium text-fg">Withdraw to another chain</h2>
        <span className="text-[11.5px] text-fg-4">Circle CCTP V2 · burn on Arc, mint on {REMOTE_CHAINS.map((r) => r.name).join(" / ")}</span>
      </div>
      <p className="measure mt-1.5 text-[12.5px] leading-relaxed text-fg-3">
        Earnings arrive as USDC on Arc. CCTP burns them here and Circle mints the same amount of native USDC on the
        destination: no bridge pool, no wrapped token.
      </p>
      {mine && wallet ? (
        <WithdrawForm key={wallet.address} address={wallet.address!} />
      ) : (
        <p className="mt-3 text-[12px] leading-relaxed text-fg-4">
          {wallet?.address ? (
            <>
              The connected wallet <span className="mono">{shortHex(wallet.address)}</span> isn&rsquo;t this provider&rsquo;s payout
              wallet <span className="mono">{shortHex(payout)}</span>; only the payout wallet can withdraw its earnings.
            </>
          ) : wallet?.available ? (
            <>
              <button type="button" onClick={wallet.login} className="text-fg-2 underline underline-offset-2 hover:text-fg">
                {wallet.mode === "privy" ? "Log in" : "Connect"}
              </button>{" "}
              as the payout wallet <span className="mono">{shortHex(payout)}</span> to withdraw.
            </>
          ) : (
            <>
              Connect the payout wallet <span className="mono">{shortHex(payout)}</span> to withdraw.
            </>
          )}{" "}
          The CLI does the same with <span className="mono text-fg-3">xorv withdraw</span>.
        </p>
      )}
    </Panel>
  );
}

/** When a burn landed, for the pending record. Only ever called from the burn handler. */
function startedAt(): number {
  return Date.now();
}

function loadPending(address: string): PendingWithdrawal | null {
  try {
    return readPendingWithdrawal(window.localStorage.getItem(pendingWithdrawalKey(address)));
  } catch {
    return null;
  }
}

function savePending(address: string, value: PendingWithdrawal | null): void {
  try {
    if (value) window.localStorage.setItem(pendingWithdrawalKey(address), JSON.stringify(value));
    else window.localStorage.removeItem(pendingWithdrawalKey(address));
  } catch {
    /* storage blocked: the withdrawal still works, it just won't survive a reload */
  }
}

function WithdrawForm({ address }: { address: `0x${string}` }) {
  const wallet = useOptionalWallet()!;
  const balanceUnits = wallet.balances?.usdcUnits ?? null;
  const [destId, setDestId] = useState<number>(REMOTE_CHAINS[0]?.chainId ?? 0);
  const [amount, setAmount] = useState<string | null>(null);
  const [recipient, setRecipient] = useState<string>(address);
  const [fast, setFast] = useState(true);
  // Pick up a withdrawal this browser started before a reload. This form only
  // renders in the browser, once the payout wallet is connected, so reading
  // storage in the initializer can't disagree with a server render.
  const [pending, setPending] = useState<PendingWithdrawal | null>(() => loadPending(address));
  const [stage, setStage] = useState<Stage>(() => (pending ? (pending.mintTx ? "done" : "attesting") : "idle"));
  const [error, setError] = useState<string | null>(null);
  const [iris, setIris] = useState<IrisState>({ state: "unseen" });

  // Poll Iris while a burn waits for its attestation.
  useEffect(() => {
    if (!pending || pending.mintTx) return;
    let alive = true;
    const url = irisMessagesUrl(NETWORK, CHAIN_CONFIG.circle.cctpDomain, pending.burnTx);
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        // 404 means Iris hasn't indexed the burn yet.
        const next = res.status === 404 ? ({ state: "unseen" } as IrisState) : irisState(parseIrisMessages(await res.json()));
        if (alive) setIris(next);
        if (next.state === "complete") clearInterval(timer);
      } catch {
        /* transient; keep polling */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 4_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [pending]);

  const dest = remoteByChainId(destId) ?? REMOTE_CHAINS[0]!;
  const amountText = amount ?? (balanceUnits ? unitsToInput(defaultWithdrawUnits(balanceUnits)) : "");
  const units = parseUsdcAmount(amountText);
  let plan: ReturnType<typeof planCctpWithdraw> | null = null;
  let planError: string | null = null;
  if (units) {
    try {
      plan = planCctpWithdraw(NETWORK, { destination: dest, amount: units, recipient: recipient as `0x${string}`, fast });
    } catch (err) {
      planError = errorMessage(err);
    }
  }
  const tooMuch = Boolean(units && balanceUnits && units > BigInt(balanceUnits));

  async function burn(): Promise<void> {
    if (!plan) return;
    setError(null);
    try {
      const client = await wallet.getWalletClient(APP_CHAIN);
      const pub = publicClientFor(NETWORK, { rpcUrl: PUBLIC_RPC_URL });
      const allowance = await pub.readContract({
        address: plan.usdc,
        abi: ERC20_APPROVE_ABI,
        functionName: "allowance",
        args: [address, plan.tokenMessenger],
      });
      if (allowance < plan.amount) {
        setStage("approving");
        const approveTx = await client.writeContract({
          address: plan.usdc,
          abi: ERC20_APPROVE_ABI,
          functionName: "approve",
          args: [plan.tokenMessenger, plan.amount],
          chain: APP_CHAIN,
          account: client.account,
        });
        const r = await pub.waitForTransactionReceipt({ hash: approveTx });
        if (r.status !== "success") throw new Error(`The approval reverted (${shortHex(approveTx)}).`);
      }
      setStage("burning");
      const burnTx = await client.writeContract({
        address: plan.tokenMessenger,
        abi: TOKEN_MESSENGER_V2_ABI,
        functionName: "depositForBurn",
        args: plan.args,
        chain: APP_CHAIN,
        account: client.account,
      });
      const receipt = await pub.waitForTransactionReceipt({ hash: burnTx });
      if (receipt.status !== "success") throw new Error(`depositForBurn reverted (${shortHex(burnTx)}).`);
      const next: PendingWithdrawal = {
        burnTx,
        chainId: dest.chainId,
        amountUnits: plan.amount.toString(),
        recipient: plan.recipient,
        startedAt: startedAt(),
      };
      savePending(address, next);
      setIris({ state: "unseen" });
      setPending(next);
      setStage("attesting");
      void wallet.refreshBalances();
    } catch (err) {
      setError(isUserRejection(err) ? "Cancelled in the wallet. Nothing was burned." : errorMessage(err));
      setStage("idle");
    }
  }

  async function mint(target: RemoteChain): Promise<void> {
    if (!pending || iris.state !== "complete") return;
    setError(null);
    setStage("minting");
    try {
      const chain = remoteViemChain(target);
      const client = await wallet.getWalletClient(chain);
      const tx = await client.writeContract({
        address: target.messageTransmitterV2,
        abi: MESSAGE_TRANSMITTER_V2_ABI,
        functionName: "receiveMessage",
        args: [iris.message, iris.attestation],
        chain,
        account: client.account,
      });
      const pub = createPublicClient({ chain, transport: http(target.rpcUrl) });
      const r = await pub.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
      if (r.status !== "success") throw new Error(`receiveMessage reverted (${shortHex(tx)}) — it may already have been minted.`);
      const done = { ...pending, mintTx: tx };
      savePending(address, done);
      setPending(done);
      setStage("done");
    } catch (err) {
      setError(isUserRejection(err) ? "Cancelled in the wallet." : errorMessage(err));
      setStage("attesting");
    } finally {
      // Back on Arc for everything else (payments, ratings), best effort.
      void wallet.getWalletClient(APP_CHAIN).catch(() => undefined);
    }
  }

  if (pending) {
    const target = remoteByChainId(pending.chainId);
    return (
      <div className="mt-4 border-t border-[var(--line)] pt-1">
        <Row label="burned on Arc">
          <Ext href={explorerTx(NETWORK, pending.burnTx)}>
            {formatUsdc(pending.amountUnits)} · {shortHex(pending.burnTx)} ↗
          </Ext>
        </Row>
        <Row label="to">
          <span className="mono">
            {shortHex(pending.recipient)} on {target?.name ?? `chain ${pending.chainId}`}
          </span>
        </Row>
        <Row label="Circle attestation">
          <Ext href={irisMessagesUrl(NETWORK, CHAIN_CONFIG.circle.cctpDomain, pending.burnTx)}>
            <span className={iris.state === "complete" ? "text-live" : ""}>
              {iris.state === "complete" ? "complete" : iris.state === "pending" ? iris.status.replace(/_/g, " ") : "waiting for Iris…"}
            </span>{" "}
            ↗
          </Ext>
        </Row>
        {pending.mintTx && target ? (
          <Row label={`minted on ${target.name}`}>
            <Ext href={`${target.explorerUrl}/tx/${pending.mintTx}`}>{shortHex(pending.mintTx)} ↗</Ext>
          </Row>
        ) : null}

        {!pending.mintTx && target ? (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => void mint(target)}
              disabled={iris.state !== "complete" || stage === "minting"}
              className="w-full rounded-lg border border-[var(--line-2)] px-4 py-2 text-[13px] text-fg transition-colors hover:border-[var(--line-3)] hover:bg-white/[0.04] disabled:opacity-40"
            >
              {stage === "minting" ? `Minting on ${target.name}…` : iris.state === "complete" ? `Mint on ${target.name}` : "Waiting for the attestation…"}
            </button>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-fg-4">
              Best effort: switches this wallet to {target.name} and calls <span className="mono">receiveMessage</span>; it needs a
              little ETH there for gas. Anyone can submit the same message and attestation, so a relayer or another wallet can
              finish it too.
            </p>
          </div>
        ) : null}

        {error ? <p className="mt-2 break-words text-[12px] text-fail">{error}</p> : null}

        <button
          type="button"
          onClick={() => {
            savePending(address, null);
            setPending(null);
            setStage("idle");
            setAmount(null);
            setError(null);
          }}
          className="mt-3 text-[12px] text-fg-4 transition-colors hover:text-fg-2"
        >
          {pending.mintTx ? "Start another withdrawal" : "Forget this withdrawal (the burn stays claimable)"}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-3 border-t border-[var(--line)] pt-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
        <label className="block text-[11.5px] text-fg-4">
          destination
          <select
            value={destId}
            onChange={(e) => setDestId(Number(e.target.value))}
            className="mt-1 w-full rounded-lg border border-[var(--line)] bg-black px-2.5 py-2 text-[13px] text-fg outline-none focus:border-[var(--line-2)]"
          >
            {REMOTE_CHAINS.map((r) => (
              <option key={r.chainId} value={r.chainId}>
                {r.name} (CCTP domain {r.cctpDomain})
              </option>
            ))}
          </select>
        </label>
        <label className="block text-[11.5px] text-fg-4">
          amount, USDC {balanceUnits ? <span>· {formatUsdc(balanceUnits)} on Arc</span> : null}
          <input
            value={amountText}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            className="tnum mt-1 w-full rounded-lg border border-[var(--line)] bg-transparent px-2.5 py-2 text-[13px] text-fg outline-none focus:border-[var(--line-2)]"
          />
        </label>
      </div>
      <label className="block text-[11.5px] text-fg-4">
        recipient on {dest.name}
        <input
          value={recipient}
          onChange={(e) => setRecipient(e.target.value.trim())}
          spellCheck={false}
          className="mono mt-1 w-full rounded-lg border border-[var(--line)] bg-transparent px-2.5 py-2 text-[12.5px] text-fg outline-none focus:border-[var(--line-2)]"
        />
      </label>
      <label className="flex items-center gap-2 text-[12px] text-fg-3">
        <input type="checkbox" checked={fast} onChange={(e) => setFast(e.target.checked)} className="accent-white" />
        Fast transfer (attested in seconds; fee capped at {plan ? formatUsdc(plan.maxFee) : "1%"}). Off: standard, no fee, waits
        for finality.
      </label>

      {plan ? (
        <p className="mono text-[11px] leading-relaxed text-fg-4">
          depositForBurn({formatUsdc(plan.amount)}, domain {plan.args[1]}, {shortHex(plan.recipient)}, USDC, any caller, maxFee{" "}
          {formatUsdc(plan.maxFee)}, threshold {plan.minFinalityThreshold}) on TokenMessengerV2 {shortHex(plan.tokenMessenger)}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => void burn()}
        disabled={!plan || tooMuch || stage !== "idle"}
        className={cn(
          "w-full rounded-lg bg-white px-4 py-2.5 text-[13.5px] font-medium text-black transition-all hover:bg-white/90 active:scale-[0.985] disabled:opacity-40",
        )}
      >
        {stage === "approving"
          ? "Approve USDC for TokenMessengerV2…"
          : stage === "burning"
            ? "Burning on Arc…"
            : plan
              ? `Withdraw ${formatUsdc(plan.amount)} to ${dest.name}`
              : "Enter an amount"}
      </button>
      <p className="text-[11.5px] leading-relaxed text-fg-4">
        Two transactions on Arc from this wallet (approve, then burn), each paying a fraction of a cent in USDC gas — keep a
        few cents on Arc. Then Circle attests and the USDC is minted on {dest.name}.
      </p>
      {tooMuch ? <p className="text-[12px] text-fail">That&rsquo;s more than this wallet holds on Arc.</p> : null}
      {planError ? <p className="text-[12px] text-fail">{planError}</p> : null}
      {error ? <p className="break-words text-[12px] text-fail">{error}</p> : null}
    </div>
  );
}

