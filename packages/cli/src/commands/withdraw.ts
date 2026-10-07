/**
 * `xorv withdraw` — take a provider's Arc earnings home over Circle CCTP V2.
 *
 * A provider is paid in USDC on Arc. To move it to Base or Ethereum (or their
 * testnets) the CLI burns it on Arc and Circle mints the same USDC on the
 * other side — no bridge liquidity, no wrapped token:
 *
 *  1. `USDC.approve(TokenMessengerV2, amount)` on Arc, only when the
 *     allowance is short.
 *  2. `TokenMessengerV2.depositForBurn(amount, destinationDomain,
 *     mintRecipient, USDC, 0x0, maxFee, minFinalityThreshold)` on Arc. Fast
 *     (threshold 1000) attests in seconds for a fee capped by `maxFee`;
 *     `--standard` (2000) waits for finality and is free. Arc is final in
 *     under a second either way, so the wait is Circle's attestation.
 *  3. Poll Circle's Iris API (`/v2/messages/26?transactionHash=…`) until the
 *     message is `complete` and carries an attestation.
 *  4. `MessageTransmitterV2.receiveMessage(message, attestation)` on the
 *     destination, which mints to the recipient. Anyone may send it, and it
 *     costs the destination chain's gas (ETH), so it is sent only when a
 *     destination key is provided (`--mint-key-env`, default `XORV_DEST_KEY`)
 *     and the destination RPC answers with the right chain id. Otherwise the
 *     exact `cast send` that finishes the job is printed.
 *
 * Gas on Arc is the same USDC that is being withdrawn (Arc's native token is
 * USDC), so the default amount is the whole balance minus a small reserve
 * that pays for the approve and the burn.
 *
 * `--resume <burnTx>` picks a withdrawal back up at step 3, for a `--no-wait`
 * run or one whose attestation wait timed out.
 */

import {
  CCTP_FAST,
  ERC20_ABI,
  ERC20_APPROVE_ABI,
  MESSAGE_TRANSMITTER_V2_ABI,
  TOKEN_MESSENGER_V2_ABI,
  accountFromKey,
  explorerTx,
  formatUsdc,
  irisMessagesUrl,
  networkConfig,
  normalizeAddress,
  parseIrisMessages,
  planCctpWithdraw,
  publicClientFor,
  remoteChain,
  sameAddress,
  walletClientFor,
  withGasHeadroom,
  type ClientOptions,
  type CctpWithdrawPlan,
  type IrisMessage,
  type RemoteChain,
} from "@xorv/protocol";
import {
  createWalletClient,
  defineChain,
  hexToNumber,
  http,
  isHex,
  parseUnits,
  publicActions,
  slice,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import { payoutAddress, requireConfig, resolvePrivateKey } from "../config.js";
import * as ui from "../ui.js";

/** USDC (6-decimal units) kept back by default to pay Arc gas for the approve + burn: 0.05 USDC. */
export const GAS_RESERVE_UNITS = 50_000n;

/** The env var a destination-chain key is read from unless `--mint-key-env` names another. */
export const DEFAULT_MINT_KEY_ENV = "XORV_DEST_KEY";

/** How long to wait for Circle's attestation by default. */
export const DEFAULT_ATTESTATION_TIMEOUT_MS = { fast: 10 * 60_000, standard: 30 * 60_000 } as const;

const IRIS_POLL_MS = 3_000;

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

/** A destination by name ("base-sepolia", "Base Sepolia") or chain id ("84532"). */
export function resolveDestination(network: string, to: string | undefined): RemoteChain {
  const remotes = networkConfig(network).remotes;
  const list = remotes.map((r) => `${r.name} (${r.chainId})`).join(", ");
  if (!to?.trim()) throw new Error(`--to is required: one of ${list}`);
  const key = to.trim();
  const found = /^\d+$/.test(key) ? remoteChain(network, Number(key)) : remoteChain(network, key);
  if (!found) throw new Error(`can't withdraw to "${key}" from ${networkConfig(network).name} — CCTP destinations: ${list}`);
  return found;
}

/**
 * How much to burn, in USDC units.
 *
 * Without `--amount`: the whole balance minus `reserve` (Arc gas is paid from
 * the same USDC). With it: exactly that, as long as the reserve is still left
 * for gas — a burn that leaves nothing to pay for itself fails on-chain after
 * the approval already cost gas.
 */
export function withdrawAmount(opts: { requested?: string; balanceUnits: bigint; reserve?: bigint }): bigint {
  const reserve = opts.reserve ?? GAS_RESERVE_UNITS;
  const spendable = opts.balanceUnits - reserve;
  if (opts.requested !== undefined && opts.requested.trim() !== "") {
    const raw = opts.requested.trim().replace(/^\$/, "");
    if (!/^\d+(\.\d{1,6})?$/.test(raw)) throw new Error(`--amount must be a USDC amount like 12.5 (at most 6 decimals), got "${opts.requested}"`);
    const amount = parseUnits(raw, 6);
    if (amount <= 0n) throw new Error("--amount must be more than zero");
    if (amount > spendable) {
      throw new Error(
        `--amount ${formatUsdc(amount)} leaves less than ${formatUsdc(reserve)} for Arc gas (balance ${formatUsdc(opts.balanceUnits)}) — ` +
          (spendable > 0n ? `withdraw at most ${formatUnitsPlain(spendable)}` : "top the address up first"),
      );
    }
    return amount;
  }
  if (spendable <= 0n) {
    throw new Error(`nothing to withdraw: balance ${formatUsdc(opts.balanceUnits)}, and ${formatUsdc(reserve)} stays for Arc gas`);
  }
  return spendable;
}

/** USDC units as a plain decimal string ("12.5"), for a value to paste back into --amount. */
export function formatUnitsPlain(units: bigint): string {
  const whole = units / 1_000_000n;
  const frac = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * The CCTP V2 message header's destination domain (bytes 8..12): version (4),
 * source domain (4), destination domain (4), nonce (32), …
 */
export function messageDestinationDomain(message: Hex): number {
  return hexToNumber(slice(message, 8, 12));
}

/** The `cast send` that finishes a withdrawal on the destination chain. */
export function castReceiveCommand(destination: RemoteChain, message: Hex, attestation: Hex, keyEnv = DEFAULT_MINT_KEY_ENV): string {
  return [
    "cast send",
    destination.messageTransmitterV2,
    '"receiveMessage(bytes,bytes)"',
    message,
    attestation,
    `--rpc-url ${destination.rpcUrl}`,
    `--private-key $${keyEnv}`,
  ].join(" ");
}

/** A viem chain for a CCTP destination (gas there is ETH). */
export function remoteViemChain(destination: RemoteChain) {
  return defineChain({
    id: destination.chainId,
    name: destination.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [destination.rpcUrl] } },
    blockExplorers: { default: { name: "Explorer", url: destination.explorerUrl } },
  });
}

