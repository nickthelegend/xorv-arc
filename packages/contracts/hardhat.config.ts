import { fileURLToPath } from "node:url";

import hardhatKeystore from "@nomicfoundation/hardhat-keystore";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";
import hardhatNodeTestRunner from "@nomicfoundation/hardhat-node-test-runner";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import hardhatViemAssertions from "@nomicfoundation/hardhat-viem-assertions";
import { configVariable, defineConfig } from "hardhat/config";

// The repo-root .env holds the broker's settings; a package-local .env is read first and wins, and real
// environment variables beat both (process.loadEnvFile never overwrites a variable that is already set).
for (const file of ["./.env", "../../.env"]) {
  try {
    process.loadEnvFile(fileURLToPath(new URL(file, import.meta.url)));
  } catch {
    // No such file: nothing to load.
  }
}
// `.env.example` ships keys as blank lines. Hardhat treats a variable that is set, even to "", as final
// and never asks the keystore, so a blank line here would hide a keystore XORV_DEPLOYER_KEY.
if (process.env.XORV_DEPLOYER_KEY?.trim() === "") delete process.env.XORV_DEPLOYER_KEY;

// XorvLedger is deployed to Arc by Foundry (contracts/script/Deploy.s.sol via scripts/deploy.sh at the
// repo root, which compiles it with Foundry's settings and verifies it on Arc's Blockscout with
// XORV_VERIFY=1). This package builds and tests it. The two Arc networks below are for ad-hoc
// `hardhat run` / `hardhat console` against a live chain (chain ids 5042002 and 5042); the key
// is a Hardhat configuration variable (environment, or `pnpm hardhat keystore set XORV_DEPLOYER_KEY`),
// resolved only when one of them is actually used. Tests never touch it.
const deployerKey = configVariable("XORV_DEPLOYER_KEY");

const ARC = {
  testnet: {
    chainId: 5042002,
    rpcUrl: process.env.ARC_TESTNET_RPC_URL?.trim() || "https://rpc.testnet.arc.io",
    explorer: "https://explorer.testnet.arc.io",
  },
  mainnet: {
    chainId: 5042,
    rpcUrl: process.env.ARC_MAINNET_RPC_URL?.trim() || "https://rpc.mainnet.arc.io",
    explorer: "https://explorer.arc.io",
  },
} as const;

// XorvLedger: 0.8.24 / cancun / optimizer 200, the settings the tests, the ABI check and the gas report
// run with, matching the vendored ERC-8004 registries. (The Foundry build that deploys it to Arc uses
// its own settings, contracts/foundry.toml: the ABI is the same, the bytecode is not.)
const LEDGER_COMPILER = {
  version: "0.8.24",
  settings: {
    evmVersion: "cancun",
    optimizer: { enabled: true, runs: 200 },
  },
};

// The vendored ERC-8004 registries are compiled the way upstream builds them (viaIR, which their
// larger functions need to avoid stack-too-deep). They exist only for local tests.
const VENDOR_COMPILER = {
  version: "0.8.24",
  settings: {
    evmVersion: "cancun",
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
  },
};

const VENDORED = [
  "contracts/vendor/erc8004/IdentityRegistryUpgradeable.sol",
  "contracts/vendor/erc8004/ReputationRegistryUpgradeable.sol",
  "contracts/vendor/erc8004/HardhatMinimalUUPS.sol",
  "contracts/vendor/erc8004/ERC1967Proxy.sol",
];

// `build`, `run` and `test` use the "default" profile; "production" is kept identical.
const buildProfile = {
  compilers: [LEDGER_COMPILER],
  overrides: Object.fromEntries(VENDORED.map((file) => [file, VENDOR_COMPILER])),
};

export default defineConfig({
  plugins: [
    hardhatViem,
    hardhatViemAssertions,
    hardhatNodeTestRunner,
    hardhatNetworkHelpers,
    hardhatKeystore,
    hardhatVerify,
  ],
  solidity: {
    profiles: {
      default: buildProfile,
      production: buildProfile,
    },
  },
  networks: {
    arcTestnet: {
      type: "http",
      chainType: "l1",
      chainId: ARC.testnet.chainId,
      url: ARC.testnet.rpcUrl,
      accounts: [deployerKey],
    },
    arcMainnet: {
      type: "http",
      chainType: "l1",
      chainId: ARC.mainnet.chainId,
      url: ARC.mainnet.rpcUrl,
      accounts: [deployerKey],
    },
  },
  // Verification is Foundry's (scripts/deploy.sh, `--verifier blockscout`): it verifies the bytecode it
  // deployed. `hardhat verify` would submit this package's 0.8.24 build, which is not what is on Arc,
  // so its Etherscan and Sourcify backends are off; Blockscout is described below for anyone who
  // deploys this build by hand and enables it.
  verify: {
    blockscout: { enabled: false },
    etherscan: { enabled: false },
    sourcify: { enabled: false },
  },
  chainDescriptors: {
    [ARC.testnet.chainId]: {
      name: "Arc Testnet",
      blockExplorers: {
        blockscout: { name: "Arc Testnet Explorer", url: ARC.testnet.explorer, apiUrl: `${ARC.testnet.explorer}/api` },
      },
    },
    [ARC.mainnet.chainId]: {
      name: "Arc",
      blockExplorers: {
        blockscout: { name: "Arc Explorer", url: ARC.mainnet.explorer, apiUrl: `${ARC.mainnet.explorer}/api` },
      },
    },
  },
});
