// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {KeelVault} from "../src/KeelVault.sol";

/// @notice Broadcasts KeelVault. Every address and limit comes from the environment.
///         The shell wrappers in this directory fill the HSKSwap addresses.
contract Deploy is Script {
    function run() external returns (KeelVault vault) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address agent = vm.envAddress("AGENT");
        address owner = vm.envOr("OWNER", vm.addr(pk));
        address swapRouter = vm.envAddress("ROUTER");
        address pool = vm.envAddress("POOL");
        address quote = vm.envAddress("QUOTE");

        KeelVault.Policy memory policy = KeelVault.Policy({
            maxAmountIn0: vm.envUint("MAX_IN_0"),
            maxAmountIn1: vm.envUint("MAX_IN_1"),
            slippageBps: uint16(vm.envUint("SLIPPAGE_BPS")),
            cooldown: uint32(vm.envUint("COOLDOWN")),
            dailyLossLimit: vm.envUint("DAILY_LOSS"),
            maxBase: vm.envUint("MAX_BASE")
        });

        vm.startBroadcast(pk);
        vault = new KeelVault(owner, agent, swapRouter, pool, quote, policy);
        vm.stopBroadcast();

        console2.log("vault", address(vault));
        console2.log("owner", owner);
        console2.log("agent", agent);
    }
}
