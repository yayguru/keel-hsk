// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ISwapRouter02, IUniswapV3Pool} from "../interfaces/IDex.sol";

contract MockERC20 {
    string public symbol;
    uint8 public decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory symbol_, uint8 decimals_) {
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }
}

contract MockPool is IUniswapV3Pool {
    address public immutable factory;
    address public immutable token0;
    address public immutable token1;
    uint24 public fee;
    uint160 public sqrtPriceX96 = uint160(1 << 96);

    constructor(address factory_, address token0_, address token1_, uint24 fee_) {
        factory = factory_;
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
    }

    function setSqrt(uint160 next) external {
        sqrtPriceX96 = next;
    }

    function slot0()
        external
        view
        returns (uint160, int24, uint16, uint16, uint16, uint8, bool)
    {
        return (sqrtPriceX96, 0, 0, 1, 1, 0, true);
    }
}

contract MockRouter is ISwapRouter02 {
    address public immutable factory;
    address public immutable WETH9;
    uint256 public outNum = 1;
    uint256 public outDen = 1;
    uint256 public calls;

    constructor(address factory_, address whsk_) {
        factory = factory_;
        WETH9 = whsk_;
    }

    function setRate(uint256 num, uint256 den) external {
        outNum = num;
        outDen = den;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        calls += 1;
        MockERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        amountOut = params.amountIn * outNum / outDen;
        if (amountOut < params.amountOutMinimum) revert("router min");
        MockERC20(params.tokenOut).transfer(params.recipient, amountOut);
    }
}

contract MockFactory {
    // Address identity is enough. KeelVault only compares factory addresses.
}
