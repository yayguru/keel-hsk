// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The two ERC-20 calls the vault needs. Handles tokens that return no bool, and USDT-style approve.
library TokenLib {
    function forceApprove(address token, address spender, uint256 amount) internal {
        if (_approve(token, spender, amount)) return;
        require(_approve(token, spender, 0));
        require(_approve(token, spender, amount));
    }

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))));
    }

    function _approve(address token, address spender, uint256 amount) private returns (bool) {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        return ok && (data.length == 0 || abi.decode(data, (bool)));
    }
}
