// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {SwapKitRouter} from "../src/SwapKitRouter.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

/**
 * @title SwapKitRouterTest
 * @notice Foundry test suite for SwapKitRouter covering deployment, admin,
 *         and swap-revert scenarios.
 */
contract SwapKitRouterTest is Test {
    SwapKitRouter public router;

    address public owner = address(this);
    address public alice = address(0xA11CE);
    address public bob   = address(0xB0B);
    address public mockRouter = address(0xDEF1);
    address public tokenA = address(0xAAAA);
    address public tokenB = address(0xBBBB);

    // ─── Setup ───────────────────────────────────────────────────────────────

    function setUp() public {
        router = new SwapKitRouter();
    }

    // ─── Deployment ──────────────────────────────────────────────────────────

    function test_DeploymentSetsOwner() public view {
        assertEq(router.owner(), address(this));
    }

    function test_InitialRouterNotWhitelisted() public view {
        assertFalse(router.whitelistedRouters(mockRouter));
    }

    // ─── Whitelist management ────────────────────────────────────────────────

    function test_OwnerCanWhitelistRouter() public {
        router.setRouterWhitelist(mockRouter, true);
        assertTrue(router.whitelistedRouters(mockRouter));
    }

    function test_OwnerCanRemoveRouterFromWhitelist() public {
        router.setRouterWhitelist(mockRouter, true);
        assertTrue(router.whitelistedRouters(mockRouter));

        router.setRouterWhitelist(mockRouter, false);
        assertFalse(router.whitelistedRouters(mockRouter));
    }

    function test_NonOwnerCannotWhitelist() public {
        vm.prank(alice);
        vm.expectRevert(SwapKitRouter.OnlyOwner.selector);
        router.setRouterWhitelist(mockRouter, true);
    }

    function test_CannotWhitelistZeroAddress() public {
        vm.expectRevert(SwapKitRouter.ZeroAddress.selector);
        router.setRouterWhitelist(address(0), true);
    }

    function test_WhitelistEmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit SwapKitRouter.RouterWhitelisted(mockRouter, true);
        router.setRouterWhitelist(mockRouter, true);
    }

    // ─── Emergency withdraw ──────────────────────────────────────────────────

    function test_EmergencyWithdrawETH() public {
        // Fund the router with 1 ETH
        vm.deal(address(router), 1 ether);

        uint256 balBefore = bob.balance;
        router.emergencyWithdraw(address(0), bob);
        uint256 balAfter = bob.balance;

        assertEq(balAfter - balBefore, 1 ether);
    }

    function test_NonOwnerCannotEmergencyWithdraw() public {
        vm.deal(address(router), 1 ether);

        vm.prank(alice);
        vm.expectRevert(SwapKitRouter.OnlyOwner.selector);
        router.emergencyWithdraw(address(0), bob);
    }

    function test_EmergencyWithdrawRevertsOnZeroRecipient() public {
        vm.expectRevert(SwapKitRouter.ZeroAddress.selector);
        router.emergencyWithdraw(address(0), address(0));
    }

    function test_EmergencyWithdrawEmitsEvent() public {
        vm.deal(address(router), 1 ether);

        vm.expectEmit(true, true, false, true);
        emit SwapKitRouter.EmergencyWithdraw(address(0), 1 ether, bob);
        router.emergencyWithdraw(address(0), bob);
    }

    // ─── Swap reverts without whitelisted router ─────────────────────────────

    function test_SwapRevertsWithNonWhitelistedRouter() public {
        // routeData starts with the router address (20 bytes) + some dummy calldata
        bytes memory routeData = abi.encodePacked(mockRouter, hex"deadbeef");

        vm.expectRevert(abi.encodeWithSelector(SwapKitRouter.RouterNotWhitelisted.selector, mockRouter));
        router.swap(tokenA, tokenB, 1000, 900, routeData);
    }

    // ─── Ownership ───────────────────────────────────────────────────────────

    function test_TransferOwnership() public {
        router.transferOwnership(alice);
        assertEq(router.owner(), alice);
    }

    function test_NonOwnerCannotTransferOwnership() public {
        vm.prank(alice);
        vm.expectRevert(SwapKitRouter.OnlyOwner.selector);
        router.transferOwnership(bob);
    }

    function test_CannotTransferOwnershipToZero() public {
        vm.expectRevert(SwapKitRouter.ZeroAddress.selector);
        router.transferOwnership(address(0));
    }

    // ─── Receive ETH ─────────────────────────────────────────────────────────

    function test_CanReceiveETH() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(router).call{value: 0.5 ether}("");
        assertTrue(ok);
        assertEq(address(router).balance, 0.5 ether);
    }
}
