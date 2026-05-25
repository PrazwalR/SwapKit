// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title SwapKitRouter
 * @notice On-chain swap aggregator that routes through whitelisted DEX routers.
 * @dev Supports single-hop and multi-hop swaps via approved router contracts.
 *
 * This contract acts as a unified entry point for swaps across multiple DEXs.
 * Only routers explicitly whitelisted by the owner can be called.
 */
contract SwapKitRouter {
    // ─── State ────────────────────────────────────────────────────────────────

    address public owner;
    mapping(address => bool) public whitelistedRouters;

    // ─── Structs ──────────────────────────────────────────────────────────────

    struct SwapStep {
        address tokenIn;
        address tokenOut;
        address router;
        uint256 amountIn;
        bytes routerCalldata;
    }

    // ─── Events ───────────────────────────────────────────────────────────────

    event SwapExecuted(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address router
    );

    event RouterWhitelisted(address indexed router, bool status);
    event EmergencyWithdraw(address indexed token, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error NotOwner();
    error RouterNotWhitelisted(address router);
    error InsufficientOutput(uint256 received, uint256 minimum);
    error SwapFailed();
    error ZeroAddress();
    error TransferFailed();

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
    }

    // ─── External Functions ───────────────────────────────────────────────────

    /**
     * @notice Execute a single-hop swap through a whitelisted router.
     * @param tokenIn Token to sell
     * @param tokenOut Token to receive
     * @param amountIn Amount of tokenIn to sell
     * @param minAmountOut Minimum acceptable output (slippage protection)
     * @param router DEX router to execute through
     * @param routerCalldata Pre-encoded calldata for the router
     * @return amountOut Actual amount received
     */
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address router,
        bytes calldata routerCalldata
    ) external payable returns (uint256 amountOut) {
        if (!whitelistedRouters[router]) revert RouterNotWhitelisted(router);

        // Transfer tokens from user (for ERC-20, not ETH)
        if (tokenIn != address(0) && tokenIn != 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE) {
            _safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
            _safeApprove(tokenIn, router, amountIn);
        }

        // Get balance before swap
        uint256 balanceBefore = _getBalance(tokenOut, address(this));

        // Execute swap through router
        (bool success,) = router.call{value: msg.value}(routerCalldata);
        if (!success) revert SwapFailed();

        // Calculate output
        uint256 balanceAfter = _getBalance(tokenOut, address(this));
        amountOut = balanceAfter - balanceBefore;

        if (amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);

        // Transfer output to user
        if (tokenOut == address(0) || tokenOut == 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE) {
            (bool sent,) = msg.sender.call{value: amountOut}("");
            if (!sent) revert TransferFailed();
        } else {
            _safeTransfer(tokenOut, msg.sender, amountOut);
        }

        emit SwapExecuted(msg.sender, tokenIn, tokenOut, amountIn, amountOut, router);
    }

    /**
     * @notice Execute a multi-hop swap through multiple routers.
     * @param steps Array of swap steps to execute in sequence
     * @param minFinalAmountOut Minimum acceptable final output
     * @return finalAmountOut Actual final amount received
     */
    function multiSwap(
        SwapStep[] calldata steps,
        uint256 minFinalAmountOut
    ) external payable returns (uint256 finalAmountOut) {
        for (uint256 i = 0; i < steps.length; i++) {
            SwapStep calldata step = steps[i];
            if (!whitelistedRouters[step.router]) revert RouterNotWhitelisted(step.router);

            if (i == 0 && step.tokenIn != address(0)) {
                _safeTransferFrom(step.tokenIn, msg.sender, address(this), step.amountIn);
            }

            _safeApprove(step.tokenIn, step.router, step.amountIn);

            uint256 balanceBefore = _getBalance(step.tokenOut, address(this));

            (bool success,) = step.router.call{value: i == 0 ? msg.value : 0}(step.routerCalldata);
            if (!success) revert SwapFailed();

            finalAmountOut = _getBalance(step.tokenOut, address(this)) - balanceBefore;
        }

        if (finalAmountOut < minFinalAmountOut) {
            revert InsufficientOutput(finalAmountOut, minFinalAmountOut);
        }

        // Transfer final output to user
        SwapStep calldata lastStep = steps[steps.length - 1];
        _safeTransfer(lastStep.tokenOut, msg.sender, finalAmountOut);
    }

    // ─── Admin Functions ──────────────────────────────────────────────────────

    function setRouterWhitelist(address router, bool status) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        whitelistedRouters[router] = status;
        emit RouterWhitelisted(router, status);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        if (token == address(0) || token == 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE) {
            (bool sent,) = owner.call{value: amount}("");
            if (!sent) revert TransferFailed();
        } else {
            _safeTransfer(token, owner, amount);
        }
        emit EmergencyWithdraw(token, amount);
    }

    // ─── Receive ETH ──────────────────────────────────────────────────────────

    receive() external payable {}

    // ─── Internal Helpers ─────────────────────────────────────────────────────

    function _getBalance(address token, address account) internal view returns (uint256) {
        if (token == address(0) || token == 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE) {
            return account.balance;
        }
        (bool success, bytes memory data) = token.staticcall(
            abi.encodeWithSelector(0x70a08231, account) // balanceOf(address)
        );
        if (!success || data.length < 32) return 0;
        return abi.decode(data, (uint256));
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0xa9059cbb, to, amount) // transfer(address,uint256)
        );
        if (!success || (data.length > 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0x23b872dd, from, to, amount) // transferFrom(address,address,uint256)
        );
        if (!success || (data.length > 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeApprove(address token, address spender, uint256 amount) internal {
        (bool success,) = token.call(
            abi.encodeWithSelector(0x095ea7b3, spender, amount) // approve(address,uint256)
        );
        // Don't revert on failed approve — some tokens don't return bool
    }
}
