/**
 * The Xorv MCP tools.
 *
 * Read-only tools (providers, network, quote, job lookup) need no key. The
 * paying tool (`xorv_run_job`) and the signing tool (`xorv_rate_job`) need a
 * payer — a local key or a Privy server wallet, see signer.ts — and say so in
 * their descriptions, because a model deciding whether to call a tool has
 * nothing to go on but its description.
 *
 * Every handler returns a result rather than throwing: an MCP tool error is a
 * message the model can read and act on, an exception is a dead call.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  encodeFunctionData,
  type Hex,
} from "viem";
import {
  explorerAddress,
  explorerAgent,
  explorerToken,
  explorerTx,
  fetchBalances,
  formatGasUsdc,
  formatUsd,
  formatUsdc,
  networkConfig,
  remoteChain,
  xorvCcipSenderAbi,
  type AccountBalances,
  type CcipQuoteTerms,
  type NetworkInfo,
  type PublicJob,
  type PublicProvider,
} from "@xorv/protocol";
import type { SessionBudget } from "./budget.js";
import type { BrokerClient } from "./broker.js";
import { BuyError, buyJob, effectiveCeiling, requestCcipQuote, requestQuote } from "./buy.js";
import type { McpConfig } from "./config.js";
import { rateJob } from "./rate.js";
import type { PayerSigner } from "./signer.js";

export const SERVER_VERSION = "0.2.0";

export interface ServerDeps {
  config: McpConfig;
  broker: BrokerClient;
  signer: PayerSigner;
  budget: SessionBudget;
  /** The fetch the x402 client wraps. */
  fetch?: typeof fetch;
  /** Balance reader for `xorv_wallet`; tests replace the RPC call. */
  balances?: (network: string, address: string) => Promise<AccountBalances>;
  pollIntervalMs?: number;
  receiptWaitMs?: number;
}

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const ADAPTER_HINT =
  "Require a specific adapter: claude-code, codex, grok, opencode, qwen, kimi, hunyuan, qwen-code, openai-compatible, echo.";

/** Payment/receipt/verification lines for a job, shared by run_job and get_job. */
function proofLines(network: string, job: PublicJob, settlementTx?: string | null): string[] {
  const lines: string[] = [];
  const tx = settlementTx ?? job.payment?.txHash ?? null;
  if (tx) lines.push(`Payment: ${explorerTx(network, tx)}`);
  if (job.receiptTxHash) lines.push(`Ledger receipt (XorvLedger): ${explorerTx(network, job.receiptTxHash)}`);
  if (job.resultHash) lines.push(`Result keccak256: ${job.resultHash}`);
  if (job.verification) {
    const v = job.verification;
    lines.push(
      `Verified by ${v.by} (${v.model}): ${v.score}/100, ${v.pass ? "pass" : "fail"} — ${v.rationale}` +
        (v.feedbackTxHash ? ` · ERC-8004 feedback ${explorerTx(network, v.feedbackTxHash)}` : ""),
    );
  }
  if (job.rating) lines.push(`Buyer rating: ${job.rating.value}/100 · ${explorerTx(network, job.rating.txHash)}`);
  return lines;
}

/** The broker's Arc stack (`/api/network` → `arc`), as status lines. */
function arcLines(info: NetworkInfo): string[] {
  const arc = info.arc;
  if (!arc) return [];
  const lines = [`Gas: paid in ${arc.gasToken} (Arc's native token); finality ${arc.finality}`];
  lines.push(
    arc.reputation
      ? `XorvReputation: ${arc.reputation.address} — escrow settlements written to ERC-8004 ("successRate") — ${arc.reputation.url}`
      : "XorvReputation: not deployed",
  );
  lines.push(`Memo: ${arc.memo.enabled ? `settlements tagged with the job id (${arc.memo.address})` : "off"}`);
  if (arc.cctp.destinations.length) {
    lines.push(`CCTP V2 (providers withdraw to): ${arc.cctp.destinations.map((d) => `${d.name} (domain ${d.domain})`).join(", ")}`);
  }
  lines.push(
    arc.ccip.receiver
      ? `CCIP: jobs fundable from ${arc.ccip.sources.map((s) => s.name).join(", ") || "no source chain"} via XorvCcipReceiver ${arc.ccip.receiver.address} (use xorv_ccip_quote)`
      : "CCIP: no XorvCcipReceiver — cross-chain jobs are off",
  );
  if (arc.gateway.enabled) lines.push(`Circle Gateway: wallet ${arc.gateway.wallet}`);
  return lines;
}

