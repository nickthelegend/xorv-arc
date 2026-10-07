/**
 * The escrow watcher and refund keeper.
 *
 * On Monad, Chainlink CRE ran the refund keeper. CRE runs on Arc testnet but
 * not on Arc mainnet, so on Arc the broker does the same job itself, with
 * nothing but RPC reads and one permissionless call:
 *
 *  1. **Refunds past the deadline.** XorvEscrow lets *anyone* refund a funded
 *     job once its deadline passes, and the money can only go to the buyer.
 *     The keeper follows every `JobFunded` the escrow emits (not just the jobs
 *     this broker remembers, so a job orphaned by a crash or a lost database is
 *     still refunded) and calls `refund(jobId)` for each one past its deadline.
 *     It refunds from a key that is **not** the escrow's attester: an attester
 *     refund means "the provider failed" and marks the provider, while a
 *     deadline refund says nothing about who was at fault.
 *  2. **Cross-chain funding.** A job posted from Base or Ethereum over CCIP is
 *     funded by XorvCcipReceiver (the escrow's buyer of record). The watcher
 *     hands each such `JobFunded` to the broker, which opens the quoted job.
 *  3. **Forwarding CCIP refunds.** A refunded cross-chain job's USDC lands on
 *     the receiver; `claimRefund(jobId)` (permissionless) forwards it to the
 *     requester. `markReleased` closes out the receiver's books after a release.
 *
 * Every write is tagged with the job id through Arc's Memo. Nothing here can
 * move money anywhere but to the buyer or to the provider the escrow already
 * names: those are the only things the contract functions it calls can do.
 */

import { getAddress, parseAbiItem, type Address, type Hex, type PrivateKeyAccount, type PublicClient } from "viem";
import {
  MAX_LOG_BLOCK_RANGE,
  XORV_ESCROW_ABI,
  escrowWriter,
  memoContractFor,
  publicClientFor,
  walletClientFor,
} from "@xorv/protocol";

const JOB_FUNDED = parseAbiItem(
  "event JobFunded(bytes32 indexed jobId, address indexed buyer, address indexed provider, address token, uint256 amount, uint40 deadline)",
);
const INTENT_RECEIVED = parseAbiItem(
  "event IntentReceived(bytes32 indexed jobId, bytes32 indexed messageId, uint64 indexed sourceChainSelector, address requester, address provider, uint256 price, uint40 deadline)",
);

