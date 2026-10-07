/**
 * The chain table is protocol surface: a wrong USDC address or EIP-712 name
 * here makes every signed payment invalid, and a silent fallback to the wrong
 * network sends real money somewhere nobody intended. These pin the verified
 * values and the override rules.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_NETWORK,
  ARC_BLOCK_TIME_MS,
  ARC_MAINNET,
  ARC_TESTNET,
  SUPPORTED_NETWORKS,
  chainIdOf,
  isSupportedNetwork,
  networkConfig,
  networkLabel,
  usdcAddress,
  viemChain,
  isLocalRpc,
} from "../src/chains.js";
import {
  explorerAddress,
  explorerAgent,
  explorerToken,
  explorerBlock,
  explorerTx,
  shortHex,
} from "../src/explorer.js";

const OVERRIDES = [
  "XORV_RPC_URL",
  "XORV_EXPLORER_URL",
  "XORV_STABLECOIN",
  "XORV_STABLECOIN_NAME",
  "XORV_STABLECOIN_VERSION",
] as const;

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(OVERRIDES.map((k) => [k, process.env[k]]));
  for (const k of OVERRIDES) delete process.env[k];
});
afterEach(() => {
  for (const k of OVERRIDES) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("networks", () => {
  it("defaults to Arc testnet, and knows exactly two networks", () => {
    expect(DEFAULT_NETWORK).toBe("eip155:5042002");
    expect(ARC_TESTNET).toBe("eip155:5042002");
    expect(ARC_MAINNET).toBe("eip155:5042");
    expect(SUPPORTED_NETWORKS).toEqual([ARC_TESTNET, ARC_MAINNET]);
    expect(isSupportedNetwork(ARC_TESTNET)).toBe(true);
    expect(isSupportedNetwork(ARC_MAINNET)).toBe(true);
    expect(isSupportedNetwork("hedera:testnet")).toBe(false);
    expect(isSupportedNetwork("eip155:8453")).toBe(false);
    expect(isSupportedNetwork(undefined)).toBe(false);
  });

  it("carries the verified testnet values", () => {
    const cfg = networkConfig(ARC_TESTNET);
    expect(cfg).toMatchObject({
      caip2: "eip155:5042002",
      chainId: 5042002,
      label: "testnet",
      rpcUrl: "https://rpc.testnet.arc.io",
      wsUrl: "wss://rpc.testnet.arc.io",
      explorerUrl: "https://explorer.testnet.arc.io",
      facilitatorUrl: null,
      faucets: { usdc: "https://faucet.circle.com" },
      hypersyncUrl: "https://arc-testnet.hypersync.xyz",
    });
    expect(cfg.usdc).toEqual({
      address: "0x3600000000000000000000000000000000000000",
      name: "USDC",
      version: "2",
      decimals: 6,
      symbol: "USDC",
    });
    expect(cfg.erc8004).toEqual({
      identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      validation: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
    });
  });

  it("carries the verified mainnet values", () => {
    const cfg = networkConfig(ARC_MAINNET);
    expect(cfg).toMatchObject({
      chainId: 5042,
      label: "mainnet",
      rpcUrl: "https://rpc.mainnet.arc.io",
      explorerUrl: "https://explorer.arc.io",
      faucets: { usdc: null },
    });
    expect(cfg.usdc.address).toBe("0x3600000000000000000000000000000000000000");
    // Read on chain: name() "USDC", version() "2". "USD Coin" would not match
    // the DOMAIN_SEPARATOR, and every signature made with it would revert.
    expect(cfg.usdc.name).toBe("USDC");
    expect(cfg.usdc.version).toBe("2");
    expect(cfg.erc8004.identity).toBe("0x8004A169FB4a3325136EB29fA0ceB6D2e539a432");
    expect(cfg.erc8004.reputation).toBe("0x8004BAa17C55a88189AE136b182e5fdA19dE9b63");
    expect(cfg.erc8004.validation).toBe("0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58");
  });

  it("throws on an unsupported network instead of falling back to one", () => {
    // A stale Hedera config must fail at boot, naming the fix.
    expect(() => networkConfig("hedera:testnet")).toThrow(/unsupported network.*eip155:5042002/);
    expect(() => networkConfig("eip155:1")).toThrow(/unsupported network/);
    expect(() => usdcAddress("hedera:mainnet")).toThrow(/unsupported network/);
  });

  it("hands out copies, so a caller mutating its config can't corrupt the table", () => {
    const a = networkConfig(ARC_TESTNET);
    a.usdc.name = "USD Coin";
    a.erc8004.identity = "0x0000000000000000000000000000000000000000";
    const b = networkConfig(ARC_TESTNET);
    expect(b.usdc.name).toBe("USDC");
    expect(b.erc8004.identity).toBe("0x8004A818BFB912233c491871b3d84c89A494BD9e");
  });

  it("labels mainnet only on an exact match, and never throws for a label", () => {
    expect(networkLabel(ARC_MAINNET)).toBe("mainnet");
    expect(networkLabel(ARC_TESTNET)).toBe("testnet");
    expect(networkLabel("something-else")).toBe("testnet");
  });

  it("parses the chain id out of any EIP-155 CAIP-2 id", () => {
    expect(chainIdOf(ARC_TESTNET)).toBe(5042002);
    expect(chainIdOf(ARC_MAINNET)).toBe(5042);
    expect(chainIdOf("eip155:8453")).toBe(8453);
    expect(() => chainIdOf("hedera:testnet")).toThrow(/not an EIP-155/);
    expect(() => chainIdOf("eip155:")).toThrow(/not an EIP-155/);
  });

  it("returns the network's USDC", () => {
    expect(usdcAddress(ARC_TESTNET)).toBe("0x3600000000000000000000000000000000000000");
    expect(usdcAddress(ARC_MAINNET)).toBe("0x3600000000000000000000000000000000000000");
  });
});

describe("environment overrides", () => {
  it("reads XORV_RPC_URL per call, without re-importing", () => {
    expect(networkConfig(ARC_TESTNET).rpcUrl).toBe("https://rpc.testnet.arc.io");
    process.env.XORV_RPC_URL = "https://my-node.example/rpc";
    expect(networkConfig(ARC_TESTNET).rpcUrl).toBe("https://my-node.example/rpc");
    delete process.env.XORV_RPC_URL;
    expect(networkConfig(ARC_TESTNET).rpcUrl).toBe("https://rpc.testnet.arc.io");
  });

  it("reads XORV_EXPLORER_URL per call and strips trailing slashes", () => {
    process.env.XORV_EXPLORER_URL = "https://explorer.testnet.arc.io///";
    expect(networkConfig(ARC_TESTNET).explorerUrl).toBe("https://explorer.testnet.arc.io");
    expect(explorerTx(ARC_TESTNET, "0xabc")).toBe("https://explorer.testnet.arc.io/tx/0xabc");
  });

  it("treats a blank override as unset", () => {
    process.env.XORV_RPC_URL = "   ";
    expect(networkConfig(ARC_TESTNET).rpcUrl).toBe("https://rpc.testnet.arc.io");
  });

  it("reads XORV_STABLECOIN per call, checksums it, and keeps the USDC domain unless told otherwise", () => {
    process.env.XORV_STABLECOIN = "0x1111111111111111111111111111111111111111";
    const cfg = networkConfig(ARC_TESTNET);
    expect(cfg.usdc.address).toBe("0x1111111111111111111111111111111111111111");
    expect(cfg.usdc.name).toBe("USDC");
    expect(usdcAddress(ARC_TESTNET)).toBe("0x1111111111111111111111111111111111111111");

    process.env.XORV_STABLECOIN = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
    process.env.XORV_STABLECOIN_NAME = "Test Dollar";
    process.env.XORV_STABLECOIN_VERSION = "1";
    expect(networkConfig(ARC_TESTNET).usdc).toMatchObject({
      address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      name: "Test Dollar",
      version: "1",
    });

    delete process.env.XORV_STABLECOIN;
    // The name/version overrides only apply alongside an address override.
    expect(networkConfig(ARC_TESTNET).usdc.name).toBe("USDC");
  });

  it("refuses a malformed XORV_STABLECOIN rather than silently pricing in real USDC", () => {
    process.env.XORV_STABLECOIN = "0.0.429274";
    expect(() => networkConfig(ARC_TESTNET)).toThrow(/XORV_STABLECOIN must be a 0x/);
  });
});

describe("viemChain", () => {
  it("builds a chain with the corrected block time and the configured endpoints", () => {
    const chain = viemChain(ARC_TESTNET);
    expect(chain.id).toBe(5042002);
    expect(chain.blockTime).toBe(ARC_BLOCK_TIME_MS);
    expect(chain.rpcUrls.default.http).toEqual(["https://rpc.testnet.arc.io"]);
    expect(chain.rpcUrls.default.webSocket).toEqual(["wss://rpc.testnet.arc.io"]);
    expect(chain.blockExplorers?.default.url).toBe("https://explorer.testnet.arc.io");
    // Gas is USDC, metered with 18 decimals (the native view of the same balance).
    expect(chain.nativeCurrency).toEqual({ name: "USDC", symbol: "USDC", decimals: 18 });
    expect(viemChain(ARC_MAINNET).id).toBe(5042);
  });

  it("applies overrides", () => {
    process.env.XORV_RPC_URL = "https://my-node.example/rpc";
    expect(viemChain(ARC_MAINNET).rpcUrls.default.http).toEqual(["https://my-node.example/rpc"]);
  });

  it("has no public x402 facilitator on Arc (the broker self-hosts)", () => {
    expect(networkConfig(ARC_TESTNET).facilitatorUrl).toBeNull();
    expect(networkConfig(ARC_MAINNET).facilitatorUrl).toBeNull();
  });
});

describe("explorer links", () => {
  const TX = "0x5f1c7e3b2a9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b";

  it("links transactions verbatim — EVM hashes need no rewriting", () => {
    expect(explorerTx(ARC_TESTNET, TX)).toBe(`https://explorer.testnet.arc.io/tx/${TX}`);
    expect(explorerTx(ARC_MAINNET, TX)).toBe(`https://explorer.arc.io/tx/${TX}`);
  });

  it("checksums addresses and tokens for display", () => {
    expect(explorerAddress(ARC_TESTNET, "0xd8da6bf26964af9d7eed9e03e53415d37aa96045")).toBe(
      "https://explorer.testnet.arc.io/address/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    );
    expect(explorerToken(ARC_MAINNET, "0x3600000000000000000000000000000000000000")).toBe(
      "https://explorer.arc.io/token/0x3600000000000000000000000000000000000000",
    );
  });

  it("tells a local chain from an Arc network by its RPC host", () => {
    expect(isLocalRpc("http://127.0.0.1:8650")).toBe(true);
    expect(isLocalRpc("http://localhost:8545")).toBe(true);
    expect(isLocalRpc("http://anvil.localhost:8545")).toBe(true);
    expect(isLocalRpc("https://rpc.testnet.arc.io")).toBe(false);
    expect(isLocalRpc("not a url")).toBe(false);
  });

  it("links a block by number", () => {
    expect(explorerBlock(ARC_TESTNET, 68_998_123)).toBe("https://explorer.testnet.arc.io/block/68998123");
  });

  it("links an ERC-8004 agent as the Identity Registry token instance page", () => {
    expect(explorerAgent(ARC_TESTNET, 42)).toBe(
      "https://explorer.testnet.arc.io/token/0x8004A818BFB912233c491871b3d84c89A494BD9e/instance/42",
    );
    expect(explorerAgent(ARC_MAINNET, "10259")).toBe(
      "https://explorer.arc.io/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432/instance/10259",
    );
    expect(explorerAgent(ARC_MAINNET, 7n)).toMatch(/\/7$/);
  });

  it("throws for an unsupported network rather than inventing a URL", () => {
    expect(() => explorerTx("hedera:testnet", TX)).toThrow(/unsupported network/);
  });
});

describe("shortHex", () => {
  it("keeps the 0x-inclusive head and the tail", () => {
    expect(shortHex("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe("0xd8dA…6045");
    expect(shortHex("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", 10, 6)).toBe("0xd8dA6BF2…A96045");
  });

  it("leaves short values alone", () => {
    expect(shortHex("0x1234")).toBe("0x1234");
    // 11 chars = head 6 + tail 4 + the ellipsis: shortening would hide nothing.
    expect(shortHex("0x123456789")).toBe("0x123456789");
    expect(shortHex("0x1234567890")).toBe("0x1234…7890");
  });
});

describe("Arc stack", () => {
  it("carries Circle's and Chainlink's Arc testnet contracts (docs.arc.io, CCIP directory)", () => {
    const cfg = networkConfig(ARC_TESTNET);
    expect(cfg.circle).toMatchObject({
      cctpDomain: 26,
      tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
      messageTransmitterV2: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
      gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
      gatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
      memo: "0x5294E9927c3306DcBaDb03fe70b92e01cCede505",
    });
    expect(cfg.ccip).toMatchObject({ chainSelector: "3034092155422581607", router: "0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8" });
    expect(cfg.remotes.map((r) => r.name)).toEqual(["Base Sepolia", "Ethereum Sepolia"]);
  });

  it("carries the mainnet ones", () => {
    const cfg = networkConfig(ARC_MAINNET);
    expect(cfg.circle.tokenMessengerV2).toBe("0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d");
    expect(cfg.circle.gatewayMinter).toBe("0x2222222d7164433c4C09B0b0D809a9b52C04C205");
    expect(cfg.ccip.chainSelector).toBe("6370580034781731079");
    expect(cfg.remotes.find((r) => r.name === "Base")?.cctpDomain).toBe(6);
  });
});
