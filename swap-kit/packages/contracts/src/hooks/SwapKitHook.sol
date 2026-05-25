// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title SwapKitHook
 * @notice Example Uniswap V4 hook that tracks swap activity.
 * @dev Implements beforeSwap and afterSwap hooks for monitoring and custom logic.
 *
 * In Uniswap V4, hook permissions are encoded in the hook contract's address.
 * The last byte of the address determines which hooks are active:
 *   - Bit 6 (0x40): BEFORE_SWAP
 *   - Bit 7 (0x80): AFTER_SWAP
 *
 * Use the CREATE2 miner (swap-kit-engine /mine endpoint) to find a salt
 * that deploys this contract to an address with the correct flag bits.
 */

/// @dev Minimal interface for Uniswap V4 hook callbacks
interface IPoolManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }
}

contract SwapKitHook {
    // ─── Constants ────────────────────────────────────────────────────────────

    uint160 constant BEFORE_SWAP_FLAG = 1 << 6;  // 0x40
    uint160 constant AFTER_SWAP_FLAG  = 1 << 7;  // 0x80

    // ─── State ────────────────────────────────────────────────────────────────

    address public immutable poolManager;
    address public owner;

    /// @notice Total number of swaps tracked
    uint256 public totalSwaps;

    /// @notice Total volume tracked per token pair (currency0 => currency1 => volume)
    mapping(address => mapping(address => uint256)) public pairVolume;

    // ─── Events ───────────────────────────────────────────────────────────────

    event BeforeSwapTriggered(
        address indexed currency0,
        address indexed currency1,
        bool zeroForOne,
        int256 amountSpecified,
        address sender
    );

    event AfterSwapTriggered(
        address indexed currency0,
        address indexed currency1,
        bool zeroForOne,
        int256 amountSpecified,
        int128 deltaAmount0,
        int128 deltaAmount1
    );

    // ─── Errors ───────────────────────────────────────────────────────────────

    error NotPoolManager();
    error NotOwner();

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyPoolManager() {
        if (msg.sender != poolManager) revert NotPoolManager();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address _poolManager) {
        poolManager = _poolManager;
        owner = msg.sender;
    }

    // ─── Hook Callbacks ───────────────────────────────────────────────────────

    /**
     * @notice Called by PoolManager before a swap executes.
     * @dev Can be used for:
     *   - Custom fee logic (dynamic fees based on volatility)
     *   - Access control (whitelist/blacklist traders)
     *   - Oracle updates (TWAP price feeds)
     */
    function beforeSwap(
        address sender,
        IPoolManager.PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        bytes calldata /* hookData */
    ) external onlyPoolManager returns (bytes4) {
        emit BeforeSwapTriggered(
            key.currency0,
            key.currency1,
            params.zeroForOne,
            params.amountSpecified,
            sender
        );

        totalSwaps++;

        // Return the function selector to indicate success
        return this.beforeSwap.selector;
    }

    /**
     * @notice Called by PoolManager after a swap completes.
     * @dev Can be used for:
     *   - Volume tracking and analytics
     *   - Fee distribution to LPs or protocol
     *   - Post-trade notifications
     */
    function afterSwap(
        address /* sender */,
        IPoolManager.PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        int128 deltaAmount0,
        int128 deltaAmount1,
        bytes calldata /* hookData */
    ) external onlyPoolManager returns (bytes4) {
        // Track volume
        uint256 volume = params.zeroForOne
            ? uint256(uint128(deltaAmount0 > 0 ? deltaAmount0 : -deltaAmount0))
            : uint256(uint128(deltaAmount1 > 0 ? deltaAmount1 : -deltaAmount1));

        pairVolume[key.currency0][key.currency1] += volume;

        emit AfterSwapTriggered(
            key.currency0,
            key.currency1,
            params.zeroForOne,
            params.amountSpecified,
            deltaAmount0,
            deltaAmount1
        );

        return this.afterSwap.selector;
    }

    // ─── View Functions ───────────────────────────────────────────────────────

    /**
     * @notice Returns the hook's permission flags.
     * @dev In V4, these must match the address bits. Use CREATE2 mining to deploy.
     */
    function getHookPermissions() external pure returns (uint160) {
        return BEFORE_SWAP_FLAG | AFTER_SWAP_FLAG;
    }

    /**
     * @notice Get accumulated volume for a token pair.
     */
    function getVolume(address currency0, address currency1) external view returns (uint256) {
        return pairVolume[currency0][currency1];
    }
}
