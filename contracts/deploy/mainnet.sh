#!/usr/bin/env bash
# Deploy KeelVault to HSK Chain mainnet (chain id 177).
# This spends real HSK on gas. Read submission/MAINNET_STEPS.md first.
# Required env: PRIVATE_KEY, AGENT. Optional: OWNER.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${CONFIRM_MAINNET:-}" != "yes" ]]; then
  echo "Refusing to broadcast. Re-run with CONFIRM_MAINNET=yes after reading submission/MAINNET_STEPS.md." >&2
  exit 1
fi
if [[ -z "${PRIVATE_KEY:-}" || -z "${AGENT:-}" ]]; then
  echo "Set PRIVATE_KEY and AGENT in the environment. Do not pass them as arguments." >&2
  exit 1
fi

# Router, factory and quoter: @hskswap/sdk-core@1.0.3 HASHKEY_MAINNET_ADDRESSES.
# WHSK and USDT: docs.hskchain.net token page.
# Pool: factory.getPool(WHSK, USDT, 3000) on https://mainnet.hsk.xyz, 20 Nov 2026.
# token0 is WHSK (18). token1 is USDT (6).
export ROUTER=0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3
export POOL=0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC
export QUOTE=0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029
export MAX_IN_0=5000000000000000000
export MAX_IN_1=2000000
export SLIPPAGE_BPS=100
export COOLDOWN=60
export DAILY_LOSS=5000000
export MAX_BASE=50000000000000000000

forge script script/Deploy.s.sol \
  --rpc-url https://mainnet.hsk.xyz \
  --broadcast \
  --slow
