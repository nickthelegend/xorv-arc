/**
 * Xorv's x402 facilitator wiring (server side, Node only).
 *
 * Xorv runs its **own** facilitator in-process. On Arc the facilitator is the
 * account that submits the buyer's signed EIP-3009 authorization and pays the
 * gas for it, in USDC, so a job poster signs typed data and never sends a
 * transaction. There is no public x402 facilitator for Arc, and running our
 * own is also what lets it fund XorvEscrow (only the escrow's attester may). `x402Facilitator`
 * implements the same `FacilitatorClient` surface the HTTP client does, so the
 * resource server cannot tell the difference — which is the point:
 * self-hosted and hosted are a config flag, not two code paths.
 *
 * The buyer-side helpers (`usdcPaymentOption`, `buyerX402Client`) live in
 * `x402-client.ts` so the browser bundle never pulls facilitator code in.
 */

import { x402Facilitator } from "@x402/core/facilitator";
import { HTTPFacilitatorClient, type FacilitatorClient, type x402ResourceServer } from "@x402/core/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme as ExactEvmFacilitatorScheme } from "@x402/evm/exact/facilitator";
import { AsyncLocalStorage } from "node:async_hooks";
import { getAddress, type Account, type Address, type Hex, type PublicClient, type Transport, type WalletClient } from "viem";
import { EscrowFacilitatorScheme } from "./escrow.js";
import { networkConfig } from "./chains.js";
import { walletClientFor, withGasHeadroom, withSignerLock } from "./evm.js";
import { readEnv } from "./env.js";
import { jobMemo, wrapWithMemo, type MemoTag } from "./memo.js";
import { writeContractSync, type SyncWrite } from "./sync-send.js";

/** Where log lines go; the broker passes its own, tests pass a spy. */
export type X402Logger = (line: string) => void;

/**
 * How long settlement waits for the `transferWithAuthorization` receipt.
 *
 * Arc finalizes in under a second, so 30 s is dozens of blocks of slack — long
 * enough for an RPC hiccup, short enough that a stuck settlement fails the
 * request instead of holding it for the library's 3-minute default.
 */
export const SETTLEMENT_CONFIRMATION_TIMEOUT_MS = 30_000;

/**
 * One line that says why a payment was refused.
 *
 * A rejected payment is the hardest failure in this system to diagnose from
 * the outside — the caller sees a bare 402 and the reason lives only on the
 * server. Everything needed to act on it (reason, payer, asset, amount,
 * payee) goes in the one line.
 */
export function formatPaymentRejection(
  result: Pick<VerifyResponse, "invalidReason" | "invalidMessage" | "payer">,
  requirements: Pick<PaymentRequirements, "asset" | "amount" | "payTo" | "network">,
): string {
  return (
    `[x402] payment rejected: ${result.invalidReason ?? "unknown"}` +
    `${result.invalidMessage ? ` — ${result.invalidMessage}` : ""}` +
    ` (payer=${result.payer ?? "?"}, network=${requirements.network}, asset=${requirements.asset},` +
    ` amount=${requirements.amount}, payTo=${requirements.payTo})`
  );
}

/** One line that says why a settlement failed. */
export function formatSettlementFailure(
  result: Pick<SettleResponse, "errorReason" | "errorMessage" | "payer" | "transaction">,
): string {
  return (
    `[x402] settlement failed: ${result.errorReason ?? "unknown"}` +
    `${result.errorMessage ? ` — ${result.errorMessage}` : ""}` +
    ` (payer=${result.payer ?? "?"}${result.transaction ? `, tx=${result.transaction}` : ""})`
  );
}

/**
 * Log rejections on a resource server, at the point of decision.
 *
 * This matters most with a *hosted* facilitator: an `isValid: false` verify
 * result is delivered to `onAfterVerify` (with `ctx.result`), **not** to
 * `onVerifyFailure`, which only fires when the facilitator throws. A server
 * that only hooks `onVerifyFailure` never sees a single rejection. This hooks
 * all three paths.
 */
