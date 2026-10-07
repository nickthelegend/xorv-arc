/**
 * `xorv identity` — this node's ERC-8004 agent identity.
 *
 * An ERC-8004 identity is an NFT on Arc's canonical Identity Registry whose
 * `agentWallet` is the address the agent is paid at. Registering one does two
 * things for a provider:
 *
 *  - **Receipts bind to it.** XorvLedger records a job against the agent id
 *    only when the job's `payTo` equals the registry's `agentWallet`, so "this
 *    agent was paid for this job" is enforced on-chain, not asserted by us.
 *  - **Reputation becomes portable.** Buyer ratings and the Kimi verifier's
 *    scores land in the public Reputation Registry under the agent id, where
 *    any marketplace can read them — not in Xorv's database.
 *
 * Registration is one transaction from the payout key itself:
 * `register(agentURI)` makes the caller the owner *and* the agent wallet, so no
 * second `setAgentWallet` call (and no signature dance) is needed. That is also
 * why it needs the key and a little USDC for gas (Arc's gas token is USDC): it
 * is one of the few things in Xorv a provider pays gas for. An address-only node can still earn without it; it just earns
 * without an on-chain identity.
 *
 * The agentURI points at the broker (`<broker>/agents/<providerId>.json`),
 * which serves the ERC-8004 registration file — a URL that stays stable, so
 * the registration never needs a follow-up `setAgentURI` write when the
 * node's details change. The provider id is computed here from the node id
 * (`providerIdFor`, the same one-way hash the broker uses), never the node id
 * itself: the node id is what reclaims this node's slot on the broker, and an
 * agent URI is public forever.
 *
 * `xorv identity bind` then ties the identity to XorvReputation: one
 * `bind(agentId)` from the payout key, after which every escrow settlement
 * for this wallet (release or at-fault refund) is written to the agent's
 * ERC-8004 reputation with tag "successRate". `xorv identity` shows the
 * contract's counters and score for this node once it knows where it is.
 */

import {
  IDENTITY_ABI,
  accountFromKey,
  explorerAddress,
  explorerAgent,
  explorerTx,
  fetchBalances,
  formatAgo,
  formatGasUsdc,
  formatUsdc,
  networkConfig,
  networkLabel,
  normalizeAddress,
  providerIdFor,
  publicClientFor,
  sameAddress,
  walletClientFor,
  withGasHeadroom,
  type ClientOptions,
} from "@xorv/protocol";
import { parseEventLogs, zeroAddress, type Address, type Hex, type PrivateKeyAccount } from "viem";
import {
  payoutAddress,
  requireConfig,
  resolveBrokerUrl,
  resolvePrivateKey,
  saveConfig,
  type NodeConfig,
} from "../config.js";
import * as ui from "../ui.js";
import {
  bindAgent,
  formatScore,
  readReputation,
  resolveReputationAddress,
  type ReputationRecord,
} from "../reputation.js";

/**
 * The registration file URL this node's identity points at: keyed by the
 * public provider id, computed locally, so the node id never goes on-chain.
 */
export function agentUri(brokerUrl: string, nodeId: string): string {
  return `${brokerUrl.replace(/\/+$/, "")}/agents/${providerIdFor(nodeId)}.json`;
}

/**
 * True for an agent URI minted by an older CLI, which keyed it by the raw
 * node id. That id is what reclaims this node's broker slot, so an on-chain
 * URI naming it is a standing takeover risk: the node needs a new node id.
 */
export function uriExposesNodeId(uri: string | null, nodeId: string): boolean {
  if (!uri || !nodeId) return false;
  return uri.includes(`/agents/${encodeURIComponent(nodeId)}.json`) || uri.includes(`/agents/${nodeId}.json`);
}

/** A URI nobody but this machine can resolve — worth a warning before it goes on-chain for good. */
export function isLocalUri(uri: string): boolean {
  try {
    const host = new URL(uri).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host.endsWith(".local");
  } catch {
    return true;
  }
}

export interface GasCheck {
  gas: bigint;
  /** Worst-case fee for this transaction, in native USDC wei (gas limit × max fee). */
  costWei: bigint;
  balanceWei: bigint;
  enough: boolean;
}

