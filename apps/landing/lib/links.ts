export const REPO_URL = "https://github.com/nickthelegend/xorv-arc";
/** Public broker the live ledger section reads. Optional: the page works without it. */
export const BROKER_URL = (
  process.env.NEXT_PUBLIC_XORV_BROKER_URL?.trim() || "http://localhost:8402"
).replace(/\/+$/, "");
/** The buyer app (Privy sign-in, pay per job). Falls back to its dev port. */
export const APP_URL = (process.env.NEXT_PUBLIC_XORV_APP_URL?.trim() || "http://localhost:3002").replace(
  /\/+$/,
  "",
);
export const LOOM_URL = "https://loompad.tech";
export const X402_URL = "https://x402.org";
export const ARC_URL = "https://www.arc.io";
export const ARC_DOCS_URL = "https://docs.arc.io";
/** Circle's faucet: testnet USDC, which on Arc is also the gas token. */
export const FAUCET_URL = "https://faucet.circle.com";
export const GATEWAY_URL = "https://developers.circle.com/gateway";
export const CCTP_URL = "https://developers.circle.com/cctp";
export const CCIP_URL = "https://docs.chain.link/ccip";
export const ERC8004_URL = "https://eips.ethereum.org/EIPS/eip-8004";
/** Where a provider guide lives until the Arc build of `@xorv/cli` is on npm. */
export const CLI_GUIDE_URL = `${REPO_URL}/tree/main/packages/cli#readme`;

export const NAV = [
  { label: "How it works", href: "#how" },
  { label: "Earn", href: "#earn" },
  { label: "Adapters", href: "#adapters" },
  { label: "Built with", href: "#stack" },
  { label: "Ledger", href: "#ledger" },
  { label: "Security", href: "#security" },
  { label: "FAQ", href: "#faq" },
];