// ---------------------------------------------------------------------------
// Chain + Iris I/O
// ---------------------------------------------------------------------------

/** Approve TokenMessengerV2 when the allowance is short, then depositForBurn. Waits for both receipts. */
export async function burnOnArc(opts: {
  network: string;
  account: PrivateKeyAccount;
  plan: CctpWithdrawPlan;
  client?: ClientOptions;
  onApprove?: (txHash: Hex | null, allowance: bigint) => void;
}): Promise<{ approveTx: Hex | null; burnTx: Hex }> {
  const wallet = walletClientFor(opts.network, opts.account, opts.client);
  const { plan } = opts;
  const owner = opts.account.address;
  const allowance = await wallet.readContract({
    address: plan.usdc,
    abi: ERC20_APPROVE_ABI,
    functionName: "allowance",
    args: [owner, plan.tokenMessenger],
  });
  let approveTx: Hex | null = null;
  if (allowance < plan.amount) {
    const gas = await wallet.estimateContractGas({
      address: plan.usdc,
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [plan.tokenMessenger, plan.amount],
      account: opts.account,
    });
    approveTx = await wallet.writeContract({
      address: plan.usdc,
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [plan.tokenMessenger, plan.amount],
      gas: withGasHeadroom(gas),
    });
    const receipt = await wallet.waitForTransactionReceipt({ hash: approveTx, checkReplacement: false, timeout: 60_000 });
    if (receipt.status !== "success") throw new Error(`approve() reverted — ${explorerTx(opts.network, approveTx)}`);
  }
  opts.onApprove?.(approveTx, allowance);

  const gas = await wallet.estimateContractGas({
    address: plan.tokenMessenger,
    abi: TOKEN_MESSENGER_V2_ABI,
    functionName: "depositForBurn",
    args: plan.args,
    account: opts.account,
  });
  const burnTx = await wallet.writeContract({
    address: plan.tokenMessenger,
    abi: TOKEN_MESSENGER_V2_ABI,
    functionName: "depositForBurn",
    args: plan.args,
    gas: withGasHeadroom(gas),
  });
  const receipt = await wallet.waitForTransactionReceipt({ hash: burnTx, checkReplacement: false, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`depositForBurn() reverted — ${explorerTx(opts.network, burnTx)}`);
  return { approveTx, burnTx };
}

/**
 * Poll Iris until the burn's message is `complete` with an attestation.
 *
 * A 404 is "Iris hasn't indexed the burn yet", not an error. Returns null on
 * timeout; `onStatus` hears every status change ("not indexed yet",
 * "pending_confirmations", "complete").
 */
export async function waitForAttestation(opts: {
  network: string;
  burnTx: Hex;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onStatus?: (status: string) => void;
}): Promise<(IrisMessage & { message: Hex; attestation: Hex }) | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const url = irisMessagesUrl(opts.network, networkConfig(opts.network).circle.cctpDomain, opts.burnTx);
  const deadline = now() + opts.timeoutMs;
  let last = "";
  for (;;) {
    let status = "not indexed yet";
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const [first] = parseIrisMessages(await res.json());
        if (first) {
          status = first.status;
          if (first.status === "complete" && first.message && first.attestation) {
            if (status !== last) opts.onStatus?.(status);
            return { ...first, message: first.message, attestation: first.attestation };
          }
        }
      } else if (res.status !== 404) {
        status = `iris answered ${res.status}`;
      }
    } catch (err) {
      status = `iris unreachable (${err instanceof Error ? err.message : String(err)})`;
    }
    if (status !== last) {
      opts.onStatus?.(status);
      last = status;
    }
    if (now() >= deadline) return null;
    await sleep(opts.intervalMs ?? IRIS_POLL_MS);
  }
}

