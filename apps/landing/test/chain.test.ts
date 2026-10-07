import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The chain facts the page links to. CHAIN reads NEXT_PUBLIC_* once at module
 * load, so each case stubs the env and re-imports the module fresh.
 */

async function load(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const key of [
    "NEXT_PUBLIC_XORV_NETWORK",
    "NEXT_PUBLIC_XORV_EXPLORER_URL",
    "NEXT_PUBLIC_XORV_LEDGER_ADDRESS",
    "NEXT_PUBLIC_XORV_ESCROW_ADDRESS",
    "NEXT_PUBLIC_XORV_REPUTATION_ADDRESS",
  ]) {
    vi.stubEnv(key, env[key] ?? "");
  }
  return import("@/lib/chain");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("CHAIN", () => {
  it("defaults to Arc testnet with Circle's and ERC-8004's real addresses", async () => {
    const { CHAIN } = await load();
    expect(CHAIN).toMatchObject({
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
    });
  });

  it("switches to Arc mainnet by CAIP-2 id", async () => {
    const { CHAIN } = await load({ NEXT_PUBLIC_XORV_NETWORK: "eip155:5042" });
    expect(CHAIN).toMatchObject({
      network: "eip155:5042",
      chainId: 5042,
      name: "Arc mainnet",
      explorerUrl: "https://explorer.arc.io",
      rpcUrl: "https://rpc.mainnet.arc.io",
      erc8004: {
        identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
        reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
      },
    });
  });

  it("falls back to testnet for an unknown network rather than guessing", async () => {
    const { CHAIN } = await load({ NEXT_PUBLIC_XORV_NETWORK: "eip155:1" });
    expect(CHAIN.network).toBe("eip155:5042002");
  });

  it("invents no Xorv contract address when the build wasn't given one", async () => {
    const { CHAIN } = await load();
    expect(CHAIN.ledger).toBeNull();
    expect(CHAIN.escrow).toBeNull();
    expect(CHAIN.reputation).toBeNull();
  });

  it("takes Xorv's contract addresses and an explorer override from the env", async () => {
    const escrow = "0x3333333333333333333333333333333333333333";
    const { CHAIN, explorer } = await load({
      NEXT_PUBLIC_XORV_ESCROW_ADDRESS: ` ${escrow} `,
      NEXT_PUBLIC_XORV_EXPLORER_URL: "https://blockscout.example/",
    });
    expect(CHAIN.escrow).toBe(escrow);
    expect(explorer.address(escrow)).toBe(`https://blockscout.example/address/${escrow}`);
  });
});

describe("explorer", () => {
  it("builds Blockscout paths", async () => {
    const { explorer } = await load();
    const hash = `0x${"ab".repeat(32)}`;
    expect(explorer.tx(hash)).toBe(`https://explorer.testnet.arc.io/tx/${hash}`);
    expect(explorer.block(BigInt(123))).toBe("https://explorer.testnet.arc.io/block/123");
    expect(explorer.token("0x3600000000000000000000000000000000000000")).toBe(
      "https://explorer.testnet.arc.io/token/0x3600000000000000000000000000000000000000",
    );
    expect(explorer.nft("0x8004A818BFB912233c491871b3d84c89A494BD9e", 42)).toBe(
      "https://explorer.testnet.arc.io/token/0x8004A818BFB912233c491871b3d84c89A494BD9e/instance/42",
    );
  });

  it("names Arc networks and passes anything else through", async () => {
    const { networkName } = await load();
    expect(networkName("eip155:5042002")).toBe("Arc testnet");
    expect(networkName("eip155:5042")).toBe("Arc mainnet");
    expect(networkName("eip155:8453")).toBe("eip155:8453");
    expect(networkName(null)).toBe("Arc testnet");
  });
});
