/**
 * The chain: a local fork of Arc testnet, with Xorv's contracts deployed by
 * the real deploy script.
 *
 * Forking (rather than a blank local chain) is the point of the exercise: the
 * USDC the buyer pays in is Circle's real FiatToken at `0x3600…0000`, with its
 * real EIP-712 domain ("USDC", "2") and its real EIP-3009 authorizations; the
 * Identity and Reputation registries are the canonical ERC-8004 v2.0.0
 * singletons; Arc's Memo predeploy, CCTP's TokenMessengerV2 and Chainlink's
 * CCIP router are the real contracts. The broker, the CLI and the MCP server
 * run with their default testnet configuration — only the RPC URL points
 * somewhere else.
 *
 * The fork is **Arc Foundry's** anvil (`arc-anvil --network arc`): plain anvil
 * can fork Arc but cannot move Arc's native USDC (the ERC-20 at 0x3600… is a
 * view of the native balance, implemented by a precompile). On Arc the native
 * balance *is* the USDC balance, so funding is `anvil_setBalance` — 18-decimal
 * native units, which the ERC-20 reports with 6.
 */

import fs from "node:fs";
import path from "node:path";
import { createPublicClient, getAddress, http, parseAbi, toHex, type Address, type Hex, type PublicClient } from "viem";
import { ARC_TESTNET, networkConfig, viemChain } from "@xorv/protocol";
import { delay, tail, type ManagedProcess, type ProcessGroup } from "./procs.js";

export const FIAT_TOKEN_ABI = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
]);

/** Arc Foundry's anvil: ARC_ANVIL, else `arc-anvil` on PATH. */
export function arcAnvil(): string {
  return process.env.ARC_ANVIL?.trim() || "arc-anvil";
}

export interface Fork {
  url: string;
  chainId: number;
  forkBlock: bigint;
  forkedFrom: string;
  process: ManagedProcess;
  client: PublicClient;
  rpc<T = unknown>(method: string, params?: unknown[]): Promise<T>;
}

/** Start arc-anvil forking Arc testnet with 1-second blocks. */
export async function startFork(opts: {
  group: ProcessGroup;
  port: number;
  forkUrl: string;
  forkBlock?: string | null;
  env: NodeJS.ProcessEnv;
}): Promise<Fork> {
  const url = `http://127.0.0.1:${opts.port}`;
  const args = [
    "--network",
    "arc",
    "--fork-url",
    opts.forkUrl,
    ...(opts.forkBlock ? ["--fork-block-number", opts.forkBlock] : []),
    "--host",
    "127.0.0.1",
    "--port",
    String(opts.port),
    "--block-time",
    "1",
    "--silent",
  ];
  const proc = opts.group.start("fork", arcAnvil(), args, { cwd: process.cwd(), env: opts.env });
  const rpc = async <T,>(method: string, params: unknown[] = []): Promise<T> => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = (await res.json()) as { result?: T; error?: { message: string } };
    if (json.error) throw new Error(`${method}: ${json.error.message}`);
    return json.result as T;
  };
  let chainId = 0;
  await waitUntil("arc-anvil to answer", 120_000, async () => {
    if (!proc.running) throw new Error(`arc-anvil exited\n${tail(proc.output)}`);
    chainId = Number(await rpc<string>("eth_chainId"));
    return chainId > 0;
  });
  if (chainId !== networkConfig(ARC_TESTNET).chainId) throw new Error(`the fork reports chain ${chainId}, not Arc testnet`);
  const client = createPublicClient({ chain: viemChain(ARC_TESTNET), transport: http(url, { timeout: 120_000 }), pollingInterval: 250 });
  const forkBlock = await client.getBlockNumber();
  return { url, chainId, forkBlock, forkedFrom: opts.forkUrl, process: proc, client, rpc };
}

/** USDC units (6 decimals) → the native balance's 18-decimal units. */
export const nativeFromUsdc = (units: bigint): bigint => units * 10n ** 12n;

