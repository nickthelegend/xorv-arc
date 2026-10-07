/**
 * `pnpm e2e:arc`: Xorv on a local fork of Arc testnet, end to end, with the Arc stack checked on chain.
 *
 * Arc Foundry's anvil forks Arc testnet, so Circle's real USDC (0x3600…, which is also the gas
 * token), the canonical ERC-8004 registries, Arc's Memo predeploy, CCTP's TokenMessengerV2 and
 * Chainlink's CCIP router are the real contracts. The real deploy script puts XorvLedger,
 * XorvReputation, XorvEscrow and XorvCcipReceiver on it; then the built broker (self-hosted x402
 * facilitator = escrow attester, refund keeper on a separate key), a real provider node
 * (`xorv start`, echo adapter) and a buyer paying with the protocol's x402 client. Checked on chain:
 *
 *  1. ERC-8004: the provider registers an agent on the real Identity Registry and binds it in
 *     XorvReputation.
 *  2. x402 in USDC into XorvEscrow: the buyer holds only USDC and sends no transaction; the
 *     facilitator's funding goes through Arc's Memo with the job id.
 *  3. The release pays the provider (Memo-tagged) and writes the outcome to the real ERC-8004
 *     Reputation Registry (tag "successRate", client XorvReputation); XorvLedger receipts it;
 *     the buyer's gasless rating lands as ERC-8004 "starred" feedback through XorvLedger.
 *  4. A buyer's cancel refunds in full (no fault, Memo-tagged).
 *  5. Chainlink CCIP: a job posted from Base Sepolia. CCTP's mint into the receiver is
 *     simulated by a USDC transfer (no attestation exists on a fork), and the CCIP delivery is
 *     the real router address impersonated on the fork calling the receiver; from there the
 *     receiver funds the real escrow, the broker runs the job and releases it.
 *  6. The refund keeper: an orphaned cross-chain job past its deadline is refunded by the keeper
 *     key (not the attester, so no fault) and forwarded to the requester with claimRefund.
 *  7. CCTP V2: the provider burns its earnings on Arc to Base Sepolia (real TokenMessengerV2).
 *  8. Circle Gateway: the broker reaches Circle's live testnet Gateway API.
 *
 * Needs `pnpm build`, Arc Foundry (ARC_ANVIL / ARC_FORGE) and network access to the Arc testnet
 * RPC. No keys or funds: every key is generated for the run. Writes e2e/last-run-arc.md.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  stringToHex,
  toHex,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import {
  ARC_TESTNET,
  IDENTITY_ABI,
  MEMO_ABI,
  RATING_TAG1,
  REPUTATION_ABI,
  TOKEN_MESSENGER_V2_ABI,
  ERC20_APPROVE_ABI,
  XORV_ESCROW_ABI,
  XORV_LEDGER_ABI,
  escrowJobId,
  memoEventsIn,
  networkConfig,
  planCctpWithdraw,
  remoteChain,
  textHash,
  viemChain,
  xorvCcipReceiverAbi,
  xorvReputationAbi,
  type Capability,
  type PublicJob,
  type PublicProvider,
  type QuoteResponse,
} from "@xorv/protocol";
import { brokerApi, getJob, payQuote, waitForJob } from "./api.js";
import { deployArc, setUsdc, startFork, waitUntil, warp, type Fork } from "./chain.js";
import { cleanEnv, sealedBrokerEnv } from "./env.js";
import { readFeedback, readLedgerEvents, readSettlement, usdcBalance } from "./onchain.js";
import { ProcessGroup, tail } from "./procs.js";
import { Report, bold, dim } from "./report.js";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const E2E_DIR = path.join(REPO, "e2e");
const BROKER_ENTRY = path.join(REPO, "services", "broker", "dist", "index.js");
const CLI_ENTRY = path.join(REPO, "packages", "cli", "dist", "index.js");
const NETWORK = ARC_TESTNET;
const NET = networkConfig(NETWORK);
const USDC = NET.usdc.address as Address;
const MEMO = NET.circle.memo;
const BASE_SEPOLIA = remoteChain(NETWORK, "Base Sepolia")!;
const PRICE_UNITS = 1_000n; // the echo capability's $0.001
const CAPABILITIES: Capability[] = [
  { id: "echo", adapter: "echo", displayName: "Echo (test)", model: null, priceUsdMicros: 1_000, maxConcurrency: 4 },
];
/** Ports this harness may use (Xorv's range on the shared machine). */
const FORK_PORT = Number(process.env.XORV_E2E_FORK_PORT ?? 8810);
const BROKER_PORT = Number(process.env.XORV_E2E_BROKER_PORT ?? 8812);

