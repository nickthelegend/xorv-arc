import { describe, expect, it } from "vitest";
import { recoverTypedDataAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ARC_TESTNET,
  BURN_INTENT_DOMAIN,
  BURN_INTENT_TYPES,
  buildBurnIntent,
  burnIntentFromJson,
  burnIntentToJson,
  gatewayFor,
  type CcipQuoteTerms,
} from "@xorv/protocol/web";
import {
  checkGatewayIntent,
  formatScoreBps,
  fundingSources,
  gatewayTypedDataForSigning,
  parseUsdcAmount,
  postJobArgs,
  postJobCast,
  readGateway,
  readGatewayIntent,
  readGatewayMint,
  readProviderEscrow,
  shortfallUnits,
  suggestedTopUp,
  unitsToInput,
} from "@/lib/arc";
import { toWalletTypedData } from "@/lib/typed-data";

const buyer = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey()).address;

describe("the provider escrow record (XorvReputation)", () => {
  it("reads a configured, bound record", () => {
    const rec = readProviderEscrow({
      configured: true,
      reputation: "0x1111111111111111111111111111111111111111",
      completed: 12,
      failed: 1,
      earnedUnits: "120000",
      scoreBps: 9234,
      agentId: "7",
      reputationUrl: "https://explorer.testnet.arc.io/address/0x1111111111111111111111111111111111111111",
      agentUrl: "javascript:alert(1)",
    });
    expect(rec).toMatchObject({ configured: true, error: null, completed: 12, failed: 1, earnedUnits: "120000", scoreBps: 9234, agentId: "7" });
    if (rec.configured && rec.error === null) expect(rec.agentUrl).toBeNull();
    expect(formatScoreBps(9234)).toBe("92.3%");
    expect(formatScoreBps(10_000)).toBe("100.0%");
  });

  it("says unconfigured, unbound and unreadable apart", () => {
    expect(readProviderEscrow({ configured: false })).toEqual({ configured: false });
    expect(readProviderEscrow(null)).toEqual({ configured: false });
    expect(readProviderEscrow({ configured: true, error: "rpc down" })).toEqual({ configured: true, error: "rpc down" });
    const unbound = readProviderEscrow({ configured: true, reputation: "0x1111111111111111111111111111111111111111", agentId: null, scoreBps: 99999 });
    expect(unbound).toMatchObject({ agentId: null, scoreBps: 10_000, completed: 0, earnedUnits: "0" });
  });
});