/**
 * `MessageTransmitterV2.receiveMessage(message, attestation)` on the
 * destination. Checks the RPC is the destination chain first: a key pointed at
 * the wrong chain should print the cast command, not spend gas on a revert.
 */
export async function mintOnDestination(opts: {
  destination: RemoteChain;
  key: string;
  message: Hex;
  attestation: Hex;
  client?: ClientOptions;
}): Promise<Hex> {
  const account = accountFromKey(opts.key);
  const wallet = createWalletClient({
    account,
    chain: remoteViemChain(opts.destination),
    transport: opts.client?.transport ?? http(opts.client?.rpcUrl ?? opts.destination.rpcUrl, { timeout: 20_000, retryCount: 1 }),
  }).extend(publicActions);
  const chainId = await wallet.getChainId();
  if (chainId !== opts.destination.chainId) {
    throw new UnreachableDestination(`${opts.destination.rpcUrl} is chain ${chainId}, not ${opts.destination.name} (${opts.destination.chainId})`);
  }
  const gas = await wallet.estimateContractGas({
    address: opts.destination.messageTransmitterV2,
    abi: MESSAGE_TRANSMITTER_V2_ABI,
    functionName: "receiveMessage",
    args: [opts.message, opts.attestation],
    account,
  });
  const txHash = await wallet.writeContract({
    address: opts.destination.messageTransmitterV2,
    abi: MESSAGE_TRANSMITTER_V2_ABI,
    functionName: "receiveMessage",
    args: [opts.message, opts.attestation],
    gas: withGasHeadroom(gas),
  });
  const receipt = await wallet.waitForTransactionReceipt({ hash: txHash, checkReplacement: false, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`receiveMessage() reverted — ${opts.destination.explorerUrl}/tx/${txHash}`);
  return txHash;
}

/** The destination RPC could not be used; the caller falls back to the cast command. */
export class UnreachableDestination extends Error {}

// ---------------------------------------------------------------------------
// The whole flow
// ---------------------------------------------------------------------------

export type WithdrawEvent =
  | { kind: "approve"; txHash: Hex | null; allowance: bigint }
  | { kind: "burn"; txHash: Hex; explorer: string }
  | { kind: "attestation"; status: string }
  | { kind: "mint"; txHash: Hex; explorer: string };

export type WithdrawFinish =
  | { kind: "minted" }
  | { kind: "no-wait" }
  | { kind: "timeout" }
  | { kind: "no-key"; cast: string }
  | { kind: "unreachable"; cast: string; detail: string }
  | { kind: "mint-failed"; cast: string; detail: string };

export interface WithdrawResult {
  network: string;
  destination: RemoteChain;
  /** Null when resuming a burn sent earlier. */
  plan: CctpWithdrawPlan | null;
  approveTx: Hex | null;
  burnTx: Hex;
  burnExplorer: string;
  irisUrl: string;
  attestation: { message: Hex; attestation: Hex } | null;
  mintTx: Hex | null;
  mintExplorer: string | null;
  finish: WithdrawFinish;
}

export interface WithdrawDeps {
  client?: ClientOptions;
  destClient?: ClientOptions;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: WithdrawEvent) => void;
}

