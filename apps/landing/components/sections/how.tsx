import { Reveal } from "@/components/ui/reveal";
import { Section, SectionHeading } from "@/components/ui/kit";

/**
 * How a job gets paid for.
 *
 * Numbered, and the numbers are load-bearing: this is a protocol sequence where
 * step 3 cannot happen before step 2, and the reader needs the order. Rendered
 * as a ruled list rather than a card grid — six equal boxes would flatten a
 * sequence into a menu.
 */
const STEPS = [
  {
    n: "01",
    title: "Someone posts a job",
    body: "A prompt, an optional model, a price ceiling — from the app, a script, an agent, or another chain over Chainlink CCIP. On a broker with the API keys set, Hunyuan hy4 screens the prompt and Qwen 3.8 Max picks a model when the buyer didn't; either way the matcher takes the cheapest live provider that can run it — liveness proven by heartbeat, not by a status page.",
  },
  {
    n: "02",
    title: "The network answers 402",
    body: "The quote freezes one provider at one price, single-use, for five minutes. The paid request answers HTTP 402 with the exact USDC amount, a refund deadline, and XorvEscrow as the payee — never the broker's own wallet.",
  },
  {
    n: "03",
    title: "The buyer signs once, and pays no gas",
    body: "One EIP-712 signature over an EIP-3009 authorization — a message, not a transaction — whose nonce commits to the job and its deadline. The broker's facilitator submits it and pays the gas, in USDC, so the buyer only ever holds USDC. Short on Arc? Circle Gateway is built to top the wallet up from another chain with one more signature (not yet exercised on testnet).",
  },
  {
    n: "04",
    title: "The money waits, then the job runs",
    body: "The USDC lands in XorvEscrow, final in one block, about half a second — Arc has no reorgs and no confirmation wait. The broker never takes custody. Then the job is dispatched to the provider's node and streams back live.",
  },
  {
    n: "05",
    title: "Delivered: released. Not delivered: refunded.",
    body: "On delivery the escrow pays the provider and records the result's hash; if the job fails, is cancelled or misses its deadline, it refunds the buyer in full — and after the deadline anyone may trigger that refund. Every move carries the job id in Arc's Memo, so the USDC can be reconciled by job on chain.",
  },
  {
    n: "06",
    title: "Settlement becomes reputation",
    body: "XorvReputation writes each release, and each at-fault refund, to the provider's ERC-8004 agent as successRate feedback — reputation that can only be earned by delivering paid work. The buyer can add a gasless rating, and Kimi K3 scores every public result there too.",
  },
];

export function How() {
  return (
    <Section id="how">
      <Reveal>
        <SectionHeading
          title="A job, a payment and a receipt — in one request"
          sub="x402 turns HTTP 402 from a status code nobody used into a working payment rail. Xorv runs the whole loop on Arc, where USDC is both the payment and the gas, and every step that moves money or reputation leaves an event you can read."
        />
      </Reveal>

      <ol className="mx-auto mt-16 max-w-3xl">
        {STEPS.map((step, i) => (
          <Reveal key={step.n} delay={i * 0.05}>
            <li className="group grid grid-cols-[2.5rem_1fr] gap-x-5 border-t border-[var(--line)] py-7 sm:grid-cols-[3.5rem_1fr] sm:gap-x-8">
              <span className="mono tnum pt-0.5 text-[12px] text-fg-4 transition-colors group-hover:text-fg-2">
                {step.n}
              </span>
              <div>
                <h3 className="text-[16.5px] font-medium tracking-[-0.015em] text-fg">
                  {step.title}
                </h3>
                <p className="measure mt-2 text-[14.5px] leading-relaxed text-fg-2">{step.body}</p>
              </div>
            </li>
          </Reveal>
        ))}
        <li className="border-t border-[var(--line)]" aria-hidden />
      </ol>

      <Reveal delay={0.1}>
        <p className="measure mx-auto mt-12 text-center text-[13.5px] leading-relaxed text-fg-3">
          Payment is locked <em className="not-italic text-fg-2">before</em> the job runs and
          released only after it delivers. The provider knows the money is there before spending
          real quota on a stranger&rsquo;s prompt, and the buyer knows it can only go to work that
          arrived — on Arc that costs a single ~0.5 s block, final on inclusion. The authorization is bound
          to one job and expires with the quote, so it can&rsquo;t be replayed or cashed late. A
          failed job is reassigned to another provider at no extra charge.
        </p>
      </Reveal>
    </Section>
  );
}