describe("Circle Gateway top-up", () => {
  it("reads balances per chain and picks the funded sources, largest first", () => {
    const info = readGateway({
      available: true,
      wallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
      minter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
      sources: [{ domain: 6, name: "Base Sepolia" }, { domain: 0, name: "Ethereum Sepolia" }, { bad: true }],
      depositor: buyer.address,
      totalUnits: "3500000",
      balances: [
        { domain: 0, name: "Ethereum Sepolia", balanceUnits: "500000", balance: "0.50" },
        { domain: 6, name: "Base Sepolia", balanceUnits: "3000000", balance: "3.00" },
        { domain: 3, name: "Arbitrum Sepolia", balanceUnits: "0", balance: "0.00" },
      ],
    });
    expect(info.sources).toHaveLength(2);
    expect(fundingSources(info).map((b) => b.domain)).toEqual([6, 0]);
    expect(readGateway({ available: false, error: "Circle Gateway is off on this broker" })).toMatchObject({ available: false, balances: [], error: "Circle Gateway is off on this broker" });
  });

  it("sizes the top-up from the shortfall", () => {
    expect(shortfallUnits("40000", "50000")).toBe(10_000n);
    expect(shortfallUnits("60000", "50000")).toBe(0n);
    expect(suggestedTopUp(10_000n)).toBe(100_000n); // at least $0.10
    expect(suggestedTopUp(2_000_000n)).toBe(2_210_000n);
    expect(parseUsdcAmount("$1.25")).toBe(1_250_000n);
    expect(parseUsdcAmount("0")).toBeNull();
    expect(parseUsdcAmount("1.2345678")).toBeNull();
    expect(parseUsdcAmount("abc")).toBeNull();
    expect(unitsToInput(2_210_000n)).toBe("2.21");
    expect(unitsToInput(3_000_000n)).toBe("3");
  });

  it("signs the broker's burn intent so the broker recovers the buyer — through Privy's JSON-safe path too", async () => {
    const g = gatewayFor(ARC_TESTNET);
    const intent = buildBurnIntent(g, { sourceDomain: 6, depositor: buyer.address, recipient: buyer.address, value: 1_000_000n, salt: `0x${"ab".repeat(32)}` });
    // Exactly what POST /api/gateway/intent answers.
    const wire = JSON.parse(
      JSON.stringify({
        typedData: { domain: BURN_INTENT_DOMAIN, types: BURN_INTENT_TYPES, primaryType: "BurnIntent", message: burnIntentToJson(intent) },
        maxFeeUnits: intent.maxFee.toString(),
        maxFee: "0.022",
      }),
    );
    const { typedData } = readGatewayIntent(wire);
    checkGatewayIntent(typedData, { depositor: buyer.address, recipient: buyer.address, amountUnits: 1_000_000n, sourceDomain: 6, arcDomain: 26 });

    const forViem = gatewayTypedDataForSigning(typedData);
    const direct = await buyer.signTypedData(forViem as never);
    // Privy only ever sees the JSON-safe form; same digest, same signature.
    const safe = toWalletTypedData(forViem as never);
    const viaPrivy = await buyer.signTypedData(JSON.parse(JSON.stringify(safe)) as never);
    expect(viaPrivy).toBe(direct);

    // The broker's side: read the JSON intent back and recover the signer.
    const back = burnIntentFromJson(g, typedData.message);
    const signer = await recoverTypedDataAddress({ domain: BURN_INTENT_DOMAIN, types: BURN_INTENT_TYPES, primaryType: "BurnIntent", message: back, signature: direct as Hex });
    expect(signer).toBe(buyer.address);
  });

  it("refuses to sign an intent that isn't what the buyer asked for", () => {
    const g = gatewayFor(ARC_TESTNET);
    const intent = buildBurnIntent(g, { sourceDomain: 6, depositor: buyer.address, recipient: other, value: 1_000_000n, salt: `0x${"cd".repeat(32)}` });
    const td = readGatewayIntent({ typedData: { domain: BURN_INTENT_DOMAIN, types: BURN_INTENT_TYPES, primaryType: "BurnIntent", message: JSON.parse(JSON.stringify(burnIntentToJson(intent))) } }).typedData;
    const expectFor = { depositor: buyer.address, recipient: buyer.address, amountUnits: 1_000_000n, sourceDomain: 6, arcDomain: 26 };
    expect(() => checkGatewayIntent(td, expectFor)).toThrow(/recipient/);
    expect(() => checkGatewayIntent(td, { ...expectFor, recipient: other, amountUnits: 2_000_000n })).toThrow(/amount/);
    expect(() => checkGatewayIntent(td, { ...expectFor, recipient: other, sourceDomain: 0 })).toThrow(/source chain/);
    expect(() => readGatewayIntent({ error: "nope" })).toThrow("nope");
  });

  it("reads the mint result", () => {
    const tx = `0x${"12".repeat(32)}`;
    expect(readGatewayMint({ status: "minted", recipient: buyer.address, amountUnits: "1000000", amount: "1.00", mintTxHash: tx, explorerUrl: `https://explorer.testnet.arc.io/tx/${tx}` })).toMatchObject({
      mintTxHash: tx,
      amount: "1.00",
    });
    expect(() => readGatewayMint({ error: "Circle Gateway answered 400" })).toThrow("Circle Gateway answered 400");
  });
});

describe("posting a job over Chainlink CCIP", () => {
  const terms: CcipQuoteTerms = {
    receiver: "0x2222222222222222222222222222222222222222",
    arcChainSelector: "3034092155422581607",
    jobId: `0x${"ef".repeat(32)}`,
    provider: "0x3333333333333333333333333333333333333333",
    price: "50000",
    deadline: 1_790_000_000,
    sources: [{ name: "Base Sepolia", chainId: 84532, selector: "10344971235874465080", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", cctpDomain: 6 }],
    senders: { "84532": "0x4444444444444444444444444444444444444444" },
  };

  it("lays out postJob's arguments in order, with the approval it needs", () => {
    const a = postJobArgs(terms);
    expect(a).toMatchObject({ jobId: terms.jobId, provider: terms.provider, price: 50_000n, deadline: 1_790_000_000, maxFee: 0n, minFinalityThreshold: 2000, approve: 50_000n });
    expect(postJobArgs(terms, { maxFee: 1_000n, minFinalityThreshold: 1000 }).approve).toBe(51_000n);
  });

  it("prints a cast line an agent can run", () => {
    const line = postJobCast(terms, terms.senders["84532"]!, "https://sepolia.base.org");
    expect(line).toContain("cast send 0x4444444444444444444444444444444444444444");
    expect(line).toContain("postJob(bytes32,address,uint256,uint40,uint256,uint32)");
    expect(line).toContain(`${terms.jobId} ${terms.provider} 50000 1790000000 0 2000`);
  });
});
