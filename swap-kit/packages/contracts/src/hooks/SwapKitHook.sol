// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// ─── Minimal Uniswap V4 interfaces (inline to avoid external dep) ────────────

/// @notice Minimal PoolKey definition matching Uniswap V4.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @notice Minimal swap params for Uniswap V4.
struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

/// @notice Balance delta returned by the pool manager after a swap.
type BalanceDelta is int256;

/// @notice Minimal IHooks interface for Uniswap V4.
interface IHooks {
    function beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    ) external returns (bytes4);

    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) external returns (bytes4);
}

// ─── Hook Flags ──────────────────────────────────────────────────────────────

/// @dev Bit flags indicating which hooks are implemented.
///      These match the Uniswap V4 hook flag convention: the hook contract
///      address must have these bits set in its leading bytes.
uint160 constant BEFORE_SWAP_FLAG = 1 << 7;
uint160 constant AFTER_SWAP_FLAG  = 1 << 6;

/**
 * @title SwapKitHook
 * @notice A Uniswap V4 hook that intercepts swaps for analytics and
 *         optional custom-fee enforcement.
 *
 * - `beforeSwap`  — logs the swap intent; could enforce extra fee logic.
 * - `afterSwap`   — emits an event with the actual output for off-chain tracking.
 *
 * The contract address **must** be mined so its leading bits match the flags
 * returned by `getHookPermissions()` (CREATE2 salt mining).
 */
contract SwapKitHook is IHooks {
    // ─── Events ──────────────────────────────────────────────────────────────

    event BeforeSwapIntent(
        address indexed sender,
        address indexed currency0,
        address indexed currency1,
        bool zeroForOne,
        int256 amountSpecified
    );

    event AfterSwapExecuted(
        address indexed sender,
        address indexed currency0,
        address indexed currency1,
        int256 delta
    );

    // ─── State ───────────────────────────────────────────────────────────────

    address public immutable poolManager;
    address public owner;

    /// @notice Custom fee override in basis points (0 = use pool default).
    uint256 public customFeeBps;

    // ─── Errors ──────────────────────────────────────────────────────────────

    error OnlyPoolManager();
    error OnlyOwner();

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier onlyPoolManager() {
        if (msg.sender != poolManager) revert OnlyPoolManager();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(address _poolManager) {
        poolManager = _poolManager;
        owner = msg.sender;
    }

    // ─── Hook Implementations ────────────────────────────────────────────────

    /**
     * @notice Called by the PoolManager **before** a swap is executed.
     *         Emits intent data and could enforce custom fee logic.
     */
    function beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata /* hookData */
    ) external override onlyPoolManager returns (bytes4) {
        emit BeforeSwapIntent(
            sender,
            key.currency0,
            key.currency1,
            params.zeroForOne,
            params.amountSpecified
        );

        // Custom fee enforcement placeholder:
        // if (customFeeBps > 0) { … }

        return IHooks.beforeSwap.selector;
    }

    /**
     * @notice Called by the PoolManager **after** a swap is executed.
     *         Emits the actual delta for off-chain tracking / analytics.
     */
    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata /* params */,
        BalanceDelta delta,
        bytes calldata /* hookData */
    ) external override onlyPoolManager returns (bytes4) {
        emit AfterSwapExecuted(
            sender,
            key.currency0,
            key.currency1,
            BalanceDelta.unwrap(delta)
        );

        return IHooks.afterSwap.selector;
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    /**
     * @notice Set a custom fee override (in basis points).
     *         Pass 0 to use the pool's default fee.
     */
    function setCustomFee(uint256 _feeBps) external onlyOwner {
        customFeeBps = _feeBps;
    }

    /**
     * @notice Returns the hook permission flags (which hooks are active).
     */
    function getHookPermissions() external pure returns (uint160) {
        return BEFORE_SWAP_FLAG | AFTER_SWAP_FLAG;
    }
}
