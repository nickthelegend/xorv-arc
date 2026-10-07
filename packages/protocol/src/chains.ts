/**
 * Arc network configuration — the one table every participant reads.
 *
 * A marketplace that hardcodes an RPC, an explorer or a token address in six
 * packages ends up with six slightly different ideas of which chain it is on.
 * Everything chain-shaped lives here instead, keyed by CAIP-2 id, which is also
 * the network string x402 puts on the wire (`eip155:5042002`), so the value a
 * buyer sees in a 402 is the same key the broker looked its config up with.
 *
 * Arc is Circle's stablecoin L1: **USDC is the gas token**. The same balance has
 * two faces, the native one the EVM meters gas in (18 decimals) and a Circle
 * FiatToken ERC-20 at `0x3600…0000` (6 decimals). Every amount of money in this
 * codebase is the 6-decimal ERC-20 view; the 18-decimal view only appears when
 * reading a gas balance. Buyers, providers and the broker hold one token.
 *
 * Testnet is the default. Mainnet is a deliberate choice, never a fallback: an
 * unrecognised network string throws rather than quietly resolving to a real
 * USDC contract.
 *
 * Three overrides are read from the environment **per call** (not at module
 * load, so tests and hot config reloads see changes without re-importing):
 *
 *  - `XORV_RPC_URL`       — a private RPC, or a local Arc fork.
 *  - `XORV_EXPLORER_URL`  — a different Blockscout instance.
 *  - `XORV_STABLECOIN`    — a different ERC-20 to price in (a test token).
 *                           `XORV_STABLECOIN_NAME` and `XORV_STABLECOIN_VERSION`
 *                           override its EIP-712 domain, which must match the
 *                           token exactly or every signed payment is rejected.
 *
 * A process talks to one network, so the overrides apply to whichever network
 * is asked for.
 */

import { defineChain, getAddress, isAddress, type Address, type Chain } from "viem";
import { readEnv } from "./env.js";
import { USDC_DECIMALS } from "./money.js";

/** Arc testnet (chain id 5042002), as a CAIP-2 network id. The default. */
export const ARC_TESTNET = "eip155:5042002" as const;

/** Arc mainnet (chain id 5042), as a CAIP-2 network id. */
export const ARC_MAINNET = "eip155:5042" as const;

/** Where Xorv runs unless told otherwise. */
export const DEFAULT_NETWORK = ARC_TESTNET;

export type ArcNetwork = typeof ARC_TESTNET | typeof ARC_MAINNET;

/** Every network this package has a config for. */
export const SUPPORTED_NETWORKS: readonly ArcNetwork[] = [ARC_TESTNET, ARC_MAINNET];

/**
 * Arc's block interval. Finality is deterministic and sub-second: a
 * transaction in a block is final, there are no reorgs to wait out.
 */
export const ARC_BLOCK_TIME_MS = 500;

/** Native USDC's decimals: the gas view of the balance. Money uses USDC_DECIMALS (6). */
export const NATIVE_DECIMALS = 18;

/**
 * Arc's mempool refuses transactions whose maxFeePerGas is under 20 gwei
 * (docs.arc.io, EVM differences). viem's fee estimate already clears it (the
 * base fee sits at the floor); kept for anything that sets fees by hand.
 */
export const ARC_MIN_FEE_PER_GAS_WEI = 20_000_000_000n;

export interface UsdcConfig {
  /** Checksummed ERC-20 address. */
  address: Address;
  /** EIP-712 domain name — "USDC" on Arc (read on chain), *not* "USD Coin". */
  name: string;
  /** EIP-712 domain version. */
  version: string;
  decimals: number;
  symbol: string;
}

/** The canonical ERC-8004 v2.0.0 singletons (vanity `0x8004…` proxies). */
export interface Erc8004Registries {
  identity: Address;
  reputation: Address;
  validation: Address;
}