/** The slice of XorvCcipReceiver the keeper calls. */
export const XORV_CCIP_RECEIVER_KEEPER_ABI = [
  { type: "function", name: "claimRefund", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "markReleased", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "executePending", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "bytes32" }], outputs: [] },
  {
    type: "function",
    name: "getIntent",
    stateMutability: "view",
    inputs: [{ name: "jobId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "beneficiary", type: "address" },
          { name: "deadline", type: "uint40" },
          { name: "status", type: "uint8" },
          { name: "sourceSender", type: "address" },
          { name: "sourceChainSelector", type: "uint64" },
          { name: "provider", type: "address" },
          { name: "price", type: "uint96" },
        ],
      },
    ],
  },
  { type: "function", name: "available", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;

/** XorvCcipReceiver.Status, mirrored. */
export const INTENT_STATUS = ["none", "pending", "funded", "released", "refunded", "cancelled"] as const;

export interface FundedJob {
  jobId: Hex;
  buyer: Address;
  provider: Address;
  amount: bigint;
  deadline: number;
  txHash: Hex;
  blockNumber: bigint;
}

export interface CcipIntent {
  beneficiary: Address;
  deadline: number;
  status: (typeof INTENT_STATUS)[number];
  sourceSender: Address;
  sourceChainSelector: bigint;
  provider: Address;
  price: bigint;
  messageId: Hex | null;
}

export interface KeeperOptions {
  network: string;
  escrow: Address;
  /** The escrow's attester; the keeper refuses to refund from it (that would mark the provider). */
  attester: Address | null;
  /** Signs refunds and CCIP book-keeping; null keeps the watcher read-only. */
  account: PrivateKeyAccount | null;
  ccipReceiver: Address | null;
  /** First block to scan (the escrow's deploy block); defaults to a recent window. */
  fromBlock?: bigint | null;
  /** Called for every JobFunded whose buyer is the CCIP receiver. */
  onCrossChainFunded?: (job: FundedJob, intent: CcipIntent | null) => void;
  log?: (line: string) => void;
  /** Tests inject a client. */
  client?: PublicClient;
}

/** How far back the first scan reaches when no deploy block is known (~10 hours of Arc). */
const DEFAULT_LOOKBACK = 70_000n;

export class RefundKeeper {
  readonly enabled: boolean;
  private readonly client: PublicClient;
  private cursor: bigint | null;
  private readonly open = new Map<string, FundedJob>();
  private readonly crossChain = new Map<string, FundedJob>();
  private running = false;
  readonly refunded: { jobId: Hex; tx: Hex }[] = [];
  /** Where cross-chain fundings go when the options didn't name a handler (the broker sets it after construction). */
  crossChainHandler: ((job: FundedJob, intent: CcipIntent | null) => void) | null = null;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: KeeperOptions) {
    this.client = opts.client ?? (publicClientFor(opts.network) as PublicClient);
    this.cursor = opts.fromBlock ?? null;
    this.log = opts.log ?? ((line) => console.log(`[keeper] ${line}`));
    const isAttester = opts.account && opts.attester && opts.account.address.toLowerCase() === opts.attester.toLowerCase();
    if (isAttester) {
      this.log(
        "the keeper key is the escrow's attester: an attester refund marks the provider as at fault, so deadline " +
          "refunds are left to anyone else (set XORV_KEEPER_KEY to a separate key)",
      );
    }
    this.enabled = Boolean(opts.account) && !isAttester;
  }

  /** Jobs the keeper is following (funded, not yet seen settled). */
  get watching(): number {
    return this.open.size;
  }

  /** One pass: read new JobFunded logs, refund what is past its deadline. Never throws. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.scan();
      await this.refundExpired();
    } catch (err) {
      this.log(`pass failed (will retry): ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    } finally {
      this.running = false;
    }
  }

  private async scan(): Promise<void> {
    const head = await this.client.getBlockNumber();
    let from = this.cursor ?? (head > DEFAULT_LOOKBACK ? head - DEFAULT_LOOKBACK : 0n);
    const window = BigInt(MAX_LOG_BLOCK_RANGE);
    while (from <= head) {
      const to = from + window - 1n > head ? head : from + window - 1n;
      const logs = await this.client.getLogs({ address: this.opts.escrow, event: JOB_FUNDED, fromBlock: from, toBlock: to });
      for (const log of logs) {
        const a = log.args as { jobId: Hex; buyer: Address; provider: Address; amount: bigint; deadline: number | bigint };
        const job: FundedJob = {
          jobId: a.jobId,
          buyer: getAddress(a.buyer),
          provider: getAddress(a.provider),
          amount: a.amount,
          deadline: Number(a.deadline),
          txHash: log.transactionHash as Hex,
          blockNumber: log.blockNumber as bigint,
        };
        this.open.set(job.jobId.toLowerCase(), job);
        if (this.opts.ccipReceiver && job.buyer.toLowerCase() === this.opts.ccipReceiver.toLowerCase()) {
          this.crossChain.set(job.jobId.toLowerCase(), job);
          // IntentReceived is in the funding tx (or an earlier one, when the dollars arrived late):
          // look a few thousand blocks back from it, inside Arc's 10,000-block getLogs cap.
          const intent = await this.intent(job.jobId, job.blockNumber > 5_000n ? job.blockNumber - 5_000n : 0n, job.blockNumber).catch(() => null);
          (this.opts.onCrossChainFunded ?? this.crossChainHandler)?.(job, intent);
        }
      }
      from = to + 1n;
    }
    this.cursor = head + 1n;
  }

  /** The CCIP receiver's record of a job, with the message id when the logs have it. */
  async intent(jobId: Hex, fromBlock?: bigint, toBlock?: bigint): Promise<CcipIntent | null> {
    const receiver = this.opts.ccipReceiver;
    if (!receiver) return null;
    const raw = (await this.client.readContract({
      address: receiver,
      abi: XORV_CCIP_RECEIVER_KEEPER_ABI,
      functionName: "getIntent",
      args: [jobId],
    })) as { beneficiary: Address; deadline: number; status: number; sourceSender: Address; sourceChainSelector: bigint; provider: Address; price: bigint };
    let messageId: Hex | null = null;
    if (fromBlock !== undefined && toBlock !== undefined) {
      const logs = await this.client
        .getLogs({ address: receiver, event: INTENT_RECEIVED, args: { jobId }, fromBlock, toBlock })
        .catch(() => []);
      messageId = ((logs.at(-1)?.args as { messageId?: Hex } | undefined)?.messageId ?? null) as Hex | null;
    }
    return {
      beneficiary: getAddress(raw.beneficiary),
      deadline: Number(raw.deadline),
      status: INTENT_STATUS[raw.status] ?? "none",
      sourceSender: getAddress(raw.sourceSender),
      sourceChainSelector: raw.sourceChainSelector,
      provider: getAddress(raw.provider),
      price: raw.price,
      messageId,
    };
  }

  private async refundExpired(): Promise<void> {
    if (this.open.size === 0) return;
    const block = await this.client.getBlock();
    const now = Number(block.timestamp);
    for (const [key, job] of this.open) {
      if (job.deadline >= now) continue;
      const onChain = (await this.client.readContract({
        address: this.opts.escrow,
        abi: XORV_ESCROW_ABI,
        functionName: "getJob",
        args: [job.jobId],
      })) as { status: number };
      const status = Number(onChain.status);
      if (status === 2 || status === 3) {
        // Settled (released or refunded) by someone: close the CCIP books if needed, stop watching.
        this.open.delete(key);
        if (this.crossChain.has(key)) await this.forwardCrossChain(job.jobId, status === 3 ? "refunded" : "released");
        continue;
      }
      if (status !== 1 || !this.enabled || !this.opts.account) continue;
      try {
        const tx = await this.write(this.opts.escrow, XORV_ESCROW_ABI, "refund", [job.jobId]);
        this.refunded.push({ jobId: job.jobId, tx });
        this.log(`refunded ${job.jobId} past its deadline → ${job.buyer} (${tx})`);
        this.open.delete(key);
        if (this.crossChain.has(key)) await this.forwardCrossChain(job.jobId, "refunded");
      } catch (err) {
        this.log(`refund ${job.jobId}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
    }
  }

  /**
   * After a cross-chain job settles: forward a refund to the requester
   * (claimRefund) or close the receiver's books on a release (markReleased).
   * Both are permissionless; a revert because it already happened is fine.
   */
  async forwardCrossChain(jobId: Hex, outcome: "refunded" | "released"): Promise<Hex | null> {
    const receiver = this.opts.ccipReceiver;
    if (!receiver || !this.opts.account) return null;
    try {
      const intent = await this.intent(jobId);
      if (!intent || intent.status !== "funded") return null;
      const tx = await this.write(receiver, XORV_CCIP_RECEIVER_KEEPER_ABI, outcome === "refunded" ? "claimRefund" : "markReleased", [jobId]);
      this.crossChain.delete(jobId.toLowerCase());
      this.log(`${outcome === "refunded" ? "forwarded the refund of" : "closed out"} cross-chain job ${jobId} (${tx})`);
      return tx;
    } catch (err) {
      this.log(`ccip ${outcome} ${jobId}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      return null;
    }
  }

  private async write(address: Address, abi: unknown, functionName: string, args: readonly unknown[]): Promise<Hex> {
    const account = this.opts.account!;
    const wallet = walletClientFor(this.opts.network, account);
    // Same writer as the escrow's attester path: signer lock, gas headroom, Memo tag by job id.
    const writer = escrowWriter(wallet, account, memoContractFor(this.opts.network)) as unknown as {
      writeContract(args: Record<string, unknown>): Promise<Hex>;
    };
    const hash = await writer.writeContract({ address, abi, functionName, args });
    const receipt = await wallet.waitForTransactionReceipt({ hash, timeout: 30_000 });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
    return hash;
  }
}