export function logPaymentRejections(
  server: Pick<x402ResourceServer, "onAfterVerify" | "onVerifyFailure" | "onSettleFailure">,
  log: X402Logger = console.error,
): void {
  server.onAfterVerify(async (ctx) => {
    if (!ctx.result.isValid) log(formatPaymentRejection(ctx.result, ctx.requirements));
  });
  server.onVerifyFailure(async (ctx) => {
    log(`[x402] verify errored: ${ctx.error.message} (payTo=${ctx.requirements.payTo}, amount=${ctx.requirements.amount})`);
  });
  server.onSettleFailure(async (ctx) => {
    log(`[x402] settle errored: ${ctx.error.message} (payTo=${ctx.requirements.payTo}, amount=${ctx.requirements.amount})`);
  });
}

/**
 * An in-process facilitator backed by our own EOA.
 *
 * The EOA needs a little USDC for gas (Arc's gas token) and holds none of the
 * buyers' money: payments go buyer → provider, or buyer → escrow.
 *
 * Every write goes through `withSignerLock` and carries an explicit gas limit
 * of estimate + headroom. The lock is shared per address with every other
 * writer in the process (the ledger writer, the rating relay), so a
 * facilitator that shares the operator's key cannot race it for a nonce.
 *
 * Every money movement is tagged with Arc's Memo extension (see `memo.ts`):
 * escrow writes carry their job id, and a direct `transferWithAuthorization`
 * carries the job id the broker set with `withSettlementMemo`.
 */
