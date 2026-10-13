/**
 * The questions a careful person actually asks.
 *
 * Including the uncomfortable ones. Someone is about to run prompts from
 * strangers against a paid account on their own laptop; pretending that has no
 * downside is the fastest way to lose them.
 */
export const FAQ: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: "Is this against my AI provider's terms of service?",
    a: "Possibly — check yours. Most consumer AI subscriptions are licensed to one person, and reselling that capacity may breach them. Xorv is infrastructure and doesn't decide this for you. Where your plan's terms forbid resale, sell through an API-key backend instead — the Qwen 3.8 Max, Kimi K3 and Hunyuan adapters, a team or enterprise plan that permits it, or your own local models through the OpenAI-compatible adapter.",
  },
  {
    q: "What can a stranger's prompt do to my machine?",
    a: "Each job runs inside an OS-level sandbox — seatbelt on macOS, bubblewrap on Linux, or a container if you opt in — in a fresh directory that is deleted when the job ends. Your payout key, SSH keys and cloud credentials are unreadable, and the job inherits an allowlisted environment rather than your shell. On a host with neither seatbelt nor bubblewrap there is no filesystem boundary, and xorv doctor says so. Set XORV_SAFE_MODE=1 to disable tools and sell text generation only.",
  },
  {
    q: "Do I need a gas token, to buy or to earn?",
    a: "No — on Arc, USDC is the gas token, so there is no second token to hold. A buyer signs an EIP-3009 authorization — a message, not a transaction — and Xorv's facilitator submits it and pays the gas, so the buyer only ever holds USDC. A provider only needs an address that can receive USDC, which on Arc is any address. The one optional thing a provider pays gas for is minting an ERC-8004 identity: a single transaction, paid in USDC. Testnet USDC comes from Circle's faucet.",
  },
  {
    q: "Is the broker a middleman that can take a cut?",
    a: "It isn't the payee, and it never has custody. The 402 response names XorvEscrow, and the buyer's client recomputes the authorization's nonce from the job id and its refund deadline rather than accepting one from the server — so one signature can fund that one job and nothing else. From the escrow the money goes to the provider doing the job or back to the buyer in full, and every move is public and tagged with the job id; the broker settles jobs, it doesn't hold them. The protocol fee is currently zero.",
  },
  {
    q: "What happens if a provider fails or disappears mid-job?",
    a: "The job is reassigned to another live provider at no extra cost to the buyer: the USDC stays in the escrow and only its eventual payee changes, with the refund deadline unchanged. The failure counts against the original provider in the broker's matcher, which is what it sorts on, and XorvReputation writes it to their ERC-8004 agent as a failed successRate entry — so a provider who keeps failing stops winning jobs. On XorvLedger the job still gets exactly one receipt, for its final outcome, recorded without an agent identity because the provider first matched is not the one that finished the work. If no other provider can take the job, the escrow refunds the buyer in full; and if a job is never settled, anyone can refund the buyer once its deadline passes — the refund keeper does it automatically.",
  },
  {
    q: "Can a provider fake its own reputation?",
    a: "Not cheaply. The successRate feedback XorvReputation writes comes only from escrow settlements — a release or an at-fault refund that moved real USDC — so every point of it costs the full price of a job, in public, with the job id on the transfer. Buyer ratings reach ERC-8004 only through XorvLedger: one per job, signed by the wallet that paid, and the ledger refuses a receipt the provider paid for and a rating from the agent's own wallet, owner or operators. Reputation comes from settlement, not from reviews anyone can write.",
  },
  {
    q: "What does the chain record — and what doesn't it?",
    a: "XorvEscrow records every job's funding, release, refund or reassignment — buyer, provider, amount, deadline, and on release a hash of the result — and every one of those USDC moves carries the job id in Arc's Memo, so anyone can reconcile the money by job. XorvReputation writes each settlement to the provider's ERC-8004 agent. XorvLedger adds provider registrations, sampled heartbeats, one receipt per job with keccak-256 hashes of the prompt and the result, and every rating. Never the prompt or the result themselves: a hash lets anyone holding the text prove it matches, and tells everyone else nothing.",
  },
  {
    q: "Are private jobs actually private?",
    a: "The result is. On a private job the provider seals the result to a key derived from your passkey before it leaves their node, so the broker only ever stores ciphertext and the hash on chain commits to that ciphertext — and the same passkey opens it on your other devices. None of this depends on the chain: the keys come from the passkey, not from a wallet. The prompt stays readable to the screener, the router and the provider running it, because a model can't work on text it can't read. The AI verifier skips private jobs.",
  },
  {
    q: "My USDC is on another chain. Do I have to bridge it?",
    a: "No. Deposit it into Circle Gateway once, on any chain Gateway supports — Base, Ethereum, Arbitrum, Avalanche, OP, Polygon or Arc. When your Arc wallet is short for a job, you sign one burn intent — no gas, no chain switch — and the broker mints the USDC on Arc. Fund once on any chain, pay per job on Arc. Providers go the other way with CCTP V2: burn earnings on Arc and mint native USDC on Base or Ethereum, with no bridge liquidity and no wrapped token. Be aware that neither direction has been exercised end to end on Arc testnet yet: both need funds on another chain. The Gateway signing and API calls are unit-tested and the CCTP burn is covered on a fork.",
  },
  {
    q: "Why Arc?",
    a: "Because x402 locks payment before the work starts, and on Arc that wait is one block of about half a second with deterministic finality — no reorgs and no confirmation count, so a provider can start the moment the escrow is funded. Gas is paid in USDC, so buyers and providers hold one token and every fee is priced in the same dollars as the job. It's EVM, so USDC's EIP-3009 authorizations give buyers a one-signature payment, and ERC-8004's identity and reputation registries are deployed here. And Circle's own rails are native to it: Gateway to fund from any chain, CCTP to withdraw to Base or Ethereum, and Memo to tag every transfer with the job it paid for.",
  },
  {
    q: "Can an agent use this without a human?",
    a: "That's the point. Xorv ships an MCP server that pays from a Privy server wallet under a spending policy, and a MetaMask Agent Wallet plugin that pays under the user's MetaMask policy. An agent on Base or Ethereum is meant to be able to post and pay for a job through Chainlink CCIP without ever holding funds on Arc: CCTP moves the USDC, CCIP carries the job to Arc, and a refund is forwarded back. That cross-chain path has not been run on testnet yet; it is covered by Chainlink Local and fork tests. Either way an agent discovers capacity, prices a job, pays for it and gets the result back with an Arc explorer link — no account, no card, no human in the loop. Every path carries a hard per-job ceiling, because a model that can spend without a bound can empty a wallet through a loop it didn't mean to write.",
  },
];
