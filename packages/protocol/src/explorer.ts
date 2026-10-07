/**
 * Block-explorer links.
 *
 * Built in one place so every surface — CLI, broker JSON, both web apps —
 * shows the same URL for the same thing, and so pointing the whole network at
 * a different explorer is one env var (`XORV_EXPLORER_URL`) rather than a grep.
 *
 * Arc's explorers are Blockscout, whose `/tx/`, `/address/`, `/block/` and
 * `/token/` paths any other Blockscout shares, so an override needs no path
 * rewriting. EVM hashes go in verbatim.
 */

import { getAddress, isAddress } from "viem";
import { networkConfig } from "./chains.js";

/** Checksum an address for display when it is one; pass anything else through. */
function displayAddress(value: string): string {
  const trimmed = value.trim();
  return isAddress(trimmed, { strict: false }) ? getAddress(trimmed) : trimmed;
}

/** Explorer link for a transaction hash. */
export function explorerTx(network: string, txHash: string): string {
  return `${networkConfig(network).explorerUrl}/tx/${txHash.trim()}`;
}

/** Explorer link for an account or contract. */
export function explorerAddress(network: string, address: string): string {
  return `${networkConfig(network).explorerUrl}/address/${displayAddress(address)}`;
}

/** Explorer link for a block. */
export function explorerBlock(network: string, block: number | bigint): string {
  return `${networkConfig(network).explorerUrl}/block/${String(block)}`;
}

/** Explorer link for a token contract. */
export function explorerToken(network: string, token: string): string {
  return `${networkConfig(network).explorerUrl}/token/${displayAddress(token)}`;
}

/**
 * Explorer link for a provider's ERC-8004 agent identity.
 *
 * An agent is an ERC-721 token on the Identity Registry, so its page is the
 * token instance page: `/token/<identity registry>/instance/<agentId>`.
 */
export function explorerAgent(network: string, agentId: string | number | bigint): string {
  const cfg = networkConfig(network);
  return `${cfg.explorerUrl}/token/${cfg.erc8004.identity}/instance/${String(agentId)}`;
}

/**
 * Shorten a hash or address for tight UI: `0x1234…abcd`.
 *
 * `head` counts from the very start (so it includes the `0x`), `tail` from the
 * end. Anything already short enough comes back unchanged — an ellipsis that
 * hides nothing is just noise.
 */
export function shortHex(hex: string, head = 6, tail = 4): string {
  const value = hex.trim();
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

/** Chainlink's CCIP explorer page for a message id. */
export function ccipMessageUrl(messageId: string): string {
  return `https://ccip.chain.link/msg/${messageId.trim()}`;
}
