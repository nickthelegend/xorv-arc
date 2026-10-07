/**
 * `pnpm --filter @xorv/broker setup` — what this broker needs on Arc, and
 * what it has.
 *
 * Read-only and idempotent: it never sends a transaction or edits a file. It
 * reports the operator, facilitator and verifier EOAs and their USDC
 * balances, which AI roles will run (and why the others won't), says
 * where to get more, checks the XorvLedger deployment (or prints the exact
 * command that makes one), and ends with the env lines to paste into `.env`.
 *
 *   pnpm --filter @xorv/broker setup                the report
 *   pnpm --filter @xorv/broker setup -- --new-keys  also print fresh keys to use
 *
 * Deploying is deliberately a separate, explicit step
 * (`sh scripts/deploy.sh testnet`): a redeploy moves the contracts to new
 * addresses and orphans everything indexed under the old ones, which is not
 * something a setup script should do on a whim.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  XORV_LEDGER_ABI,
  explorerAddress,
  fetchBalances,
  formatGasUsdc,
  formatUsdc,
  networkConfig,
  publicClientFor,
  sameAddress,
} from "@xorv/protocol";
import { loadConfig } from "../config.js";
import { createAiHooks, describeAiRoles } from "../ai/index.js";

/** Below this a gas-paying key is worth topping up: 0.10 USDC is a few hundred Arc writes. */
const GAS_FLOOR_WEI = 10n ** 17n;

const here = path.dirname(fileURLToPath(import.meta.url));

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

async function balanceLine(network: string, address: string, needs: "gas" | "usdc"): Promise<void> {
  try {
    const { nativeWei, usdcUnits } = await fetchBalances(network, address);
    const low = needs === "gas" ? BigInt(nativeWei) < GAS_FLOOR_WEI : BigInt(usdcUnits) === 0n;
    line("", `${formatUsdc(usdcUnits)} USDC (gas view ${formatGasUsdc(nativeWei)})${low ? "   ← needs funding" : ""}`);
  } catch (err) {
    line("", `balance unavailable (${err instanceof Error ? err.message : String(err)})`);
  }
}

interface DeploymentRecord {
  address?: string;
  blockNumber?: number;
  broker?: string;
}

