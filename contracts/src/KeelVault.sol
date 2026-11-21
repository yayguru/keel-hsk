// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ISwapRouter02, IUniswapV3Pool, IERC20, IWHSK} from "./interfaces/IDex.sol";
import {MulDiv} from "./MulDiv.sol";
import {ReentrancyGuard} from "./ReentrancyGuard.sol";
import {TokenLib} from "./TokenLib.sol";

/// @title KeelVault
/// @notice Holds a WHSK/USDT inventory for one HSKSwap pool. The agent may swap.
///         The owner sets the policy, can only tighten it through `tighten`, and is
///         the only address that can withdraw or pause. The router calldata is built
///         here, so the agent cannot call an arbitrary contract.
contract KeelVault is ReentrancyGuard {

    uint256 internal constant BPS = 10_000;
    uint256 internal constant FEE_DENOM = 1_000_000;
    uint16 internal constant MAX_SLIPPAGE_BPS = 500;
    uint32 internal constant MAX_COOLDOWN = 7 days;
    uint256 internal constant MAX_REASON = 180;

    struct Policy {
        uint256 maxAmountIn0;
        uint256 maxAmountIn1;
        uint16 slippageBps;
        uint32 cooldown;
        uint256 dailyLossLimit;
        uint256 maxBase;
    }

    /// @notice Fields with `has*` false are left unchanged. Every set field must be safer.
    struct Patch {
        bool hasMax0;
        uint256 maxAmountIn0;
        bool hasMax1;
        uint256 maxAmountIn1;
        bool hasSlippage;
        uint16 slippageBps;
        bool hasCooldown;
        uint32 cooldown;
        bool hasDaily;
        uint256 dailyLossLimit;
        bool hasMaxBase;
        uint256 maxBase;
    }

    address public owner;
    address public agent;
    address public immutable router;
    address public immutable pool;
    address public immutable token0;
    address public immutable token1;
    address public immutable quoteToken;
    address public immutable baseToken;
    address public immutable whsk;
    uint24 public immutable fee;

    Policy public policy;
    bool public paused;

    uint256 public baseQty;
    uint256 public quoteCost;
    uint32 public dayId;
    uint256 public dayRealizedLoss;
    uint256 public lastSwapAt;
    mapping(bytes32 => bool) public usedDecision;

    error NotOwner();
    error NotAgent();
    error AgentIsOwner();
    error PausedError();
    error BadToken();
    error BadPolicy();
    error NoCode();
    error Cap(uint256 amount, uint256 maxAmount);
    error Slippage(uint256 amountOutMin, uint256 floorMin);
    error DailyLoss(uint256 realized, uint256 limit);
    error Cooldown(uint256 readyAt);
    error Inventory(uint256 nextBase, uint256 maxBase);
    error Replay();
    error NotTighter();
    error Deadline(uint256 deadline, uint256 nowTs);
    error ReasonTooLong();
    error ZeroAmount();
    error PoolPrice();

    event OwnerSet(address indexed owner);
    event AgentSet(address indexed agent);
    event PausedSet(bool paused);
    event PolicySet(Policy policy);
    event Wrapped(uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event Decision(
        bytes32 indexed decisionId,
        address indexed tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 amountOut,
        uint256 dayRealizedLoss,
        uint256 baseQty,
        uint256 quoteCost,
        bool stopOut,
        bytes reason
    );

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    constructor(
        address owner_,
        address agent_,
        address router_,
        address pool_,
        address quote_,
        Policy memory policy_
    ) {
        if (owner_ == address(0) || agent_ == address(0) || owner_ == agent_) revert AgentIsOwner();
        if (router_.code.length == 0 || pool_.code.length == 0) revert NoCode();

        address factory = ISwapRouter02(router_).factory();
        if (factory != IUniswapV3Pool(pool_).factory()) revert BadToken();

        token0 = IUniswapV3Pool(pool_).token0();
        token1 = IUniswapV3Pool(pool_).token1();
        fee = IUniswapV3Pool(pool_).fee();
        if (fee >= 100_000) revert BadPolicy();
        if (quote_ != token0 && quote_ != token1) revert BadToken();

        router = router_;
        pool = pool_;
        quoteToken = quote_;
        baseToken = quote_ == token0 ? token1 : token0;
        whsk = ISwapRouter02(router_).WETH9();
        _validate(policy_);
        policy = policy_;
        owner = owner_;
        agent = agent_;

        emit OwnerSet(owner_);
        emit AgentSet(agent_);
        emit PolicySet(policy_);
    }

    receive() external payable {
        if (msg.sender != whsk) revert BadToken();
    }

    function setAgent(address next) external onlyOwner {
        if (next == address(0) || next == owner) revert AgentIsOwner();
        agent = next;
        emit AgentSet(next);
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0) || next == agent) revert AgentIsOwner();
        owner = next;
        emit OwnerSet(next);
    }

    function setPaused(bool next) external onlyOwner {
        paused = next;
        emit PausedSet(next);
    }

    /// @notice Absolute policy write. Slippage cannot exceed 5% and cooldown cannot exceed 7 days.
    function setPolicy(Policy calldata next) external onlyOwner {
        _validate(next);
        policy = next;
        emit PolicySet(next);
    }

    /// @notice Owner path used by the desk. Caps and slippage can only move down. Cooldown can only move up.
    function tighten(Patch calldata patch) external onlyOwner {
        Policy memory next = policy;
        if (patch.hasMax0) {
            if (patch.maxAmountIn0 > next.maxAmountIn0) revert NotTighter();
            next.maxAmountIn0 = patch.maxAmountIn0;
        }
        if (patch.hasMax1) {
            if (patch.maxAmountIn1 > next.maxAmountIn1) revert NotTighter();
            next.maxAmountIn1 = patch.maxAmountIn1;
        }
        if (patch.hasSlippage) {
            if (patch.slippageBps > next.slippageBps) revert NotTighter();
            next.slippageBps = patch.slippageBps;
        }
        if (patch.hasCooldown) {
            if (patch.cooldown < next.cooldown) revert NotTighter();
            next.cooldown = patch.cooldown;
        }
        if (patch.hasDaily) {
            if (patch.dailyLossLimit > next.dailyLossLimit) revert NotTighter();
            next.dailyLossLimit = patch.dailyLossLimit;
        }
        if (patch.hasMaxBase) {
            if (patch.maxBase > next.maxBase) revert NotTighter();
            next.maxBase = patch.maxBase;
        }
        _validate(next);
        policy = next;
        emit PolicySet(next);
    }

    /// @notice Wrap native HSK into WHSK. Only useful when WHSK is one side of the pool.
    function wrap() external payable onlyOwner {
        if (msg.value == 0) revert ZeroAmount();
        if (whsk != token0 && whsk != token1) revert BadToken();
        IWHSK(whsk).deposit{value: msg.value}();
        emit Wrapped(msg.value);
    }

    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0) || amount == 0) revert ZeroAmount();
        TokenLib.safeTransfer(token, to, amount);
        emit Withdrawn(token, to, amount);
    }

    function withdrawNative(address payable to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0) || amount == 0) revert ZeroAmount();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert ZeroAmount();
        emit Withdrawn(address(0), to, amount);
    }

    /// @notice Spot output after the pool fee, before price impact. Rounded down.
    function spotOut(address tokenIn, uint256 amountIn) public view returns (uint256) {
        if (tokenIn != token0 && tokenIn != token1) revert BadToken();
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (sqrtPriceX96 == 0 || amountIn == 0) revert PoolPrice();
        uint256 afterFee = MulDiv.mulDiv(amountIn, FEE_DENOM - fee, FEE_DENOM);
        uint256 sqrt = uint256(sqrtPriceX96);
        if (tokenIn == token0) {
            uint256 step = MulDiv.mulDiv(afterFee, sqrt, 1 << 96);
            return MulDiv.mulDiv(step, sqrt, 1 << 96);
        }
        uint256 step0 = MulDiv.mulDiv(afterFee, 1 << 96, sqrt);
        return MulDiv.mulDiv(step0, 1 << 96, sqrt);
    }

    function risk()
        external
        view
        returns (
            bool paused_,
            uint32 dayId_,
            uint256 dayRealizedLoss_,
            uint256 baseQty_,
            uint256 quoteCost_,
            uint256 cooldownRemaining,
            uint256 quoteBalance,
            uint256 baseBalance,
            Policy memory policy_
        )
    {
        uint256 readyAt = lastSwapAt == 0 ? 0 : lastSwapAt + policy.cooldown;
        uint256 remaining = block.timestamp >= readyAt ? 0 : readyAt - block.timestamp;
        return (
            paused,
            dayId,
            dayRealizedLoss,
            baseQty,
            quoteCost,
            remaining,
            IERC20(quoteToken).balanceOf(address(this)),
            IERC20(baseToken).balanceOf(address(this)),
            policy
        );
    }

    /// @param stopOut Recorded for the explorer. It does not bypass a cap. Sells are allowed after the daily loss limit; buys are not.
    function swap(
        address tokenIn,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline,
        bytes32 decisionId,
        bool stopOut,
        bytes calldata reason
    ) external onlyAgent nonReentrant returns (uint256 amountOut) {
        if (paused) revert PausedError();
        if (block.timestamp > deadline) revert Deadline(deadline, block.timestamp);
        if (reason.length > MAX_REASON) revert ReasonTooLong();
        if (amountIn == 0 || amountOutMin == 0) revert ZeroAmount();
        if (usedDecision[decisionId]) revert Replay();
        if (tokenIn != token0 && tokenIn != token1) revert BadToken();

        address tokenOut = tokenIn == token0 ? token1 : token0;
        Policy memory p = policy;

        uint256 maxIn = tokenIn == token0 ? p.maxAmountIn0 : p.maxAmountIn1;
        if (amountIn > maxIn) revert Cap(amountIn, maxIn);

        // A vault that has never traded is not cooling down. lastSwapAt starts at 0.
        if (lastSwapAt != 0) {
            uint256 readyAt = lastSwapAt + p.cooldown;
            if (block.timestamp < readyAt) revert Cooldown(readyAt);
        }

        _rollDay();
        bool buying = tokenIn == quoteToken;
        if (buying && dayRealizedLoss >= p.dailyLossLimit) revert DailyLoss(dayRealizedLoss, p.dailyLossLimit);

        uint256 floorMin = MulDiv.mulDiv(spotOut(tokenIn, amountIn), BPS - p.slippageBps, BPS);
        if (amountOutMin < floorMin) revert Slippage(amountOutMin, floorMin);

        uint256 beforeIn = IERC20(tokenIn).balanceOf(address(this));
        uint256 beforeOut = IERC20(tokenOut).balanceOf(address(this));
        if (beforeIn < amountIn) revert Cap(amountIn, beforeIn);

        usedDecision[decisionId] = true;
        lastSwapAt = block.timestamp;

        TokenLib.forceApprove(tokenIn, router, amountIn);
        amountOut = ISwapRouter02(router).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: amountOutMin,
                sqrtPriceLimitX96: 0
            })
        );
        TokenLib.forceApprove(tokenIn, router, 0);

        uint256 spent = beforeIn - IERC20(tokenIn).balanceOf(address(this));
        uint256 got = IERC20(tokenOut).balanceOf(address(this)) - beforeOut;
        if (spent != amountIn || got < amountOutMin) revert Slippage(got, amountOutMin);

        if (buying) {
            baseQty += got;
            quoteCost += spent;
            if (baseQty > p.maxBase) revert Inventory(baseQty, p.maxBase);
        } else {
            _accountSell(spent, got);
        }

        emit Decision(
            decisionId, tokenIn, tokenOut, spent, amountOutMin, got, dayRealizedLoss, baseQty, quoteCost, stopOut, reason
        );
    }

    function _accountSell(uint256 baseSpent, uint256 quoteGot) internal {
        uint256 tracked = baseQty;
        uint256 untracked = baseSpent > tracked ? baseSpent - tracked : 0;
        uint256 fromTracked = baseSpent - untracked;
        uint256 costRemoved = tracked == 0 ? 0 : MulDiv.mulDiv(quoteCost, fromTracked, tracked);
        baseQty = tracked - fromTracked;
        quoteCost -= costRemoved;
        if (quoteGot < costRemoved) {
            dayRealizedLoss += costRemoved - quoteGot;
        }
    }

    function _rollDay() internal {
        uint32 today = uint32(block.timestamp / 1 days);
        if (today != dayId) {
            dayId = today;
            dayRealizedLoss = 0;
        }
    }

    function _validate(Policy memory next) internal pure {
        if (next.slippageBps > MAX_SLIPPAGE_BPS || next.cooldown > MAX_COOLDOWN) revert BadPolicy();
    }
}
