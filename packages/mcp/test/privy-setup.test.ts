/**
 * The Privy policy the setup script writes, its argument parsing, and the
 * guarantee that importing the script does nothing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentPolicy,
  parseCapUsdc,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
} from "../src/privy-policy.js";
import { LEDGER, NETWORK, PROVIDER } from "./helpers/mock-broker.js";

const USDC_TESTNET = "0x3600000000000000000000000000000000000000";
/** A mixed-case ledger address, so both spellings are distinct. */
const MIXED_LEDGER = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

describe("buildAgentPolicy", () => {
  it("allows only USDC TransferWithAuthorization on the chain, up to the cap", () => {
    const policy = buildAgentPolicy({ network: NETWORK, capUnits: 500_000n });
    expect(policy).toMatchObject({ chain_type: "ethereum", version: "1.0", name: "xorv-agent-testnet" });
    expect(policy.rules).toHaveLength(1);
    const [rule] = policy.rules;
    expect(rule).toMatchObject({ method: "eth_signTypedData_v4", action: "ALLOW" });
    expect(rule!.name).toContain("$0.5000");
    expect(rule!.conditions).toEqual([
      { field_source: "ethereum_typed_data_domain", field: "chainId", operator: "eq", value: "5042002" },
      {
        field_source: "ethereum_typed_data_domain",
        field: "verifyingContract",
        operator: "in",
        // Arc's USDC address has no letters, so both spellings are the same one.
        value: [USDC_TESTNET],
      },
      {
        field_source: "ethereum_typed_data_message",
        field: "value",
        operator: "lte",
        value: "500000",
        typed_data: { primary_type: "TransferWithAuthorization", types: TRANSFER_WITH_AUTHORIZATION_TYPES },
      },
    ]);
  });

  it("uses Arc mainnet's chain id (5042) and USDC on mainnet", () => {
    const policy = buildAgentPolicy({ network: "eip155:5042", capUnits: 1n });
    expect(policy.rules[0]!.conditions[0]).toMatchObject({ value: "5042" });
    expect(policy.rules[0]!.conditions[1]).toMatchObject({ value: expect.arrayContaining(["0x3600000000000000000000000000000000000000"]) });
  });

  it("can restrict payees, and adds a rating rule for a known ledger", () => {
    const policy = buildAgentPolicy({ network: NETWORK, capUnits: 10_000n, payTo: [PROVIDER.toLowerCase()], ledger: MIXED_LEDGER.toLowerCase() });
    expect(policy.rules[0]!.conditions[3]).toMatchObject({
      field_source: "ethereum_typed_data_message",
      field: "to",
      operator: "in",
      value: [PROVIDER, PROVIDER.toLowerCase()],
    });
    expect(policy.rules[1]).toMatchObject({
      name: "XorvLedger job ratings",
      method: "eth_signTypedData_v4",
      conditions: [
        { field: "chainId", value: "5042002" },
        { field: "verifyingContract", operator: "in", value: [MIXED_LEDGER, MIXED_LEDGER.toLowerCase()] },
      ],
    });
  });

  it("adds an escrow rule: ReceiveWithAuthorization on Arc USDC, up to the cap, only into XorvEscrow", () => {
    const ESCROW = "0x1C75B3F897AD80a1A6fb32f864Cc845aabcC657E";
    const policy = buildAgentPolicy({ network: NETWORK, capUnits: 250_000n, escrow: ESCROW.toLowerCase() });
    expect(policy.rules).toHaveLength(2);
    const rwa = { primary_type: "ReceiveWithAuthorization", types: RECEIVE_WITH_AUTHORIZATION_TYPES };
    expect(policy.rules[1]).toMatchObject({ method: "eth_signTypedData_v4", action: "ALLOW" });
    expect(policy.rules[1]!.name).toMatch(/escrow.*\$0\.2500.*XorvEscrow/);
    expect(policy.rules[1]!.conditions).toEqual([
      { field_source: "ethereum_typed_data_domain", field: "chainId", operator: "eq", value: "5042002" },
      { field_source: "ethereum_typed_data_domain", field: "verifyingContract", operator: "in", value: [USDC_TESTNET] },
      { field_source: "ethereum_typed_data_message", field: "value", operator: "lte", value: "250000", typed_data: rwa },
      { field_source: "ethereum_typed_data_message", field: "to", operator: "in", value: [ESCROW, ESCROW.toLowerCase()], typed_data: rwa },
    ]);
    expect(RECEIVE_WITH_AUTHORIZATION_TYPES.ReceiveWithAuthorization.map((f) => f.name)).toEqual([
      "from",
      "to",
      "value",
      "validAfter",
      "validBefore",
      "nonce",
    ]);
  });

  it("refuses a zero cap and bad addresses", () => {
    expect(() => buildAgentPolicy({ network: NETWORK, capUnits: 0n })).toThrow(/greater than zero/);
    expect(() => buildAgentPolicy({ network: NETWORK, capUnits: 1n, payTo: ["0.0.1234"] })).toThrow(/not an EVM address/);
    expect(() => buildAgentPolicy({ network: "hedera:testnet", capUnits: 1n })).toThrow(/unsupported network/);
  });
});

