// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {KeelVault} from "../src/KeelVault.sol";
import {MockERC20, MockFactory, MockPool, MockRouter} from "../src/mocks/Mocks.sol";

contract KeelVaultTest is Test {
    uint256 internal constant WAD = 1e18;

    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");
    address internal stranger = makeAddr("stranger");

    MockFactory internal factory;
    MockERC20 internal base;
    MockERC20 internal quote;
    MockPool internal pool;
    MockRouter internal router;
    KeelVault internal vault;
    uint256 internal nonce;

    function setUp() public {
        factory = new MockFactory();
        base = new MockERC20("BASE", 18);
        quote = new MockERC20("QUOTE", 18);
        // Uniswap orders token0 < token1. The test treats the lower address as base.
        if (address(base) > address(quote)) {
            (base, quote) = (quote, base);
        }
        _deploy(0, _policy());
        quote.mint(address(vault), 10_000 * WAD);
        base.mint(address(router), 10_000 * WAD);
        quote.mint(address(router), 10_000 * WAD);
    }

    function _policy() internal pure returns (KeelVault.Policy memory p) {
        p.maxAmountIn0 = 1_000 * WAD;
        p.maxAmountIn1 = 1_000 * WAD;
        p.slippageBps = 100;
        p.cooldown = 0;
        p.dailyLossLimit = 100 * WAD;
        p.maxBase = 5_000 * WAD;
    }

    function _deploy(uint24 fee, KeelVault.Policy memory p) internal {
        router = new MockRouter(address(factory), address(base));
        pool = new MockPool(address(factory), address(base), address(quote), fee);
        // If base is not token0 the pool constructor still stores the addresses we pass,
        // but Uniswap requires token0 < token1. Enforce that here.
        require(address(base) < address(quote), "token order");
        vault = new KeelVault(owner, agent, address(router), address(pool), address(quote), p);
    }

    function _floor(address tokenIn, uint256 amountIn) internal view returns (uint256) {
        return vault.spotOut(tokenIn, amountIn) * 9_900 / 10_000;
    }

    function _buy(uint256 amountIn) internal returns (uint256 out) {
        nonce += 1;
        uint256 minOut = _floor(address(quote), amountIn);
        vm.prank(agent);
        out = vault.swap(
            address(quote), amountIn, minOut, block.timestamp + 60, keccak256(abi.encode("buy", nonce)), false, "buy"
        );
    }

    function _sell(uint256 amountIn, bytes32 id) internal returns (uint256 out) {
        uint256 minOut = _floor(address(base), amountIn);
        vm.prank(agent);
        out = vault.swap(address(base), amountIn, minOut, block.timestamp + 60, id, true, "sell");
    }

    function test_spot_at_price_one_with_fee() public {
        // Redeploy at the 0.30% fee used by the WHSK/USDT pool.
        quote.mint(address(this), 1);
        KeelVault.Policy memory p = _policy();
        router = new MockRouter(address(factory), address(base));
        pool = new MockPool(address(factory), address(base), address(quote), 3000);
        vault = new KeelVault(owner, agent, address(router), address(pool), address(quote), p);
        assertEq(vault.spotOut(address(base), WAD), 997 * WAD / 1000);
        assertEq(vault.spotOut(address(quote), WAD), 997 * WAD / 1000);
    }

    function test_buy_and_sell_round_trip_keeps_cost() public {
        router.setRate(1, 1);
        uint256 bought = _buy(1_000 * WAD);
        assertEq(bought, 1_000 * WAD);
        assertEq(vault.baseQty(), 1_000 * WAD);
        assertEq(vault.quoteCost(), 1_000 * WAD);

        uint256 sold = _sell(400 * WAD, keccak256("sell-1"));
        assertEq(sold, 400 * WAD);
        assertEq(vault.baseQty(), 600 * WAD);
        assertEq(vault.quoteCost(), 600 * WAD);
        assertEq(vault.dayRealizedLoss(), 0);
    }

    function test_stop_out_realizes_loss_and_blocks_the_next_buy() public {
        router.setRate(1, 1);
        _buy(1_000 * WAD);

        // Price falls to 0.25. sqrtPriceX96 = 2^95.
        pool.setSqrt(uint160(1 << 95));
        router.setRate(1, 4);
        uint256 sold = _sell(1_000 * WAD, keccak256("stop"));
        assertEq(sold, 250 * WAD);
        assertEq(vault.baseQty(), 0);
        assertEq(vault.quoteCost(), 0);
        assertEq(vault.dayRealizedLoss(), 750 * WAD);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(KeelVault.DailyLoss.selector, 750 * WAD, 100 * WAD));
        vault.swap(address(quote), 10 * WAD, 1, block.timestamp + 60, keccak256("again"), false, "buy");
    }

    function test_loss_resets_on_the_next_day() public {
        router.setRate(1, 1);
        _buy(200 * WAD);
        pool.setSqrt(uint160(1 << 95));
        router.setRate(1, 4);
        _sell(200 * WAD, keccak256("stop-day"));
        assertGt(vault.dayRealizedLoss(), 100 * WAD);

        vm.warp(block.timestamp + 1 days);
        pool.setSqrt(uint160(1 << 96));
        router.setRate(1, 1);
        uint256 out = _buy(10 * WAD);
        assertEq(out, 10 * WAD);
        assertEq(vault.dayRealizedLoss(), 0);
    }

    function test_per_trade_cap() public {
        router.setRate(1, 1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(KeelVault.Cap.selector, 1_001 * WAD, 1_000 * WAD));
        vault.swap(address(quote), 1_001 * WAD, 1, block.timestamp + 60, keccak256("big"), false, "big");
    }

    function test_slippage_floor_rejects_a_loose_minimum() public {
        router.setRate(1, 1);
        uint256 floorMin = _floor(address(quote), 100 * WAD);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(KeelVault.Slippage.selector, floorMin - 1, floorMin));
        vault.swap(address(quote), 100 * WAD, floorMin - 1, block.timestamp + 60, keccak256("loose"), false, "loose");
    }

    function test_router_min_out_still_applies() public {
        router.setRate(1, 2); // pays half, while spot floor is 99% of spot
        uint256 floorMin = _floor(address(quote), 100 * WAD);
        vm.prank(agent);
        vm.expectRevert(bytes("router min"));
        vault.swap(address(quote), 100 * WAD, floorMin, block.timestamp + 60, keccak256("impact"), false, "impact");
    }

    function test_cooldown() public {
        KeelVault.Policy memory p = _policy();
        p.cooldown = 60;
        _deploy(0, p);
        quote.mint(address(vault), 100 * WAD);
        base.mint(address(router), 100 * WAD);
        router.setRate(1, 1);
        _buy(10 * WAD);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(KeelVault.Cooldown.selector, block.timestamp + 60));
        vault.swap(address(quote), 10 * WAD, 1, block.timestamp + 120, keccak256("soon"), false, "soon");

        vm.warp(block.timestamp + 60);
        uint256 out = _buy(10 * WAD);
        assertEq(out, 10 * WAD);
    }

    function test_inventory_cap() public {
        KeelVault.Policy memory p = _policy();
        p.maxBase = 50 * WAD;
        _deploy(0, p);
        quote.mint(address(vault), 100 * WAD);
        base.mint(address(router), 100 * WAD);
        router.setRate(1, 1);
        uint256 minOut = _floor(address(quote), 60 * WAD);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(KeelVault.Inventory.selector, 60 * WAD, 50 * WAD));
        vault.swap(address(quote), 60 * WAD, minOut, block.timestamp + 60, keccak256("inv"), false, "inv");
    }

    function test_only_agent_can_swap_and_only_owner_can_withdraw() public {
        vm.prank(stranger);
        vm.expectRevert(KeelVault.NotAgent.selector);
        vault.swap(address(quote), 1, 1, block.timestamp + 60, keccak256("nope"), false, "nope");

        vm.prank(agent);
        vm.expectRevert(KeelVault.NotOwner.selector);
        vault.withdraw(address(quote), agent, 1);

        vm.prank(owner);
        vault.withdraw(address(quote), owner, 25 * WAD);
        assertEq(quote.balanceOf(owner), 25 * WAD);
    }

    function test_pause_blocks_swaps() public {
        vm.prank(owner);
        vault.setPaused(true);
        vm.prank(agent);
        vm.expectRevert(KeelVault.PausedError.selector);
        vault.swap(address(quote), 1, 1, block.timestamp + 60, keccak256("paused"), false, "paused");
    }

    function test_replay_and_deadline_and_reason() public {
        router.setRate(1, 1);
        bytes32 id = keccak256("once");
        uint256 minOut = _floor(address(quote), 10 * WAD);
        vm.prank(agent);
        vault.swap(address(quote), 10 * WAD, minOut, block.timestamp + 60, id, false, "once");

        vm.prank(agent);
        vm.expectRevert(KeelVault.Replay.selector);
        vault.swap(address(quote), 10 * WAD, 1, block.timestamp + 60, id, false, "once");

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(KeelVault.Deadline.selector, block.timestamp - 1, block.timestamp));
        vault.swap(address(quote), 10 * WAD, 1, block.timestamp - 1, keccak256("late"), false, "late");

        bytes memory longReason = new bytes(181);
        vm.prank(agent);
        vm.expectRevert(KeelVault.ReasonTooLong.selector);
        vault.swap(address(quote), 10 * WAD, 1, block.timestamp + 60, keccak256("long"), false, longReason);
    }

    function test_wrong_token() public {
        MockERC20 other = new MockERC20("NO", 18);
        vm.prank(agent);
        vm.expectRevert(KeelVault.BadToken.selector);
        vault.swap(address(other), 1, 1, block.timestamp + 60, keccak256("other"), false, "other");
    }

    function test_tighten_cannot_loosen_and_set_policy_can() public {
        KeelVault.Patch memory loosen;
        loosen.hasMax1 = true;
        loosen.maxAmountIn1 = 2_000 * WAD;
        vm.prank(owner);
        vm.expectRevert(KeelVault.NotTighter.selector);
        vault.tighten(loosen);

        KeelVault.Patch memory tighter;
        tighter.hasDaily = true;
        tighter.dailyLossLimit = 40 * WAD;
        tighter.hasCooldown = true;
        tighter.cooldown = 30;
        tighter.hasSlippage = true;
        tighter.slippageBps = 50;
        vm.prank(owner);
        vault.tighten(tighter);
        (,, uint16 slippage, uint32 cooldown, uint256 daily,) = vault.policy();
        assertEq(slippage, 50);
        assertEq(cooldown, 30);
        assertEq(daily, 40 * WAD);

        KeelVault.Policy memory widened = _policy();
        widened.dailyLossLimit = 80 * WAD;
        vm.prank(owner);
        vault.setPolicy(widened);
        (,,,, uint256 daily2,) = vault.policy();
        assertEq(daily2, 80 * WAD);

        widened.slippageBps = 501;
        vm.prank(owner);
        vm.expectRevert(KeelVault.BadPolicy.selector);
        vault.setPolicy(widened);
    }

    function test_decision_event_and_router_is_the_only_callee() public {
        router.setRate(1, 1);
        uint256 minOut = _floor(address(quote), 10 * WAD);
        vm.expectEmit(true, true, false, true);
        emit KeelVault.Decision(
            keccak256("id"),
            address(quote),
            address(base),
            10 * WAD,
            minOut,
            10 * WAD,
            0,
            10 * WAD,
            10 * WAD,
            false,
            "buy"
        );
        vm.prank(agent);
        vault.swap(address(quote), 10 * WAD, minOut, block.timestamp + 60, keccak256("id"), false, "buy");
        assertEq(router.calls(), 1);
    }

    function test_wrap_and_reject_agent_owner() public {
        vm.deal(owner, 2 ether);
        vm.prank(owner);
        vault.wrap{value: 1 ether}();
        assertEq(base.balanceOf(address(vault)), 1 ether);

        vm.expectRevert(KeelVault.AgentIsOwner.selector);
        new KeelVault(owner, owner, address(router), address(pool), address(quote), _policy());
    }

    function test_price_four_sell_books_a_gain() public {
        router.setRate(1, 1);
        _buy(100 * WAD);
        pool.setSqrt(uint160(2 << 96));
        router.setRate(4, 1);
        uint256 sold = _sell(100 * WAD, keccak256("gain"));
        assertEq(sold, 400 * WAD);
        assertEq(vault.dayRealizedLoss(), 0);
        assertEq(vault.baseQty(), 0);
    }

    function testFuzz_spot_is_monotone(uint128 raw) public {
        uint256 amount = bound(raw, 1_000, 1e24);
        uint256 smaller = vault.spotOut(address(base), amount / 2);
        uint256 larger = vault.spotOut(address(base), amount);
        assertGe(larger, smaller);
    }
}
