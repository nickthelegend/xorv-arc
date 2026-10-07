/**
 * Circle Gateway on the broker: the intent a buyer signs, the checks before
 * anything reaches Circle, and (with GATEWAY_LIVE=1) a round trip to Circle's
 * real testnet Gateway API, which needs no key.
 */

import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET, BURN_INTENT_DOMAIN, BURN_INTENT_TYPES, burnIntentFromJson, gatewayFor } from "@xorv/protocol";
import { ArcHttpError, createGateway, usdcUnitsFromDecimal } from "../src/arc.js";

const buyer = privateKeyToAccount(generatePrivateKey());

async function signedIntent(gateway: ReturnType<typeof createGateway>, signer = buyer) {
  const { typedData } = gateway.intent({ depositor: buyer.address, sourceDomain: 6, amountUnits: "1500000" });
  const message = burnIntentFromJson(gatewayFor(ARC_TESTNET), typedData.message);
  const signature = await signer.signTypedData({ domain: BURN_INTENT_DOMAIN, types: BURN_INTENT_TYPES, primaryType: "BurnIntent", message });
  return { burnIntent: typedData.message, signature };
}

describe("Circle Gateway (broker)", () => {
  it("builds the burn intent: Base Sepolia → Arc, minted to the buyer, with a capped fee", () => {
    const gateway = createGateway({ network: ARC_TESTNET, relayer: null });
    const out = gateway.intent({ depositor: buyer.address, sourceDomain: 6, amountUnits: "1500000" });
    expect(out.typedData.domain).toEqual({ name: "GatewayWallet", version: "1" });
    expect(out.typedData.message.spec).toMatchObject({ sourceDomain: 6, destinationDomain: 26, value: "1500000" });
    expect(BigInt(out.maxFeeUnits)).toBeGreaterThan(0n);
    expect(() => gateway.intent({ depositor: "nope", sourceDomain: 6, amountUnits: "1" })).toThrow(ArcHttpError);
    expect(() => gateway.intent({ depositor: buyer.address, sourceDomain: 6, amountUnits: "x" })).toThrow(/base units/);
  });

  it("refuses to mint without an operator key, and refuses a signature that isn't the depositor's before calling Circle", async () => {
    let called = 0;
    const fetchSpy = (async () => {
      called += 1;
      return new Response("{}", { status: 500 });
    }) as typeof fetch;
    const readOnly = createGateway({ network: ARC_TESTNET, relayer: null, fetch: fetchSpy });
    await expect(readOnly.mint(await signedIntent(readOnly))).rejects.toThrow(/no operator key/);

    const gateway = createGateway({ network: ARC_TESTNET, relayer: privateKeyToAccount(generatePrivateKey()), fetch: fetchSpy });
    const forged = await signedIntent(gateway, privateKeyToAccount(generatePrivateKey()));
    await expect(gateway.mint(forged)).rejects.toThrow(/isn't signed by its depositor/);
    expect(called).toBe(0);
  });

  it("reads Circle's decimal balances without floating point", () => {
    expect(usdcUnitsFromDecimal("12.5")).toBe(12_500_000n);
    expect(usdcUnitsFromDecimal("0.000001")).toBe(1n);
    expect(usdcUnitsFromDecimal("3")).toBe(3_000_000n);
    expect(usdcUnitsFromDecimal("1.23456789")).toBe(1_234_567n);
    expect(usdcUnitsFromDecimal("garbage")).toBe(0n);
  });

  it.runIf(process.env.GATEWAY_LIVE === "1")(
    "live: Circle's testnet Gateway API answers balances, and refuses a correctly signed intent only for the empty balance",
    async () => {
      const gateway = createGateway({ network: ARC_TESTNET, relayer: privateKeyToAccount(generatePrivateKey()) });
      const balances = await gateway.balances(buyer.address);
      expect(balances.totalUnits).toBe("0");
      expect(balances.balances.length).toBeGreaterThan(0);
      const err = await gateway.mint(await signedIntent(gateway)).catch((e: unknown) => e as ArcHttpError);
      expect(err).toBeInstanceOf(ArcHttpError);
      expect((err as ArcHttpError).message).toMatch(/balance|insufficient/i);
    },
    30_000,
  );
});