export function buildLocalFacilitator(opts: {
  network: string;
  account: Account;
  rpcUrl?: string;
  /** Tests pass a viem `custom()` transport; defaults to HTTP. */
  transport?: Transport;
  confirmationTimeoutMs?: number;
  log?: X402Logger;
  /**
   * XorvEscrow address. When set, the `escrow` scheme is served too, and the
   * account must be the escrow's attester (only the attester may fund a job).
   */
  escrow?: string | null;
  /** Called around each escrow write, so background RPC readers can back off. */
  onEscrowWrite?: (phase: "start" | "end") => void;
  /** Arc's Memo contract; defaults to the network's, `null` turns tagging off. */
  memo?: Address | null;
}): FacilitatorClient {
  const log = opts.log ?? console.error;
  const cfg = networkConfig(opts.network);
  const account = opts.account;
  const wallet = walletClientFor(cfg.caip2, account, { rpcUrl: opts.rpcUrl, transport: opts.transport });
  const memo = opts.memo === undefined ? memoContractFor(cfg.caip2) : opts.memo;

  const signer = toFacilitatorEvmSigner(
    {
      address: account.address,
      getCode: (args) => wallet.getCode(args),
      readContract: (args) => wallet.readContract({ ...args, args: args.args ?? [] } as never),
      verifyTypedData: (args) => wallet.verifyTypedData(args as never),
      writeContract: (args) =>
        withSignerLock(account.address, async () => {
          const tag = settlementMemo.getStore();
          if (memo && tag) {
            // The x402 transferWithAuthorization, routed through Arc's Memo with the job's id.
            const wrapped = wrapWithMemo(memo, { address: args.address, abi: args.abi as never, functionName: args.functionName, args: args.args ?? [], gas: 0n }, tag);
            const req = { address: wrapped.address, abi: wrapped.abi, functionName: wrapped.functionName, args: wrapped.args, account };
            const gas = withGasHeadroom(await wallet.estimateContractGas(req as never));
            return wallet.writeContract({ ...req, gas } as never);
          }
          const request = { ...args, args: args.args ?? [], account };
          const gas =
            args.gas ?? withGasHeadroom(await wallet.estimateContractGas(request as never));
          return wallet.writeContract({ ...request, gas } as never);
        }),
      sendTransaction: (args) =>
        withSignerLock(account.address, async () => {
          const gas = withGasHeadroom(await wallet.estimateGas({ account, to: args.to, data: args.data }));
          return wallet.sendTransaction({ account, to: args.to, data: args.data, gas } as never);
        }),
      waitForTransactionReceipt: (args) => wallet.waitForTransactionReceipt(args),
    },
    { confirmationTimeoutMs: opts.confirmationTimeoutMs ?? SETTLEMENT_CONFIRMATION_TIMEOUT_MS },
  );

  const facilitator = new x402Facilitator().register(
    cfg.caip2 as Network,
    new ExactEvmFacilitatorScheme(signer),
  );
  if (opts.escrow) {
    facilitator.register(
      cfg.caip2 as Network,
      new EscrowFacilitatorScheme(
        { public: wallet as unknown as PublicClient, wallet: escrowWriter(wallet, account, memo) },
        { escrow: getAddress(opts.escrow), onWrite: opts.onEscrowWrite },
      ),
    );
  }

  // Adapt x402Facilitator to the FacilitatorClient shape the resource server
  // expects. Everything is local, so there is no network hop and no retry.
  return {
    async verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements) {
      try {
        const result = await facilitator.verify(paymentPayload, paymentRequirements);
        // Logged here, once, at the point of decision — see formatPaymentRejection.
        if (!result.isValid) log(formatPaymentRejection(result, paymentRequirements));
        return result;
      } catch (err) {
        log(`[x402] verify errored: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
    async settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements) {
      try {
        const result = await facilitator.settle(paymentPayload, paymentRequirements);
        if (!result.success) log(formatSettlementFailure(result));
        return result;
      } catch (err) {
        log(`[x402] settle errored: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
    async getSupported() {
      // x402Facilitator.getSupported() is synchronous and types `network` as a
      // plain string; the client interface wants a Promise of CAIP-2 networks.
      return facilitator.getSupported() as SupportedResponse;
    },
  };
}

/**
 * The memo a settlement should carry, set by the broker around the x402
 * `settle` call (`withSettlementMemo`). An AsyncLocalStorage, so concurrent
 * settlements each tag their own job.
 */
const settlementMemo = new AsyncLocalStorage<MemoTag>();

/** Run `fn` with every facilitator write inside it tagged with `tag` (Arc Memo). */
export function withSettlementMemo<T>(tag: MemoTag | null, fn: () => Promise<T>): Promise<T> {
  return tag ? settlementMemo.run(tag, fn) : fn();
}

/**
 * Arc's Memo contract for this network, or null when tagging is off
 * (`XORV_MEMO=off`, e.g. on a plain dev chain that has no Memo predeploy).
 */
export function memoContractFor(network: string): Address | null {
  const flag = readEnv("XORV_MEMO")?.toLowerCase();
  if (flag === "off" || flag === "0" || flag === "false") return null;
  return networkConfig(network).circle.memo;
}

/** The escrow job id a write is about: `fund(Funding)` carries it in the struct, the rest take it first. */
function escrowJobOf(functionName: string, args: readonly unknown[]): Hex | null {
  const first = args[0];
  if (functionName === "fund" || functionName === "fundDirect") {
    const id = (first as { jobId?: Hex } | undefined)?.jobId ?? (typeof first === "string" ? first : undefined);
    return (id as Hex | undefined) ?? null;
  }
  return typeof first === "string" && first.startsWith("0x") && first.length === 66 ? (first as Hex) : null;
}

/**
 * The wallet the escrow scheme writes through: the same per-signer lock and
 * gas headroom as the exact scheme above, so an escrow funding and any other
 * write from this key (a ledger receipt, a release) can't race on a nonce.
 * With `memo` set, every escrow write goes through Arc's Memo contract tagged
 * with its job id (`xorv:fund`, `xorv:release`, …); the escrow still sees this
 * EOA as msg.sender, so attester checks are unchanged.
 */
export function escrowWriter(wallet: ReturnType<typeof walletClientFor>, account: Account, memo: Address | null = null): WalletClient {
  return {
    account,
    chain: wallet.chain,
    writeContract: (args: Record<string, unknown>) =>
      withSignerLock(account.address, async () => {
        const write = args as unknown as SyncWrite;
        const jobId = memo ? escrowJobOf(write.functionName, write.args ?? []) : null;
        const target: SyncWrite =
          memo && jobId ? (wrapWithMemo(memo, { ...write, gas: 0n }, jobMemo(jobId, write.functionName)) as SyncWrite) : write;
        const request = { address: target.address, abi: target.abi, functionName: target.functionName, args: target.args, account };
        const gas =
          memo && jobId
            ? withGasHeadroom(await wallet.estimateContractGas(request as never))
            : ((args.gas as bigint | undefined) ?? withGasHeadroom(await wallet.estimateContractGas(request as never)));
        // Sends with eth_sendRawTransactionSync where a node offers it; Arc's RPC doesn't, so it falls back.
        return writeContractSync(wallet, account, { ...target, gas });
      }),
  } as unknown as WalletClient;
}

/** A facilitator that talks HTTP to a hosted one. */
export function buildHostedFacilitator(url: string): FacilitatorClient {
  return new HTTPFacilitatorClient({ url });
}

export interface FacilitatorChoice {
  facilitator: FacilitatorClient;
  mode: "self" | "hosted";
  description: string;
  /** The EOA paying settlement gas when self-hosted; null when a hosted facilitator manages it. */
  address: string | null;
  /** The hosted facilitator's URL; null when self-hosted. */
  url: string | null;
}

/**
 * Pick a facilitator from config (`XORV_FACILITATOR`).
 *
 *  - `self` (the default) runs one in-process and needs a funded `account`;
 *  - `hosted` is the network's public facilitator (NetworkConfig.facilitatorUrl),
 *    which Arc does not have today, so it is refused there;
 *  - an `http(s)://` URL is any other hosted facilitator.
 *
 * `self` without an account throws with the fix in the message rather than
 * falling back to hosted: which party can move settlement gas — and see every
 * payment — is a decision, not a default to change silently.
 */
export function buildFacilitator(opts: {
  mode?: string | null;
  network: string;
  account?: Account | null;
  rpcUrl?: string;
  transport?: Transport;
  log?: X402Logger;
  /** XorvEscrow address; self-hosted only (the account must be its attester). */
  escrow?: string | null;
  onEscrowWrite?: (phase: "start" | "end") => void;
  /** Arc's Memo contract; defaults to the network's (see `memoContractFor`). */
  memo?: Address | null;
}): FacilitatorChoice {
  const mode = (opts.mode ?? "").trim() || "self";
  const cfg = networkConfig(opts.network);

  if (mode === "self") {
    if (!opts.account) {
      throw new Error(
        "the self-hosted x402 facilitator needs a key holding a little USDC for gas " +
          "(XORV_FACILITATOR_KEY, or XORV_OPERATOR_KEY) — or set XORV_FACILITATOR to a hosted facilitator's URL",
      );
    }
    return {
      facilitator: buildLocalFacilitator({
        network: cfg.caip2,
        account: opts.account,
        rpcUrl: opts.rpcUrl,
        transport: opts.transport,
        log: opts.log,
        escrow: opts.escrow,
        onEscrowWrite: opts.onEscrowWrite,
        memo: opts.memo,
      }),
      mode: "self",
      description: "self-hosted (in-process)",
      address: opts.account.address,
      url: null,
    };
  }

  const url = mode === "hosted" ? cfg.facilitatorUrl : mode;
  if (url === null) {
    throw new Error(`there is no public x402 facilitator for ${cfg.name}: use XORV_FACILITATOR=self (the default) or a facilitator URL`);
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`XORV_FACILITATOR must be "self", "hosted" or an http(s) URL, got "${mode}"`);
  }
  return {
    facilitator: buildHostedFacilitator(url),
    mode: "hosted",
    description: `hosted (${url})`,
    address: null,
    url,
  };
}
