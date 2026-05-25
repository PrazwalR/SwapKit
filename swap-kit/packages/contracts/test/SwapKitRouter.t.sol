// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "../src/SwapKitRouter.sol";

/**
 * @title SwapKitRouterTest
 * @notice Foundry tests for SwapKitRouter
 */
contract SwapKitRouterTest {
    SwapKitRouter public router;

    // ─── Setup ────────────────────────────────────────────────────────────────

    function setUp() public {
        router = new SwapKitRouter();
    }

    // ─── Tests ────────────────────────────────────────────────────────────────

    function test_ownerIsDeployer() public view {
        assert(router.owner() == address(this));
    }

    function test_whitelistRouter() public {
        address mockRouter = address(0xBEEF);

        // Initially not whitelisted
        assert(!router.whitelistedRouters(mockRouter));

        // Whitelist
        router.setRouterWhitelist(mockRouter, true);
        assert(router.whitelistedRouters(mockRouter));

        // Remove from whitelist
        router.setRouterWhitelist(mockRouter, false);
        assert(!router.whitelistedRouters(mockRouter));
    }

    function test_transferOwnership() public {
        address newOwner = address(0xCAFE);
        router.transferOwnership(newOwner);
        assert(router.owner() == newOwner);
    }

    function test_receiveETH() public {
        // Should accept ETH
        (bool success,) = address(router).call{value: 1 ether}("");
        assert(success);
        assert(address(router).balance == 1 ether);
    }

    function test_emergencyWithdrawETH() public {
        // Send ETH to router
        (bool sent,) = address(router).call{value: 1 ether}("");
        assert(sent);

        uint256 balanceBefore = address(this).balance;

        // Withdraw
        router.emergencyWithdraw(
            0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE,
            1 ether
        );

        assert(address(this).balance == balanceBefore + 1 ether);
    }

    // Required to receive ETH from emergency withdraw
    receive() external payable {}
}
