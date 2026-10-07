/**
 * A scripted chain that accepts signed transactions: enough of a node for
 * viem's estimate → sign → send → wait-for-receipt path, with every raw
 * transaction kept so a test can decode exactly what was signed.
 *
 * `call` answers eth_call; `logs` builds a mined transaction's receipt logs;
 * `revert` decides a transaction's status.
 */

import { keccak256, parseTransaction, zeroAddress, type Hex, type TransactionSerializable } from "viem";
import { fakeRpc, hex, type RpcHandler } from "./fake-rpc.js";

export interface FakeChainOptions {
  chainId: number;
  from: string;
  call?: (call: { to: string; data: Hex }) => Hex;
  logs?: (tx: TransactionSerializable & { hash: Hex }) => unknown[];
  revert?: (tx: TransactionSerializable) => boolean;
  balance?: bigint;
  extra?: Record<string, RpcHandler>;
}

const BASE_FEE = 20_000_000_000n; // Arc's 20 gwei floor
const TIP = 1_000_000_000n;

const block = () => ({
  number: hex(1_000),
  hash: keccak256("0x01"),
  parentHash: keccak256("0x00"),
  timestamp: hex(1_790_000_000),
  baseFeePerGas: hex(BASE_FEE),
  gasLimit: hex(30_000_000),
  gasUsed: "0x0",
  transactions: [],
  uncles: [],
  logsBloom: `0x${"0".repeat(512)}`,
  extraData: "0x",
  miner: zeroAddress,
  difficulty: "0x0",
  size: "0x0",
  nonce: "0x0000000000000000",
});

export function fakeChain(opts: FakeChainOptions) {
  const sent: Hex[] = [];
  const rpc = fakeRpc({
    eth_chainId: () => hex(opts.chainId),
    eth_blockNumber: () => hex(1_001),
    eth_getBalance: () => hex(opts.balance ?? 10n ** 18n),
    eth_estimateGas: () => hex(100_000),
    eth_getTransactionCount: () => hex(sent.length),
    eth_maxPriorityFeePerGas: () => hex(TIP),
    eth_gasPrice: () => hex(BASE_FEE + TIP),
    eth_getBlockByNumber: () => block(),
    eth_call: ([call]) => {
      if (!opts.call) throw new Error("fake chain: unexpected eth_call");
      return opts.call(call as { to: string; data: Hex });
    },
    eth_sendRawTransaction: ([raw]) => {
      sent.push(raw as Hex);
      return keccak256(raw as Hex);
    },
    eth_getTransactionReceipt: ([hash]) => {
      const raw = sent.find((tx) => keccak256(tx) === hash);
      if (!raw) return null;
      const tx = parseTransaction(raw);
      const reverted = opts.revert?.(tx) ?? false;
      return {
        transactionHash: hash,
        transactionIndex: "0x0",
        blockHash: keccak256("0x01"),
        blockNumber: hex(1_001),
        from: opts.from.toLowerCase(),
        to: tx.to?.toLowerCase() ?? null,
        cumulativeGasUsed: hex(100_000),
        gasUsed: hex(100_000),
        effectiveGasPrice: hex(BASE_FEE + TIP),
        contractAddress: null,
        logsBloom: `0x${"0".repeat(512)}`,
        status: reverted ? "0x0" : "0x1",
        type: "0x2",
        logs: reverted
          ? []
          : (opts.logs?.({ ...tx, hash: hash as Hex }) ?? []).map((log, i) => ({
              blockNumber: hex(1_001),
              blockHash: keccak256("0x01"),
              transactionHash: hash,
              transactionIndex: "0x0",
              logIndex: hex(i),
              removed: false,
              ...(log as object),
            })),
      };
    },
    ...opts.extra,
  });
  return { ...rpc, sent, decoded: () => sent.map((raw) => parseTransaction(raw)) };
}