/**
 * Can this address afford `register(agentURI)`?
 *
 * Budgets the worst case, limit × max fee per gas — the same padded limit the
 * send will use — against the native (gas) view of the address's USDC.
 */
export async function checkRegisterGas(opts: {
  network: string;
  account: Address;
  agentURI: string;
  client?: ClientOptions;
}): Promise<GasCheck> {
  const client = publicClientFor(opts.network, opts.client);
  const { identity } = networkConfig(opts.network).erc8004;
  const [balanceWei, estimate, fees] = await Promise.all([
    client.getBalance({ address: opts.account }),
    client.estimateContractGas({
      address: identity,
      abi: IDENTITY_ABI,
      functionName: "register",
      args: [opts.agentURI],
      account: opts.account,
    }),
    client.estimateFeesPerGas(),
  ]);
  const gas = withGasHeadroom(estimate);
  const perGas = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
  const costWei = gas * perGas;
  return { gas, costWei, balanceWei, enough: balanceWei >= costWei };
}

/**
 * Send `IdentityRegistry.register(agentURI)` from `account` and return the new
 * agent id, read from the `Registered` event in the receipt.
 *
 * The id comes from the event rather than a pre-send simulation's return
 * value: ids are sequential, so another registration landing first would make
 * a simulated id wrong.
 */
export async function registerAgent(opts: {
  network: string;
  account: PrivateKeyAccount;
  agentURI: string;
  gas: bigint;
  client?: ClientOptions;
}): Promise<{ agentId: string; txHash: Hex }> {
  const wallet = walletClientFor(opts.network, opts.account, opts.client);
  const { identity } = networkConfig(opts.network).erc8004;
  const txHash = await wallet.writeContract({
    address: identity,
    abi: IDENTITY_ABI,
    functionName: "register",
    args: [opts.agentURI],
    gas: opts.gas,
  });
  // No replacement check: this key sends nothing else concurrently, and
  // skipping it saves a transaction lookup per poll.
  const receipt = await wallet.waitForTransactionReceipt({ hash: txHash, checkReplacement: false, timeout: 60_000 });
  if (receipt.status !== "success") {
    throw new Error(`register() reverted — ${explorerTx(opts.network, txHash)}`);
  }
  const events = parseEventLogs({ abi: IDENTITY_ABI, eventName: "Registered", logs: receipt.logs }).filter((log) =>
    sameAddress(log.address, identity),
  );
  const mine = events.find((log) => sameAddress(log.args.owner, opts.account.address)) ?? events[0];
  if (!mine) {
    throw new Error(`register() succeeded but emitted no Registered event — ${explorerTx(opts.network, txHash)}`);
  }
  return { agentId: mine.args.agentId.toString(), txHash };
}

export interface IdentityState {
  agentId: string;
  owner: Address | null;
  /** Null when the registry has cleared it (it does on every NFT transfer). */
  wallet: Address | null;
  uri: string | null;
  /** The payout address this node is configured with. */
  payout: Address;
  /** `wallet == payout` — the condition XorvLedger enforces on every receipt. */
  walletMatches: boolean;
  ownerMatches: boolean;
}

/**
 * Read an agent back from the registry and compare it to the payout address.
 *
 * `ownerOf` reverts for an id that does not exist; that surfaces as a thrown
 * error, which is the right answer for a config pointing at a phantom agent.
 */
