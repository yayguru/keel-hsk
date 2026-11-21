#!/usr/bin/env bash
# Deploy KeelVault to HSK Chain testnet (chain id 133).
# Required env: PRIVATE_KEY, AGENT. Optional: OWNER (defaults to the key's address).
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${PRIVATE_KEY:-}" || -z "${AGENT:-}" ]]; then
  echo "Set PRIVATE_KEY and AGENT in the environment. Do not pass them as arguments." >&2
  exit 1
fi

# Addresses from @hskswap/sdk-core@1.0.3 HASHKEY_TESTNET_ADDRESSES,
# checked on https://testnet.hsk.xyz on 20 Nov 2026.
# Pool token0 is the test USDT below (18 decimals). token1 is WHSK.
export ROUTER=0xa6914E66690c6794244B5f66a09eAEbf66254237
export POOL=0xc076FB478b77633736738579c7f48D2539604a50
export QUOTE=0x98B6173A8B7DFc52ce8bc88f1184a918A1CCaa4F
export MAX_IN_0=50000000000000000
export MAX_IN_1=2000000000000000
export SLIPPAGE_BPS=100
export COOLDOWN=30
export DAILY_LOSS=200000000000000000
export MAX_BASE=20000000000000000

forge script script/Deploy.s.sol \
  --rpc-url https://testnet.hsk.xyz \
  --broadcast \
  --slow
