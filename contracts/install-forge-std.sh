#!/usr/bin/env bash
# Install the one test dependency. KeelVault itself does not import it.
# Pin: forge-std v1.17.0 (f3dae6e6ee381f25eb6a246f7da9b85c91a68219)
set -euo pipefail
cd "$(dirname "$0")"
rm -rf lib/forge-std
git clone --depth 1 --branch v1.17.0 https://github.com/foundry-rs/forge-std.git lib/forge-std
rm -rf lib/forge-std/.git lib/forge-std/lib
echo "forge-std v1.17.0 installed in contracts/lib/forge-std"