/** A chain a buyer can fund from, or a provider can withdraw to. */
export interface RemoteChain {
  name: string;
  chainId: number;
  /** Circle CCTP domain id. */
  cctpDomain: number;
  usdc: Address;
  tokenMessengerV2: Address;
  messageTransmitterV2: Address;
  /** Chainlink CCIP chain selector and router, when the lane to Arc is live. */
  ccipSelector: string | null;
  ccipRouter: Address | null;
  rpcUrl: string;
  explorerUrl: string;
}

/** Circle's contracts on Arc. Same shape on both networks; addresses differ. */
export interface CircleContracts {
  /** CCTP domain id of Arc itself. */
  cctpDomain: number;
  tokenMessengerV2: Address;
  messageTransmitterV2: Address;
  gatewayWallet: Address;
  gatewayMinter: Address;
  /** Circle's Gateway REST API (balances, transfer attestations). */
  gatewayApiUrl: string;
  /** Circle's Iris API (CCTP attestations). */
  irisApiUrl: string;
  /** Arc's Memo transaction extension: tags a contract call with an id, keeping msg.sender. */
  memo: Address;
  eurc: Address;
  /** USYC, the tokenized money-market fund (permissioned: Circle allowlists holders). */
  usyc: Address;
}

/** Chainlink CCIP on Arc. */
export interface CcipConfig {
  chainSelector: string;
  router: Address;
  link: Address;
}

export interface NetworkConfig {
  caip2: ArcNetwork;
  chainId: number;
  /** Chain name, e.g. "Arc Testnet". */
  name: string;
  /** Short label for CLI and UI chrome. */
  label: "testnet" | "mainnet";
  rpcUrl: string;
  wsUrl: string;
  /** Explorer (Blockscout) base URL with no trailing slash. */
  explorerUrl: string;
  usdc: UsdcConfig;
  erc8004: Erc8004Registries;
  circle: CircleContracts;
  ccip: CcipConfig;
  /** Chains a buyer funds from (Gateway, CCTP + CCIP) and providers withdraw to (CCTP). */
  remotes: RemoteChain[];
  /**
   * A hosted x402 facilitator for this network, or null. There is no public
   * facilitator for Arc: the broker runs its own (`XORV_FACILITATOR=self`),
   * which is also what lets it fund the escrow.
   */
  facilitatorUrl: string | null;
  /** Where to get test USDC; null on mainnet. On Arc the same USDC pays the gas. */
  faucets: { usdc: string | null };
  /** Envio HyperSync endpoint, for the indexer. */
  hypersyncUrl: string;
}

/**
 * The built-in values, from docs.arc.io (contract addresses, 2026-10-07) and
 * the Chainlink CCIP directory. USDC's EIP-712 domain ("USDC", "2") was read
 * on chain on both networks.
 */
