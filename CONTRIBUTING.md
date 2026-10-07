# Contributing

## Setup

Node 22.18+ for the workspace (the broker needs 22.13+ for `node:sqlite`; the CLI and MCP server
alone run on 20.19+) and pnpm 10 (`corepack enable`).

```bash
pnpm install
pnpm build                  # protocol first; every package resolves @xorv/protocol from its dist/
pnpm test                   # every workspace suite; no keys, no RPC, no testnet funds
```

For the Solidity side you also need [Foundry](https://getfoundry.sh), and for anything that moves
Arc's native USDC on a local fork, **Arc Foundry** (`arc-anvil`, `arc-forge`, `arc-cast`; see
<https://docs.arc.io/arc/tutorials/install-arc-foundry>). Stock anvil can fork Arc but cannot move
its native USDC, which on Arc is the same balance as the USDC ERC-20.

### Running it against Arc testnet

```bash
cp .env.example .env               # everything is optional; each key adds a capability
pnpm broker:setup                  # read-only: keys, USDC balances, AI roles, ledger, what's missing
pnpm --filter @xorv/broker setup -- --new-keys   # also prints fresh EVM keys for .env
pnpm usdc                          # read-only: is the demo buyer funded, does the facilitator have gas
```

- **Network.** `XORV_NETWORK` defaults to Arc testnet, `eip155:5042002` (RPC
  `https://rpc.testnet.arc.io`, explorer `https://explorer.testnet.arc.io`). Mainnet is
  `eip155:5042`; any other value fails at boot.
- **One token.** USDC is Arc's gas token, so every key needs only USDC: test USDC comes from
  <https://faucet.circle.com> (pick Arc Testnet). Buyers need USDC to pay; the facilitator,
  operator, verifier and keeper keys need a little for gas. Use fresh keys: anvil's dev account 1
  (`0x7099…79C8`) is on Arc testnet's USDC blocklist.
- **With no keys**, the broker boots, matches and dispatches jobs and reads the ledger read-only,
  but payments are disabled and the paid route answers 503 with the fix: Arc has no public x402
  facilitator, so the broker needs `XORV_FACILITATOR_KEY` (or `XORV_OPERATOR_KEY`) to self-host one.
- **Your own contracts.** `scripts/deploy.sh testnet` deploys XorvLedger, XorvReputation, XorvEscrow
  and XorvCcipReceiver and writes `deployments/arc-testnet.json`:

  ```bash
  XORV_BROKER_ADDRESS=<the broker's settlement key address> pnpm deploy:testnet
  ```

  It reads `DEPLOYER_PRIVATE_KEY` from the file `DEPLOYER_ENV` points at (default
  `../.deployer/deployer.env`), holds a shared deployer lock only for the broadcast, and prints the
  gas used and its USDC cost. `XORV_BROKER_ADDRESS` becomes both the escrow's attester and the
  ledger's broker, so use the address of the key you set as `XORV_OPERATOR_KEY` (and leave
  `XORV_FACILITATOR_KEY` unset, or set it to the same key). Give the refund keeper its own
  `XORV_KEEPER_KEY`: it refuses to refund from the attester's key. Then copy the addresses into
  `XORV_LEDGER_ADDRESS`, `XORV_ESCROW_ADDRESS`, `XORV_REPUTATION_ADDRESS` and
  `XORV_CCIP_RECEIVER_ADDRESS`, and the deploy block into `XORV_LEDGER_FROM_BLOCK`. Mainnet is the
  same script with `XORV_CONFIRM_MAINNET=1`; see [MAINNET.md](MAINNET.md).
- **A private RPC** (`XORV_RPC_URL`) spares you the public one's rate limit. The public RPC caps
  `eth_getLogs` at 10,000 blocks; every reader in the repo already works inside that.

Then, in three terminals:

```bash
pnpm broker                                  # :8402, restarts on change
node packages/cli/dist/index.js init         # once
node packages/cli/dist/index.js start        # a provider node (`echo` works with nothing installed)
pnpm app                                     # :3002; apps/app/.env.local takes NEXT_PUBLIC_PRIVY_APP_ID
```

`pnpm landing` serves the marketing site on :3000. `pnpm mcp` runs the MCP server from source.

### Running it on a local Arc Foundry fork

No testnet funds needed. Two ways:

```bash
pnpm build && ARC_ANVIL=arc-anvil ARC_FORGE=arc-forge pnpm demo
```