/**
 * Burn (or resume a burn), wait for the attestation, and mint on the
 * destination when a key is at hand. Everything after the burn degrades to
 * "here is how to finish": the USDC is already burned, so the one thing this
 * must never do is throw away the message and attestation.
 */
export async function runWithdraw(
  input: {
    network: string;
    account: PrivateKeyAccount;
    destination: RemoteChain;
    /** A plan to burn, or a burn tx to resume. */
    plan?: CctpWithdrawPlan;
    resumeTx?: Hex;
    wait: boolean;
    mintKeyEnv: string;
    timeoutMs: number;
  },
  deps: WithdrawDeps = {},
): Promise<WithdrawResult> {
  const { network, destination } = input;
  const emit = deps.onEvent ?? (() => {});
  let approveTx: Hex | null = null;
  let burnTx: Hex;
  if (input.resumeTx) {
    burnTx = input.resumeTx;
  } else if (input.plan) {
    const sent = await burnOnArc({
      network,
      account: input.account,
      plan: input.plan,
      client: deps.client,
      onApprove: (txHash, allowance) => emit({ kind: "approve", txHash, allowance }),
    });
    approveTx = sent.approveTx;
    burnTx = sent.burnTx;
  } else {
    throw new Error("runWithdraw needs a plan or a burn transaction to resume");
  }
  const burnExplorer = explorerTx(network, burnTx);
  if (!input.resumeTx) emit({ kind: "burn", txHash: burnTx, explorer: burnExplorer });
  const irisUrl = irisMessagesUrl(network, networkConfig(network).circle.cctpDomain, burnTx);
  const base = { network, destination, plan: input.plan ?? null, approveTx, burnTx, burnExplorer, irisUrl };

  if (!input.wait) return { ...base, attestation: null, mintTx: null, mintExplorer: null, finish: { kind: "no-wait" } };

  const attested = await waitForAttestation({
    network,
    burnTx,
    fetchImpl: deps.fetchImpl,
    timeoutMs: input.timeoutMs,
    sleep: deps.sleep,
    now: deps.now,
    onStatus: (status) => emit({ kind: "attestation", status }),
  });
  if (!attested) return { ...base, attestation: null, mintTx: null, mintExplorer: null, finish: { kind: "timeout" } };
  const attestation = { message: attested.message, attestation: attested.attestation };
  const domain = messageDestinationDomain(attested.message);
  if (domain !== destination.cctpDomain) {
    throw new Error(
      `the burn's message goes to CCTP domain ${domain}, not ${destination.name} (domain ${destination.cctpDomain}) — pass the matching --to`,
    );
  }
  const cast = castReceiveCommand(destination, attested.message, attested.attestation, input.mintKeyEnv);

  const key = (deps.env ?? process.env)[input.mintKeyEnv]?.trim();
  if (!key) return { ...base, attestation, mintTx: null, mintExplorer: null, finish: { kind: "no-key", cast } };
  try {
    const mintTx = await mintOnDestination({ destination, key, ...attestation, client: deps.destClient });
    const mintExplorer = `${destination.explorerUrl}/tx/${mintTx}`;
    emit({ kind: "mint", txHash: mintTx, explorer: mintExplorer });
    return { ...base, attestation, mintTx, mintExplorer, finish: { kind: "minted" } };
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0]! : String(err);
    const unreachable = err instanceof UnreachableDestination || isNetworkError(err);
    return {
      ...base,
      attestation,
      mintTx: null,
      mintExplorer: null,
      finish: unreachable ? { kind: "unreachable", cast, detail } : { kind: "mint-failed", cast, detail },
    };
  }
}