describe("parseCapUsdc", () => {
  it("parses dollars into USDC units", () => {
    expect(parseCapUsdc("0.50")).toBe(500_000n);
    expect(parseCapUsdc("$2")).toBe(2_000_000n);
    expect(parseCapUsdc("0.000001")).toBe(1n);
  });

  it("refuses zero, junk and sub-unit precision", () => {
    expect(() => parseCapUsdc("0")).toThrow(/greater than zero/);
    expect(() => parseCapUsdc("-1")).toThrow(/dollar amount/);
    expect(() => parseCapUsdc("lots")).toThrow(/dollar amount/);
    expect(() => parseCapUsdc("0.0000001")).toThrow(/more than 6 decimals/);
  });
});

describe("privy-setup script", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does nothing on import", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const mod = await import("../src/scripts/privy-setup.js");
    expect(typeof mod.main).toBe("function");
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("requires --cap-usdc, accepts pnpm's forwarded --, and validates the network", async () => {
    const { parseSetupArgs } = await import("../src/scripts/privy-setup.js");
    expect(() => parseSetupArgs([])).toThrow(/--cap-usdc is required/);
    expect(parseSetupArgs(["--", "--cap-usdc", "0.25"])).toMatchObject({ capUnits: 250_000n, network: NETWORK, dryRun: false });
    expect(() => parseSetupArgs(["--cap-usdc", "1", "--network", "hedera:testnet"])).toThrow(/eip155:5042002/);
    expect(parseSetupArgs(["--cap-usdc", "1"], { XORV_NETWORK: "eip155:5042" })).toMatchObject({ network: "eip155:5042" });
    expect(parseSetupArgs(["--cap-usdc", "1", "--pay-to", `${PROVIDER}, ${LEDGER}`, "--owner-key"])).toMatchObject({
      payTo: [PROVIDER, LEDGER],
      ownerKey: true,
    });
    expect(parseSetupArgs(["-h"])).toBe("help");
    expect(parseSetupArgs(["--cap-usdc", "1", "--escrow", LEDGER])).toMatchObject({ escrow: LEDGER });
  });

  it("prints the policy on --dry-run without credentials or network", async () => {
    const { main } = await import("../src/scripts/privy-setup.js");
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => lines.push(line));
    const code = await main(["--cap-usdc", "0.5", "--ledger", LEDGER, "--dry-run"], {});
    expect(code).toBe(0);
    const policy = JSON.parse(lines.join("\n")) as { rules: unknown[] };
    expect(policy.rules).toHaveLength(2);
  });

  it("reads the ledger and escrow addresses from a broker's /api/network", async () => {
    const { contractsFromBroker } = await import("../src/scripts/privy-setup.js");
    const logs: string[] = [];
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ledger: { address: LEDGER }, escrow: { address: PROVIDER.toLowerCase() } }))) as typeof fetch;
    expect(await contractsFromBroker("http://b/", (l) => logs.push(l), fetchImpl)).toEqual({ ledger: LEDGER, escrow: PROVIDER });
    expect(logs).toEqual([]);
    const none = (async () => new Response(JSON.stringify({ ledger: null }))) as typeof fetch;
    expect(await contractsFromBroker("http://b", (l) => logs.push(l), none)).toEqual({ ledger: null, escrow: null });
    expect(logs.join(" ")).toMatch(/no XorvEscrow/);
  });

  it("stops with a clear message when the Privy app credentials are missing", async () => {
    const { main } = await import("../src/scripts/privy-setup.js");
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((line: string) => errors.push(line));
    expect(await main(["--cap-usdc", "0.5"], {})).toBe(2);
    expect(errors.join("\n")).toMatch(/XORV_PRIVY_APP_ID and XORV_PRIVY_APP_SECRET/);
  });
});
