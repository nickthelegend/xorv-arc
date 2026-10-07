/**
 * Which x402 facilitator settles this broker's payments.
 *
 * The facilitator is whoever submits a buyer's signed EIP-3009 authorization
 * and pays the gas for it — in USDC, Arc's gas token. There is no public x402
 * facilitator for Arc, so the default is the broker's own in-process one
 * (`XORV_FACILITATOR=self`, the key in XORV_FACILITATOR_KEY or
 * XORV_OPERATOR_KEY). It is also the only facilitator that can fund
 * XorvEscrow: its key is the escrow's attester. A hosted facilitator URL is
 * still accepted for a network that has one.
 *
 * The one thing this refuses to do is change a choice silently. With no key
 * to self-host with, payments are disabled and the paid route answers 503
 * with the fix, rather than settling through someone else.
 */

import type { FacilitatorClient } from "@x402/core/server";
import { buildFacilitator, networkConfig } from "@xorv/protocol";
import type { BrokerConfig } from "./config.js";

export interface FacilitatorResolution {
  /** Null when payments are unavailable; the paid route then answers 503. */
  facilitator: FacilitatorClient | null;
  mode: "self" | "hosted";
  description: string;
  /** The EOA paying settlement gas when self-hosted. */
  address: string | null;
  url: string | null;
  /** Why `facilitator` is null, phrased as the fix. */
  unavailableReason: string | null;
  /** A boot-time notice worth printing (e.g. "no key, fell back to hosted"). */
  notice: string | null;
}

export function resolveFacilitator(
  config: Pick<BrokerConfig, "network" | "facilitatorMode" | "facilitatorAccount" | "escrowAddress">,
  opts: { injected?: FacilitatorClient; log?: (line: string) => void } = {},
): FacilitatorResolution {
  if (opts.injected) {
    return {
      facilitator: opts.injected,
      mode: "self",
      description: "injected (test)",
      address: config.facilitatorAccount?.address ?? null,
      url: null,
      unavailableReason: null,
      notice: null,
    };
  }

  const cfg = networkConfig(config.network);
  const explicit = config.facilitatorMode;
  // Self-hosted unless told otherwise: Arc has no public facilitator.
  const mode = explicit ?? "self";

  if (mode === "self" && !config.facilitatorAccount) {
    return {
      facilitator: null,
      mode: "self",
      description: "self-hosted (unavailable: no key)",
      address: null,
      url: null,
      unavailableReason:
        "payments are disabled: the self-hosted facilitator needs XORV_FACILITATOR_KEY (or XORV_OPERATOR_KEY) " +
        `holding a little USDC for gas on ${cfg.name}`,
      notice: null,
    };
  }

  if (mode === "hosted" && cfg.facilitatorUrl === null) {
    return {
      facilitator: null,
      mode: "hosted",
      description: "hosted (unavailable)",
      address: null,
      url: null,
      unavailableReason: `payments are disabled: there is no public x402 facilitator for ${cfg.name}; use XORV_FACILITATOR=self`,
      notice: null,
    };
  }

  const choice = buildFacilitator({
    mode,
    network: config.network,
    account: config.facilitatorAccount,
    log: opts.log,
    // Escrow needs a facilitator that knows the scheme and holds the attester key: self-hosted only.
    escrow: mode === "self" ? (config.escrowAddress ?? null) : null,
  });
  return {
    facilitator: choice.facilitator,
    mode: choice.mode,
    description: choice.description,
    address: choice.address,
    url: choice.url,
    unavailableReason: null,
    notice: null,
  };
}