const report = new Report();
const runDir = fs.mkdtempSync(path.join((fs.mkdirSync(path.join(E2E_DIR, ".runs"), { recursive: true }), path.join(E2E_DIR, ".runs")), "arc-"));
const group = new ProcessGroup(path.join(runDir, "logs"));
let finishing: Promise<never> | null = null;

process.on("exit", () => group.killAllSync());
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    report.error ??= `interrupted by ${signal}`;
    void finish(130);
  });
}

function finish(code: number): Promise<never> {
  finishing ??= (async (): Promise<never> => {
    await group.stopAll();
    const markdown = report.markdown({
      command: "pnpm e2e:arc",
      environment: [
        ["node", process.version],
        ["platform", `${process.platform} ${os.release()}`],
        ["fork", `arc-anvil --network arc, forking ${NET.rpcUrl}`],
        ["duration", `${((Date.now() - report.startedAt.getTime()) / 1000).toFixed(1)} s`],
      ],
    });
    fs.writeFileSync(path.join(E2E_DIR, "last-run-arc.md"), markdown);
    process.stderr.write(`\n${bold(report.summaryLine())}\n${dim("report: e2e/last-run-arc.md")}\n`);
    if (report.passed) fs.rmSync(runDir, { recursive: true, force: true });
    else {
      process.stderr.write(`${dim(`logs kept in ${path.join(runDir, "logs")}`)}\n`);
      for (const proc of group.list()) {
        if (proc.output.trim()) process.stderr.write(`\n--- ${proc.name} (last lines) ---\n${tail(proc.output, 25)}\n`);
      }
    }
    process.exit(report.passed ? 0 : code);
  })();
  return finishing;
}

const party = () => {
  const key = generatePrivateKey();
  return { key, address: privateKeyToAccount(key).address };
};

const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const anvilKey = (index: number): Hex => toHex(mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index }).getHdKey().privateKey!);

async function receiptOf(fork: Fork, hash: Hex): Promise<TransactionReceipt> {
  return fork.client.getTransactionReceipt({ hash });
}

/** The Memo events a transaction emitted (Arc's Memo predeploy). */
async function memosIn(fork: Fork, hash: Hex) {
  return memoEventsIn((await receiptOf(fork, hash)).logs, MEMO);
}

