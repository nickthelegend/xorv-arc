import { describe, expect, it } from "vitest";
import { ETHEREUM_SLOT_MS, formatGas, formatGasUsdc, formatMs, settledMs, vsEthereumSlot } from "@/lib/speed";

describe("the Arc speed receipt's formatting", () => {
  it("shows milliseconds under a second and seconds above", () => {
    expect(formatMs(612.4)).toBe("612 ms");
    expect(formatMs(999)).toBe("999 ms");
    expect(formatMs(1240)).toBe("1.24 s");
  });

  it("shows gas paid in USDC (Arc's gas token), short, without inventing precision", () => {
    expect(formatGasUsdc("4210650000000000")).toBe("0.00421 USDC");
    expect(formatGasUsdc(10n ** 18n)).toBe("1 USDC");
    expect(formatGasUsdc("0")).toBe("0 USDC");
    expect(formatGasUsdc("999")).toBe("<0.000001 USDC");
  });

  it("groups gas digits", () => {
    expect(formatGas("84213")).toBe("84,213");
  });

  it("treats the receipt as final: one settlement time, confirm first", () => {
    expect(settledMs({ confirmMs: 480, finalMs: 520 })).toBe(480);
    expect(settledMs({ confirmMs: null, finalMs: 520 })).toBe(520);
    expect(settledMs({ confirmMs: null })).toBeNull();
  });

  it("compares with one Ethereum slot only when the gap is real", () => {
    expect(ETHEREUM_SLOT_MS).toBe(12_000);
    expect(vsEthereumSlot(600)).toBe(20);
    expect(vsEthereumSlot(7_000)).toBeNull();
    expect(vsEthereumSlot(null)).toBeNull();
    expect(vsEthereumSlot(0)).toBeNull();
  });
});
