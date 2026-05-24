// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";

/**
 * @title SwapKitRouter
 * @notice Aggregation router that dispatches swap calls to whitelisted DEX routers.
 *         Supports single-hop and multi-hop (chained) swaps.
 */
contract SwapKitRouter {
    // ─── Types ───────────────────────────────────────────────────────────────────

    struct SwapStep {
        address tokenIn;
        address tokenOut;
        address router;
        bytes data; // calldata to forward to the DEX router
    }

    // ─── State ───────────────────────────────────────────────────────────────────

    address public owner;

    /// @notice Only routers in this set may be called.
    mapping(address => bool) public whitelistedRouters;

    // ─── Events ──────────────────────────────────────────────────────────────────

    event SwapExecuted(
        address indexed sender,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    event RouterWhitelisted(address indexed router, bool allowed);

    event EmergencyWithdraw(address indexed token, uint256 amount, address indexed to);

    // ─── Errors ──────────────────────────────────────────────────────────────────

    error OnlyOwner();
    error RouterNotWhitelisted(address router);
    error InsufficientOutput(uint256 actual, uint256 minRequired);
    error SwapCallFailed(address router);
    error ZeroAddress();

    // ─── Modifiers ───────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
    }

    // ─── Core: single-hop swap ───────────────────────────────────────────────────

    /**
     * @notice Execute a single-hop swap through a whitelisted DEX router.
     * @param tokenIn     Address of the input token (address(0) for native ETH).
     * @param tokenOut    Address of the output token.
     * @param amountIn    Amount of `tokenIn` to sell.
     * @param minAmountOut Minimum acceptable output — reverts if not met.
     * @param routeData   ABI-encoded call forwarded to the DEX router.
     *                    The first 20 bytes encode the target router address;
     *                    the remainder is the router's calldata.
     * @return amountOut  Actual amount of `tokenOut` received.
     */
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes calldata routeData
    ) external payable returns (uint256 amountOut) {
        // Decode target router from routeData
        address router = address(bytes20(routeData[:20]));
        bytes calldata routerCalldata = routeData[20:];

        if (!whitelistedRouters[router]) revert RouterNotWhitelisted(router);

        // Pull ERC-20 tokens from sender (skip for native ETH)
        if (tokenIn != address(0)) {
            IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
            IERC20(tokenIn).approve(router, amountIn);
        }

        uint256 balBefore = _balanceOf(tokenOut, address(this));

        // Forward call to the DEX router
        (bool success,) = router.call{value: tokenIn == address(0) ? msg.value : 0}(routerCalldata);
        if (!success) revert SwapCallFailed(router);

        uint256 balAfter = _balanceOf(tokenOut, address(this));
        amountOut = balAfter - balBefore;

        if (amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);

        // Transfer output to the caller
        _transfer(tokenOut, msg.sender, amountOut);

        emit SwapExecuted(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
    }

    // ─── Core: multi-hop swap ────────────────────────────────────────────────────

    /**
     * @notice Execute a multi-hop swap by chaining several `SwapStep`s.
     *         The output of each step becomes the input of the next.
     * @param steps Ordered array of swap steps.
     * @return finalAmountOut Amount of the final output token received.
     */
    function multiSwap(SwapStep[] calldata steps) external payable returns (uint256 finalAmountOut) {
        uint256 currentAmount;

        for (uint256 i = 0; i < steps.length; i++) {
            SwapStep calldata step = steps[i];

            if (!whitelistedRouters[step.router]) revert RouterNotWhitelisted(step.router);

            // For the first step, pull tokens from the sender
            if (i == 0) {
                if (step.tokenIn != address(0)) {
                    IERC20(step.tokenIn).transferFrom(msg.sender, address(this), _inputAmount(step));
                    IERC20(step.tokenIn).approve(step.router, _inputAmount(step));
                }
                currentAmount = _inputAmount(step);
            } else {
                // Approve the next router to spend what we received
                if (step.tokenIn != address(0)) {
                    IERC20(step.tokenIn).approve(step.router, currentAmount);
                }
            }

            uint256 balBefore = _balanceOf(step.tokenOut, address(this));

            (bool success,) = step.router.call{
                value: (i == 0 && step.tokenIn == address(0)) ? msg.value : 0
            }(step.data);
            if (!success) revert SwapCallFailed(step.router);

            uint256 balAfter = _balanceOf(step.tokenOut, address(this));
            currentAmount = balAfter - balBefore;
        }

        finalAmountOut = currentAmount;

        // Transfer the final output to the caller
        SwapStep calldata lastStep = steps[steps.length - 1];
        _transfer(lastStep.tokenOut, msg.sender, finalAmountOut);

        emit SwapExecuted(
            msg.sender,
            steps[0].tokenIn,
            lastStep.tokenOut,
            _inputAmount(steps[0]),
            finalAmountOut
        );
    }

    // ─── Admin ───────────────────────────────────────────────────────────────────

    /**
     * @notice Whitelist or de-whitelist a DEX router address.
     */
    function setRouterWhitelist(address router, bool allowed) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        whitelistedRouters[router] = allowed;
        emit RouterWhitelisted(router, allowed);
    }

    /**
     * @notice Emergency withdrawal of any token (or native ETH) stuck in this contract.
     * @param token The token address (address(0) for native ETH).
     * @param to    Recipient.
     */
    function emergencyWithdraw(address token, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();

        uint256 amount;
        if (token == address(0)) {
            amount = address(this).balance;
            (bool ok,) = to.call{value: amount}("");
            require(ok, "ETH transfer failed");
        } else {
            amount = IERC20(token).balanceOf(address(this));
            IERC20(token).transfer(to, amount);
        }

        emit EmergencyWithdraw(token, amount, to);
    }

    /**
     * @notice Transfer ownership.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
    }

    // ─── Receive ETH ─────────────────────────────────────────────────────────────

    receive() external payable {}

    // ─── Internals ───────────────────────────────────────────────────────────────

    function _balanceOf(address token, address account) internal view returns (uint256) {
        if (token == address(0)) return account.balance;
        return IERC20(token).balanceOf(account);
    }

    function _transfer(address token, address to, uint256 amount) internal {
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            require(ok, "ETH transfer failed");
        } else {
            IERC20(token).transfer(to, amount);
        }
    }

    /**
     * @dev Extracts the input amount from the step's calldata.
     *      For simplicity, we ABI-decode the first uint256 parameter.
     */
    function _inputAmount(SwapStep calldata step) internal pure returns (uint256) {
        return abi.decode(step.data[:32], (uint256));
    }
}
