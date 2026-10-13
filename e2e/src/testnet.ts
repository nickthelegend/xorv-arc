/**
 * `pnpm e2e:testnet`: the core Xorv loop on the PUBLIC Arc testnet (chain 5042002), no fork.
 *
 * It uses the contracts already deployed (deployments/arc-testnet.json) and real transactions:
 *  1. the provider registers an ERC-8004 agent on Arc's Identity Registry and binds it in XorvReputation;
 *  2. a buyer pays a job over x402 (EIP-3009, gasless for the buyer); the broker's facilitator funds XorvEscrow
 *     (Memo-tagged when the RPC has the predeploy);
 *  3. the provider node delivers, the broker releases the escrow and XorvReputation writes the outcome to the
 *     ERC-8004 Reputation Registry; XorvLedger receipts the job;
 *  4. the buyer's gasless EIP-712 rating becomes ERC-8004 feedback;
 *  5. a second, AI-routed job (screener / router / verifier on the local mock model server, the provider's qwen adapter)
 *     whose verification is written to ERC-8004 too.
 *
 * Keys come from a gitignored env file (XORV_TESTNET_ENV, default <repo>/.env.local, or ../xorv-arc/.env.local); they are
 * never printed. Each needs a little testnet USDC (gas). Writes docs/E2E-TESTNET.md with explorer links.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, getAddress, http, parseAbi, parseEventLogs, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ARC_TESTNET,
  IDENTITY_ABI,
  RATING_TAG1,
  XORV_ESCROW_ABI,
  escrowJobId,
  memoEventsIn,
  networkConfig,
  textHash,
  viemChain,
  xorvReputationAbi,
  type Capability,
  type PublicProvider,
  type QuoteResponse,
} from "@xorv/protocol";
import { brokerApi, getJob, payQuote, waitForJob } from "./api.js";
import { waitUntil } from "./chain.js";
import { cleanEnv, sealedBrokerEnv } from "./env.js";
import { answerToken, startMockLlm, VERIFIER_SCORE, type MockLlm } from "./mock-llm.js";
import { readFeedback, readLedgerEvents, readSettlement, usdcBalance } from "./onchain.js";
import { ProcessGroup, tail } from "./procs.js";
import { Report, bold, dim } from "./report.js";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const BROKER_ENTRY = path.join(REPO, "services", "broker", "dist", "index.js");
const CLI_ENTRY = path.join(REPO, "packages", "cli", "dist", "index.js");
const NETWORK = ARC_TESTNET;
const NET = networkConfig(NETWORK);
const RPC = process.env.XORV_TESTNET_RPC?.trim() || "https://rpc.testnet.arc.io";
const EXPLORER = "https://explorer.testnet.arc.io";
const USDC = NET.usdc.address as Address;
const MEMO = NET.circle.memo;
const BROKER_PORT = Number(process.env.XORV_E2E_BROKER_PORT ?? 8812);
const CAPABILITIES: Capability[] = [
  { id: "echo", adapter: "echo", displayName: "Echo (test)", model: null, priceUsdMicros: 1_000, maxConcurrency: 4 },
  { id: "qwen", adapter: "qwen", displayName: "Qwen 3.8 Max", model: "qwen3.8-max", priceUsdMicros: 40_000, maxConcurrency: 2 },
];

// Printed at the top of docs/E2E-TESTNET.md so nobody reads the AI job as a real-model run.
const MOCK_NOTE = [
  "",
  "",
  "## What is real and what is not",
  "",
  "- **Real, on Arc testnet (5042002)**: every transaction below, the x402/EIP-3009 funding into XorvEscrow, Arc Memo tags,",
  "  the release to the provider, the ERC-8004 registration and feedback, the XorvLedger receipt, the gasless rating, the",
  "  broker's `/api/network`, and the USDC balances. Nothing here is a fork.",
  "- **Mocked**: the model APIs. The screener, router and verifier roles, and the provider's `qwen` adapter, called a local",
  "  mock OpenAI-compatible server (`e2e/src/mock-llm.ts`) that answers by rule. So the AI job's answer and the **verification",
  "  score of 92 are the mock's, not a model's**. The provider's other capability, `echo`, is a labelled test capability.",
  "  No real Qwen, Kimi, Hunyuan or Claude call was made in this run. A broker started without the mock variables calls the",
  "  real endpoints, or leaves a role off when its key is unset.",
  "- **Not covered here** (each needs another chain): Circle Gateway, CCTP V2 withdrawals, Chainlink CCIP cross-chain jobs.",
  "  Deadline refunds, cancel and reassign were not run on testnet either.",
].join("\n");

const tx = (hash: string) => `[${hash}](${EXPLORER}/tx/${hash})`;
const addr = (a: string) => `[${a}](${EXPLORER}/address/${a})`;

function loadEnvFile(): Record<string, string> {
  const candidates = [process.env.XORV_TESTNET_ENV, path.join(REPO, ".env.local"), path.join(REPO, "..", "xorv-arc", ".env.local")].filter(Boolean) as string[];
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) throw new Error("no env file with the testnet keys (set XORV_TESTNET_ENV)");
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

const report = new Report();
const E2E_DIR = path.join(REPO, "e2e");
const runDir = fs.mkdtempSync(path.join((fs.mkdirSync(path.join(E2E_DIR, ".runs"), { recursive: true }), path.join(E2E_DIR, ".runs")), "testnet-"));
const group = new ProcessGroup(path.join(runDir, "logs"));
let mock: MockLlm | null = null;
let finishing: Promise<never> | null = null;
const OUT = process.env.XORV_TESTNET_REPORT ?? path.join(REPO, "docs", "E2E-TESTNET.md");

// XORV_TESTNET_HOLD=1: after a passing run keep the broker, provider node and mock model server up (so the app can be
// pointed at them) until SIGTERM/SIGINT.
const HOLD = process.env.XORV_TESTNET_HOLD === "1";
let holding = false;
const APP_ORIGINS = process.env.XORV_TESTNET_APP_ORIGINS ?? "http://127.0.0.1:8820,http://localhost:8820";

process.on("exit", () => group.killAllSync());
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (holding) {
      void group.stopAll().then(() => mock?.close()).catch(() => undefined).finally(() => {
        fs.rmSync(runDir, { recursive: true, force: true });
        process.exit(0);
      });
      return;
    }
    report.error ??= `interrupted by ${signal}`;
    void finish(130);
  });
}

function finish(code: number): Promise<never> {
  finishing ??= (async (): Promise<never> => {
    const keepUp = HOLD && report.passed;
    if (!keepUp) {
      await group.stopAll();
      await mock?.close().catch(() => undefined);
    }
    let markdown = report.markdown({
      command: "pnpm e2e:testnet",
      environment: [
        ["node", process.version],
        ["platform", `${process.platform} ${os.release()}`],
        ["chain", `Arc testnet (5042002) via ${RPC}, no fork`],
        ["duration", `${((Date.now() - report.startedAt.getTime()) / 1000).toFixed(1)} s`],
      ],
    });
    markdown = markdown
      .replace("# Xorv end-to-end run", "# Xorv end-to-end run on the public Arc testnet")
      .replace(/Produced by .*\nforked chain or the running processes during the run; transaction hashes are local to that fork\./s, "Produced by `pnpm e2e:testnet`. Every value below was read back from Arc testnet (chain 5042002) or the running processes;\nevery transaction hash is a real transaction, linked to the Arc explorer." + MOCK_NOTE);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, markdown);
    process.stderr.write(`\n${bold(report.summaryLine())}\n${dim(`report: ${path.relative(REPO, OUT)}`)}\n`);
    if (keepUp) {
      holding = true;
      process.stderr.write(`${bold("holding")}: broker http://127.0.0.1:${BROKER_PORT} (pid ${process.pid} owns it); send SIGTERM to stop\n`);
      await new Promise<never>(() => undefined);
    }
    if (report.passed) fs.rmSync(runDir, { recursive: true, force: true });
    else {
      process.stderr.write(`${dim(`logs kept in ${path.join(runDir, "logs")}`)}\n`);
      for (const proc of group.list()) if (proc.output.trim()) process.stderr.write(`\n--- ${proc.name} (last lines) ---\n${tail(proc.output, 25)}\n`);
    }
    process.exit(report.passed ? 0 : code);
  })();
  return finishing;
}

async function main(): Promise<void> {
  const env = loadEnvFile();
  const dep = JSON.parse(fs.readFileSync(path.join(REPO, "deployments", "arc-testnet.json"), "utf8")) as {
    blockNumber: number;
    contracts: { XorvLedger: Address; XorvReputation: Address; XorvEscrow: Address; XorvCcipReceiver: Address };
  };
  const d = { ledger: dep.contracts.XorvLedger, reputation: dep.contracts.XorvReputation, escrow: dep.contracts.XorvEscrow, ccip: dep.contracts.XorvCcipReceiver, fromBlock: BigInt(dep.blockNumber) };
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} missing from the env file`);
    return v as Hex;
  };
  const keys = { operator: need("XORV_OPERATOR_KEY"), keeper: need("XORV_KEEPER_KEY"), buyer: need("XORV_DEMO_PAYER_KEY"), provider: need("XORV_DEMO_PROVIDER_KEY") };
  const buyer = privateKeyToAccount(keys.buyer);
  // XorvReputation binds a provider address to ONE agent, so a repeat run uses a fresh provider key (a one-off
  // funded from the configured provider) unless XORV_TESTNET_FRESH=0.
  const funder = keys.provider;
  const fresh = process.env.XORV_TESTNET_FRESH !== "0";
  if (fresh) keys.provider = generatePrivateKey();
  const provider = privateKeyToAccount(keys.provider);
  const operator = privateKeyToAccount(keys.operator);
  const keeper = privateKeyToAccount(keys.keeper);

  const client = createPublicClient({ chain: viemChain(NETWORK), transport: http(RPC) });
  const wallet = (key: Hex) => createWalletClient({ chain: viemChain(NETWORK), transport: http(RPC), account: privateKeyToAccount(key) });
  const txs: Hex[] = [];
  const record = (label: string, hash: string) => {
    report.fact(label, tx(hash), "transactions");
  };
  const send = async (key: Hex, label: string, req: Record<string, unknown>) => {
    const hash = await wallet(key).writeContract(req as never);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} reverted (${hash})`);
    record(label, hash);
    txs.push(hash);
    return receipt;
  };

  report.fact("broker operator (escrow attester, ledger broker, facilitator, verifier)", addr(operator.address), "parties");
  report.fact("keeper (deadline refunds)", addr(keeper.address), "parties");
  report.fact("provider", addr(provider.address), "parties");
  report.fact("buyer (holds USDC only, sends no transaction)", addr(buyer.address), "parties");
  report.fact("XorvLedger", addr(d.ledger), "contracts");
  report.fact("XorvEscrow", addr(d.escrow), "contracts");
  report.fact("XorvReputation", addr(d.reputation), "contracts");
  report.fact("XorvCcipReceiver", addr(d.ccip), "contracts");

  if (fresh) {
    await report.step("fund a fresh provider key (0.05 USDC) from the configured provider", async () => {
      await send(funder, "fund the fresh provider with 0.05 USDC", { address: USDC, abi: parseAbi(["function transfer(address,uint256) returns (bool)"]), functionName: "transfer", args: [provider.address, 50_000n] });
    });
  }

  await report.step("preflight: built, public RPC reachable, deployment is live, parties funded", async (note) => {
    const missing = [BROKER_ENTRY, CLI_ENTRY].filter((f) => !fs.existsSync(f));
    if (missing.length) throw new Error(`missing ${missing.map((f) => path.relative(REPO, f)).join(", ")}: run \`pnpm build\``);
    report.equal("RPC chain id", await client.getChainId(), 5042002);
    report.equal("escrow attester is the broker operator", await client.readContract({ address: d.escrow, abi: XORV_ESCROW_ABI, functionName: "attester" }), operator.address);
    report.equal("escrow reports to XorvReputation", await client.readContract({ address: d.escrow, abi: XORV_ESCROW_ABI, functionName: "registry" }), d.reputation);
    for (const [name, a] of [["operator", operator], ["provider", provider], ["buyer", buyer]] as const) {
      const bal = await usdcBalance(client, USDC, a.address);
      report.check(`${name} has testnet USDC`, bal > 0n, `${bal} units`);
    }
    const memoCode = await client.getCode({ address: MEMO as Address });
    report.check("Arc Memo predeploy is live on the public RPC", Boolean(memoCode && memoCode !== "0x"), `${MEMO}`);
    note(`block ${await client.getBlockNumber()}`);
  });
  const startBlock = (await client.getBlockNumber()) - 50n;
  const balancesBefore = { buyer: await usdcBalance(client, USDC, buyer.address), provider: await usdcBalance(client, USDC, provider.address), operator: await usdcBalance(client, USDC, operator.address) };

  const mockKeys = { qwen: "tn-qwen", kimi: "tn-kimi", hunyuan: "tn-hunyuan" };
  mock = await report.step("start the mock OpenAI-compatible model server", async (note) => {
    const server = await startMockLlm({ keys: mockKeys });
    note(`listening on ${server.url}`);
    return server;
  });

  const brokerUrl = `http://127.0.0.1:${BROKER_PORT}`;
  const api = brokerApi(brokerUrl);
  const providerHome = path.join(runDir, "provider");
  const providerEnv: NodeJS.ProcessEnv = {
    ...cleanEnv(),
    XORV_HOME: providerHome,
    XORV_NETWORK: NETWORK,
    XORV_RPC_URL: RPC,
    XORV_BROKER_URL: brokerUrl,
    XORV_QWEN_API_KEY: mockKeys.qwen,
    XORV_QWEN_BASE_URL: mock.baseUrl("qwen"),
  };

  // 1. ERC-8004 -------------------------------------------------------------------------------
  const agentId = await report.step("ERC-8004: the provider registers an agent (xorv identity register) and binds it in XorvReputation", async (note) => {
    fs.mkdirSync(providerHome, { recursive: true });
    fs.writeFileSync(
      path.join(providerHome, "config.json"),
      JSON.stringify({
        nodeId: `testnet-${Math.random().toString(36).slice(2, 10)}`,
        label: "e2e-testnet-provider",
        network: NETWORK,
        brokerUrl,
        address: provider.address,
        privateKey: keys.provider,
        agentId: null,
        capabilities: CAPABILITIES,
        region: null,
        tunnel: { enabled: false, hostname: null },
        sandboxDir: path.join(providerHome, "jobs"),
        providerId: null,
        token: null,
      }),
    );
    const result = await group.run("identity-register", process.execPath, [CLI_ENTRY, "identity", "register", "--yes"], { cwd: providerHome, env: providerEnv, timeoutMs: 120_000 });
    const out = `${result.stdout}\n${result.stderr}`;
    if (result.code !== 0) throw new Error(`xorv identity register exited ${result.code}\n${tail(out)}`);
    const saved = JSON.parse(fs.readFileSync(path.join(providerHome, "config.json"), "utf8")) as { agentId: string | null };
    if (!saved.agentId) throw new Error(`no agent id saved\n${tail(out)}`);
    const id = BigInt(saved.agentId);
    const regLogs = await client.getContractEvents({ address: NET.erc8004.identity, abi: IDENTITY_ABI, eventName: "Registered", args: { agentId: id }, fromBlock: startBlock, toBlock: "latest" });
    const regTx = regLogs[0]?.transactionHash;
    if (regTx) record("ERC-8004 Identity Registry: register()", regTx);
    report.equal("agent wallet is the provider's payout address", await client.readContract({ address: NET.erc8004.identity, abi: IDENTITY_ABI, functionName: "getAgentWallet", args: [id] }), provider.address);
    const [bound0] = (await client.readContract({ address: d.reputation, abi: xorvReputationAbi, functionName: "agentOf", args: [provider.address] })) as readonly [boolean, bigint];
    if (!bound0) await send(keys.provider, "XorvReputation.bind(agent)", { address: d.reputation, abi: xorvReputationAbi, functionName: "bind", args: [id] });
    const [bound, bAgent] = (await client.readContract({ address: d.reputation, abi: xorvReputationAbi, functionName: "agentOf", args: [provider.address] })) as readonly [boolean, bigint];
    report.check("XorvReputation binds the provider to its agent", bound && bAgent === id, `${bound} #${bAgent}`);
    report.equal("binding is live", await client.readContract({ address: d.reputation, abi: xorvReputationAbi, functionName: "isLive", args: [provider.address] }), true);
    note(`agent #${id}`);
    return id;
  });
  report.fact("provider ERC-8004 agent", `#${agentId} ([registry](${EXPLORER}/address/${NET.erc8004.identity}))`, "chain");

  // Broker + provider ----------------------------------------------------------------------------
  await report.step("start the broker against the public RPC (facilitator = attester, keeper, ledger receipts, AI roles on the mock)", async (note) => {
    const benv = sealedBrokerEnv(REPO, {
      XORV_NETWORK: NETWORK,
      XORV_RPC_URL: RPC,
      XORV_OPERATOR_KEY: keys.operator,
      XORV_FACILITATOR: "self",
      XORV_KEEPER_KEY: keys.keeper,
      XORV_ESCROW_ADDRESS: d.escrow,
      XORV_ESCROW_DEADLINE_S: "600",
      XORV_REPUTATION_ADDRESS: d.reputation,
      XORV_CCIP_RECEIVER_ADDRESS: d.ccip,
      XORV_LEDGER_ADDRESS: d.ledger,
      XORV_LEDGER_FROM_BLOCK: d.fromBlock.toString(),
      XORV_RECEIPT_BATCH_MS: "1500",
      XORV_BROKER_PORT: String(BROKER_PORT),
      XORV_PUBLIC_URL: brokerUrl,
      XORV_BROKER_URL: brokerUrl,
      XORV_CORS_ORIGINS: APP_ORIGINS,
      XORV_DB: path.join(runDir, "broker.db"),
      XORV_SCREENER: "hunyuan",
      XORV_ROUTER: "qwen",
      XORV_VERIFIER: "kimi",
      XORV_SCREENER_FAIL: "closed",
      XORV_HUNYUAN_API_KEY: mockKeys.hunyuan,
      XORV_HUNYUAN_BASE_URL: mock!.baseUrl("hunyuan"),
      XORV_QWEN_API_KEY: mockKeys.qwen,
      XORV_QWEN_BASE_URL: mock!.baseUrl("qwen"),
      XORV_KIMI_API_KEY: mockKeys.kimi,
      XORV_KIMI_BASE_URL: mock!.baseUrl("kimi"),
    });
    const proc = group.start("broker", process.execPath, [BROKER_ENTRY], { cwd: runDir, env: benv, echo: process.env.XORV_E2E_ECHO === "1" });
    await waitUntil("the broker to answer /health", 120_000, async () => {
      if (!proc.running) throw new Error(`the broker exited\n${tail(proc.output)}`);
      return (await api.raw("/health")).status === 200;
    }, 500);
    const info = await api.get<Record<string, any>>("/api/network");
    report.equal("broker chain id", info.chainId, 5042002);
    report.equal("broker reports the escrow", info.escrow?.address, d.escrow);
    report.equal("Arc stack: gas token", info.arc?.gasToken, "USDC");
    report.equal("Arc stack: Memo tagging on", info.arc?.memo?.enabled, true);
    report.equal("Arc stack: XorvReputation", info.arc?.reputation?.address, d.reputation);
    report.equal("Arc stack: refund keeper on", info.arc?.keeper?.enabled, true);
    report.equal("ledger mode", info.ledger?.mode, "write");
    note(`listening on ${brokerUrl}`);
  });

  await report.step("provider: go live (xorv start, echo + qwen adapters, ERC-8004 agent)", async (note) => {
    const proc = group.start("provider", process.execPath, [CLI_ENTRY, "start"], { cwd: providerHome, env: providerEnv, echo: process.env.XORV_E2E_ECHO === "1" });
    const live = await waitUntil("the provider to be online", 180_000, async () => {
      if (!proc.running) throw new Error(`xorv start exited\n${tail(proc.output)}`);
      const { providers } = await api.get<{ providers: PublicProvider[] }>("/api/providers");
      return providers.find((p) => p.address === provider.address && p.connected);
    }, 500);
    report.equal("broker verified the provider's ERC-8004 agent", live.agentId, agentId.toString());
    note(`provider ${live.id} connected`);
  });

  // 2-3. x402 into escrow, release, ERC-8004 ----------------------------------------------------------
  const released = await report.step("x402 in USDC: the buyer pays into XorvEscrow (Memo-tagged); delivery releases to the provider", async (note) => {
    const before = { buyer: await usdcBalance(client, USDC, buyer.address), provider: await usdcBalance(client, USDC, provider.address) };
    const quote = await api.post<QuoteResponse>("/api/quotes", { prompt: "Say hello to Arc testnet", adapter: "echo", maxPriceUsdMicros: 10_000 });
    report.equal("the quote names the escrow", quote.escrow?.address, d.escrow);
    report.equal("the 402 offers escrow first", quote.accepts[0]?.scheme, "escrow");
    const paid = await payQuote({ quote, buyer, network: NETWORK });
    const done = await waitForJob(api, paid.jobId, 180_000);
    report.equal("job completed", done.status, "completed");
    const job = await waitUntil("the escrow to be released", 120_000, async () => {
      const j = await getJob(api, paid.jobId);
      return j.payment?.escrow?.state === "released" ? j : null;
    }, 500);
    const jobId = escrowJobId(quote.quoteId) as Hex;
    const fundTx = job.payment!.txHash as Hex;
    const releaseTx = job.payment!.escrow!.releaseTx as Hex;
    record("x402 funding: buyer -> XorvEscrow (sent by the facilitator)", fundTx);
    record("escrow release -> provider (+ ERC-8004 feedback)", releaseTx);

    const funding = await readSettlement(client, USDC, fundTx);
    report.check("funding moved exactly the price buyer -> XorvEscrow", funding.transfers.some((t) => t.from === buyer.address && t.to === d.escrow && t.value === 1_000n), JSON.stringify(funding.transfers.map((t) => ({ from: t.from, to: t.to, value: String(t.value) }))));
    report.equal("funding sent by the facilitator (the buyer sent nothing)", funding.from, operator.address);
    report.equal("buyer never sent a transaction (nonce 0)", await client.getTransactionCount({ address: buyer.address }), 0);
    const fundMemo = memoEventsIn((await client.getTransactionReceipt({ hash: fundTx })).logs, MEMO);
    report.check("Arc Memo on the funding (memoId = job id, text xorv:fund)", fundMemo.some((m) => m.memoId === jobId && m.target === d.escrow && m.text === "xorv:fund"), JSON.stringify(fundMemo.map((m) => ({ id: m.memoId, t: m.text }))));
    const releaseReceipt = await client.getTransactionReceipt({ hash: releaseTx });
    const ev = parseEventLogs({ abi: XORV_ESCROW_ABI, logs: releaseReceipt.logs, eventName: "JobReleased" })[0] as { args: { provider: string; resultHash: string } } | undefined;
    report.equal("JobReleased pays the provider", ev?.args.provider, provider.address);
    report.equal("JobReleased carries the result's hash", ev?.args.resultHash, textHash(done.result ?? ""));
    report.check("Arc Memo on the release (text xorv:release)", memoEventsIn(releaseReceipt.logs, MEMO).some((m) => m.memoId === jobId && m.text === "xorv:release"));
    report.equal("buyer paid exactly the price", before.buyer - (await usdcBalance(client, USDC, buyer.address)), 1_000n);
    report.equal("provider received exactly the price", (await usdcBalance(client, USDC, provider.address)) - before.provider, 1_000n);
    report.fact("x402 funding gas", `${funding.gasUsed}`, "gas");
    report.fact("release gas (with the ERC-8004 write)", `${releaseReceipt.gasUsed}`, "gas");
    note(`job ${paid.jobId}`);
    return { job, jobId, releaseTx, releaseReceipt };
  });

  await report.step("ERC-8004: the release wrote the outcome to the Reputation Registry through XorvReputation", async () => {
    const outcome = parseEventLogs({ abi: xorvReputationAbi, logs: released.releaseReceipt.logs, eventName: "OutcomeRecorded" })[0] as { args: { success: boolean; feedbackWritten: boolean } } | undefined;
    report.check("OutcomeRecorded(success, feedbackWritten)", Boolean(outcome?.args.success && outcome.args.feedbackWritten), JSON.stringify(outcome?.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    const feedback = (await readFeedback(client, NET.erc8004.reputation, agentId, startBlock)).filter((f) => f.client === d.reputation);
    const last = feedback.at(-1);
    report.equal("NewFeedback client is XorvReputation", last?.client, d.reputation);
    report.equal("feedback value 100 (released)", last?.value, 100n);
    report.equal("feedback tag1", last?.tag1, "successRate");
    report.equal("feedback tag2", last?.tag2, "xorv-escrow");
    report.equal("feedbackHash is the escrow job id", last?.feedbackHash, released.jobId);
    const [completed, failed, earned] = (await client.readContract({ address: d.reputation, abi: xorvReputationAbi, functionName: "stats", args: [provider.address] })) as readonly [bigint, bigint, bigint, number];
    report.check("XorvReputation stats: 1 completed, 0 failed, earned the price", completed >= 1n && failed === 0n && earned >= 1_000n, `${completed}/${failed}/${earned}`);
    const view = await api.get<Record<string, unknown>>(`/api/providers/${released.job.providerId}/escrow`);
    report.check("broker serves the escrow record with the agent", Number(view.completed) >= 1 && view.agentId === agentId.toString(), JSON.stringify(view));
  });

  // 4. Ledger receipt + rating ---------------------------------------------------------------------------
  await report.step("XorvLedger receipts the release; the buyer's gasless rating becomes ERC-8004 feedback", async (note) => {
    const withReceipt = await waitUntil("the receipt", 120_000, async () => {
      const j = await getJob(api, released.job.id);
      return j.receiptTxHash ? j : null;
    }, 500);
    record("XorvLedger.recordJobs (receipt)", withReceipt.receiptTxHash!);
    const events = await readLedgerEvents(client, d.ledger, startBlock);
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
    record("buyer rating (EIP-712, relayed by the broker) -> ERC-8004 feedback", rated.txHash);
    const starred = (await readFeedback(client, NET.erc8004.reputation, agentId, startBlock)).find((f) => f.txHash === rated.txHash);
    report.equal("rating feedback client is XorvLedger", starred?.client, d.ledger);
    report.equal("rating value", starred?.value, 95n);
    report.equal("rating tag1", starred?.tag1, RATING_TAG1);
    note(`rate ${rated.txHash}`);
  });

  // 5. AI-routed job ---------------------------------------------------------------------------------------
  await report.step("AI job: screener + router + provider's qwen adapter + verifier (all on the mock model server, no real model called), escrowed and released", async (note) => {
    const prompt = `Explain Arc testnet in two lines (testnet e2e ${Math.random().toString(36).slice(2, 8)})`;
    const quote = await api.post<QuoteResponse>("/api/quotes", { prompt, maxPriceUsdMicros: 100_000 });
    const paid = await payQuote({ quote, buyer, network: NETWORK });
    const done = await waitForJob(api, paid.jobId, 180_000);
    report.equal("AI job completed", done.status, "completed");
    report.check("result came from the provider's qwen adapter (answered by the mock model server)", Boolean(done.result?.includes(answerToken(prompt))), answerToken(prompt));
    const job = await waitUntil("the escrow to be released", 120_000, async () => {
      const j = await getJob(api, paid.jobId);
      return j.payment?.escrow?.state === "released" ? j : null;
    }, 500);
    record("AI job: x402 funding -> XorvEscrow", job.payment!.txHash as string);
    record("AI job: escrow release -> provider", job.payment!.escrow!.releaseTx as string);
    const verified = await waitUntil("the verifier's ERC-8004 feedback", 120_000, async () => {
      const j = await getJob(api, paid.jobId);
      const v = j.verification as (typeof j.verification & { feedbackError?: string | null }) | null;
      if (v?.feedbackError) throw new Error(`verifier feedback failed: ${v.feedbackError}`);
      return v?.feedbackTxHash ? j : null;
    }, 500);
    const v = verified.verification as Record<string, any>;
    record("verifier: ERC-8004 giveFeedback (xorv-verified)", v.feedbackTxHash);
    report.equal("verification score (the mock verifier model's, not a real model's)", v.score, VERIFIER_SCORE);
    note(`job ${paid.jobId}; score ${v.score}`);
  });

  const after = { buyer: await usdcBalance(client, USDC, buyer.address), provider: await usdcBalance(client, USDC, provider.address), operator: await usdcBalance(client, USDC, operator.address) };
  report.fact("buyer USDC spent", `${Number(balancesBefore.buyer - after.buyer) / 1e6}`, "balances");
  report.fact("provider USDC net (earnings minus gas)", `${Number(after.provider - balancesBefore.provider) / 1e6}`, "balances");
  report.fact("operator USDC spent on gas", `${Number(balancesBefore.operator - after.operator) / 1e6}`, "balances");
  report.fact("transactions (excluding the faucet transfers)", `${report.facts.filter((f) => f.section === "transactions").length}`, "balances");
}

main().then(
  () => finish(0),
  (err) => {
    report.error = err instanceof Error ? (err.stack ?? err.message) : String(err);
    return finish(1);
  },
);
