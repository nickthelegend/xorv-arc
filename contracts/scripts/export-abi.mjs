#!/usr/bin/env node
// Export the Arc contracts' ABIs from contracts/out (run `forge build` first) into
// packages/protocol/src as `as const` TypeScript, so viem infers every call and event.
//
//   cd contracts && forge build && node scripts/export-abi.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const contracts = join(dirname(fileURLToPath(import.meta.url)), "..");
const protocol = join(contracts, "..", "packages", "protocol", "src");

const targets = [
  { contract: "XorvEscrow", src: "src/XorvEscrow.sol", out: "xorv-escrow.abi.ts", name: "XORV_ESCROW_ABI" },
  { contract: "XorvReputation", src: "src/XorvReputation.sol", out: "abi/xorv-reputation.ts", name: "xorvReputationAbi" },
  { contract: "XorvCcipReceiver", src: "src/ccip/XorvCcipReceiver.sol", out: "abi/xorv-ccip-receiver.ts", name: "xorvCcipReceiverAbi" },
  { contract: "XorvCcipSender", src: "src/ccip/XorvCcipSender.sol", out: "abi/xorv-ccip-sender.ts", name: "xorvCcipSenderAbi" },
];

for (const t of targets) {
  const file = t.src.split("/").pop();
  const artifact = JSON.parse(readFileSync(join(contracts, "out", file, `${t.contract}.json`), "utf8"));
  const body =
    `/**\n * GENERATED from contracts/${t.src} — do not edit by hand.\n` +
    ` * Regenerate: cd contracts && forge build && node scripts/export-abi.mjs\n */\n` +
    `export const ${t.name} = ${JSON.stringify(artifact.abi, null, 2)} as const;\n`;
  const dest = join(protocol, t.out);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, body);
  console.log(`${t.contract} -> packages/protocol/src/${t.out} (${artifact.abi.length} entries)`);
}