export async function readIdentity(opts: {
  network: string;
  agentId: string;
  payout: string;
  client?: ClientOptions;
}): Promise<IdentityState> {
  const client = publicClientFor(opts.network, opts.client);
  const { identity } = networkConfig(opts.network).erc8004;
  const id = BigInt(opts.agentId);
  const [owner, wallet, uri] = await Promise.all([
    client.readContract({ address: identity, abi: IDENTITY_ABI, functionName: "ownerOf", args: [id] }),
    client.readContract({ address: identity, abi: IDENTITY_ABI, functionName: "getAgentWallet", args: [id] }),
    client
      .readContract({ address: identity, abi: IDENTITY_ABI, functionName: "tokenURI", args: [id] })
      .catch(() => null),
  ]);
  const payout = normalizeAddress(opts.payout);
  const walletAddr = wallet === zeroAddress ? null : normalizeAddress(wallet);
  return {
    agentId: id.toString(),
    owner: normalizeAddress(owner),
    wallet: walletAddr,
    uri,
    payout,
    walletMatches: sameAddress(walletAddr, payout),
    ownerMatches: sameAddress(owner, payout),
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface IdentityRegisterOptions {
  uri?: string;
  force?: boolean;
  yes?: boolean;
}

export async function identityRegisterCommand(opts: IdentityRegisterOptions = {}): Promise<void> {
  const config = requireConfig();
  const network = config.network;
  const cfg = networkConfig(network);
  console.log(ui.banner("ERC-8004 identity"));

  if (config.agentId && !opts.force) {
    ui.ok(`this node is already agent ${ui.c.bold(`#${config.agentId}`)}`);
    ui.muted(`  ${explorerAgent(network, config.agentId)}`);
    ui.info(`check it with ${ui.c.accent("xorv identity show")}, or pass --force to register a new one`);
    ui.blank();
    return;
  }

  const payout = payoutAddress(config);
  const account = accountFromKey(resolvePrivateKey(config));
  if (!sameAddress(account.address, payout)) {
    // The registry makes the *sender* the agent wallet, so registering from any
    // other key would bind the identity to an address this node is not paid at
    // — and XorvLedger would refuse every receipt for it.
    throw new Error(
      `the configured key controls ${account.address}, not the payout address ${payout} — ` +
        "the identity must be registered from the payout key itself",
    );
  }

  const uri = opts.uri?.trim() || agentUri(resolveBrokerUrl(config), config.nodeId);
  ui.muted(`  registry  ${cfg.erc8004.identity} (${cfg.name})`);
  ui.muted(`  agentURI  ${uri}`);
  ui.muted(`  wallet    ${payout}`);
  ui.blank();
  if (isLocalUri(uri)) {
    ui.warn("that agentURI only resolves on this machine — nobody else can read the registration file");
    ui.muted("  point the node at a public broker (xorv init), or pass --uri <public url>");
    ui.blank();
  }

  const spin = ui.spinner(`checking ${ui.c.bold(payout)} can pay the gas…`);
  let gas: GasCheck;
  try {
    const balances = await fetchBalances(network, payout);
    if (BigInt(balances.nativeWei) === 0n) {
      spin.fail("this address holds no USDC — registering an identity costs a little gas, and gas on Arc is USDC");
      faucetHint(config);
      process.exitCode = 1;
      return;
    }
    gas = await checkRegisterGas({ network, account: payout, agentURI: uri });
  } catch (err) {
    spin.fail(`could not reach ${cfg.rpcUrl}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  if (!gas.enough) {
    spin.fail(`needs up to ${formatGasUsdc(gas.costWei)} for gas, holds ${formatGasUsdc(gas.balanceWei)}`);
    faucetHint(config);
    process.exitCode = 1;
    return;
  }
  spin.succeed(`gas up to ${formatGasUsdc(gas.costWei)} · balance ${formatGasUsdc(gas.balanceWei)}`);

  if (!opts.yes) {
    const go = await ui.confirm(`register an ERC-8004 identity for ${ui.c.bold(config.label)}?`, true);
    if (!go) {
      ui.info("nothing sent");
      ui.blank();
      return;
    }
  }

  const send = ui.spinner("sending register(agentURI)…");
  try {
    const { agentId, txHash } = await registerAgent({ network, account, agentURI: uri, gas: gas.gas });
    send.succeed(`registered as agent ${ui.c.bold(`#${agentId}`)}`);
    saveConfig({ ...config, agentId });
    ui.blank();
    console.log(
      ui.box(
        ui.kv([
          ["agent", ui.c.bold(`#${agentId}`)],
          ["wallet", payout],
          ["identity", ui.c.accent(explorerAgent(network, agentId))],
          ["tx", ui.c.muted(explorerTx(network, txHash))],
        ]),
        { title: "identity", color: ui.BRAND.mint },
      ),
    );
    ui.blank();
    ui.info(`restart ${ui.c.accent("xorv start")} so the broker records jobs against agent #${agentId}`);
  } catch (err) {
    send.fail(`registration failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
  ui.blank();
}

export interface IdentityShowOptions {
  json?: boolean;
  /** XorvReputation address; default XORV_REPUTATION_ADDRESS, then the broker's /api/network. */
  reputation?: string;
}

/**
 * This node's XorvReputation record, or null when the contract can't be found
 * or read. Never throws: reputation decorates `xorv identity` / `xorv status`,
 * it must not stop them.
 */
export async function nodeReputation(opts: {
  network: string;
  provider: string;
  brokerUrl: string | null;
  flag?: string;
  client?: ClientOptions;
  fetchImpl?: typeof fetch;
}): Promise<ReputationRecord | { error: string } | null> {
  let found: Awaited<ReturnType<typeof resolveReputationAddress>>;
  try {
    found = await resolveReputationAddress({ flag: opts.flag, brokerUrl: opts.brokerUrl, fetchImpl: opts.fetchImpl });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (!found) return null;
  try {
    return await readReputation({ network: opts.network, reputation: found.address, provider: opts.provider, client: opts.client });
  } catch (err) {
    return { error: `could not read XorvReputation ${found.address}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * The rows `xorv identity` / `xorv status` show for a XorvReputation record —
 * pure, so the wording is tested without a chain.
 *
 * `agentId` is the node's configured agent, to say when the wallet is bound to
 * a different one.
 */
export function reputationRows(
  network: string,
  record: ReputationRecord,
  agentId: string | null,
  now = Date.now(),
): Array<[string, string]> {
  let binding: string;
  if (!record.bound) {
    binding = ui.c.warn(`not bound — settlements aren't written to ERC-8004 yet: ${agentId ? "xorv identity bind" : "xorv identity register, then bind"}`);
  } else if (agentId && record.agentId !== agentId) {
    binding = ui.c.warn(`bound to agent #${record.agentId}, not this node's #${agentId} — run xorv identity bind`);
  } else if (!record.live) {
    binding = ui.c.bad(`bound to agent #${record.agentId}, but its agent wallet no longer matches — not writing`);
  } else {
    binding = `${ui.c.ok(`agent #${record.agentId} · live`)} ${ui.c.muted("— every escrow settlement is written to ERC-8004")}`;
  }
  const jobs = record.completed + record.failed;
  return [
    ["reputation", `${record.contract} ${ui.c.muted(explorerAddress(network, record.contract))}`],
    ["binding", binding],
    [
      "jobs",
      jobs === 0
        ? ui.c.muted("no escrow settlements yet")
        : `${ui.c.ok(`${record.completed} completed`)} · ${record.failed ? ui.c.bad(`${record.failed} failed`) : "0 failed"}`,
    ],
    ["score", `${ui.c.bold(formatScore(record.scoreBps))} ${ui.c.muted("success rate, Laplace-smoothed (50% with no history)")}`],
    ["earned", `${ui.c.money(formatUsdc(record.earnedUnits))} ${ui.c.muted("through the escrow")}`],
    ["last job", record.lastJobAt ? formatAgo(record.lastJobAt * 1000, now) : ui.c.muted("—")],
  ];
}

export async function identityShowCommand(opts: IdentityShowOptions = {}): Promise<void> {
  const config = requireConfig();
  const network = config.network;
  const payout = payoutAddress(config);
  const reputation = await nodeReputation({ network, provider: payout, brokerUrl: resolveBrokerUrl(config), flag: opts.reputation });
  const repJson = reputation && !("error" in reputation) ? reputation : null;

  if (!config.agentId) {
    if (opts.json) {
      console.log(JSON.stringify({ agentId: null, payout, network, reputation: repJson }, null, 2));
      return;
    }
    console.log(ui.banner("ERC-8004 identity"));
    ui.warn("this node has no ERC-8004 identity yet");
    ui.muted("  it can still earn; an identity makes its receipts and reputation verifiable on-chain");
    ui.info(`register one with ${ui.c.accent("xorv identity register")} (one transaction, a few cents of USDC gas)`);
    if (repJson) {
      ui.blank();
      console.log(ui.box(ui.kv(reputationRows(network, repJson, null)), { title: "XorvReputation", color: ui.BRAND.amber }));
    }
    ui.blank();
    return;
  }

  const state = await readIdentity({ network, agentId: config.agentId, payout });
  if (opts.json) {
    console.log(
      JSON.stringify({ ...state, network, explorer: explorerAgent(network, state.agentId), reputation: repJson }, null, 2),
    );
    if (!state.walletMatches) process.exitCode = 1;
    return;
  }

  console.log(ui.banner("ERC-8004 identity"));
  console.log(
    ui.box(
      ui.kv([
        ["agent", `${ui.c.bold(`#${state.agentId}`)} ${ui.c.muted(`(${networkLabel(network)})`)}`],
        ["owner", `${state.owner ?? "—"} ${state.ownerMatches ? ui.c.ok("· payout key") : ui.c.warn("· not this node's payout address")}`],
        [
          "agent wallet",
          state.wallet
            ? `${state.wallet} ${state.walletMatches ? ui.c.ok("· matches payout") : ui.c.bad("· does NOT match payout")}`
            : ui.c.bad("cleared (the NFT was transferred) — re-verify the wallet"),
        ],
        ["payout", `${payout} ${ui.c.muted(explorerAddress(network, payout))}`],
        ["agentURI", state.uri ? ui.c.muted(state.uri) : ui.c.muted("—")],
        ["explorer", ui.c.accent(explorerAgent(network, state.agentId))],
      ]),
      { title: "identity", color: state.walletMatches ? ui.BRAND.mint : ui.BRAND.rose },
    ),
  );
  ui.blank();
  if (repJson) {
    const healthy = repJson.live && repJson.agentId === state.agentId;
    console.log(
      ui.box(ui.kv(reputationRows(network, repJson, state.agentId)), {
        title: "XorvReputation",
        color: healthy ? ui.BRAND.mint : ui.BRAND.amber,
      }),
    );
    ui.blank();
  } else if (reputation && "error" in reputation) {
    ui.warn(`  ${reputation.error}`);
    ui.blank();
  } else {
    ui.muted("  XorvReputation: unknown — set XORV_REPUTATION_ADDRESS or pass --reputation <addr> to see on-chain stats");
    ui.blank();
  }
  if (uriExposesNodeId(state.uri, config.nodeId)) {
    ui.warn("this agent URI publishes the node id, which is what lets a node reclaim its slot on the broker");
    ui.muted("  give the node a new nodeId in config.json, then register a new identity: xorv identity register --force");
    ui.blank();
  }
  if (!state.walletMatches) {
    // XorvLedger refuses a receipt whose payTo is not the agent's wallet, so a
    // mismatch means jobs are paid but never recorded against this identity.
    ui.bad("the registry's agent wallet is not this node's payout address — receipts will not bind to this agent");
    ui.muted("  register a new identity from the payout key: xorv identity register --force");
    process.exitCode = 1;
    ui.blank();
  }
}

export interface IdentityBindOptions {
  /** XorvReputation address; default XORV_REPUTATION_ADDRESS, then the broker's /api/network. */
  reputation?: string;
  yes?: boolean;
}

/**
 * `xorv identity bind` — `XorvReputation.bind(agentId)` from the payout key, so
 * every escrow settlement for this node is written to its ERC-8004 agent.
 *
 * Checked before anything is sent: the node has an agent, the key is the
 * payout key, the registry's agent wallet is the payout address (bind maps
 * *that* wallet, so binding an agent whose wallet is elsewhere would collect
 * someone else's history), and the contract isn't already writing for it.
 */
export async function identityBindCommand(opts: IdentityBindOptions = {}): Promise<void> {
  const config = requireConfig();
  const network = config.network;
  const cfg = networkConfig(network);
  console.log(ui.banner("bind identity to XorvReputation"));

  if (!config.agentId) {
    throw new Error("this node has no ERC-8004 identity to bind — run `xorv identity register` first");
  }
  const payout = payoutAddress(config);
  const account = accountFromKey(resolvePrivateKey(config));
  if (!sameAddress(account.address, payout)) {
    throw new Error(
      `the configured key controls ${account.address}, not the payout address ${payout} — ` +
        "bind from the payout key, the only key that can later move its binding",
    );
  }

  const found = await resolveReputationAddress({ flag: opts.reputation, brokerUrl: resolveBrokerUrl(config) });
  if (!found) {
    throw new Error(
      "don't know where XorvReputation is — pass --reputation <addr>, set XORV_REPUTATION_ADDRESS, " +
        "or point the node at a broker whose /api/network names it (arc.reputation)",
    );
  }
  const reputation = found.address;
  ui.muted(`  contract  ${reputation} ${ui.c.muted(`(from ${found.source === "flag" ? "--reputation" : found.source === "env" ? "XORV_REPUTATION_ADDRESS" : "the broker"})`)}`);
  ui.muted(`  agent     #${config.agentId} (${cfg.name})`);
  ui.muted(`  wallet    ${payout}`);
  ui.blank();

  const spin = ui.spinner("reading the agent and its current binding…");
  let state: IdentityState;
  let before: ReputationRecord;
  let balanceWei: bigint;
  try {
    [state, before, balanceWei] = await Promise.all([
      readIdentity({ network, agentId: config.agentId, payout }),
      readReputation({ network, reputation, provider: payout }),
      fetchBalances(network, payout).then((b) => BigInt(b.nativeWei)),
    ]);
  } catch (err) {
    spin.fail(`could not read ${cfg.rpcUrl}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  if (!state.walletMatches) {
    spin.fail(`agent #${state.agentId}'s wallet is ${state.wallet ?? "cleared"}, not this node's payout address`);
    ui.muted("  bind() maps the agent's wallet; register a new identity from the payout key: xorv identity register --force");
    process.exitCode = 1;
    ui.blank();
    return;
  }
  if (before.bound && before.live && before.agentId === state.agentId) {
    spin.succeed(`already bound: agent #${state.agentId} collects this node's escrow outcomes`);
    ui.blank();
    console.log(ui.box(ui.kv(reputationRows(network, before, state.agentId)), { title: "XorvReputation", color: ui.BRAND.mint }));
    ui.blank();
    return;
  }
  if (balanceWei === 0n) {
    spin.fail("this address holds no USDC — bind() costs a little gas, and gas on Arc is USDC");
    faucetHint(config);
    process.exitCode = 1;
    return;
  }
  spin.succeed(
    before.bound
      ? `currently bound to agent #${before.agentId}${before.live ? "" : " (no longer live)"} — will re-bind to #${state.agentId}`
      : `not bound yet · gas balance ${formatGasUsdc(balanceWei)}`,
  );

  if (!opts.yes) {
    const go = await ui.confirm(`bind agent #${state.agentId} to XorvReputation?`, true);
    if (!go) {
      ui.info("nothing sent");
      ui.blank();
      return;
    }
  }

  const send = ui.spinner(`sending bind(${state.agentId})…`);
  try {
    const { txHash } = await bindAgent({ network, account, reputation, agentId: state.agentId });
    send.succeed(`bound agent ${ui.c.bold(`#${state.agentId}`)} — escrow settlements now land in its ERC-8004 reputation`);
    ui.muted(`  ${explorerTx(network, txHash)}`);
    ui.blank();
    const after = await readReputation({ network, reputation, provider: payout }).catch(() => null);
    if (after) {
      console.log(ui.box(ui.kv(reputationRows(network, after, state.agentId)), { title: "XorvReputation", color: ui.BRAND.mint }));
      ui.blank();
    }
  } catch (err) {
    send.fail(`bind failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    ui.blank();
  }
}

function faucetHint(config: NodeConfig): void {
  const cfg = networkConfig(config.network);
  const faucet = cfg.faucets.usdc;
  ui.blank();
  if (faucet) {
    ui.info(`get test USDC at ${ui.c.accent(faucet)} (choose "${cfg.name}") for ${ui.c.bold(config.address)}`);
    ui.muted("  USDC is Arc's gas token; a few cents cover the transaction");
  } else {
    ui.info(`send a little USDC to ${ui.c.bold(config.address)} on ${cfg.name} to pay the gas`);
  }
}
