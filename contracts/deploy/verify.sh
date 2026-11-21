#!/usr/bin/env bash
# Verify KeelVault on Sourcify and on a Blockscout explorer.
# Same command for HSK testnet (133) and mainnet (177).
#
# Required:
#   CHAIN_ID          133 or 177
#   ADDRESS           deployed KeelVault
#   EXPLORER          https://testnet-explorer.hskchain.net or https://hsk.blockscout.com
#   CREATION_TX       deploy transaction hash
#   OWNER AGENT ROUTER POOL QUOTE
#   MAX_IN_0 MAX_IN_1 SLIPPAGE_BPS COOLDOWN DAILY_LOSS MAX_BASE
#
# The explorer gateway rejects bodies over about 100KB. This script sends the
# standard JSON for the current build, which stays under that line because the
# vault does not import OpenZeppelin.
set -euo pipefail
cd "$(dirname "$0")/.."

for name in CHAIN_ID ADDRESS EXPLORER CREATION_TX OWNER AGENT ROUTER POOL QUOTE MAX_IN_0 MAX_IN_1 SLIPPAGE_BPS COOLDOWN DAILY_LOSS MAX_BASE; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing $name" >&2
    exit 1
  fi
done

export PATH="${PATH}:/home/ubuntu/.foundry/bin:${HOME}/.foundry/bin"
forge build --offline --skip test --skip script >/dev/null

ARGS=$(cast abi-encode "constructor(address,address,address,address,address,(uint256,uint256,uint16,uint32,uint256,uint256))" \
  "$OWNER" "$AGENT" "$ROUTER" "$POOL" "$QUOTE" \
  "(${MAX_IN_0},${MAX_IN_1},${SLIPPAGE_BPS},${COOLDOWN},${DAILY_LOSS},${MAX_BASE})")
ARGS_HEX=${ARGS#0x}

python3 - << PY
import json, pathlib, urllib.parse, urllib.request
root = pathlib.Path(".").resolve()
art = json.loads((root / "out/KeelVault.sol/KeelVault.json").read_text())
meta = art["metadata"]
if isinstance(meta, str):
    meta = json.loads(meta)
sources = {name: {"content": (root / name).read_text()} for name in meta["sources"]}
std = {
    "language": "Solidity",
    "sources": sources,
    "settings": {
        "remappings": meta["settings"].get("remappings", []),
        "optimizer": {"enabled": True, "runs": 200},
        "viaIR": True,
        "evmVersion": "cancun",
        "metadata": {"bytecodeHash": "ipfs"},
        "libraries": {},
        "outputSelection": {"*": {"*": ["*"]}},
    },
}
raw = json.dumps(std, separators=(",", ":")).encode()
print(f"standard json bytes {len(raw)}")
if len(raw) > 95000:
    raise SystemExit("standard JSON is over the explorer gateway limit")
path = pathlib.Path("/tmp/keel-standard.json")
path.write_bytes(raw)
open("/tmp/keel-std-for-sourcify.json","w").write(json.dumps({
    "stdJsonInput": std,
    "compilerVersion": "0.8.26+commit.8a97fa7a",
    "contractIdentifier": "src/KeelVault.sol:KeelVault",
    "creationTransactionHash": "${CREATION_TX}",
}))
PY

echo "Sourcify"
python3 - << PY
import json, urllib.request
body = open("/tmp/keel-std-for-sourcify.json","rb").read()
url = "https://sourcify.dev/server/v2/verify/${CHAIN_ID}/${ADDRESS}"
req = urllib.request.Request(url, data=body, headers={"content-type":"application/json","accept":"application/json","user-agent":"keel"})
with urllib.request.urlopen(req, timeout=120) as response:
    submitted = json.loads(response.read().decode())
print(submitted)
vid = submitted["verificationId"]
status_url = f"https://sourcify.dev/server/v2/verify/{vid}"
for _ in range(20):
    with urllib.request.urlopen(urllib.request.Request(status_url, headers={"accept":"application/json","user-agent":"keel"}), timeout=30) as response:
        data = json.loads(response.read().decode())
    if data.get("isJobCompleted"):
        contract = data.get("contract") or {}
        error = data.get("error")
        print("sourcify", contract.get("match"), contract.get("runtimeMatch"), contract.get("creationMatch"))
        if error or contract.get("runtimeMatch") != "exact_match":
            raise SystemExit((error or {}).get("message") or "Sourcify did not exact-match the runtime bytecode")
        break
PY

echo "Blockscout"
curl -sS -m 60 -A keel -H "accept: application/json" \
  -F "compiler_version=v0.8.26+commit.8a97fa7a" \
  -F "contract_name=KeelVault" \
  -F "autodetect_constructor_args=false" \
  -F "constructor_args=${ARGS_HEX}" \
  -F "evm_version=cancun" \
  -F "license_type=mit" \
  -F "files[0]=@/tmp/keel-standard.json;type=application/json;filename=standard.json" \
  "${EXPLORER}/api/v2/smart-contracts/${ADDRESS}/verification/via/standard-input"
echo
echo "Submitted. Check ${EXPLORER}/address/${ADDRESS}"