/** The CCIP terms as instructions for a buyer agent on a source chain. Pure; sends nothing. */
export function ccipInstructions(
  network: string,
  terms: CcipQuoteTerms,
  opts: { sourceChain?: string | null; fast?: boolean } = {},
): { lines: string[]; sources: CcipQuoteTerms["sources"] } {
  let sources = terms.sources;
  if (opts.sourceChain) {
    const wanted = /^\d+$/.test(opts.sourceChain.trim())
      ? remoteChain(network, Number(opts.sourceChain.trim()))
      : remoteChain(network, opts.sourceChain);
    sources = wanted ? terms.sources.filter((s) => s.chainId === wanted.chainId) : [];
    if (sources.length === 0) {
      throw new BuyError(
        "quote",
        `no CCIP lane from "${opts.sourceChain}" to Arc on this broker — sources: ${terms.sources.map((s) => `${s.name} (${s.chainId})`).join(", ") || "none"}`,
      );
    }
  }
  const price = BigInt(terms.price);
  const jobId = terms.jobId as Hex;
  const minFinality = opts.fast ? 1000 : 2000;
  const lines: string[] = [];
  for (const src of sources) {
    const sender = terms.senders[String(src.chainId)] ?? null;
    lines.push(``, `From ${src.name} (chain ${src.chainId}, CCIP selector ${src.selector}, CCTP domain ${src.cctpDomain}):`);
    lines.push(`  USDC there: ${src.usdc}`);
    if (!sender) {
      lines.push("  XorvCcipSender: this broker knows none on this chain — deploy one or ask the operator for its address.");
      continue;
    }
    lines.push(`  XorvCcipSender: ${sender}`);
    lines.push(
      `  1. USDC.approve(${sender}, ${opts.fast ? `${price} + maxFee` : price.toString()})`,
      `  2. fee = XorvCcipSender.quotePostJob(${jobId}, ${terms.provider}, ${price}, ${terms.deadline}) — the CCIP fee, in ${src.name}'s native gas token`,
      opts.fast
        ? `  3. XorvCcipSender.postJob{value: fee}(${jobId}, ${terms.provider}, ${price}, ${terms.deadline}, maxFee, 1000) — maxFee from Circle's CCTP fast-transfer fee API`
        : `  3. XorvCcipSender.postJob{value: fee}(${jobId}, ${terms.provider}, ${price}, ${terms.deadline}, 0, 2000) — a standard CCTP transfer, no Circle fee`,
    );
    if (!opts.fast) {
      const data = encodeFunctionData({
        abi: xorvCcipSenderAbi,
        functionName: "postJob",
        args: [jobId, terms.provider as Hex, price, terms.deadline, 0n, minFinality],
      });
      lines.push(`     calldata: ${data}`);
    }
  }
  return { lines, sources };
}

