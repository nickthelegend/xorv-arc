import { describe, expect, it } from "vitest";
import { ESCROW_RELEASE_GAS, blockIntervalMs, finalityLag, formatGwei, gasCostWei, releaseCostText } from "@/lib/arc-live";

describe("the Arc live strip's math", () => {
  it("measures the block interval from timestamps over a window", () => {
    expect(blockIntervalMs({ number: 1_000n, timestamp: 1_760_000_000n }, { number: 1_120n, timestamp: 1_760_000_060n })).toBe(500);
    expect(blockIntervalMs({ number: 5n, timestamp: 10n }, { number: 5n, timestamp: 10n })).toBeNull();
    expect(blockIntervalMs({ number: 5n, timestamp: 20n }, { number: 6n, timestamp: 10n })).toBeNull();
  });

  it("prices one escrow release in USDC at the current gas price", () => {
    expect(ESCROW_RELEASE_GAS).toBe(300_000n);
    expect(gasCostWei(20_000_000_000n)).toBe(6_000_000_000_000_000n);
    expect(releaseCostText(20_000_000_000n)).toBe("0.006 USDC");
    expect(gasCostWei(-1n)).toBe(0n);
  });

  it("formats gwei to one decimal", () => {
    expect(formatGwei(20_000_000_000n)).toBe("20.0 gwei");
    expect(formatGwei(20_160_000_000n)).toBe("20.2 gwei");
  });

  it("reports how far finalized trails latest (zero on Arc)", () => {
    expect(finalityLag(100n, 100n)).toBe(0);
    expect(finalityLag(101n, 100n)).toBe(1);
    expect(finalityLag(100n, 101n)).toBe(0);
    expect(finalityLag(100n, null)).toBeNull();
  });
});
