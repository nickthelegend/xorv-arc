/**
 * The Arc facts this site links to.
 *
 * Every address quoted on the page resolves to something a reader can open on
 * Arc's Blockscout explorer. A marketing site for a payments network that can't
 * show you the payments is just a claim.
 *
 * ## Why this is a local copy and not `@xorv/protocol/web`
 *
 * The protocol package owns these values for the broker, the CLI and the app.
 * The landing deliberately does not depend on it: it is a leaf site that
 * deploys on its own, and pulling in a workspace package means every build
 * (Vercel's included) has to compile the protocol first — for a page that needs
 * a handful of addresses and a string shortener. The values below are the verified
 * ones from the port spec; the live section prefers whatever the broker's
 * `/api/network` reports, so a drifted constant here shows up as a mismatch in
 * one place rather than a wrong link everywhere.
 *
 * Everything is overridable through `NEXT_PUBLIC_*`, which Next inlines at
 * build time — so pointing the site at mainnet or at the deployed ledger is an
 * env change and a redeploy, not an edit.
 */

export interface ChainFacts {
  /** CAIP-2 id, the same string the broker and the x402 `accepts` use. */
  network: string;
  chainId: number;
  name: string;
  explorerUrl: string;
  /** Public JSON-RPC endpoint (WebSocket is the same host over wss://). */
  rpcUrl: string;
  /**
   * USDC's ERC-20 interface (6 decimals). On Arc USDC is also the native gas
   * token (18 decimals at the protocol level); this is the view apps transfer.
   */
  usdc: string;
  /** Arc's Memo contract: every escrow move and x402 transfer carries its job id. */
  memo: string;
  erc8004: { identity: string; reputation: string };
}

const NETWORKS: Record<string, ChainFacts> = {
  "eip155:5042002": {
    network: "eip155:5042002",
    chainId: 5042002,
    name: "Arc testnet",
    explorerUrl: "https://explorer.testnet.arc.io",
    rpcUrl: "https://rpc.testnet.arc.io",
    usdc: "0x3600000000000000000000000000000000000000",
    memo: "0x5294E9927c3306DcBaDb03fe70b92e01cCede505",
    erc8004: {
      identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    },
  },
  "eip155:5042": {
    network: "eip155:5042",
    chainId: 5042,
    name: "Arc mainnet",
    explorerUrl: "https://explorer.arc.io",
    rpcUrl: "https://rpc.mainnet.arc.io",
    usdc: "0x3600000000000000000000000000000000000000",
    memo: "0x5294E9927c3306DcBaDb03fe70b92e01cCede505",
    erc8004: {
      identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
    },
  },
};

/** An unset or empty `NEXT_PUBLIC_*` reads as "use the default", not as "". */
function env(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

const base = NETWORKS[env(process.env.NEXT_PUBLIC_XORV_NETWORK) ?? ""] ?? NETWORKS["eip155:5042002"]!;

export const CHAIN = {
  ...base,
  explorerUrl: (env(process.env.NEXT_PUBLIC_XORV_EXPLORER_URL) ?? base.explorerUrl).replace(/\/+$/, ""),
  /**
   * The XorvLedger contract, when the build knows it. Optional on purpose: the
   * live section reads the address from the broker too, and a site built
   * before the contract existed must not invent one.
   */
  ledger: env(process.env.NEXT_PUBLIC_XORV_LEDGER_ADDRESS),
  /** XorvEscrow, when the build knows it. Same rule: no address is invented. */
  escrow: env(process.env.NEXT_PUBLIC_XORV_ESCROW_ADDRESS),
  /** XorvReputation (escrow settlements → ERC-8004), when the build knows it. */
  reputation: env(process.env.NEXT_PUBLIC_XORV_REPUTATION_ADDRESS),
};

/** A human name for a CAIP-2 id the broker reports, or the id itself when it isn't an Arc network. */
export function networkName(network: string | null | undefined): string {
  if (!network) return CHAIN.name;
  return NETWORKS[network]?.name ?? network;
}

/**
 * Explorer links, in Blockscout's path shapes (`/tx/`, `/address/`, `/block/`,
 * `/token/`). An explorer override on the same software needs no rewriting —
 * and an EVM hash goes in verbatim, with no id-format translation to get wrong.
 */
export const explorer = {
  tx: (hash: string) => `${CHAIN.explorerUrl}/tx/${hash}`,
  address: (address: string) => `${CHAIN.explorerUrl}/address/${address}`,
  block: (n: number | bigint) => `${CHAIN.explorerUrl}/block/${n.toString()}`,
  token: (address: string) => `${CHAIN.explorerUrl}/token/${address}`,
  /** An ERC-721 instance, e.g. an ERC-8004 agent on the Identity Registry. */
  nft: (address: string, id: string | number | bigint) => `${CHAIN.explorerUrl}/token/${address}/instance/${id.toString()}`,
};

/**
 * Shorten a hash or address for tight UI: `0x1234…abcd`.
 *
 * Same contract as the protocol's `shortHex`: `head` counts from the very
 * start (so it includes the `0x`), `tail` from the end, and anything already
 * short enough comes back unchanged — an ellipsis that hides nothing is noise.
 */
export function shortHex(hex: string, head = 6, tail = 4): string {
  const value = hex.trim();
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}