async function main(): Promise<void> {
  const forkUrl = process.env.ARC_FORK_URL?.trim() || NET.rpcUrl;

  await report.step("preflight", async (note) => {
    const missing = [BROKER_ENTRY, CLI_ENTRY].filter((f) => !fs.existsSync(f));
    if (missing.length) throw new Error(`missing ${missing.map((f) => path.relative(REPO, f)).join(", ")}: run \`pnpm build\``);
    note(`run directory ${runDir}`);
  });

  // Fork-only keys: the deployer and broker are anvil's well-known dev accounts; everyone else is fresh.
  const deployer = { key: anvilKey(0), address: privateKeyToAccount(anvilKey(0)).address };
  const operator = { key: anvilKey(1), address: privateKeyToAccount(anvilKey(1)).address };
  const parties = { keeper: party(), provider: party(), buyer: party(), requester: party(), cctp: party() };
  const buyer = privateKeyToAccount(parties.buyer.key);
  report.fact("deployer (owner of every contract)", deployer.address, "parties");
  report.fact("broker operator (escrow attester, ledger broker, facilitator)", operator.address, "parties");
  report.fact("keeper (deadline refunds, not the attester)", parties.keeper.address, "parties");
  report.fact("provider", parties.provider.address, "parties");
  report.fact("buyer (holds USDC only, sends no transaction)", parties.buyer.address, "parties");
  report.fact("CCIP requester (a buyer agent on Base Sepolia)", parties.requester.address, "parties");

  const fork = await report.step(`fork Arc testnet (arc-anvil --network arc, :${FORK_PORT})`, async (note) => {
    const f = await startFork({ group, port: FORK_PORT, forkUrl, forkBlock: process.env.ARC_FORK_BLOCK?.trim() || null, env: cleanEnv() });
    note(`serving ${f.url}, forked at block ${f.forkBlock}`);
    return f;
  });
  report.fact("fork block", fork.forkBlock.toString(), "chain");

  await report.step("USDC: real FiatToken on Arc, also the gas token", async () => {
    const name = await fork.client.readContract({ address: USDC, abi: parseAbi(["function name() view returns (string)"]), functionName: "name" });
    const version = await fork.client.readContract({ address: USDC, abi: parseAbi(["function version() view returns (string)"]), functionName: "version" });
    report.equal("USDC EIP-712 name", name, "USDC");
    report.equal("USDC EIP-712 version", version, "2");
    for (const p of [deployer, operator, parties.keeper, parties.provider]) await setUsdc(fork, p.address, 50_000_000n);
    await setUsdc(fork, parties.buyer.address, 5_000_000n);
    await setUsdc(fork, parties.cctp.address, 50_000_000n);
    report.equal("buyer USDC (ERC-20 view)", await usdcBalance(fork.client, USDC, parties.buyer.address), 5_000_000n);
    report.equal("buyer native balance is the same USDC with 18 decimals", await fork.client.getBalance({ address: parties.buyer.address }), 5_000_000n * 10n ** 12n);
  });

  const d = await report.step("deploy with scripts/deploy.sh local (XorvLedger, XorvReputation, XorvEscrow, XorvCcipReceiver)", async (note) => {
    const dep = await deployArc({ group, repo: REPO, runDir, fork, deployerKey: deployer.key, broker: operator.address, env: cleanEnv() });
    report.equal("escrow attester is the broker", await fork.client.readContract({ address: dep.escrow, abi: XORV_ESCROW_ABI, functionName: "attester" }), operator.address);
    report.equal("escrow reports outcomes to XorvReputation", await fork.client.readContract({ address: dep.escrow, abi: XORV_ESCROW_ABI, functionName: "registry" }), dep.reputation);
    report.equal("escrow lets the CCIP receiver fund jobs", await fork.client.readContract({ address: dep.escrow, abi: XORV_ESCROW_ABI, functionName: "funderAllowed", args: [dep.ccipReceiver] }), true);
    report.equal("escrow per-job cap is 100 USDC", await fork.client.readContract({ address: dep.escrow, abi: XORV_ESCROW_ABI, functionName: "maxJobAmount" }), 100_000_000n);
    note(`ledger ${dep.ledger}, escrow ${dep.escrow}, reputation ${dep.reputation}, ccip receiver ${dep.ccipReceiver}`);
    if (dep.gasUsed !== null) note(`deploy gas ${dep.gasUsed} (${dep.costUsdc} USDC)`);
    return dep;
  });
  report.fact("XorvLedger", d.ledger, "chain");
  report.fact("XorvEscrow", d.escrow, "chain");
  report.fact("XorvReputation", d.reputation, "chain");
  report.fact("XorvCcipReceiver", d.ccipReceiver, "chain");
  if (d.gasUsed !== null) report.fact("deploy gas / cost", `${d.gasUsed} gas, ${d.costUsdc} USDC`, "chain");

  const wallet = (key: Hex) => createWalletClient({ chain: viemChain(NETWORK), transport: http(fork.url), account: privateKeyToAccount(key) });
  const send = async (key: Hex, req: Parameters<ReturnType<typeof wallet>["writeContract"]>[0]): Promise<TransactionReceipt> => {
    const hash = await wallet(key).writeContract(req as never);
    const receipt = await fork.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${String((req as { functionName: string }).functionName)} reverted (${hash})`);
    return receipt;
  };

  // 1. ERC-8004 ------------------------------------------------------------------------------
  const agentId = await report.step("ERC-8004: the provider registers an agent on Arc's Identity Registry and binds it in XorvReputation", async (note) => {
    const reg = await send(parties.provider.key, {
      address: NET.erc8004.identity,
      abi: IDENTITY_ABI,
      functionName: "register",
      args: [`http://127.0.0.1:${BROKER_PORT}/agents/e2e.json`],
    } as never);
    const registered = parseEventLogs({ abi: IDENTITY_ABI, logs: reg.logs, eventName: "Registered" })[0];
    if (!registered) throw new Error("no Registered event");
    const id = (registered.args as { agentId: bigint }).agentId;
    report.equal("agent wallet is the provider's payout address", await fork.client.readContract({ address: NET.erc8004.identity, abi: IDENTITY_ABI, functionName: "getAgentWallet", args: [id] }), parties.provider.address);
    await send(parties.provider.key, { address: d.reputation, abi: xorvReputationAbi, functionName: "bind", args: [id] } as never);
    const [bound, bAgent] = (await fork.client.readContract({ address: d.reputation, abi: xorvReputationAbi, functionName: "agentOf", args: [parties.provider.address] })) as readonly [boolean, bigint];
    report.check("XorvReputation binds the provider to its agent", bound && bAgent === id, `${bound} #${bAgent}`);
    report.equal("binding is live", await fork.client.readContract({ address: d.reputation, abi: xorvReputationAbi, functionName: "isLive", args: [parties.provider.address] }), true);
    note(`agent #${id} (register ${reg.transactionHash})`);
    return id;
  });
  report.fact("provider ERC-8004 agent", `#${agentId}`, "chain");

  // Broker ------------------------------------------------------------------------------------
  const brokerUrl = `http://127.0.0.1:${BROKER_PORT}`;
  const api = brokerApi(brokerUrl);
  await report.step("start the broker (self-hosted facilitator = attester, refund keeper, CCIP watcher)", async (note) => {
    const env = sealedBrokerEnv(REPO, {
      XORV_NETWORK: NETWORK,
      XORV_RPC_URL: fork.url,
      XORV_OPERATOR_KEY: operator.key,
      XORV_FACILITATOR: "self",
      XORV_KEEPER_KEY: parties.keeper.key,
      XORV_ESCROW_ADDRESS: d.escrow,
      XORV_ESCROW_DEADLINE_S: "600",
      XORV_REPUTATION_ADDRESS: d.reputation,
      XORV_CCIP_RECEIVER_ADDRESS: d.ccipReceiver,
      XORV_LEDGER_ADDRESS: d.ledger,
      XORV_LEDGER_FROM_BLOCK: d.fromBlock.toString(),
      XORV_RECEIPT_BATCH_MS: "500",
      XORV_BROKER_PORT: String(BROKER_PORT),
      XORV_PUBLIC_URL: brokerUrl,
      XORV_BROKER_URL: brokerUrl,
      XORV_DB: path.join(runDir, "broker.db"),
      XORV_ROUTER: "off",
      XORV_SCREENER: "off",
      XORV_VERIFIER: "off",
    });
    const proc = group.start("broker", process.execPath, [BROKER_ENTRY], { cwd: runDir, env });
    await waitUntil("the broker to answer /health", 300_000, async () => {
      if (!proc.running) throw new Error(`the broker exited\n${tail(proc.output)}`);
      return (await api.raw("/health")).status === 200;
    });
    const info = await api.get<Record<string, any>>("/api/network");
    report.equal("broker reports the escrow", info.escrow?.address, d.escrow);
    report.equal("Arc stack: gas token", info.arc?.gasToken, "USDC");
    report.equal("Arc stack: Memo tagging on", info.arc?.memo?.enabled, true);
    report.equal("Arc stack: XorvReputation", info.arc?.reputation?.address, d.reputation);
    report.equal("Arc stack: CCIP receiver", info.arc?.ccip?.receiver?.address, d.ccipReceiver);
    report.equal("Arc stack: refund keeper on", info.arc?.keeper?.enabled, true);
    note(`listening on ${brokerUrl}`);
  });

  const providerHome = path.join(runDir, "provider");
  await report.step("provider: go live (xorv start, echo, ERC-8004 agent)", async (note) => {
    fs.mkdirSync(providerHome, { recursive: true });
    fs.writeFileSync(
      path.join(providerHome, "config.json"),
      JSON.stringify({
        nodeId: `e2e-arc-${Math.random().toString(36).slice(2, 10)}`,
        label: "e2e-arc-provider",
        network: NETWORK,
        brokerUrl,
        address: parties.provider.address,
        privateKey: parties.provider.key,
        agentId: agentId.toString(),
        capabilities: CAPABILITIES,
        region: null,
        tunnel: { enabled: false, hostname: null },
        sandboxDir: path.join(providerHome, "jobs"),
        providerId: null,
        token: null,
      }),
    );
    const env = { ...cleanEnv(), XORV_HOME: providerHome, XORV_NETWORK: NETWORK, XORV_RPC_URL: fork.url, XORV_BROKER_URL: brokerUrl };
    const proc = group.start("provider", process.execPath, [CLI_ENTRY, "start"], { cwd: providerHome, env });
    const live = await waitUntil("the provider to be online", 300_000, async () => {
      if (!proc.running) throw new Error(`xorv start exited\n${tail(proc.output)}`);
      const { providers } = await api.get<{ providers: PublicProvider[] }>("/api/providers");
      return providers.find((p) => p.address === parties.provider.address && p.connected);
    });
    report.equal("broker verified the provider's ERC-8004 agent", live.agentId, agentId.toString());
    note(`provider ${live.id} connected`);
  });

  // 2-3. x402 into escrow, release, ERC-8004 ------------------------------------------------------
  const released = await report.step("x402 in USDC: the buyer pays into XorvEscrow (Memo-tagged), the release pays the provider", async (note) => {
    const before = { buyer: await usdcBalance(fork.client, USDC, parties.buyer.address), provider: await usdcBalance(fork.client, USDC, parties.provider.address) };
    const quote = await api.post<QuoteResponse>("/api/quotes", { prompt: "Say hello to Arc", maxPriceUsdMicros: 10_000 });
    report.equal("the quote names the escrow", quote.escrow?.address, d.escrow);
    report.equal("the 402 offers escrow first", quote.accepts[0]?.scheme, "escrow");
    const paid = await payQuote({ quote, buyer, network: NETWORK });
    const done = await waitForJob(api, paid.jobId);
    report.equal("job completed", done.status, "completed");
    const job = await waitUntil("the escrow to be released", 60_000, async () => {
      const j = await getJob(api, paid.jobId);
      return j.payment?.escrow?.state === "released" ? j : null;
    });
    const jobId = escrowJobId(quote.quoteId) as Hex;
    const fundTx = job.payment!.txHash as Hex;
    const releaseTx = job.payment!.escrow!.releaseTx as Hex;

    const funding = await readSettlement(fork.client, USDC, fundTx);
    report.check(
      "funding moved exactly the price buyer → XorvEscrow",
      funding.transfers.some((t) => t.from === parties.buyer.address && t.to === d.escrow && t.value === PRICE_UNITS),
      JSON.stringify(funding.transfers.map((t) => ({ from: t.from, to: t.to, value: String(t.value) }))),
    );
    report.equal("funding sent by the facilitator (the buyer sent nothing)", funding.from, operator.address);
    report.equal("buyer never sent a transaction (nonce 0)", await fork.client.getTransactionCount({ address: parties.buyer.address }), 0);
    const fundMemo = await memosIn(fork, fundTx);
    report.check("Arc Memo on the funding: memoId = job id, target = escrow, text xorv:fund", fundMemo.some((m) => m.memoId === jobId && m.target === d.escrow && m.text === "xorv:fund"), JSON.stringify(fundMemo.map((m) => ({ id: m.memoId, t: m.text }))));

    const releaseReceipt = await receiptOf(fork, releaseTx);
    const releasedEvent = parseEventLogs({ abi: XORV_ESCROW_ABI, logs: releaseReceipt.logs, eventName: "JobReleased" })[0] as { args: { provider: string; resultHash: string } } | undefined;
    report.equal("JobReleased pays the provider", releasedEvent?.args.provider, parties.provider.address);
    report.equal("JobReleased carries the result's hash", releasedEvent?.args.resultHash, textHash(done.result ?? ""));
    const releaseMemo = await memosIn(fork, releaseTx);
    report.check("Arc Memo on the release: memoId = job id, text xorv:release", releaseMemo.some((m) => m.memoId === jobId && m.text === "xorv:release"));

    report.equal("buyer paid exactly the price", before.buyer - (await usdcBalance(fork.client, USDC, parties.buyer.address)), PRICE_UNITS);
    report.equal("provider received exactly the price", (await usdcBalance(fork.client, USDC, parties.provider.address)) - before.provider, PRICE_UNITS);
    report.fact("x402 funding gas", `${funding.gasUsed}`, "gas");
    report.fact("release gas (with the ERC-8004 write)", `${releaseReceipt.gasUsed}`, "gas");
    note(`fund ${fundTx}, release ${releaseTx}`);
    return { job, jobId, releaseTx, releaseReceipt };
  });

  await report.step("ERC-8004: the release wrote the outcome to Arc's Reputation Registry through XorvReputation", async () => {
    const outcome = parseEventLogs({ abi: xorvReputationAbi, logs: released.releaseReceipt.logs, eventName: "OutcomeRecorded" })[0] as
      | { args: { provider: string; agentId: bigint; success: boolean; feedbackWritten: boolean } }
      | undefined;
    report.check("OutcomeRecorded(success, feedbackWritten)", Boolean(outcome?.args.success && outcome.args.feedbackWritten), JSON.stringify(outcome?.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    const feedback = (await readFeedback(fork.client, NET.erc8004.reputation, agentId, d.fromBlock)).filter((f) => f.client === d.reputation);
    const last = feedback.at(-1);
    report.equal("NewFeedback client is XorvReputation", last?.client, d.reputation);
    report.equal("feedback value 100 (released)", last?.value, 100n);
    report.equal("feedback tag1", last?.tag1, "successRate");
    report.equal("feedback tag2", last?.tag2, "xorv-escrow");
    report.equal("feedbackHash is the escrow job id", last?.feedbackHash, released.jobId);
    const [completed, failed, earned] = (await fork.client.readContract({ address: d.reputation, abi: xorvReputationAbi, functionName: "stats", args: [parties.provider.address] })) as readonly [bigint, bigint, bigint, number];
    report.check("XorvReputation stats: 1 completed, 0 failed, earned the price", completed === 1n && failed === 0n && earned === PRICE_UNITS, `${completed}/${failed}/${earned}`);
    const view = await api.get<Record<string, unknown>>(`/api/providers/${released.job.providerId}/escrow`);
    report.check("broker serves the escrow record with the agent", view.completed === 1 && view.agentId === agentId.toString(), JSON.stringify(view));
  });

  await report.step("XorvLedger receipts the release; the buyer's gasless rating becomes ERC-8004 feedback", async (note) => {
    const withReceipt = await waitUntil("the receipt", 60_000, async () => {
      const j = await getJob(api, released.job.id);
      return j.receiptTxHash ? j : null;
    });
    const events = await readLedgerEvents(fork.client, d.ledger, d.fromBlock);
    const recorded = events.recorded.find((e) => e.transactionHash === withReceipt.receiptTxHash);
    report.equal("JobRecorded.paymentTx is the release", recorded?.args.paymentTx, released.releaseTx);
    report.equal("JobRecorded.agentId is the provider's agent", recorded?.args.agentId, agentId);
    const offer = await api.get<{ typedData: any; deadline: number }>(`/api/jobs/${released.job.id}/rating?value=95`);
    const signature = await buyer.signTypedData({
      ...offer.typedData,
      domain: { ...offer.typedData.domain, chainId: BigInt(offer.typedData.domain.chainId) },
      message: { ...offer.typedData.message, value: BigInt(offer.typedData.message.value), deadline: BigInt(offer.typedData.message.deadline) },
    });
    const rated = await api.post<{ txHash: Hex }>(`/api/jobs/${released.job.id}/rate`, { value: 95, deadline: offer.deadline, signature });
    const starred = (await readFeedback(fork.client, NET.erc8004.reputation, agentId, d.fromBlock)).find((f) => f.txHash === rated.txHash);
    report.equal("rating feedback client is XorvLedger", starred?.client, d.ledger);
    report.equal("rating value", starred?.value, 95n);
    report.equal("rating tag1", starred?.tag1, RATING_TAG1);
    note(`rate ${rated.txHash}`);
  });

  // 4. Cancel -----------------------------------------------------------------------------------
  await report.step("a buyer's cancel refunds the escrow in full, provider not at fault (Memo-tagged)", async (note) => {
    const before = await usdcBalance(fork.client, USDC, parties.buyer.address);
    const quote = await api.post<QuoteResponse>("/api/quotes", { prompt: "slow: please take your time", maxPriceUsdMicros: 10_000 });
    const paid = await payQuote({ quote, buyer, network: NETWORK });
    const res = await api.raw(`/api/jobs/${paid.jobId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${String(paid.body.cancelToken)}` },
      body: "{}",
    });
    const body = res.body as { refunded?: boolean; refundTx?: Hex; status?: string };
    if (body.status !== "failed") throw new Error(`the job finished before the cancel (${JSON.stringify(body)}); rerun`);
    const refund = parseEventLogs({ abi: XORV_ESCROW_ABI, logs: (await receiptOf(fork, body.refundTx!)).logs, eventName: "JobRefunded" })[0] as { args: { providerAtFault: boolean } } | undefined;
    report.equal("JobRefunded, provider not at fault", refund?.args.providerAtFault, false);
    report.check("Arc Memo on the refund (xorv:cancel)", (await memosIn(fork, body.refundTx!)).some((m) => m.text === "xorv:cancel"));
    report.equal("buyer made whole", await usdcBalance(fork.client, USDC, parties.buyer.address), before);
    note(`refund ${body.refundTx}`);
  });

  // 5. Chainlink CCIP -------------------------------------------------------------------------------
  const sourceSender = getAddress(`0x${keccak256(stringToHex("xorv-e2e-base-sepolia-sender")).slice(26)}`);
  const ccipSelector = BigInt(BASE_SEPOLIA.ccipSelector!);
  await report.step("CCIP: the owner allowlists a XorvCcipSender on Base Sepolia (selector + sender)", async () => {
    await send(deployer.key, { address: d.ccipReceiver, abi: xorvCcipReceiverAbi, functionName: "allowSender", args: [ccipSelector, sourceSender, true] } as never);
    report.equal("allowlisted", await fork.client.readContract({ address: d.ccipReceiver, abi: xorvCcipReceiverAbi, functionName: "allowedSenders", args: [ccipSelector, sourceSender] }), true);
  });

  /** Deliver a POST_JOB as Chainlink's real Arc router would (impersonated on this fork only). */
  async function deliverCcip(messageId: Hex, body: { jobId: Hex; requester: Address; provider: Address; price: bigint; deadline: number }) {
    const data = encodeAbiParameters(
      [{ type: "uint8" }, { type: "bytes" }],
      [1, encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint40" }], [body.jobId, body.requester, body.provider, body.price, body.deadline])],
    );
    const router = NET.ccip.router;
    await fork.rpc("anvil_impersonateAccount", [router]);
    await setUsdc(fork, router, 1_000_000n);
    const hash = await createWalletClient({ chain: viemChain(NETWORK), transport: http(fork.url) }).writeContract({
      account: router,
      address: d.ccipReceiver,
      abi: xorvCcipReceiverAbi,
      functionName: "ccipReceive",
      args: [{ messageId, sourceChainSelector: ccipSelector, sender: encodeAbiParameters([{ type: "address" }], [sourceSender]), data, destTokenAmounts: [] }],
      gas: 1_500_000n,
      chain: viemChain(NETWORK),
    } as never);
    await fork.rpc("anvil_stopImpersonatingAccount", [router]);
    const receipt = await fork.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`ccipReceive reverted (${hash})`);
    return receipt;
  }

  /** What CCTP's mint into the receiver would do: USDC arrives at the receiver (no attestation exists on a fork). */
  async function simulateCctpMint(amount: bigint) {
    return send(parties.cctp.key, { address: USDC, abi: parseAbi(["function transfer(address,uint256) returns (bool)"]), functionName: "transfer", args: [d.ccipReceiver, amount] } as never);
  }

  await report.step("CCIP: a buyer agent on Base Sepolia funds a quoted job; the broker runs it and releases it", async (note) => {
    const quote = (await api.post<QuoteResponse & { ccip?: any }>("/api/quotes", { prompt: "Say hello from Base", maxPriceUsdMicros: 10_000, payVia: "ccip" })) as QuoteResponse;
    const terms = quote.ccip!;
    report.equal("CCIP terms name the receiver", terms.receiver, d.ccipReceiver);
    report.equal("CCIP terms carry Arc's selector", terms.arcChainSelector, NET.ccip.chainSelector);
    report.check("Base Sepolia is a CCIP source", terms.sources.some((s) => s.chainId === 84532));
    const requesterBefore = await usdcBalance(fork.client, USDC, parties.requester.address);
    await simulateCctpMint(BigInt(terms.price) + 1_000n); // price + CCTP fast-transfer fee headroom
    const messageId = keccak256(stringToHex(`ccip-msg-${quote.quoteId}`));
    const delivery = await deliverCcip(messageId, { jobId: terms.jobId as Hex, requester: parties.requester.address, provider: terms.provider as Address, price: BigInt(terms.price), deadline: terms.deadline });
    const funded = parseEventLogs({ abi: XORV_ESCROW_ABI, logs: delivery.logs, eventName: "JobFunded" })[0] as { args: { buyer: string; provider: string } } | undefined;
    report.equal("escrow JobFunded by the receiver (buyer of record)", funded?.args.buyer, d.ccipReceiver);
    const job = await waitUntil("the broker to open and finish the CCIP job", 90_000, async () => {
      const { jobs } = await api.get<{ jobs: PublicJob[] }>("/api/jobs?limit=20");
      const j = jobs.find((x) => x.payment?.crossChain && x.payment.escrow?.jobId === terms.jobId);
      if (!j) return null;
      const full = await getJob(api, j.id);
      return full.payment?.escrow?.state === "released" ? full : null;
    });
    report.equal("job payment is cross-chain via CCIP", job.payment?.crossChain?.via, "ccip");
    report.equal("source chain", job.payment?.crossChain?.sourceChain, "Base Sepolia");
    report.equal("payer is the requester", job.payment?.payer, parties.requester.address);
    report.equal("CCIP message id", job.payment?.crossChain?.messageId, messageId);
    const intent = await waitUntil("the receiver to close the intent (markReleased)", 60_000, async () => {
      const it = (await fork.client.readContract({ address: d.ccipReceiver, abi: xorvCcipReceiverAbi, functionName: "getIntent", args: [terms.jobId as Hex] })) as { status: number };
      return it.status === 3 ? it : null;
    });
    report.equal("receiver intent status Released", intent.status, 3);
    report.equal("requester spent nothing on Arc", await usdcBalance(fork.client, USDC, parties.requester.address), requesterBefore);
    note(`ccipReceive ${delivery.transactionHash}, release ${job.payment?.escrow?.releaseTx}`);
  });

  // 6. Refund keeper -------------------------------------------------------------------------------
  await report.step("refund keeper: an orphaned CCIP job past its deadline is refunded (no fault) and forwarded to the requester", async (note) => {
    const block = await fork.client.getBlock();
    const deadline = Number(block.timestamp) + 120;
    const orphan = keccak256(stringToHex(`orphan-${Date.now()}`));
    await simulateCctpMint(2_000n);
    await deliverCcip(keccak256(stringToHex(`ccip-orphan-${orphan}`)), { jobId: orphan, requester: parties.requester.address, provider: parties.provider.address, price: 2_000n, deadline });
    const before = await usdcBalance(fork.client, USDC, parties.requester.address);
    await warp(fork, 180);
    const refunded = await waitUntil("the keeper's refund", 90_000, async () => {
      const job = (await fork.client.readContract({ address: d.escrow, abi: XORV_ESCROW_ABI, functionName: "getJob", args: [orphan] })) as { status: number };
      return job.status === 3 ? job : null;
    });
    report.equal("escrow status Refunded", refunded.status, 3);
    const logs = await fork.client.getContractEvents({ address: d.escrow, abi: XORV_ESCROW_ABI, eventName: "JobRefunded", args: { jobId: orphan }, fromBlock: d.fromBlock });
    const tx = await fork.client.getTransaction({ hash: logs[0]!.transactionHash });
    report.equal("refunded by the keeper key", getAddress(tx.from), parties.keeper.address);
    report.equal("deadline refund is not the provider's fault", (logs[0]!.args as { providerAtFault: boolean }).providerAtFault, false);
    await waitUntil("claimRefund to forward the USDC to the requester", 60_000, async () => ((await usdcBalance(fork.client, USDC, parties.requester.address)) - before === 2_000n ? true : null));
    report.equal("requester got the price back on Arc", (await usdcBalance(fork.client, USDC, parties.requester.address)) - before, 2_000n);
    note(`refund ${logs[0]!.transactionHash}`);
  });

  // 7. CCTP V2 withdraw ------------------------------------------------------------------------------
  await report.step("CCTP V2: the provider withdraws its Arc earnings to Base Sepolia (real TokenMessengerV2)", async (note) => {
    const amount = 1_000_000n;
    const plan = planCctpWithdraw(NETWORK, { destination: BASE_SEPOLIA, amount, recipient: parties.provider.address });
    const before = await usdcBalance(fork.client, USDC, parties.provider.address);
    await send(parties.provider.key, { address: USDC, abi: ERC20_APPROVE_ABI, functionName: "approve", args: [plan.tokenMessenger, amount] } as never);
    const burn = await send(parties.provider.key, { address: plan.tokenMessenger, abi: TOKEN_MESSENGER_V2_ABI, functionName: "depositForBurn", args: plan.args } as never);
    const ev = parseEventLogs({ abi: TOKEN_MESSENGER_V2_ABI, logs: burn.logs, eventName: "DepositForBurn" })[0] as { args: { amount: bigint; destinationDomain: number; mintRecipient: Hex } } | undefined;
    report.equal("DepositForBurn to domain 6 (Base Sepolia)", ev?.args.destinationDomain, 6);
    report.equal("burned amount", ev?.args.amount, amount);
    report.equal("mint recipient is the provider", ev?.args.mintRecipient?.toLowerCase(), `0x${"0".repeat(24)}${parties.provider.address.slice(2).toLowerCase()}`);
    const spent = before - (await usdcBalance(fork.client, USDC, parties.provider.address));
    report.check("provider's USDC debited by the amount (plus gas, paid in USDC)", spent >= amount && spent < amount + 100_000n, String(spent));
    note(`burn ${burn.transactionHash}; the mint on Base Sepolia needs Circle's attestation, which a fork can't get`);
  });

  // 8. Circle Gateway ---------------------------------------------------------------------------------
  await report.step("Circle Gateway: the broker reads a unified balance from Circle's live testnet API", async (note) => {
    const res = await api.raw(`/api/gateway?depositor=${parties.buyer.address}`);
    const body = res.body as { available?: boolean; totalUnits?: string; balances?: unknown[]; error?: string };
    if (res.status !== 200) throw new Error(`GET /api/gateway → ${res.status}: ${body.error ?? ""}`);
    report.equal("a fresh buyer's unified balance is 0", body.totalUnits, "0");
    report.check("Circle answered per source domain", Array.isArray(body.balances) && body.balances.length > 0, String(body.balances?.length));
    const intent = await api.post<{ typedData: any }>("/api/gateway/intent", { depositor: parties.buyer.address, sourceDomain: 6, amountUnits: "1000000" });
    report.equal("burn intent targets Arc (domain 26)", intent.typedData.message.spec.destinationDomain, 26);
    note("spending a real Gateway balance needs testnet USDC deposited on a source chain (user-run)");
  });
}

main().then(
  () => finish(0),
  (err) => {
    report.error ??= err instanceof Error ? err.message : String(err);
    return finish(1);
  },
);
