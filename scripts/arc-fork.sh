#!/usr/bin/env bash
# Rehearse the Xorv deploy on a local fork of Arc testnet: Circle's real USDC, the real
# ERC-8004 registries and Chainlink's real CCIP router, without spending testnet USDC.
#
#   scripts/arc-fork.sh                      # fork on 127.0.0.1:8810, deploy, write deployments/local-fork.json
#   ARC_FORK_PORT=8811 scripts/arc-fork.sh   # another port
#   ARC_FORK_STOP=1 scripts/arc-fork.sh      # stop the fork this script started on that port
#
# Needs Arc Foundry (https://docs.arc.io/arc/tutorials/install-arc-foundry): plain anvil can
# fork Arc but can't move Arc's native USDC; `--network arc` can. Set ARC_ANVIL / ARC_CAST /
# ARC_FORGE to its binaries (defaults: arc-anvil / arc-cast / arc-forge on PATH).
#  1. starts arc-anvil forking Arc testnet with 1-second blocks (pid in .fork/arc-fork-<port>.pid);
#  2. deploys with scripts/deploy.sh local, anvil's well-known dev account 0 as deployer and
#     account 2 as the broker (account 1 is blocklisted on Arc testnet), into deployments/local-fork.json (git-ignored).
# The fork keeps running for the app/e2e; stop it with ARC_FORK_STOP=1.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
ANVIL=${ARC_ANVIL:-arc-anvil}
CAST=${ARC_CAST:-$(command -v arc-cast || echo cast)}
PORT=${ARC_FORK_PORT:-8810}
RPC=http://127.0.0.1:$PORT
PIDFILE=.fork/arc-fork-$PORT.pid
mkdir -p .fork

if [ "${ARC_FORK_STOP:-}" = 1 ]; then
  if [ -f "$PIDFILE" ]; then kill "$(cat "$PIDFILE")" 2>/dev/null || true; rm -f "$PIDFILE"; echo "stopped fork on :$PORT"; fi
  exit 0
fi

if ! "$CAST" chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  nohup "$ANVIL" --network arc --fork-url "${ARC_FORK_URL:-https://rpc.testnet.arc.io}" \
    --host 127.0.0.1 --port "$PORT" --block-time 1 --silent > ".fork/arc-fork-$PORT.log" 2>&1 &
  echo $! > "$PIDFILE"
  i=0; until "$CAST" chain-id --rpc-url "$RPC" >/dev/null 2>&1; do
    i=$((i+1)); [ $i -gt 90 ] && { echo "the fork didn't start: .fork/arc-fork-$PORT.log" >&2; exit 1; }; sleep 1
  done
fi
echo "Arc testnet fork on $RPC (chain $("$CAST" chain-id --rpc-url "$RPC"), pid $(cat "$PIDFILE" 2>/dev/null || echo '?'))"

# anvil's public dev accounts (the well-known "test ... junk" mnemonic): only ever used on this local fork.
MNEMONIC="test test test test test test test test test test test junk"
umask 077
printf 'DEPLOYER_PRIVATE_KEY=%s\n' "$("$CAST" wallet private-key --mnemonic "$MNEMONIC")" > .fork/deployer.env
# Account 1 (0x7099…79C8) is on Arc testnet's USDC blocklist, so the broker defaults to account 2.
BROKER=$("$CAST" wallet address --mnemonic "$MNEMONIC" --mnemonic-index 2)

DEPLOYER_ENV="$ROOT/.fork/deployer.env" XORV_BROKER_ADDRESS=${XORV_BROKER_ADDRESS:-$BROKER} XORV_NO_LOCK=1 \
ARC_RPC_URL=$RPC XORV_DEPLOYMENT_FINAL="$ROOT/deployments/local-fork.json" \
  "$ROOT/scripts/deploy.sh" local