/** The ledger in deployments/arc-<network>.json (written by contracts/script/Deploy.s.sol). */
function readDeployment(network: string): DeploymentRecord | null {
  const name = network === "eip155:5042" ? "arc-mainnet" : "arc-testnet";
  const file = path.resolve(here, "../../../../deployments", `${name}.json`);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const contracts = (raw.contracts ?? raw) as Record<string, unknown>;
    const address = (contracts.XorvLedger ?? contracts.xorvLedger ?? contracts.ledger) as string | undefined;
    if (!address) return null;
    return { address, blockNumber: typeof raw.blockNumber === "number" ? raw.blockNumber : undefined, broker: raw.broker as string | undefined };
  } catch {
    return null;
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const config = loadConfig();
  const cfg = networkConfig(config.network);
  const env: Record<string, string> = {};
  let newOperator: string | null = null;

  console.log("");
  console.log(`  ▁▂▃  XORV setup — ${cfg.name} (${config.network})`);
  console.log("");
  line("rpc", cfg.rpcUrl);
  line("explorer", cfg.explorerUrl);
  line("usdc", `${cfg.usdc.address}  (EIP-712 "${cfg.usdc.name}" v${cfg.usdc.version})`);
  line("erc-8004 identity", cfg.erc8004.identity);
  line("erc-8004 reputation", cfg.erc8004.reputation);
  console.log("");

  if (argv.includes("--new-keys")) {
    console.log("  fresh keys (keep them secret; fund the addresses before use):");
    for (const name of ["XORV_OPERATOR_KEY", "XORV_FACILITATOR_KEY"]) {
      const key = generatePrivateKey();
      const address = privateKeyToAccount(key).address;
      line(name, address);
      env[name] = key;
      if (name === "XORV_OPERATOR_KEY") newOperator = address;
    }
    console.log("");
  }

  // -- operator: ledger writes, rating relays --------------------------------
  if (config.operator) {
    line("operator", `${config.operator.address}   ${explorerAddress(config.network, config.operator.address)}`);
    await balanceLine(config.network, config.operator.address, "gas");
  } else {
    line("operator", "not set — the broker runs read-only (no ledger writes, no rating relays)");
  }

  // -- facilitator: settles buyers' EIP-3009 authorizations ------------------
  if (config.facilitatorAccount) {
    const shared = config.operator && sameAddress(config.operator.address, config.facilitatorAccount.address);
    line(
      "facilitator",
      `${config.facilitatorAccount.address}${shared ? "   (same as operator — a separate XORV_FACILITATOR_KEY is recommended)" : ""}`,
    );
    if (!shared) await balanceLine(config.network, config.facilitatorAccount.address, "gas");
  } else {
    line(
      "facilitator",
      config.facilitatorMode === "self"
        ? "XORV_FACILITATOR=self but no key — payments are disabled"
        : "no key — payments are disabled (Arc has no public x402 facilitator; set XORV_FACILITATOR_KEY)",
    );
  }

  // -- AI roles: Hunyuan screens, Qwen routes, Kimi verifies -----------------
  // Built exactly as the broker builds them (no model is called here).
  const ai = createAiHooks({
    ai: config.ai,
    network: config.network,
    verifierAccount: config.verifierAccount ?? null,
    log: () => undefined,
  });
  describeAiRoles(ai).forEach((role, i) => line(i === 0 ? "ai roles" : "", role));
  const verifier = ai.report?.().verifier.feedback;
  if (verifier?.onChain && verifier.address) {
    const shared = config.operator && sameAddress(config.operator.address, verifier.address);
    if (!shared) {
      await balanceLine(config.network, verifier.address, "gas");
      line("", "a separate verifier key: add it to the indexer's ENVIO_XORV_VERIFIER_ADDRESSES");
    }
  }
  console.log("");
  if (cfg.faucets.usdc) {
    console.log("  faucet:");
    line("USDC (gas and payments)", `${cfg.faucets.usdc}  — pick "Arc Testnet"`);
    console.log("    On Arc USDC is the gas token: broker keys need a little, buyers need only what they spend.");
    console.log("");
  }

  // -- the ledger -----------------------------------------------------------
  const deployment = readDeployment(config.network);
  const ledger = config.ledgerAddress ?? deployment?.address ?? null;
  if (ledger) {
    line("xorv ledger", `${ledger}   ${explorerAddress(config.network, ledger)}`);
    try {
      const client = publicClientFor(config.network);
      const code = await client.getCode({ address: ledger as `0x${string}` });
      if (!code || code === "0x") {
        line("", "no contract code at this address on this network — wrong network, or not deployed yet");
      } else {
        const broker = await client.readContract({
          address: ledger as `0x${string}`,
          abi: XORV_LEDGER_ABI,
          functionName: "broker",
        });
        const ok = config.operator && sameAddress(broker, config.operator.address);
        line(
          "",
          ok
            ? `broker = ${broker} ✔ (the operator can write)`
            : `broker = ${broker} — XORV_OPERATOR_KEY must be this address's key, or the owner must call setBroker`,
        );
      }
    } catch (err) {
      line("", `could not read the ledger (${err instanceof Error ? err.message : String(err)})`);
    }
    if (!config.ledgerAddress) env.XORV_LEDGER_ADDRESS = ledger;
    if (!config.ledgerFromBlock && deployment?.blockNumber !== undefined) {
      env.XORV_LEDGER_FROM_BLOCK = String(deployment.blockNumber);
    }
  } else {
    const target = config.network === "eip155:5042" ? "mainnet" : "testnet";
    line("xorv ledger", "not deployed / not configured");
    console.log("");
    console.log("  deploy XorvLedger, XorvEscrow, XorvReputation and the CCIP receiver (gas in USDC):");
    console.log("");
    console.log(
      `      XORV_BROKER_ADDRESS=${config.operator?.address ?? newOperator ?? "<operator address>"} sh scripts/deploy.sh ${target}`,
    );
    console.log("");
    console.log(`  it writes deployments/arc-${target}.json — copy the addresses into .env.`);
  }
  console.log("");

  if (!process.env.XORV_PUBLIC_URL?.trim()) {
    console.log("  note: XORV_PUBLIC_URL is unset. It is baked into agent and feedback URIs on-chain, so set it");
    console.log("        to the broker's public https URL before providers register agents or buyers rate jobs.");
    console.log("");
  }

  if (Object.keys(env).length > 0) {
    console.log("  paste into .env:");
    console.log("");
    for (const [key, value] of Object.entries(env)) console.log(`${key}=${value}`);
    console.log("");
  }
}

// Only when run directly — importing this file (a test, a REPL) must not
// start making RPC calls.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error("\n  setup failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