const BASE: Readonly<Record<ArcNetwork, NetworkConfig>> = {
  [ARC_TESTNET]: {
    caip2: ARC_TESTNET,
    chainId: 5042002,
    name: "Arc Testnet",
    label: "testnet",
    rpcUrl: "https://rpc.testnet.arc.io",
    wsUrl: "wss://rpc.testnet.arc.io",
    explorerUrl: "https://explorer.testnet.arc.io",
    usdc: {
      address: "0x3600000000000000000000000000000000000000",
      name: "USDC",
      version: "2",
      decimals: USDC_DECIMALS,
      symbol: "USDC",
    },
    erc8004: {
      identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      validation: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
    },
    circle: {
      cctpDomain: 26,
      tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
      messageTransmitterV2: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
      gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
      gatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
      gatewayApiUrl: "https://gateway-api-testnet.circle.com",
      irisApiUrl: "https://iris-api-sandbox.circle.com",
      memo: "0x5294E9927c3306DcBaDb03fe70b92e01cCede505",
      eurc: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
      usyc: "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C",
    },
    ccip: {
      chainSelector: "3034092155422581607",
      router: "0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8",
      link: "0x745827566D1EFb6B91632df0bFD5a9b5392F54E0",
    },
    remotes: [
      {
        name: "Base Sepolia",
        chainId: 84532,
        cctpDomain: 6,
        usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
        messageTransmitterV2: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
        ccipSelector: "10344971235874465080",
        ccipRouter: "0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93",
        rpcUrl: "https://sepolia.base.org",
        explorerUrl: "https://sepolia.basescan.org",
      },
      {
        name: "Ethereum Sepolia",
        chainId: 11155111,
        cctpDomain: 0,
        usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
        messageTransmitterV2: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
        ccipSelector: "16015286601757825753",
        ccipRouter: "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59",
        rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
        explorerUrl: "https://sepolia.etherscan.io",
      },
    ],
    facilitatorUrl: null,
    faucets: { usdc: "https://faucet.circle.com" },
    hypersyncUrl: "https://arc-testnet.hypersync.xyz",
  },
  [ARC_MAINNET]: {
    caip2: ARC_MAINNET,
    chainId: 5042,
    name: "Arc",
    label: "mainnet",
    rpcUrl: "https://rpc.mainnet.arc.io",
    wsUrl: "wss://rpc.mainnet.arc.io",
    explorerUrl: "https://explorer.arc.io",
    usdc: {
      address: "0x3600000000000000000000000000000000000000",
      name: "USDC",
      version: "2",
      decimals: USDC_DECIMALS,
      symbol: "USDC",
    },
    erc8004: {
      identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
      validation: "0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58",
    },
    circle: {
      cctpDomain: 26,
      tokenMessengerV2: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
      messageTransmitterV2: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
      gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
      gatewayMinter: "0x2222222d7164433c4C09B0b0D809a9b52C04C205",
      gatewayApiUrl: "https://gateway-api.circle.com",
      irisApiUrl: "https://iris-api.circle.com",
      memo: "0x5294E9927c3306DcBaDb03fe70b92e01cCede505",
      eurc: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
      usyc: "0x8a5D989Bbb96929F689B0200f435f53dA42bF490",
    },
    ccip: {
      chainSelector: "6370580034781731079",
      router: "0xB79791184973589c38e114D43Eb8E4588C283A18",
      link: "0x76a443768A5e3B8d1AED0105FC250877841Deb40",
    },
    remotes: [
      {
        name: "Base",
        chainId: 8453,
        cctpDomain: 6,
        usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        tokenMessengerV2: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
        messageTransmitterV2: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
        ccipSelector: "15971525489660198786",
        ccipRouter: "0x881e3A65B4d4a04dD529061dd0071cf975F58bCD",
        rpcUrl: "https://mainnet.base.org",
        explorerUrl: "https://basescan.org",
      },
      {
        name: "Ethereum",
        chainId: 1,
        cctpDomain: 0,
        usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        tokenMessengerV2: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
        messageTransmitterV2: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
        ccipSelector: "5009297550715157269",
        ccipRouter: "0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D",
        rpcUrl: "https://ethereum-rpc.publicnode.com",
        explorerUrl: "https://etherscan.io",
      },
    ],
    facilitatorUrl: null,
    faucets: { usdc: null },
    hypersyncUrl: "https://arc.hypersync.xyz",
  },
};

/** True for the CAIP-2 ids this package has a config for. */
export function isSupportedNetwork(network: unknown): network is ArcNetwork {
  return network === ARC_TESTNET || network === ARC_MAINNET;
}

/**
 * The full config for a network, with environment overrides applied.
 *
 * Throws on anything but `eip155:5042002` / `eip155:5042`. A leftover network
 * string from another chain in someone's `.env` must fail at boot with a
 * message that names the fix, not resolve to *some* chain and fail later as a
 * mystery 402.
 */
