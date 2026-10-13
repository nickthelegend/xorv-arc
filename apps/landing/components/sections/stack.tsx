import type { ReactNode } from "react";
import { Hunyuan, Kimi, Qwen } from "@lobehub/icons";
import { Reveal } from "@/components/ui/reveal";
import { Section, SectionHeading } from "@/components/ui/kit";
import { CHAIN, explorer } from "@/lib/chain";
import { ARC_URL, CCIP_URL, CCTP_URL, ERC8004_URL, GATEWAY_URL, REPO_URL, X402_URL } from "@/lib/links";
import { cn } from "@/lib/utils";

/**
 * What Xorv is built with.
 *
 * Not a logo wall. A row of logos says "we used these" and nothing else; the
 * claim worth making is *where each one sits in the loop*, and that is a
 * sentence, not a picture. So every entry is a wordmark set in the page's own
 * type, a one-word role, and what it actually does.
 *
 * Two groups: the Arc stack the money and reputation run on, then the models
 * and agent wallet that sit in the job loop itself.
 *
 * Text only, on purpose: no fetched third-party logos. The three model marks
 * are the monochrome glyphs from `@lobehub/icons` that the adapter table and
 * the app's model picker already ship.
 */

interface Item {
  name: string;
  role: string;
  href: string;
  mark?: ReactNode;
  body: string;
}

const ARC: Item[] = [
  {
    name: "Arc",
    role: "chain",
    href: ARC_URL,
    body: "Circle's stablecoin chain. Gas is paid in USDC, so buyers and providers hold one token, and blocks land about every half second and are final on inclusion — a funded escrow is final the block it lands in, with no reorg to wait out. Measured on testnet, a payment takes 2 to 3 seconds from the broker sending it to holding its receipt.",
  },
  {
    name: "x402 + XorvEscrow",
    role: "payments",
    href: X402_URL,
    body: "A job is paid over HTTP 402 with one EIP-3009 signature in USDC. The broker's facilitator funds XorvEscrow with it and pays the gas; delivery releases the money to the provider, anything else refunds the buyer.",
  },
  {
    name: "ERC-8004",
    role: "identity",
    href: ERC8004_URL,
    body: "Providers mint an agent on Arc's Identity Registry and bind it to their payout wallet. Their record lives in the Reputation Registry, where any marketplace can read it — not in Xorv's database.",
  },
  {
    name: "XorvReputation",
    role: "reputation",
    href: `${REPO_URL}/blob/main/contracts/src/XorvReputation.sol`,
    body: "Every escrow release, and every at-fault refund, is written to the provider's ERC-8004 agent as successRate feedback. Reputation from settlement, not from reviews: each point of it cost a paid job.",
  },
  {
    name: "Arc Memo",
    role: "reconciliation",
    href: explorer.address(CHAIN.memo),
    body: "Every escrow fund, release and refund, and every x402 transfer, is tagged with the escrow job id and a label like xorv:release — so anyone can reconcile Xorv's USDC flows job by job, straight from the chain.",
  },
  {
    name: "Circle Gateway",
    role: "funding",
    href: GATEWAY_URL,
    body: "Fund once on any chain, pay per job on Arc. A buyer deposits USDC on Base, Ethereum, Arbitrum, Avalanche, OP, Polygon or Arc; when their Arc wallet is short, one signed burn intent — no gas, no chain switch — is minted on Arc. Not yet exercised on testnet: it needs a USDC deposit on another chain; the signing and API calls are unit-tested.",
  },
  {
    name: "CCTP V2",
    role: "withdrawals",
    href: CCTP_URL,
    body: "Providers burn their Arc earnings with TokenMessengerV2 and mint native USDC on Base or Ethereum. No bridge liquidity, no wrapped token — the same USDC on the other side. Not yet exercised on testnet: the burn is covered on a fork and the mint on the destination chain is user-run.",
  },
  {
    name: "Chainlink CCIP",
    role: "cross-chain jobs",
    href: CCIP_URL,
    body: "An agent on Base or Ethereum calls XorvCcipSender.postJob. CCTP moves the USDC, CCIP carries the job to XorvCcipReceiver on Arc, which funds XorvEscrow — and a refund is forwarded back to the chain it came from. XorvCcipReceiver is deployed on Arc testnet, but no cross-chain send has been run; the flow is covered by Chainlink Local and fork tests.",
  },
  {
    name: "Refund keeper",
    role: "refunds",
    href: `${REPO_URL}/blob/main/services/broker/src/keeper.ts`,
    body: "Refunds every escrowed job past its deadline, automatically. The contract lets anyone do it once the deadline passes — the money can only go back to the buyer — so the keeper is a convenience, not a trust assumption.",
  },
  {
    name: "Envio",
    role: "indexer",
    href: "https://envio.dev",
    body: "HyperIndex can follow Xorv's contracts and the ERC-8004 registries over Arc's HyperSync and derive earnings, success rate and reputation per provider. The indexer is in the repo with its tests but is not deployed: the stats and leaderboard further down this page are read from the broker and Arc's RPC.",
  },
  {
    name: "Privy",
    role: "wallets",
    href: "https://privy.io",
    body: "With a Privy app id configured, the app's embedded wallet signs each x402 payment and each gasless rating right in the browser — sign in with email, Google or a passkey, no extension. Without one, the app offers an injected wallet and a testnet demo account. Agents buying over MCP pay from a Privy server wallet held to a spending policy.",
  },
  {
    name: "Mera",
    role: "privacy",
    href: "https://mera.category.xyz/",
    body: "Private jobs are sealed to a key derived from your passkey. The provider encrypts the result before it leaves the node, so the broker stores only ciphertext — and you can open it on a second device. No chain involved: the key comes from the passkey, not a wallet.",
  },
];