`pnpm demo` (`e2e/src/demo.ts`) forks Arc testnet, deploys with the real deploy script, and starts
the broker, two provider nodes, a few seeded paid jobs and the app with a funded demo account, on
ports 8820 (chain), 8821 (broker) and 8822 (app). `XORV_DEMO_PORT_BASE` moves them; Ctrl-C stops
everything.

Or by hand:

```bash
pnpm fork                    # scripts/arc-fork.sh: arc-anvil --network arc on :8810, deploy,
                             # deployments/local-fork.json (git-ignored)
ARC_FORK_STOP=1 pnpm fork    # stop it
```

`arc-fork.sh` deploys from anvil's well-known dev account 0 with account 2 as the broker (account 1
is blocklisted). Point the broker at it with `XORV_RPC_URL=http://127.0.0.1:8810`, the broker key of
account 2, the addresses in the record and a separate keeper key. Fund any address with
`arc-cast rpc anvil_setBalance <address> <wei>`: the native balance has 18 decimals and *is* the USDC
balance, so `0x8ac7230489e80000` (10e18 wei) shows as 10 USDC in the ERC-20. Set `XORV_MEMO=off`
only on a chain without Arc's Memo predeploy; a fork of Arc has it.

## Tests

```bash
pnpm test                                    # every workspace suite, sequentially
pnpm --filter @xorv/protocol test            # one package; likewise @xorv/broker, @xorv/cli,
                                             # @xorv/mcp, @xorv/mm-plugin, xorv-app, xorv-landing
pnpm --filter @xorv/contracts test           # XorvLedger: Hardhat 3 + node:test, vendored ERC-8004 registries
```

`packages/protocol/test/escrow.anvil.test.ts` runs only when an `anvil` binary and the Foundry
build output are present, and is skipped otherwise.

Rules the suite keeps, and that new tests must keep:

- **No keys, no network.** Stub at the chain boundary: the broker takes a `ChainLike`, an
  injectable facilitator, an `EscrowOps` (with an in-memory escrow, `MemoryEscrow`) and a keeper;
  viem runs over the fake JSON-RPC in `test/support/fake-rpc.ts`; model APIs and Circle's Gateway
  API are a scripted `fetch`. A test that needs a funded key or a live RPC will not get run.
- **Real code on the other side where possible.** The contracts test against the real ERC-8004
  registry code, the MCP mock broker verifies signatures, the MetaMask plugin's manifest is checked
  with MetaMask's own schema, and the passkey tests run real Mera.
- **Windows is a development platform.** POSIX-only cases (seatbelt, bubblewrap, file modes) are
  skipped on `win32` with a reason, not deleted.

### Contracts (Foundry)

```bash
cd contracts
git submodule update --init                  # lib/forge-std, lib/openzeppelin-contracts
npm ci                                       # Chainlink CCIP, Chainlink Local, versioned OpenZeppelin
forge build
forge test                                   # unit, invariant and Chainlink Local suites (fork suites skip)
ARC_FORK_TESTS=1 arc-forge test --network arc                            # + the Arc testnet fork suites
ARC_FORK_TESTS=1 arc-forge test --network arc --match-path 'test/fork/*' # only the fork suites
```

The fork suites need Arc Foundry's forge with `--network arc` and access to the Arc testnet RPC:
without it, any native-USDC movement on the fork reverts. After changing a contract, regenerate the
TypeScript ABIs with `forge build && node scripts/export-abi.mjs` (from `contracts/`), which writes
`packages/protocol/src/xorv-escrow.abi.ts` and `packages/protocol/src/abi/*.ts`. See
[contracts/README.md](contracts/README.md) for what each suite covers.

### The end-to-end runs

```bash
pnpm build
ARC_ANVIL=arc-anvil ARC_FORGE=arc-forge pnpm e2e:arc    # the Arc stack, writes e2e/last-run-arc.md
ARC_ANVIL=arc-anvil ARC_FORGE=arc-forge pnpm e2e        # CLI, MCP, private jobs, AI roles; writes e2e/last-run.md
```

Both fork Arc testnet and need its RPC. See [e2e/README.md](e2e/README.md).

### The Envio indexer (Linux, macOS, WSL or Docker)

`services/indexer` is **outside the pnpm workspace** (`!services/indexer` in
`pnpm-workspace.yaml`), because Envio 3.x ships no Windows binary. It has its own lockfile, and its
`node_modules` must never be installed from Windows.

