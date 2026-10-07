#!/usr/bin/env node
/**
 * User-run: a buyer agent on Base Sepolia (or Ethereum Sepolia) pays for a Xorv job on Arc with one
 * source-chain transaction. Circle CCTP V2 burns the USDC to XorvCcipReceiver on Arc (the dollars);
 * Chainlink CCIP carries the job (the instruction). TESTNET ONLY: it refuses any other chain.
 *
 *   BUYER_KEY=0x… XORV_BROKER_URL=https://broker… node scripts/ccip-send.mjs --source base-sepolia \
 *     --prompt "Summarise the CCIP docs" [--max 0.05] [--sender 0x<XorvCcipSender>] [--yes]
 *   node scripts/ccip-send.mjs --status <jobId> [--broker …]       # where the job stands on Arc
 *
 * The buyer needs USDC (price + CCTP fast fee) and a little ETH for the CCIP fee on the source chain.
 * Nothing is sent without --yes: without it the script prints what it would do.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// viem comes from the workspace (packages/protocol depends on it).
const require = createRequire(path.join(here, "..", "packages", "protocol", "package.json"));
const { createPublicClient, createWalletClient, http, parseAbi, formatUnits, formatEther, defineChain } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const SOURCES = {
  "base-sepolia": { chainId: 84532, name: "Base Sepolia", rpc: "https://sepolia.base.org", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  "ethereum-sepolia": { chainId: 11155111, name: "Ethereum Sepolia", rpc: "https://ethereum-sepolia-rpc.publicnode.com", usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
};
const ARC_TESTNET_RPC = "https://rpc.testnet.arc.io";

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);
const broker = (opt("broker") ?? process.env.XORV_BROKER_URL ?? "http://localhost:8402").replace(/\/+$/, "");

const SENDER_ABI = parseAbi([
  "function postJob(bytes32 jobId, address provider, uint256 price, uint40 deadline, uint256 maxFee, uint32 minFinalityThreshold) payable returns (bytes32)",
  "function quotePostJob(bytes32 jobId, address provider, uint256 price, uint40 deadline) view returns (uint256)",
  "event JobPosted(bytes32 indexed messageId, bytes32 indexed jobId, address indexed requester, address provider, uint256 price, uint40 deadline, uint256 maxFee, uint256 ccipFee)",
]);
const ERC20 = parseAbi(["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)"]);
const RECEIVER_ABI = parseAbi([
  "function getIntent(bytes32 jobId) view returns ((address beneficiary, uint40 deadline, uint8 status, address sourceSender, uint64 sourceChainSelector, address provider, uint96 price))",
]);
const INTENT_STATUS = ["none (CCIP message not delivered yet)", "pending (waiting for the CCTP mint)", "funded (escrowed on Arc; the job runs)", "released", "refunded", "cancelled"];

async function json(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} → ${res.status}: ${body.error ?? JSON.stringify(body)}`);
  return body;
}

async function status(jobId) {
  const net = await json(`${broker}/api/network`);
  const receiver = net.arc?.ccip?.receiver?.address;
  if (!receiver) throw new Error("the broker reports no CCIP receiver");
  const arc = createPublicClient({ transport: http(net.chainId === 5042 ? "https://rpc.mainnet.arc.io" : ARC_TESTNET_RPC) });
  const intent = await arc.readContract({ address: receiver, abi: RECEIVER_ABI, functionName: "getIntent", args: [jobId] });
  console.log(`job ${jobId} on Arc: ${INTENT_STATUS[intent.status] ?? intent.status}`);
  if (intent.status > 0) console.log(`  requester ${intent.beneficiary}, provider ${intent.provider}, price ${formatUnits(intent.price, 6)} USDC`);
  const { jobs } = await json(`${broker}/api/jobs?limit=200`);
  const job = jobs.find((j) => j.payment?.escrow?.jobId?.toLowerCase() === jobId.toLowerCase());
  if (job) console.log(`  broker job ${job.id}: ${job.status}${job.payment?.crossChain?.ccipExplorerUrl ? `  ${job.payment.crossChain.ccipExplorerUrl}` : ""}`);
}

async function main() {
  const statusOf = opt("status");
  if (statusOf) return status(statusOf);

  const source = SOURCES[opt("source", "base-sepolia")];
  if (!source) throw new Error(`--source must be one of ${Object.keys(SOURCES).join(", ")} (testnet only)`);
  const key = process.env.BUYER_KEY?.trim();
  if (!key) throw new Error("set BUYER_KEY (the buyer agent's key on the source chain; never printed)");
  const prompt = opt("prompt");
  if (!prompt) throw new Error('--prompt "…" is required');
  const maxUsd = Number(opt("max", "0.05"));

  const quote = await json(`${broker}/api/quotes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, maxPriceUsdMicros: Math.round(maxUsd * 1e6), payVia: "ccip" }),
  });
  const terms = quote.ccip;
  if (!terms) throw new Error("the broker returned no CCIP terms (is XORV_CCIP_RECEIVER_ADDRESS set?)");
  if (!terms.sources.some((s) => s.chainId === source.chainId)) throw new Error(`${source.name} is not a CCIP source for this broker`);
  const senderAddress = opt("sender") ?? terms.senders[String(source.chainId)];
  if (!senderAddress) throw new Error(`no XorvCcipSender known on ${source.name}: pass --sender 0x… (deploy one with contracts/script/DeploySender.s.sol)`);

  const chain = defineChain({ id: source.chainId, name: source.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [source.rpc] } } });
  const account = privateKeyToAccount(key);
  const pub = createPublicClient({ chain, transport: http(source.rpc) });
  const wallet = createWalletClient({ chain, transport: http(source.rpc), account });
  const price = BigInt(terms.price);
  const maxFee = price / 100n > 10_000n ? price / 100n : 10_000n; // CCTP fast-transfer cap: 1%, at least 0.01 USDC
  const ccipFee = await pub.readContract({ address: senderAddress, abi: SENDER_ABI, functionName: "quotePostJob", args: [terms.jobId, terms.provider, price, terms.deadline] });
  const usdc = await pub.readContract({ address: source.usdc, abi: ERC20, functionName: "balanceOf", args: [account.address] });

  console.log(`quote ${quote.quoteId}: ${quote.priceLabel} to ${quote.provider.label} (${terms.provider})`);
  console.log(`  escrow job id ${terms.jobId}, deadline ${new Date(terms.deadline * 1000).toISOString()}`);
  console.log(`  ${source.name}: burn ${formatUnits(price + maxFee, 6)} USDC (price + max CCTP fee) to ${terms.receiver} on Arc, CCIP fee ${formatEther(ccipFee)} ETH`);
  console.log(`  buyer ${account.address} holds ${formatUnits(usdc, 6)} USDC on ${source.name}`);
  if (!flag("yes")) {
    console.log("dry run: add --yes to send");
    return;
  }
  const allowance = await pub.readContract({ address: source.usdc, abi: ERC20, functionName: "allowance", args: [account.address, senderAddress] });
  if (allowance < price + maxFee) {
    const tx = await wallet.writeContract({ address: source.usdc, abi: ERC20, functionName: "approve", args: [senderAddress, price + maxFee] });
    await pub.waitForTransactionReceipt({ hash: tx });
    console.log(`approved: ${tx}`);
  }
  const hash = await wallet.writeContract({
    address: senderAddress,
    abi: SENDER_ABI,
    functionName: "postJob",
    args: [terms.jobId, terms.provider, price, terms.deadline, maxFee, 1000],
    value: (ccipFee * 11n) / 10n, // 10% headroom; the sender refunds the excess
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  const posted = receipt.logs.find((l) => l.address.toLowerCase() === senderAddress.toLowerCase());
  const messageId = posted?.topics?.[1];
  console.log(`postJob: ${hash}`);
  if (messageId) console.log(`CCIP message ${messageId}: https://ccip.chain.link/msg/${messageId}`);
  console.log(`then: node scripts/ccip-send.mjs --status ${terms.jobId} --broker ${broker}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