/**
 * Set an address's USDC to exactly `units` (6 decimals). On Arc the native
 * balance is the USDC balance, so this is `anvil_setBalance`, read back
 * through the ERC-20 to prove the two views agree.
 */
export async function setUsdc(fork: Fork, address: Address, units: bigint): Promise<void> {
  await fork.rpc("anvil_setBalance", [address, toHex(nativeFromUsdc(units))]);
  const usdc = networkConfig(ARC_TESTNET).usdc.address;
  const seen = await fork.client.readContract({ address: usdc, abi: FIAT_TOKEN_ABI, functionName: "balanceOf", args: [address] });
  if (seen !== units) throw new Error(`setBalance(${address}) shows ${seen} USDC units through the ERC-20, not ${units}`);
}

export interface ArcDeployment {
  ledger: Address;
  escrow: Address;
  reputation: Address;
  ccipReceiver: Address;
  owner: Address;
  broker: Address;
  fromBlock: bigint;
  gasUsed: bigint | null;
  costUsdc: string | null;
  output: string;
  ms: number;
}

/**
 * Deploy with the real script (`scripts/deploy.sh local`): XorvLedger,
 * XorvReputation, XorvEscrow and XorvCcipReceiver, wired the way testnet and
 * mainnet are. `deployerKey` is a throwaway fork key.
 */
export async function deployArc(opts: {
  group: ProcessGroup;
  repo: string;
  runDir: string;
  fork: Fork;
  deployerKey: Hex;
  broker: Address;
  env: NodeJS.ProcessEnv;
}): Promise<ArcDeployment> {
  const deployerEnv = path.join(opts.runDir, "deployer.env");
  fs.writeFileSync(deployerEnv, `DEPLOYER_PRIVATE_KEY=${opts.deployerKey}\n`, { mode: 0o600 });
  const record = path.join(opts.runDir, "deployment.json");
  const fromBlock = await opts.fork.client.getBlockNumber();
  const forge = process.env.ARC_FORGE?.trim();
  const result = await opts.group.run("deploy", "bash", [path.join(opts.repo, "scripts", "deploy.sh"), "local"], {
    cwd: opts.repo,
    env: {
      ...opts.env,
      DEPLOYER_ENV: deployerEnv,
      XORV_BROKER_ADDRESS: opts.broker,
      XORV_NO_LOCK: "1",
      ARC_RPC_URL: opts.fork.url,
      XORV_DEPLOYMENT_FINAL: record,
      ...(forge ? { ARC_FORGE: forge } : {}),
    },
    timeoutMs: 600_000,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0 || !fs.existsSync(record)) throw new Error(`scripts/deploy.sh local failed (exit ${result.code})\n${tail(output)}`);
  const json = JSON.parse(fs.readFileSync(record, "utf8")) as {
    contracts: Record<string, string>;
    owner: string;
    broker: string;
    blockNumber?: number;
  };
  const gas = /gas used: (\d+)\s+cost: ([\d.e-]+) USDC/.exec(output);
  return {
    ledger: getAddress(json.contracts.XorvLedger!),
    escrow: getAddress(json.contracts.XorvEscrow!),
    reputation: getAddress(json.contracts.XorvReputation!),
    ccipReceiver: getAddress(json.contracts.XorvCcipReceiver!),
    owner: getAddress(json.owner),
    broker: getAddress(json.broker),
    fromBlock,
    gasUsed: gas ? BigInt(gas[1]!) : null,
    costUsdc: gas ? gas[2]! : null,
    output,
    ms: result.ms,
  };
}

/** Move the fork's clock forward and mine a block (for deadlines). */
export async function warp(fork: Fork, seconds: number): Promise<void> {
  await fork.rpc("evm_increaseTime", [seconds]);
  await fork.rpc("evm_mine", []);
}

/** Poll until `check` returns a value (or throw after `timeoutMs`). */
export async function waitUntil<T>(what: string, timeoutMs: number, check: () => Promise<T | null | undefined | false>, everyMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await delay(everyMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}${lastError ? ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})` : ""}`);
}