- **On Linux, macOS or WSL2:** `cd services/indexer && pnpm install && pnpm check`
  (`envio codegen && tsc --noEmit && vitest run`). No database, network or token needed.
- **From Windows**, run the same in a throwaway container; the exact command is in
  [services/indexer/README.md](services/indexer/README.md#tests-in-a-throwaway-container-works-from-windows).
- **A local indexer with GraphQL:** `cp .env.example .env` (set `ENVIO_API_TOKEN` and the contract
  addresses and start block), then `pnpm dev` (Arc testnet, HyperSync at
  `arc-testnet.hypersync.xyz`) or `pnpm dev:mainnet`. It starts Postgres and Hasura in Docker, and
  GraphQL is at `http://localhost:8080/v1/graphql`. Point the broker at it with `XORV_INDEXER_URL`.
- **After a contract change**, copy the changed ABI into `services/indexer/abis/` (for XorvLedger,
  `packages/contracts/abi/XorvLedger.json`). The indexer's tests fail until you do.

## Before you open a PR

```bash
pnpm build && pnpm typecheck && pnpm test
cd contracts && forge test
```

CI runs the workspace build, typecheck and tests on Node 22 and 24, builds the frontends, checks
that the CLI still starts on its declared floor of Node 20.19, builds and boots the broker image,
runs the indexer's checks, and runs `forge build` and `forge test` (the Arc fork suites run there
too, as informational). Never commit `.env`, keys, `node_modules` or build output.

## Commit style

Look at `git log` and match it:

- **An imperative title that says what changed and why**, 72 characters or fewer. For example:
  "Settle x402 payments before dispatch so providers never work unpaid", not "fix payment bug" or
  "updates".
- **A short body explaining the reasoning**: what was wrong, what the change does about it, and
  anything a reviewer would otherwise have to work out from the diff.
- **One logical change per commit.** A refactor, a fix and a feature are three commits.
- **Stage explicit paths** (`git add <paths>`, never `git add -A`). Don't commit the root
  `pnpm-lock.yaml` in a change that doesn't need it.
- Work written with an AI coding assistant ends with a trailer naming it. In this repository that
  is:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```

  The README's AI tools disclosure depends on it staying honest.

## Writing an adapter

An adapter is one class with two methods. Put it in `packages/cli/src/adapters/` and register it in
`adapters/index.ts`:

```ts
export class MyAdapter implements JobAdapter {
  readonly kind = "my-adapter";
  readonly installHint = "how to get the thing this drives";

  async available(): Promise<boolean> { return cliAvailable("mybin"); }

  async run(input: RunInput): Promise<string> {
    const result = await runChild({
      cmd: "mybin", args: ["-p", input.prompt],
      cwd: input.cwd, signal: input.signal,
      onLine: (line) => input.emit({ kind: "message", text: line }),
    });
    return clampResult(result.stdout);
  }
}
```

An adapter for an OpenAI-compatible hosted model does not need a child process at all. Add a preset
to `LLM_PRESETS` in `packages/protocol/src/llm.ts` and follow `packages/cli/src/adapters/hosted.ts`.
Add the new kind to `AdapterKind` in `packages/protocol/src/types.ts`.

Rules that aren't obvious:

- **Report only what the CLI actually tells you.** If it doesn't emit tool calls, don't infer them by
  diffing the directory. That puts guesses in the job log looking exactly like facts.
- **Honour `input.signal`.** Jobs get cancelled and time out.
- **Respect `safeMode()`.** In safe mode the adapter must not touch the disk or run a shell.
- **Keep keys out of the job.** Read API keys in-process, or pass them in the child's own environment.
  Never put them on argv, and never add them to the sandbox's environment allowlist.
- **Private jobs.** The node seals the result after your adapter returns, so an adapter needs no
  changes. But error text is reduced to a coarse vocabulary for private jobs, because adapter errors
  can quote the prompt.
- **Never trust the prompt.** It came from a stranger.

## Style

The code is commented for the reader who has to change it in six months. Explain *why*, especially
where something looks wrong and isn't: see [ARCHITECTURE.md](ARCHITECTURE.md) for the tone. Tests
assert behaviour, not implementation. Every bug fixed should arrive with the test that would have
caught it.

## Security

See [SECURITY.md](SECURITY.md). Don't open a public issue for anything exploitable: email
niveshgajengi@gmail.com.