export function networkConfig(network: string): NetworkConfig {
  if (!isSupportedNetwork(network)) {
    throw new Error(
      `unsupported network "${network}" — Xorv runs on Arc: use ${ARC_TESTNET} (testnet) or ${ARC_MAINNET} (mainnet)`,
    );
  }
  const base = BASE[network];
  const rpcUrl = readEnv("XORV_RPC_URL") ?? base.rpcUrl;
  const explorerUrl = (readEnv("XORV_EXPLORER_URL") ?? base.explorerUrl).replace(/\/+$/, "");
  return {
    ...base,
    rpcUrl,
    explorerUrl,
    usdc: stablecoinFor(base.usdc),
    erc8004: { ...base.erc8004 },
    circle: { ...base.circle },
    ccip: { ...base.ccip },
    remotes: base.remotes.map((r) => ({ ...r })),
    faucets: { ...base.faucets },
  };
}

/**
 * Apply `XORV_STABLECOIN` (+ optional EIP-712 name/version) over the default.
 *
 * A malformed override throws instead of being ignored. Ignoring it would mean
 * an operator who *thinks* they are pricing in their test token is actually
 * asking buyers for real USDC — the one silent fallback worth refusing.
 */
function stablecoinFor(base: UsdcConfig): UsdcConfig {
  const override = readEnv("XORV_STABLECOIN");
  if (!override) return { ...base };
  if (!isAddress(override, { strict: false })) {
    throw new Error(`XORV_STABLECOIN must be a 0x ERC-20 address, got "${override}"`);
  }
  return {
    ...base,
    address: getAddress(override),
    name: readEnv("XORV_STABLECOIN_NAME") ?? base.name,
    version: readEnv("XORV_STABLECOIN_VERSION") ?? base.version,
  };
}

/**
 * A viem `Chain` for a network, carrying the (possibly overridden) RPC and
 * explorer. The native currency is USDC with 18 decimals: that is the gas
 * view of the balance, not a second token.
 *
 * Built per call rather than exported as a constant so env overrides apply;
 * the definition is a few small objects, so there is nothing worth caching.
 */
export function viemChain(network: string): Chain {
  const cfg = networkConfig(network);
  return defineChain({
    id: cfg.chainId,
    name: cfg.name,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: NATIVE_DECIMALS },
    blockTime: ARC_BLOCK_TIME_MS,
    rpcUrls: { default: { http: [cfg.rpcUrl], webSocket: [cfg.wsUrl] } },
    blockExplorers: { default: { name: "Arc Explorer", url: cfg.explorerUrl } },
    contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
    testnet: cfg.label === "testnet",
  });
}

/**
 * Human label for a network, for CLI and UI chrome.
 *
 * Unlike `networkConfig` this never throws — it only decorates output — and
 * anything that is not exactly mainnet reads as "testnet", the safe
 * assumption for a label.
 */
export function networkLabel(network: string): "testnet" | "mainnet" {
  return network === ARC_MAINNET ? "mainnet" : "testnet";
}

/** The stablecoin (USDC unless overridden) a network prices in. */
export function usdcAddress(network: string): Address {
  return networkConfig(network).usdc.address;
}

/** A remote chain by EVM chain id or name (case-insensitive), or undefined. */
export function remoteChain(network: string, key: number | string): RemoteChain | undefined {
  const remotes = networkConfig(network).remotes;
  if (typeof key === "number") return remotes.find((r) => r.chainId === key);
  const k = key.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return remotes.find((r) => r.name.toLowerCase().replace(/[\s_-]+/g, "") === k || String(r.chainId) === k);
}

/**
 * The numeric chain id from a CAIP-2 `eip155:<id>` string.
 *
 * A pure parse: it accepts any EIP-155 chain (useful when checking what a
 * 402 is asking for), and throws on non-EVM namespaces.
 */
export function chainIdOf(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network.trim());
  if (!match) throw new Error(`not an EIP-155 network id: "${network}"`);
  return Number(match[1]);
}

/**
 * Whether an RPC URL is a local chain (a fork or a dev node) rather than an
 * Arc network. Anything timed against one is the local chain's timing, never
 * Arc's, and is labelled that way.
 */
export function isLocalRpc(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}
