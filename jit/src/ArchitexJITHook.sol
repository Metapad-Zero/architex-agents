// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ArchitexJITVault} from "./ArchitexJITVault.sol";

/// @notice One immutable pool policy: persistent baseline and atomic, bounded temporary liquidity.
/// @dev JIT uses fixed approved bounds, never an unconstrained recentering of a manipulable spot price.
contract ArchitexJITHook is IHooks, IUnlockCallback {
    using BalanceDeltaLibrary for BalanceDelta;
    using PoolIdLibrary for PoolKey;

    struct Policy {
        uint160 initialSqrtPriceX96;
        int24 baselineLower;
        int24 baselineUpper;
        int24 jitLower;
        int24 jitUpper;
        uint128 baselineLiquidity;
        uint128 jitLiquidity;
        uint128 maxJITAmount0;
        uint128 maxJITAmount1;
        uint128 minSwapAmount0;
        uint128 minSwapAmount1;
        uint64 validUntil;
    }

    error InvalidConfiguration();
    error InvalidPolicy();
    error Unauthorized();
    error WrongPool();
    error InvalidInitialPrice();
    error BaselineAlreadySeeded();
    error BaselineNotSeeded();
    error InvalidLifecycle();
    error InsufficientInventory();
    error ExternalLiquidityUnsupported();
    error DonationsUnsupported();
    error UnsupportedCallback();

    uint160 public constant HOOK_FLAGS = 0x2ae0;
    bytes32 public constant BASELINE_SALT = keccak256("ARCHITEX_BASELINE");
    bytes32 public constant JIT_SALT = keccak256("ARCHITEX_JIT");

    IPoolManager public immutable poolManager;
    ArchitexJITVault public immutable vault;
    PoolId public immutable poolId;
    uint160 public immutable initialSqrtPriceX96;
    int24 public immutable baselineLower;
    int24 public immutable baselineUpper;
    int24 public immutable jitLower;
    int24 public immutable jitUpper;
    uint128 public immutable baselineLiquidity;
    uint128 public immutable jitLiquidity;
    uint128 public immutable maxJITAmount0;
    uint128 public immutable maxJITAmount1;
    uint128 public immutable minSwapAmount0;
    uint128 public immutable minSwapAmount1;
    uint64 public immutable validUntil;

    bool public baselineSeeded;
    uint128 public activeJITLiquidity;
    uint256 public startedCycles;
    uint256 public completedCycles;
    uint256 public jitCycles;
    PoolKey private key;

    // 0 idle, 1 baseline seed, 2 baseline fee collection, 3 swap callbacks.
    uint8 private operation;
    bytes32 private cycleContext;

    event BaselineSeeded(uint128 liquidity, uint256 amount0, uint256 amount1);
    event SwapCycleStarted(uint256 indexed cycle, address indexed swapper, uint128 temporaryLiquidity);
    event SwapCycleCompleted(uint256 indexed cycle, uint128 temporaryLiquidity, int128 amount0, int128 amount1);

    constructor(IPoolManager manager, ArchitexJITVault vault_, uint24 fee, int24 tickSpacing, Policy memory policy) {
        if (
            address(manager).code.length == 0 || address(vault_).code.length == 0 || vault_.poolManager() != manager
                || fee == 0 || fee >= 1_000_000 || tickSpacing <= 0 || tickSpacing > type(int16).max
        ) revert InvalidConfiguration();
        if (
            policy.baselineLower < TickMath.MIN_TICK || policy.baselineUpper > TickMath.MAX_TICK
                || policy.baselineLower >= policy.jitLower || policy.jitUpper >= policy.baselineUpper
                || policy.jitLower >= policy.jitUpper || policy.baselineLower % tickSpacing != 0
                || policy.baselineUpper % tickSpacing != 0 || policy.jitLower % tickSpacing != 0
                || policy.jitUpper % tickSpacing != 0 || policy.baselineLiquidity == 0 || policy.jitLiquidity == 0
                || policy.maxJITAmount0 == 0 || policy.maxJITAmount1 == 0 || policy.validUntil <= block.timestamp
        ) revert InvalidPolicy();
        if (
            policy.initialSqrtPriceX96 <= TickMath.getSqrtPriceAtTick(policy.jitLower)
                || policy.initialSqrtPriceX96 >= TickMath.getSqrtPriceAtTick(policy.jitUpper)
        ) revert InvalidPolicy();
        uint256 spacing = uint256(uint24(tickSpacing));
        uint256 negativeExtent = uint256(-int256(TickMath.MIN_TICK));
        // The pinned manager counts the partial bucket below MIN_TICK too.
        uint256 tickBuckets =
            uint256(int256(TickMath.MAX_TICK)) / spacing + (negativeExtent + spacing - 1) / spacing + 1;
        uint256 perTickLimit = type(uint128).max / tickBuckets;
        if (
            uint256(policy.baselineLiquidity) > perTickLimit || uint256(policy.jitLiquidity) > perTickLimit
                || uint256(policy.baselineLiquidity) + uint256(policy.jitLiquidity) > type(uint128).max
        ) revert InvalidPolicy();
        (uint256 baselineAmount0, uint256 baselineAmount1) = _requiredAmounts(
            policy.initialSqrtPriceX96, policy.baselineLower, policy.baselineUpper, policy.baselineLiquidity
        );
        uint160 lowerPrice = TickMath.getSqrtPriceAtTick(policy.jitLower);
        uint160 upperPrice = TickMath.getSqrtPriceAtTick(policy.jitUpper);
        uint256 signedAmountLimit = uint256(uint128(type(int128).max));
        if (
            baselineAmount0 > signedAmountLimit || baselineAmount1 > signedAmountLimit
                || SqrtPriceMath.getAmount0Delta(lowerPrice, upperPrice, policy.jitLiquidity, true) > signedAmountLimit
                || SqrtPriceMath.getAmount1Delta(lowerPrice, upperPrice, policy.jitLiquidity, true) > signedAmountLimit
        ) revert InvalidPolicy();

        poolManager = manager;
        vault = vault_;
        initialSqrtPriceX96 = policy.initialSqrtPriceX96;
        baselineLower = policy.baselineLower;
        baselineUpper = policy.baselineUpper;
        jitLower = policy.jitLower;
        jitUpper = policy.jitUpper;
        baselineLiquidity = policy.baselineLiquidity;
        jitLiquidity = policy.jitLiquidity;
        maxJITAmount0 = policy.maxJITAmount0;
        maxJITAmount1 = policy.maxJITAmount1;
        minSwapAmount0 = policy.minSwapAmount0;
        minSwapAmount1 = policy.minSwapAmount1;
        validUntil = policy.validUntil;
        key = PoolKey({
            currency0: Currency.wrap(vault_.currency0()),
            currency1: Currency.wrap(vault_.currency1()),
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: IHooks(address(this))
        });
        poolId = key.toId();
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert Unauthorized();
        _;
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory permissions) {
        permissions.beforeInitialize = true;
        permissions.beforeAddLiquidity = true;
        permissions.beforeRemoveLiquidity = true;
        permissions.beforeSwap = true;
        permissions.afterSwap = true;
        permissions.beforeDonate = true;
    }

    function getPoolKey() external view returns (PoolKey memory) {
        return key;
    }

    /// @notice Permissionless activation uses the constructor's exact price and immutable baseline.
    function seedBaseline() external {
        if (operation != 0 || vault.hook() != address(this) || vault.inventoryOperationActive()) {
            revert InvalidLifecycle();
        }
        if (baselineSeeded) revert BaselineAlreadySeeded();
        operation = 1;
        uint160 price = currentSqrtPriceX96();
        if (price == 0) poolManager.initialize(key, initialSqrtPriceX96);
        else if (price != initialSqrtPriceX96) revert InvalidInitialPrice();
        poolManager.unlock(abi.encode(uint8(1)));
        baselineSeeded = true;
        operation = 0;
    }

    function collectBaselineFees() external {
        if (operation != 0 || !baselineSeeded || vault.inventoryOperationActive()) revert InvalidLifecycle();
        operation = 2;
        poolManager.unlock(abi.encode(uint8(2)));
        operation = 0;
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        uint8 requestedOperation = abi.decode(data, (uint8));
        if (requestedOperation != operation || (operation != 1 && operation != 2)) revert InvalidLifecycle();
        if (operation == 1) {
            (uint256 amount0, uint256 amount1) =
                _requiredAmounts(initialSqrtPriceX96, baselineLower, baselineUpper, baselineLiquidity);
            if (
                amount0 > vault.availableInventory(vault.currency0())
                    || amount1 > vault.availableInventory(vault.currency1())
            ) {
                revert InsufficientInventory();
            }
            _modify(baselineLower, baselineUpper, int256(uint256(baselineLiquidity)), BASELINE_SALT);
            emit BaselineSeeded(baselineLiquidity, amount0, amount1);
        } else {
            _modify(baselineLower, baselineUpper, 0, BASELINE_SALT);
        }
        return bytes("");
    }

    /// @dev The pinned v4 release stores pools at mapping slot 6. Keep this assumption version-specific.
    function currentSqrtPriceX96() public view returns (uint160) {
        bytes32 slot = keccak256(abi.encode(PoolId.unwrap(poolId), uint256(6)));
        return uint160(uint256(poolManager.extsload(slot)));
    }

    function beforeInitialize(address, PoolKey calldata suppliedKey, uint160 price)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        _checkPool(suppliedKey);
        if (price != initialSqrtPriceX96) revert InvalidInitialPrice();
        return IHooks.beforeInitialize.selector;
    }

    function beforeSwap(
        address sender,
        PoolKey calldata suppliedKey,
        IPoolManager.SwapParams calldata params,
        bytes calldata hookData
    ) external onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        _checkPool(suppliedKey);
        if (!baselineSeeded) revert BaselineNotSeeded();
        if (operation != 0 || activeJITLiquidity != 0 || vault.inventoryOperationActive()) revert InvalidLifecycle();
        operation = 3;
        cycleContext = keccak256(abi.encode(sender, params, hookData));
        ++startedCycles;
        uint160 price = currentSqrtPriceX96();
        if (_eligible(params, price)) {
            (uint256 amount0, uint256 amount1) = _requiredAmounts(price, jitLower, jitUpper, jitLiquidity);
            if (
                amount0 <= maxJITAmount0 && amount1 <= maxJITAmount1
                    && amount0 <= vault.availableInventory(vault.currency0())
                    && amount1 <= vault.availableInventory(vault.currency1())
            ) {
                activeJITLiquidity = jitLiquidity;
                _modify(jitLower, jitUpper, int256(uint256(jitLiquidity)), JIT_SALT);
                ++jitCycles;
            }
        }
        emit SwapCycleStarted(startedCycles, sender, activeJITLiquidity);
        return (IHooks.beforeSwap.selector, BeforeSwapDelta.wrap(0), 0);
    }

    function afterSwap(
        address sender,
        PoolKey calldata suppliedKey,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) external onlyPoolManager returns (bytes4, int128) {
        _checkPool(suppliedKey);
        if (operation != 3 || cycleContext != keccak256(abi.encode(sender, params, hookData))) {
            revert InvalidLifecycle();
        }
        uint128 temporaryLiquidity = activeJITLiquidity;
        if (temporaryLiquidity != 0) {
            // v4 packs callerDelta into int128 per asset. Collect fees separately so they cannot
            // overflow when added to an otherwise representable principal withdrawal.
            _modify(jitLower, jitUpper, 0, JIT_SALT);
            _modify(jitLower, jitUpper, -int256(uint256(temporaryLiquidity)), JIT_SALT);
            activeJITLiquidity = 0;
        }
        // Harvest each cycle to prevent persistent-position fees accumulating beyond that limit.
        _modify(baselineLower, baselineUpper, 0, BASELINE_SALT);
        cycleContext = bytes32(0);
        operation = 0;
        ++completedCycles;
        emit SwapCycleCompleted(completedCycles, temporaryLiquidity, delta.amount0(), delta.amount1());
        return (IHooks.afterSwap.selector, 0);
    }

    function beforeAddLiquidity(
        address,
        PoolKey calldata suppliedKey,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external view onlyPoolManager returns (bytes4) {
        _checkPool(suppliedKey);
        revert ExternalLiquidityUnsupported();
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata suppliedKey,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external view onlyPoolManager returns (bytes4) {
        _checkPool(suppliedKey);
        revert ExternalLiquidityUnsupported();
    }

    function beforeDonate(address, PoolKey calldata suppliedKey, uint256, uint256, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        _checkPool(suppliedKey);
        revert DonationsUnsupported();
    }

    function _eligible(IPoolManager.SwapParams calldata params, uint160 price) private view returns (bool) {
        if (
            block.timestamp > validUntil || price <= TickMath.getSqrtPriceAtTick(jitLower)
                || price >= TickMath.getSqrtPriceAtTick(jitUpper) || params.amountSpecified == type(int256).min
        ) return false;
        uint256 specified = uint256(params.amountSpecified < 0 ? -params.amountSpecified : params.amountSpecified);
        bool specifiedIs0 = params.zeroForOne == (params.amountSpecified < 0);
        return specified >= (specifiedIs0 ? minSwapAmount0 : minSwapAmount1);
    }

    function _modify(int24 lower, int24 upper, int256 liquidityDelta, bytes32 salt) private {
        (BalanceDelta delta, BalanceDelta fees) = poolManager.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: lower, tickUpper: upper, liquidityDelta: liquidityDelta, salt: salt
            }),
            bytes("")
        );
        _settleCurrency(key.currency0, delta.amount0());
        _settleCurrency(key.currency1, delta.amount1());
        vault.recordFees(fees);
    }

    function _settleCurrency(Currency currency, int128 delta) private {
        if (delta > 0) {
            // Swapper input has not necessarily arrived yet. Mint claims instead of taking cash early.
            poolManager.mint(address(vault), uint256(uint160(Currency.unwrap(currency))), uint256(uint128(delta)));
        } else if (delta < 0) {
            address asset = Currency.unwrap(currency);
            uint256 debt = uint256(-int256(delta));
            if (debt > vault.availableInventory(asset)) revert InsufficientInventory();
            uint256 claims = vault.claimBalance(asset);
            uint256 burnAmount = claims < debt ? claims : debt;
            if (burnAmount != 0) poolManager.burn(address(vault), uint256(uint160(asset)), burnAmount);
            if (debt != burnAmount) vault.settleCurrency(asset, debt - burnAmount);
        }
    }

    function _requiredAmounts(uint160 price, int24 lower, int24 upper, uint128 liquidity)
        private
        pure
        returns (uint256 amount0, uint256 amount1)
    {
        uint160 lowerPrice = TickMath.getSqrtPriceAtTick(lower);
        uint160 upperPrice = TickMath.getSqrtPriceAtTick(upper);
        if (price <= lowerPrice) {
            amount0 = SqrtPriceMath.getAmount0Delta(lowerPrice, upperPrice, liquidity, true);
        } else if (price >= upperPrice) {
            amount1 = SqrtPriceMath.getAmount1Delta(lowerPrice, upperPrice, liquidity, true);
        } else {
            amount0 = SqrtPriceMath.getAmount0Delta(price, upperPrice, liquidity, true);
            amount1 = SqrtPriceMath.getAmount1Delta(lowerPrice, price, liquidity, true);
        }
    }

    function _checkPool(PoolKey calldata suppliedKey) private view {
        if (PoolId.unwrap(suppliedKey.toId()) != PoolId.unwrap(poolId)) revert WrongPool();
    }

    // These callbacks have no address permission bit and must never become an alternate entry point.
    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert UnsupportedCallback();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert UnsupportedCallback();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert UnsupportedCallback();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert UnsupportedCallback();
    }
}
