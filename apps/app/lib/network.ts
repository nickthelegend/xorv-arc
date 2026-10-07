/**
 * Which Arc network this deployment talks to, resolved once.
 *
 * Everything chain-shaped — RPC, explorer, USDC address and its EIP-712
 * domain, ERC-8004 registries, faucets — comes from `@xorv/protocol`'s one
 * table, so the address the header reads a balance from is the same one the
 * broker's 402 asks the buyer to sign for. This module only decides *which*
 * row of that table the app is on, and builds the viem chain Privy and the
 * injected-wallet path both hand to wallets.
 *
 * `NEXT_PUBLIC_*` values are inlined at build time, so they must be read with
 * literal `process.env.NEXT_PUBLIC_…` expressions — a computed lookup would
 * come back `undefined` in the browser.
 */

import { defineChain, type Chain } from "viem";
import {
  DEFAULT_NETWORK,
  isLocalRpc,
  isSupportedNetwork,
  networkConfig,
  viemChain,
  type ArcNetwork,
  type NetworkConfig,
  type RemoteChain,
} from "@xorv/protocol/web";

/**
 * Resolve the configured network, refusing anything that is not Arc.
 *
 * A leftover `hedera:testnet` in someone's `.env.local` must fail the build
 * with a message that names the fix, not render a page that quietly points at
 * some other chain and then fails every payment as a mystery.
 */
export function resolveNetwork(raw: string | undefined): ArcNetwork {
  const value = raw?.trim();
  if (!value) return DEFAULT_NETWORK;
  if (isSupportedNetwork(value)) return value;
  throw new Error(
    `NEXT_PUBLIC_XORV_NETWORK="${value}" is not an Arc network — use eip155:5042002 (testnet) or eip155:5042 (mainnet)`,
  );
}

/** The CAIP-2 network id, e.g. `eip155:5042002`. */
export const NETWORK: ArcNetwork = resolveNetwork(process.env.NEXT_PUBLIC_XORV_NETWORK);

/** The full chain config for {@link NETWORK}. */
export const CHAIN_CONFIG: NetworkConfig = networkConfig(NETWORK);

export const IS_TESTNET = CHAIN_CONFIG.label === "testnet";

/**
 * Optional browser RPC. The public Arc endpoints are rate-limited per IP, which
 * a demo booth full of tabs polling balances can hit; a private RPC here keeps
 * the header honest without touching the broker's.
 */
export const PUBLIC_RPC_URL = process.env.NEXT_PUBLIC_XORV_RPC_URL?.trim() || CHAIN_CONFIG.rpcUrl;

/**
 * The viem chain wallets are asked to switch to and sign on: protocol's
 * definition (id, native USDC as the gas currency, Blockscout explorer, 0.5 s
 * block time) with the browser RPC applied.
 */
export const APP_CHAIN: Chain = defineChain({
  ...viemChain(NETWORK),
  rpcUrls: { default: { http: [PUBLIC_RPC_URL], webSocket: [CHAIN_CONFIG.wsUrl] } },
});

/** "Arc testnet" / "Arc mainnet" — for chrome, never for logic. */
export const NETWORK_LABEL = `Arc ${CHAIN_CONFIG.label}`;

/** Whether this app's contracts and payments run on a local chain; its timings are never Arc's. */
export const IS_LOCAL_CHAIN = isLocalRpc(PUBLIC_RPC_URL);

/**
 * The RPC the live strip reads Arc's head and gas price from. Always the real
 * network, even when the app's contracts run on a local fork: the strip is
 * Arc's heartbeat, read-only, and labelled as such.
 */
export const ARC_LIVE_RPC_URL = process.env.NEXT_PUBLIC_XORV_LIVE_RPC_URL?.trim() || CHAIN_CONFIG.rpcUrl;

/**
 * The chains a buyer funds from and a provider withdraws to (Base and Ethereum,
 * or their Sepolia testnets), as viem chains for the wallet to switch to.
 * Their gas is ETH; only Arc meters gas in USDC.
 */
export function remoteViemChain(remote: RemoteChain): Chain {
  return defineChain({
    id: remote.chainId,
    name: remote.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [remote.rpcUrl] } },
    blockExplorers: { default: { name: `${remote.name} explorer`, url: remote.explorerUrl } },
    testnet: IS_TESTNET,
  });
}

export const REMOTE_CHAINS: readonly RemoteChain[] = CHAIN_CONFIG.remotes;

export const REMOTE_VIEM_CHAINS: readonly Chain[] = REMOTE_CHAINS.map(remoteViemChain);

/** A remote chain by EVM chain id, or by CCTP domain. */
export function remoteByChainId(chainId: number): RemoteChain | undefined {
  return REMOTE_CHAINS.find((r) => r.chainId === chainId);
}
export function remoteByDomain(domain: number): RemoteChain | undefined {
  return REMOTE_CHAINS.find((r) => r.cctpDomain === domain);
}