export function createServer(deps: ServerDeps): McpServer {
  const { config, broker, signer, budget } = deps;
  const network = config.network;
  const server = new McpServer({ name: "xorv", version: SERVER_VERSION });

  /** Every tool refuses while the environment is fundamentally wrong. */
  const configProblem = (): ReturnType<typeof fail> | null =>
    config.problems.length > 0 ? fail(`This Xorv MCP server is misconfigured:\n- ${config.problems.join("\n- ")}`) : null;

  const cap = formatUsd(config.maxPriceUsdMicros);
  const budgetNote =
    config.sessionBudgetUsdMicros === null ? "" : ` and at most ${formatUsd(config.sessionBudgetUsdMicros)} across this session`;

  // -------------------------------------------------------------------------
  // Read-only tools — no key needed
  // -------------------------------------------------------------------------

  server.registerTool(
    "xorv_list_providers",
    {
      description:
        "List the AI providers currently live on the Xorv network, what models they run, what they charge per job, and the Arc address each is paid at. Use this before buying to see what capacity is available.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const bad = configProblem();
      if (bad) return bad;
      try {
        const { providers } = await broker.getJson<{ providers: PublicProvider[] }>("/api/providers");
        const live = providers.filter((p) => p.status !== "offline");
        if (live.length === 0) {
          return text(
            "No providers are online right now. Anyone can start one with `npm i -g @xorv/cli && xorv init && xorv start`.",
          );
        }
        const lines = live.map((p) => {
          const caps = p.capabilities
            .map((c) => `${c.displayName} (${c.adapter}) ${formatUsd(c.priceUsdMicros)}/job`)
            .join(", ");
          const identity = p.agentId ? ` · ERC-8004 agent #${p.agentId} ${p.agentUrl ?? explorerAgent(network, p.agentId)}` : "";
          return (
            `- ${p.label} [${p.status}]${p.region ? ` · ${p.region}` : ""} — ${caps} · ` +
            `${p.stats.jobsCompleted} jobs done, ${p.stats.jobsFailed} failed · pays to ${p.address}${identity}`
          );
        });
        return text(`${live.length} provider(s) live on ${network}:\n${lines.join("\n")}`);
      } catch (err) {
        return fail(errorText(err));
      }
    },
  );

  server.registerTool(
    "xorv_network_status",
    {
      description:
        "Show the Xorv network's overall state on Arc: live providers, settled jobs, the x402 facilitator, the USDC contract (also Arc's gas token), XorvEscrow, the XorvLedger audit contract, the ERC-8004 registries, XorvReputation, the CCTP / CCIP cross-chain pieces and the AI roles (router, safety screen, verifier).",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const bad = configProblem();
      if (bad) return bad;
      try {
        const info = await broker.getJson<NetworkInfo>("/api/network");
        const net = info.network ?? network;
        const ai = info.ai
          ? (["router", "screener", "verifier"] as const)
              .map((role) => `${role} ${info.ai[role] ? `${info.ai[role]!.by} (${info.ai[role]!.model})` : "off"}`)
              .join(", ")
          : "unknown";
        const published = info.published
          ? Object.entries(info.published)
              .map(([kind, n]) => `${kind} ${n}`)
              .join(", ")
          : "—";
        return text(
          [
            `Network: ${net} (${info.label ?? ""}, chain ${info.chainId ?? "?"})${net !== network ? ` — WARNING: this MCP server is configured for ${network}` : ""}`,
            `Explorer: ${info.explorerUrl}`,
            `USDC: ${info.usdc.address} — ${explorerToken(net, info.usdc.address)}`,
            `Facilitator: ${info.facilitator.description}${info.facilitator.address ? ` (gas paid by ${info.facilitator.address})` : ""}`,
            info.escrow ? `XorvEscrow: ${info.escrow.address} — ${info.escrow.url}` : "XorvEscrow: none (payments go straight to providers)",
            info.ledger ? `XorvLedger: ${info.ledger.address} — ${info.ledger.url}` : "XorvLedger: not configured",
            `ERC-8004: identity ${info.erc8004.identity}, reputation ${info.erc8004.reputation}`,
            ...arcLines(info),
            info.indexer ? `Indexer: ${info.indexer.url}` : "Indexer: none (ledger reads go to RPC)",
            `Ledger writes since boot: ${published}${info.lastPublishError ? ` · last error: ${info.lastPublishError}` : ""}`,
            `AI roles: ${ai}`,
            `Providers live: ${info.stats.providersLive}`,
            `Jobs: ${info.stats.jobsCompleted} completed of ${info.stats.jobsTotal}`,
            `Settled: ${formatUsd(info.stats.paidUsdMicros)}`,
          ].join("\n"),
        );
      } catch (err) {
        return fail(errorText(err));
      }
    },
  );

  server.registerTool(
    "xorv_quote",
    {
      description:
        "Get a price for a job WITHOUT paying for it. Returns which provider would run it, its Arc payout address and what it would cost in USDC. Use this to check the price before calling xorv_run_job. (An agent paying from Base or Ethereum uses xorv_ccip_quote instead.)",
      inputSchema: {
        prompt: z.string().min(1).describe("The job to price."),
        adapter: z.string().optional().describe(ADAPTER_HINT),
        max_usd: z.number().positive().optional().describe("Most you'd pay, in US dollars."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ prompt, adapter, max_usd }) => {
      const bad = configProblem();
      if (bad) return bad;
      const ceiling = effectiveCeiling({
        requestedUsd: max_usd,
        maxPriceUsdMicros: config.maxPriceUsdMicros,
        budgetRemainingUsdMicros: Number.POSITIVE_INFINITY,
      });
      try {
        const quote = await requestQuote(broker, { prompt, adapter, ceilingUsdMicros: ceiling });
        const cfg = networkConfig(network);
        const p = quote.provider;
        return text(
          [
            `Quote ${quote.quoteId} (expires in ${Math.max(0, Math.round((quote.expiresAt - Date.now()) / 1000))}s)`,
            `Price: ${quote.priceLabel} (${quote.usdcAmount} USDC units)`,
            `Provider: ${p.label} running ${p.capability}${p.model ? ` (${p.model})` : ""}`,
            `Track record: ${p.stats.jobsCompleted} completed, ${p.stats.jobsFailed} failed`,
            p.agentId ? `ERC-8004 identity: agent #${p.agentId} — ${explorerAgent(network, p.agentId)}` : "ERC-8004 identity: none",
            quote.routing ? `Routed by ${quote.routing.by} (${quote.routing.model}): ${quote.routing.reason}` : "",
            quote.screening ? `Safety screen (${quote.screening.by}): ${quote.screening.verdict}` : "",
            `Payment goes directly to ${p.address} — the broker never holds it. ${p.addressUrl ?? explorerAddress(network, p.address)}`,
            `Payable in: USDC on ${cfg.name} (x402 exact / EIP-3009 — the payer signs, the facilitator pays the gas)`,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      } catch (err) {
        return fail(err instanceof BuyError ? err.message : `Quote failed: ${errorText(err)}`);
      }
    },
  );

  server.registerTool(
    "xorv_ccip_quote",
    {
      description:
        "Get a price for a job to be paid FROM ANOTHER CHAIN (Base / Ethereum, or their testnets) over Chainlink CCIP + Circle CCTP, WITHOUT paying. " +
        "Returns the escrow job id, provider, price (USDC units) and deadline to pass to XorvCcipSender.postJob(jobId, provider, price, deadline, maxFee, minFinalityThreshold) on the source chain, " +
        "plus the sender and USDC addresses there. This tool signs nothing and sends nothing on-chain; the agent on the source chain pays with its own wallet. " +
        "The quote is held until its deadline; the job runs once XorvEscrow on Arc shows it funded.",
      inputSchema: {
        prompt: z.string().min(1).describe("The job to price."),
        adapter: z.string().optional().describe(ADAPTER_HINT),
        max_usd: z.number().positive().optional().describe("Most you'd pay, in US dollars."),
        source_chain: z
          .string()
          .optional()
          .describe("Only show this source chain (name or chain id, e.g. \"base-sepolia\" or \"84532\"). Default: every chain with a lane to Arc."),
        fast: z
          .boolean()
          .optional()
          .describe("Plan a fast CCTP transfer (minFinalityThreshold 1000, maxFee > 0). Default: standard (0, 2000), no Circle fee."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ prompt, adapter, max_usd, source_chain, fast }) => {
      const bad = configProblem();
      if (bad) return bad;
      const ceiling = effectiveCeiling({
        requestedUsd: max_usd,
        maxPriceUsdMicros: config.maxPriceUsdMicros,
        budgetRemainingUsdMicros: Number.POSITIVE_INFINITY,
      });
      try {
        const quote = await requestCcipQuote(broker, { prompt, adapter, ceilingUsdMicros: ceiling });
        if (quote.network && quote.network !== network) {
          return fail(`The broker quotes on ${quote.network} but this server is configured for ${network}.`);
        }
        const terms = quote.ccip;
        const { lines, sources } = ccipInstructions(network, terms, { sourceChain: source_chain ?? null, fast: fast ?? false });
        const p = quote.provider;
        const cfg = networkConfig(network);
        const json = {
          quoteId: quote.quoteId,
          network,
          receiver: terms.receiver,
          arcChainSelector: terms.arcChainSelector,
          jobId: terms.jobId,
          provider: terms.provider,
          price: terms.price,
          deadline: terms.deadline,
          minFinalityThreshold: fast ? 1000 : 2000,
          maxFee: fast ? null : "0",
          sources: sources.map((s) => ({ ...s, sender: terms.senders[String(s.chainId)] ?? null })),
        };
        return text(
          [
            `Cross-chain quote ${quote.quoteId} — held until ${new Date(terms.deadline * 1000).toISOString()} (the escrow deadline)`,
            `Price: ${quote.priceLabel} (${terms.price} USDC units) to ${p.label} running ${p.capability}${p.model ? ` (${p.model})` : ""}`,
            p.agentId ? `ERC-8004 identity: agent #${p.agentId} — ${explorerAgent(network, p.agentId)}` : "ERC-8004 identity: none",
            `Escrow job id: ${terms.jobId}`,
            `Provider (paid on release): ${terms.provider}`,
            `Arc side: XorvCcipReceiver ${terms.receiver} on ${cfg.name} (CCIP selector ${terms.arcChainSelector}) funds XorvEscrow for this job`,
            ...lines,
            "",
            "Nothing was signed or sent by this tool. If the job can't be funded on Arc, the USDC stays claimable by the payer's address on Arc (XorvCcipReceiver).",
            "",
            "```json",
            JSON.stringify(json, null, 2),
            "```",
          ].join("\n"),
        );
      } catch (err) {
        return fail(err instanceof BuyError ? err.message : `Cross-chain quote failed: ${errorText(err)}`);
      }
    },
  );

  server.registerTool(
    "xorv_get_job",
    {
      description:
        "Look up a Xorv job by id — its status, result, the on-chain USDC payment, the XorvLedger receipt, the AI verifier's score and any buyer rating.",
      inputSchema: { job_id: z.string().min(1).describe("The job id, e.g. job_TwzS96BhAx81.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ job_id }) => {
      const bad = configProblem();
      if (bad) return bad;
      try {
        const job = await broker.getJob(job_id);
        const header = [
          `Job ${job.id} — ${job.status}`,
          `Provider: ${job.providerLabel ?? "unassigned"}${job.providerAddress ? ` (${job.providerAddress})` : ""}`,
          `Price: ${job.priceLabel ?? "—"}`,
          ...(job.payment ? [] : ["Payment: not settled"]),
          ...proofLines(network, job),
        ];
        return text(`${header.join("\n")}\n\n${job.result ?? job.error ?? "(no result yet)"}`);
      } catch (err) {
        return fail(`Could not read job ${job_id}: ${errorText(err)}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tools that need the payer
  // -------------------------------------------------------------------------

  server.registerTool(
    "xorv_wallet",
    {
      description:
        "Show which wallet this server pays from (a local key or a policy-bounded Privy server wallet), its Arc address and USDC balance, the per-job spending cap, and how much of the session budget is left. Spends nothing.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const bad = configProblem();
      if (bad) return bad;
      let payer;
      try {
        payer = await signer.resolve();
      } catch (err) {
        return fail(errorText(err));
      }
      const cfg = networkConfig(network);
      let balanceLines: string[];
      try {
        const balances = await (deps.balances ?? fetchBalances)(network, payer.address);
        balanceLines = [
          `USDC: ${formatUsdc(balances.usdcUnits)}`,
          `Gas: ${formatGasUsdc(balances.nativeWei)} — the same USDC (Arc's gas token); not needed to buy, the broker's facilitator pays gas`,
        ];
        if (BigInt(balances.usdcUnits) === 0n && cfg.faucets.usdc) {
          balanceLines.push(`No USDC yet — get test USDC for ${payer.address} at ${cfg.faucets.usdc} (choose ${cfg.name}).`);
        }
      } catch (err) {
        balanceLines = [`Balances: could not read from ${cfg.rpcUrl} (${errorText(err)})`];
      }
      return text(
        [
          `Payer: ${payer.label}`,
          `Address: ${explorerAddress(network, payer.address)}`,
          ...balanceLines,
          payer.mode === "privy"
            ? "Privy enforces the wallet's policy on every signature (per-signature cap, USDC on this chain only)."
            : "",
          `Per-job cap: ${cap}`,
          `Session: ${budget.describe()}`,
          `Network: ${cfg.caip2} (${cfg.name})`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "xorv_run_job",
    {
      description:
        `Run an AI job on the Xorv network and PAY FOR IT with a real USDC transfer on Arc. This spends money — at most ${cap} per call${budgetNote}. ` +
        "The job runs on someone else's machine using their AI subscription, and they are paid directly. Returns the result plus explorer links proving the payment and the on-chain receipt.",
      inputSchema: {
        prompt: z.string().min(1).describe("The job to run."),
        adapter: z.string().optional().describe(ADAPTER_HINT),
        max_usd: z.number().positive().optional().describe(`Most to pay in US dollars. Capped at ${cap} regardless.`),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ prompt, adapter, max_usd }) => {
      const bad = configProblem();
      if (bad) return bad;
      try {
        const result = await buyJob(
          {
            broker,
            signer,
            budget,
            network,
            maxPriceUsdMicros: config.maxPriceUsdMicros,
            fetch: deps.fetch,
            pollIntervalMs: deps.pollIntervalMs,
            receiptWaitMs: deps.receiptWaitMs,
          },
          { prompt, adapter, maxUsd: max_usd },
        );
        const { job, quote } = result;
        const proof = [
          "",
          "---",
          `Paid ${quote.priceLabel} USDC to ${quote.provider.label} (${quote.provider.address}) from ${result.payer.label}`,
          ...proofLines(network, job, result.settlementTx),
          `Job: ${result.jobId}${job.status === "completed" && quote.provider.agentId ? " — rate it with xorv_rate_job (0–100) to write ERC-8004 reputation for this provider" : ""}`,
          `Session: ${budget.describe()}`,
        ].join("\n");
        if (job.status !== "completed") {
          return fail(`Job ${job.status}: ${job.error ?? "no result"}${proof}`);
        }
        return text(`${job.result ?? ""}${proof}`);
      } catch (err) {
        if (err instanceof BuyError) return fail(err.message);
        return fail(`Job failed: ${errorText(err)}`);
      }
    },
  );

  server.registerTool(
    "xorv_rate_job",
    {
      description:
        "Rate a finished Xorv job you paid for, from 0 (useless) to 100 (perfect). Signs an EIP-712 rating with this server's payer wallet (no gas, no money spent); the broker relays it to XorvLedger, which records it as ERC-8004 reputation for the provider. One rating per job.",
      inputSchema: {
        job_id: z.string().min(1).describe("The job id returned by xorv_run_job, e.g. job_TwzS96BhAx81."),
        value: z.number().int().min(0).max(100).describe("Score from 0 to 100."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ job_id, value }) => {
      const bad = configProblem();
      if (bad) return bad;
      try {
        const result = await rateJob({ broker, signer, network }, { jobId: job_id, value });
        return text(
          [
            `Rated job ${job_id} ${value}/100 as ${result.payer.address} (${result.payer.mode === "privy" ? "Privy server wallet" : "local key"}).`,
            result.explorerUrl ? `Relayed on-chain: ${result.explorerUrl}` : "Relayed; no transaction hash was returned.",
            `ERC-8004 feedback: agent #${result.offer.agentId} — ${explorerAgent(network, result.offer.agentId)}`,
            `Feedback file: ${result.feedbackURI}`,
          ].join("\n"),
        );
      } catch (err) {
        return fail(errorText(err));
      }
    },
  );

  return server;
}
