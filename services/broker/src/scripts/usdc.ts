/**
 * `pnpm usdc` — are the demo buyer and the facilitator funded?
 *
 * Written because "I sent it" and "it arrived" are different facts, and the
 * only way to tell them apart is to ask the chain. It reports the USDC each
 * party actually holds and what each one needs. On Arc USDC is also the gas
 * token, so everyone holds one asset: the buyer needs USDC to pay (the
 * facilitator pays the gas), and the facilitator needs a little USDC for gas
 * (payments go buyer → escrow/provider, never through it).
 *
 * Read-only. It never moves funds and never edits a file.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  accountFromKey,
  explorerAddress,
  explorerToken,
  fetchBalances,
  formatGasUsdc,
  formatUsdc,
  isEvmAddress,
  networkConfig,
  normalizeAddress,
} from "@xorv/protocol";
import { loadConfig } from "../config.js";

/** Below this a gas-paying key is worth topping up: 0.10 USDC is a few hundred Arc writes. */
const GAS_FLOOR_WEI = 10n ** 17n;

interface Party {
  label: string;
  address: string | null;
  needs: "usdc" | "gas" | "none";
}

/** An address from `<PREFIX>_ADDRESS`, or derived from `<PREFIX>_KEY`. */
function addressFrom(prefix: string): string | null {
  const direct = process.env[`${prefix}_ADDRESS`]?.trim();
  if (direct && isEvmAddress(direct)) return normalizeAddress(direct);
  const key = process.env[`${prefix}_KEY`]?.trim();
  if (!key) return null;
  try {
    return accountFromKey(key).address;
  } catch {
    return null;
  }
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const cfg = networkConfig(config.network);

  const parties: Party[] = [
    { label: "buyer (spends USDC)", address: addressFrom("XORV_DEMO_PAYER"), needs: "usdc" },
    { label: "provider (receives)", address: addressFrom("XORV_DEMO_PROVIDER"), needs: "none" },
    { label: "facilitator (pays gas)", address: config.facilitatorAccount?.address ?? null, needs: "gas" },
  ];
  if (config.operator && config.operator.address !== config.facilitatorAccount?.address) {
    parties.push({ label: "operator (ledger writes)", address: config.operator.address, needs: "gas" });
  }

  console.log("");
  console.log(`  ▁▂▃  USDC on ${cfg.name}`);
  console.log("");
  console.log(`  token  ${cfg.usdc.address}  ${explorerToken(config.network, cfg.usdc.address)}`);
  console.log("");

  let buyerFunded: boolean | null = null;
  for (const party of parties) {
    if (!party.address) {
      console.log(`  ${party.label.padEnd(26)} not configured`);
      continue;
    }
    try {
      const { nativeWei, usdcUnits } = await fetchBalances(config.network, party.address);
      console.log(`  ${party.label.padEnd(26)} ${party.address}`);
      console.log(`    ${formatUsdc(usdcUnits).padStart(10)} USDC   (gas view ${formatGasUsdc(nativeWei)})`);
      if (party.needs === "usdc") buyerFunded = BigInt(usdcUnits) > 0n;
      if (party.needs === "gas" && BigInt(nativeWei) < GAS_FLOOR_WEI) {
        console.log("    low on gas — keep at least 0.10 USDC here (Arc pays gas in USDC)");
      }
      console.log(`    ${explorerAddress(config.network, party.address)}`);
    } catch (err) {
      console.log(`  ${party.label.padEnd(26)} ${party.address}  — could not read (${err instanceof Error ? err.message : err})`);
    }
    console.log("");
  }

  if (buyerFunded === true) {
    console.log("  ✔ the buyer holds USDC and can pay for jobs.");
  } else if (buyerFunded === false) {
    console.log("  ✖ the buyer has no USDC yet.");
    if (cfg.faucets.usdc) console.log(`    Get some at ${cfg.faucets.usdc} — pick "Arc Testnet" — then re-run this.`);
  } else {
    console.log("  set XORV_DEMO_PAYER_KEY (or XORV_DEMO_PAYER_ADDRESS) to check a buyer.");
  }
  console.log("");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error("failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