function isNetworkError(err: unknown): boolean {
  const text = `${(err as { name?: string })?.name ?? ""} ${(err as Error)?.message ?? ""}`;
  return /HttpRequestError|TimeoutError|fetch failed|ECONNREFUSED|ENOTFOUND|took too long/i.test(text);
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export interface WithdrawOptions {
  to?: string;
  amount?: string;
  recipient?: string;
  standard?: boolean;
  /** Name of the env var holding the destination-chain key (default XORV_DEST_KEY). */
  mintKeyEnv?: string;
  /** Commander's `--no-wait` sets this false. */
  wait?: boolean;
  /** Resume a burn sent earlier: its Arc transaction hash. */
  resume?: string;
  /** Attestation wait, in seconds. */
  timeout?: string;
  yes?: boolean;
  json?: boolean;
}

export async function withdrawCommand(opts: WithdrawOptions = {}, deps: WithdrawDeps = {}): Promise<void> {
  const config = requireConfig();
  const network = config.network;
  const cfg = networkConfig(network);
  const payout = payoutAddress(config);
  const account = accountFromKey(resolvePrivateKey(config));
  if (!sameAddress(account.address, payout)) {
    throw new Error(
      `the configured key controls ${account.address}, not the payout address ${payout} — ` +
        "earnings sit at the payout address, so only its key can withdraw them",
    );
  }
  const fast = !opts.standard;
  const mintKeyEnv = opts.mintKeyEnv?.trim() || DEFAULT_MINT_KEY_ENV;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(mintKeyEnv)) throw new Error(`--mint-key-env must be an environment variable name, got "${mintKeyEnv}"`);
  const timeoutMs = opts.timeout
    ? parsePositiveSeconds(opts.timeout) * 1000
    : DEFAULT_ATTESTATION_TIMEOUT_MS[fast ? "fast" : "standard"];
  const wait = opts.wait !== false;
  const json = Boolean(opts.json);

  if (!json) console.log(ui.banner(`withdraw · CCTP from ${cfg.name}`));

  let destination: RemoteChain;
  let plan: CctpWithdrawPlan | undefined;
  let resumeTx: Hex | undefined;

  if (opts.resume) {
    if (!isHex(opts.resume) || opts.resume.length !== 66) throw new Error(`--resume takes the Arc burn transaction hash (0x + 64 hex), got "${opts.resume}"`);
    resumeTx = opts.resume as Hex;
    destination = resolveDestination(network, opts.to);
    if (!json) ui.info(`resuming burn ${ui.c.muted(explorerTx(network, resumeTx))} → ${destination.name}`);
  } else {
    destination = resolveDestination(network, opts.to);
    const recipient: Address = opts.recipient ? checkedRecipient(opts.recipient) : account.address;
    const client = publicClientFor(network, deps.client);
    const balanceUnits = await client.readContract({
      address: cfg.usdc.address,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });
    const amount = withdrawAmount({ requested: opts.amount, balanceUnits });
    plan = planCctpWithdraw(network, { destination, amount, recipient, fast });

    if (!json) {
      console.log(
        ui.box(
          ui.kv([
            ["from", `${account.address} ${ui.c.muted(`(${cfg.name}, balance ${formatUsdc(balanceUnits)})`)}`],
            ["to", `${ui.c.bold(destination.name)} ${ui.c.muted(`(chain ${destination.chainId}, CCTP domain ${destination.cctpDomain})`)}`],
            ["recipient", `${recipient}${sameAddress(recipient, account.address) ? ui.c.muted(" (this address)") : ""}`],
            ["amount", ui.c.money(`${formatUnitsPlain(plan.amount)} USDC`)],
            [
              "mode",
              fast
                ? `fast ${ui.c.muted(`(finality ${CCTP_FAST}, Circle fee at most ${formatUnitsPlain(plan.maxFee)} USDC)`)}`
                : `standard ${ui.c.muted(`(finality ${plan.minFinalityThreshold}, no fee)`)}`,
            ],
            ["gas", ui.c.muted(`paid in USDC on ${cfg.name}; ${formatUnitsPlain(GAS_RESERVE_UNITS)} USDC kept back by default`)],
          ]),
          { title: "CCTP V2 withdrawal", color: ui.BRAND.amber },
        ),
      );
      ui.blank();
    }
    if (!opts.yes && !json) {
      const go = await ui.confirm(`burn ${formatUnitsPlain(plan.amount)} USDC on ${cfg.name} and mint it on ${destination.name}?`, false);
      if (!go) {
        ui.info("nothing sent");
        ui.blank();
        return;
      }
    } else if (!opts.yes && json) {
      throw new Error("--json needs --yes: a withdrawal moves money and can't be confirmed interactively");
    }
  }

  let spin: ui.Spinner | null = null;
  const onEvent = (event: WithdrawEvent): void => {
    deps.onEvent?.(event);
    if (json) return;
    switch (event.kind) {
      case "approve":
        if (event.txHash) ui.ok(`approved TokenMessengerV2 ${ui.c.muted(explorerTx(network, event.txHash))}`);
        else ui.ok(`allowance already covers it ${ui.c.muted(`(${formatUnitsPlain(event.allowance)} USDC)`)}`);
        break;
      case "burn":
        ui.ok(`burned on ${cfg.name} ${ui.c.accent(event.explorer)}`);
        if (wait) spin = ui.spinner("waiting for Circle's attestation…");
        break;
      case "attestation":
        if (!spin) spin = ui.spinner(`attestation: ${event.status}`);
        else spin.update(`attestation: ${event.status}`);
        if (event.status === "complete") {
          spin.succeed("attestation: complete");
          spin = null;
        }
        break;
      case "mint":
        ui.ok(`minted on ${destination.name} ${ui.c.accent(event.explorer)}`);
        break;
    }
  };

  let result: WithdrawResult;
  try {
    result = await runWithdraw(
      { network, account, destination, plan, resumeTx, wait, mintKeyEnv, timeoutMs },
      { ...deps, onEvent },
    );
  } finally {
    (spin as ui.Spinner | null)?.stop();
  }

  if (json) {
    console.log(JSON.stringify(withdrawJson(result), null, 2));
    if (result.finish.kind === "mint-failed") process.exitCode = 1;
    return;
  }

  ui.blank();
  const resume = `xorv withdraw --resume ${result.burnTx} --to "${destination.name}"`;
  switch (result.finish.kind) {
    case "minted":
      ui.ok(`done — ${plan ? `${formatUnitsPlain(plan.amount)} USDC (less Circle's fee) ` : "USDC "}is on ${destination.name}`);
      break;
    case "no-wait":
      ui.info(`burn sent; Circle attests it shortly. Status: ${ui.c.muted(result.irisUrl)}`);
      ui.muted(`  finish later with: ${resume}`);
      break;
    case "timeout":
      ui.warn(`no attestation within ${Math.round(timeoutMs / 1000)}s — the burn is safe; Circle will attest it`);
      ui.muted(`  status: ${result.irisUrl}`);
      ui.muted(`  finish later with: ${resume}`);
      process.exitCode = 1;
      break;
    case "no-key":
    case "unreachable":
    case "mint-failed": {
      if (result.finish.kind === "no-key") {
        ui.info(`no destination key in $${mintKeyEnv} — mint it yourself (any funded ${destination.name} key may send it):`);
      } else {
        ui[result.finish.kind === "unreachable" ? "warn" : "bad"](
          `couldn't mint on ${destination.name}: ${result.finish.detail} — finish it with:`,
        );
        if (result.finish.kind === "mint-failed") process.exitCode = 1;
      }
      ui.blank();
      console.log(`  ${result.finish.cast}`);
      break;
    }
  }
  ui.blank();
}

/** The `--json` shape (bigints as strings). */
export function withdrawJson(result: WithdrawResult): Record<string, unknown> {
  return {
    network: result.network,
    destination: { name: result.destination.name, chainId: result.destination.chainId, cctpDomain: result.destination.cctpDomain },
    amount: result.plan ? result.plan.amount.toString() : null,
    maxFee: result.plan ? result.plan.maxFee.toString() : null,
    minFinalityThreshold: result.plan?.minFinalityThreshold ?? null,
    recipient: result.plan?.recipient ?? null,
    approveTransaction: result.approveTx,
    burnTransaction: result.burnTx,
    burnExplorer: result.burnExplorer,
    iris: result.irisUrl,
    message: result.attestation?.message ?? null,
    attestation: result.attestation?.attestation ?? null,
    mintTransaction: result.mintTx,
    mintExplorer: result.mintExplorer,
    status: result.finish.kind,
    cast: "cast" in result.finish ? result.finish.cast : null,
    error: "detail" in result.finish ? result.finish.detail : null,
  };
}

function checkedRecipient(value: string): Address {
  try {
    return normalizeAddress(value);
  } catch {
    throw new Error(`--recipient must be a 0x address, got "${value}"`);
  }
}

function parsePositiveSeconds(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--timeout must be a number of seconds, got "${value}"`);
  return n;
}
