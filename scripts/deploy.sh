#!/usr/bin/env bash
# Deploy Xorv's Arc contracts: XorvLedger, XorvReputation, XorvEscrow, XorvCcipReceiver.
#
#   scripts/deploy.sh testnet                          # Arc testnet (5042002)
#   XORV_CONFIRM_MAINNET=1 scripts/deploy.sh mainnet   # Arc mainnet (5042), real USDC
#   ARC_RPC_URL=http://127.0.0.1:8810 scripts/deploy.sh local   # any Arc fork / dev node
#
# Env:
#   XORV_BROKER_ADDRESS   required: the broker's settlement key (escrow attester, ledger writer);
#                         on mainnet it must not be the deployer
#   XORV_MAX_JOB_AMOUNT   per-job cap in USDC base units (default 100000000 = 100 USDC)
#   DEPLOYER_ENV          file defining DEPLOYER_PRIVATE_KEY (default ../.deployer/deployer.env);
#                         sourced inside the command, never echoed
#   ARC_RPC_URL           override the RPC (testnet https://rpc.testnet.arc.io, mainnet https://rpc.mainnet.arc.io)
#   ARC_FORGE             forge binary (default: Arc Foundry's arc-forge if found, else forge)
#   ARC_MAX_FEE / ARC_PRIORITY_FEE   EIP-1559 fees (default 60gwei / 2gwei; Arc's mempool floor
#                         is maxFeePerGas >= 20 gwei, and its base fee sits at that floor)
#   XORV_VERIFY=1         verify on Arc's Blockscout explorer
#   XORV_DEPLOYMENT_FINAL record path (default deployments/arc-<network>.json)
#   XORV_NO_LOCK=1        skip the shared deployer lock (only for throwaway local keys)
#
# The record is written to a pending file during the run and moved into place only after the
# broadcast succeeded, so a failed deploy never overwrites deployments/arc-<network>.json.
set -euo pipefail

NETWORK=${1:-}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
case "$NETWORK" in
  testnet) RPC=${ARC_RPC_URL:-https://rpc.testnet.arc.io}; EXPLORER_API=https://explorer.testnet.arc.io/api/ ;;
  mainnet) RPC=${ARC_RPC_URL:-https://rpc.mainnet.arc.io}; EXPLORER_API=https://explorer.arc.io/api/ ;;
  local)   RPC=${ARC_RPC_URL:-http://127.0.0.1:${ARC_FORK_PORT:-8810}}; EXPLORER_API= ;;
  *) echo "usage: scripts/deploy.sh <testnet|mainnet|local>" >&2; exit 2 ;;
esac

if [ "$NETWORK" = mainnet ]; then
  if [ "${XORV_CONFIRM_MAINNET:-}" != 1 ]; then
    echo "Refusing to deploy to Arc MAINNET without XORV_CONFIRM_MAINNET=1." >&2; exit 1
  fi
  echo "##############################################################"
  echo "##  DEPLOYING XORV TO ARC MAINNET (chain 5042) - REAL USDC   ##"
  echo "##############################################################"
fi
: "${XORV_BROKER_ADDRESS:?set XORV_BROKER_ADDRESS (the broker settlement key address)}"

DEPLOYER_ENV=${DEPLOYER_ENV:-$ROOT/../.deployer/deployer.env}
[ -r "$DEPLOYER_ENV" ] || { echo "deployer env not readable: $DEPLOYER_ENV" >&2; exit 1; }
DEPLOYER_ENV=$(cd "$(dirname "$DEPLOYER_ENV")" && pwd)/$(basename "$DEPLOYER_ENV")

if [ -z "${ARC_FORGE:-}" ]; then
  if command -v arc-forge >/dev/null 2>&1; then ARC_FORGE=arc-forge; else ARC_FORGE=forge; fi
fi
NET_FLAG=()
if "$ARC_FORGE" script --help 2>/dev/null | grep -q -- '--network <NETWORK>'; then NET_FLAG=(--network arc); fi

FINAL=${XORV_DEPLOYMENT_FINAL:-$ROOT/deployments/arc-$NETWORK.json}
PENDING=$ROOT/contracts/cache/deploy-$NETWORK.pending.json   # contracts/cache is git-ignored
mkdir -p "$ROOT/contracts/cache"
rm -f "$PENDING"

VERIFY=()
if [ "${XORV_VERIFY:-}" = 1 ] && [ -n "$EXPLORER_API" ]; then
  VERIFY=(--verify --verifier blockscout --verifier-url "$EXPLORER_API")
fi

cd "$ROOT/contracts"
"$ARC_FORGE" build

broadcast() {
  ( set -a; . "$DEPLOYER_ENV"; set +a
    NETWORK=$NETWORK XORV_DEPLOYMENT_OUT=$PENDING \
    "$ARC_FORGE" script script/Deploy.s.sol:Deploy ${NET_FLAG[@]+"${NET_FLAG[@]}"} \
      --rpc-url "$RPC" --broadcast --slow \
      --with-gas-price "${ARC_MAX_FEE:-60gwei}" --priority-gas-price "${ARC_PRIORITY_FEE:-2gwei}" \
      ${VERIFY[@]+"${VERIFY[@]}"} )
}

if [ "${XORV_NO_LOCK:-}" = 1 ]; then
  broadcast
else
  # Shared deployer wallet: hold the lock only for the broadcast, so nonces never collide.
  LOCK="/Volumes/Extreme SSD/Projects/arc/.deployer/lock"; until mkdir "$LOCK" 2>/dev/null; do sleep 3; done
  trap 'rmdir "$LOCK"' EXIT; broadcast; rmdir "$LOCK"; trap - EXIT
fi

mv "$PENDING" "$FINAL"
echo "record: $FINAL"

# Gas actually used by the broadcast, and what it cost in USDC (native USDC has 18 decimals).
CHAIN_ID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).chainId)' "$FINAL")
RUN="broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json"
if [ -f "$RUN" ]; then
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1]));
    let gas = 0n, wei = 0n;
    for (const x of r.receipts) { const g = BigInt(x.gasUsed); gas += g; wei += g * BigInt(x.effectiveGasPrice); }
    console.log(`txs: ${r.receipts.length}  gas used: ${gas}  cost: ${Number(wei) / 1e18} USDC`);
  ' "$RUN"
fi