const LOOP: Item[] = [
  {
    name: "MetaMask Agent Wallet",
    role: "agent wallet",
    href: "https://docs.metamask.io/agent-wallet/",
    body: "The mm xorv plugin lets an agent quote, pay for and rate jobs from its MetaMask wallet. MetaMask signs the EIP-3009 authorization under the user's own policy; the plugin never sees a key.",
  },
  {
    name: "Qwen 3.8 Max",
    role: "router",
    href: "https://www.qwencloud.com/models/qwen3.8-max-0902",
    mark: <Qwen size={15} />,
    body: "Routes each job that doesn't name a model to the adapter best suited to it, before the quote is frozen — so the price the buyer signs is for the model that will run.",
  },
  {
    name: "Hunyuan hy4",
    role: "screen",
    href: "https://www.tencentcloud.com/products/tokenhub",
    mark: <Hunyuan size={15} />,
    body: "Screens every prompt before any provider sees it, and refuses the quote when it should. A provider renting out their own machine shouldn't be the first line of defence.",
  },
  {
    name: "Kimi K3",
    role: "verifier",
    href: "https://platform.kimi.ai/docs/models",
    mark: <Kimi size={15} />,
    body: "Scores every public result against its prompt and writes the score to ERC-8004 reputation from the verifier's own address — on-chain, beside the settlement record.",
  },
];

function Grid({ label, items, wide = false }: { label: string; items: Item[]; wide?: boolean }) {
  return (
    <div className="mx-auto max-w-5xl">
      <h3 className="text-[11px] uppercase tracking-[0.14em] text-fg-4">{label}</h3>
      <ul
        className={cn(
          "mt-5 grid gap-px overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--line)] sm:grid-cols-2",
          wide ? "lg:grid-cols-4" : "lg:grid-cols-3",
        )}
      >
        {items.map((item, i) => (
          <li
            key={item.name}
            className={cn(
              "flex flex-col bg-black p-6",
              // A lone last item on the three-column grid spans the row rather than leaving two empty cells.
              !wide && i === items.length - 1 && items.length % 3 === 1 && "lg:col-span-3",
            )}
          >
            <div className="flex items-baseline justify-between gap-3">
              <a
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-[15px] font-semibold tracking-[-0.02em] text-fg underline-offset-4 hover:underline"
              >
                {item.mark ? (
                  <span aria-hidden className="flex h-4 w-4 shrink-0 items-center justify-center text-fg-2">
                    {item.mark}
                  </span>
                ) : null}
                {item.name}
              </a>
              <span className="mono shrink-0 text-[11px] text-fg-4">{item.role}</span>
            </div>
            <p className="mt-3 text-[13.5px] leading-relaxed text-fg-2">{item.body}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Stack() {
  return (
    <Section id="stack" className="border-t border-[var(--line)]">
      <Reveal>
        <SectionHeading
          title="Built on Arc"
          sub="Every name here does a job in the loop above — none of them is here as decoration. The money, the identity and the reputation run on Arc and Circle's own rails."
        />
      </Reveal>

      <Reveal delay={0.06}>
        <div className="mt-14">
          <Grid label="The Arc stack" items={ARC} />
        </div>
      </Reveal>

      <Reveal delay={0.08}>
        <div className="mt-12">
          <Grid label="In the job loop" items={LOOP} wide />
        </div>
      </Reveal>

      <Reveal delay={0.1}>
        <p className="measure mx-auto mt-10 text-center text-[13.5px] leading-relaxed text-fg-3">
          The three AI roles are switched on per broker, each only when its API key is set, and fail open: a model that is down or slow
          degrades a job to the plain price matcher, and never blocks a quote or a result. The public testnet run exercised the role code against a local mock model server; no real model API was called.
        </p>
      </Reveal>
    </Section>
  );
}
