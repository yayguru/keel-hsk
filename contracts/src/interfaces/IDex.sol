// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice SwapRouter02 exact-input single hop. The params struct has no deadline.
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);

    function factory() external view returns (address);

    function WETH9() external view returns (address);
}

interface IUniswapV3Pool {
    function factory() external view returns (address);

    function token0() external view returns (address);

    function token1() external view returns (address);

    function fee() external view returns (uint24);

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

interface IWHSK {
    function deposit() external payable;

    function withdraw(uint256 amount) external;
}
