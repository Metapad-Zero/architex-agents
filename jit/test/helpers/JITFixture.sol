// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {ArchitexJITVault} from "../../src/ArchitexJITVault.sol";
import {ArchitexJITHook} from "../../src/ArchitexJITHook.sol";
import {ArchitexJITExecutor} from "../../src/ArchitexJITExecutor.sol";

/// @dev Freely minted test asset. A six-decimal instance is a USDC MODEL, never Arc native USDC.
contract JITTestToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public transferCallback;
    bytes public callbackData;
    bool public callbackSucceeded;
    bool public callbackAttempted;
    bool public failTransfers;
    uint16 public transferFeeBps;
    uint16 public senderFeeBps;
    address public callbackSender;
    bool private callingBack;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address recipient, uint256 amount) external {
        totalSupply += amount;
        balanceOf[recipient] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        return _transfer(msg.sender, recipient, amount);
    }

    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool) {
        uint256 permitted = allowance[sender][msg.sender];
        if (permitted != type(uint256).max) allowance[sender][msg.sender] = permitted - amount;
        return _transfer(sender, recipient, amount);
    }

    function configureTransfer(address target, bytes calldata data, bool fail, uint16 feeBps) external {
        require(feeBps <= 10_000, "invalid model fee");
        transferCallback = target;
        callbackData = data;
        failTransfers = fail;
        transferFeeBps = feeBps;
        callbackSucceeded = false;
        callbackAttempted = false;
    }

    function configureSenderFee(uint16 feeBps) external {
        require(feeBps <= 10_000, "invalid model sender fee");
        senderFeeBps = feeBps;
    }

    function setCallbackSender(address sender) external {
        callbackSender = sender;
    }

    function _transfer(address sender, address recipient, uint256 amount) private returns (bool) {
        if (failTransfers) return false;
        uint256 senderFee = amount * senderFeeBps / 10_000;
        balanceOf[sender] -= amount + senderFee;
        uint256 fee = amount * transferFeeBps / 10_000;
        balanceOf[recipient] += amount - fee;
        totalSupply -= fee + senderFee;
        if (
            transferCallback != address(0) && !callingBack && (callbackSender == address(0) || callbackSender == sender)
        ) {
            callingBack = true;
            callbackAttempted = true;
            (callbackSucceeded,) = transferCallback.call(callbackData);
            callingBack = false;
        }
        return true;
    }
}

/// @dev Independent test caller exercising arbitrary routers and multiple swaps in one unlock.
///      No production executor protections are assumed in these direct PoolManager paths.
contract JITDirectRouter is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    IPoolManager public immutable manager;
    bool private active;

    struct Call {
        address payer;
        PoolKey key;
        IPoolManager.SwapParams[] swaps;
        bytes hookData;
        uint256 donate0;
        uint256 donate1;
        bool modifyPosition;
        IPoolManager.ModifyLiquidityParams liquidity;
    }

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    function swap(PoolKey memory key, IPoolManager.SwapParams memory params) external returns (BalanceDelta delta) {
        IPoolManager.SwapParams[] memory swaps = new IPoolManager.SwapParams[](1);
        swaps[0] = params;
        Call memory request;
        request.payer = msg.sender;
        request.key = key;
        request.swaps = swaps;
        BalanceDelta[] memory deltas = _call(request);
        return deltas[0];
    }

    function swapMany(PoolKey memory key, IPoolManager.SwapParams[] memory swaps)
        external
        returns (BalanceDelta[] memory)
    {
        Call memory request;
        request.payer = msg.sender;
        request.key = key;
        request.swaps = swaps;
        return _call(request);
    }

    function donate(PoolKey memory key, uint256 amount0, uint256 amount1) external {
        Call memory request;
        request.payer = msg.sender;
        request.key = key;
        request.swaps = new IPoolManager.SwapParams[](0);
        request.donate0 = amount0;
        request.donate1 = amount1;
        _call(request);
    }

    function modifyLiquidity(PoolKey memory key, IPoolManager.ModifyLiquidityParams memory params) external {
        Call memory request;
        request.payer = msg.sender;
        request.key = key;
        request.swaps = new IPoolManager.SwapParams[](0);
        request.modifyPosition = true;
        request.liquidity = params;
        _call(request);
    }

    function _call(Call memory data) private returns (BalanceDelta[] memory) {
        require(!active, "test router reentry");
        active = true;
        bytes memory result = manager.unlock(abi.encode(data));
        active = false;
        return abi.decode(result, (BalanceDelta[]));
    }

    function unlockCallback(bytes calldata encoded) external returns (bytes memory) {
        require(msg.sender == address(manager) && active, "test callback authentication");
        Call memory data = abi.decode(encoded, (Call));
        BalanceDelta[] memory deltas = new BalanceDelta[](data.swaps.length);
        if (data.donate0 != 0 || data.donate1 != 0) {
            manager.donate(data.key, data.donate0, data.donate1, data.hookData);
        }
        if (data.modifyPosition) manager.modifyLiquidity(data.key, data.liquidity, data.hookData);
        for (uint256 i; i < data.swaps.length; ++i) {
            deltas[i] = manager.swap(data.key, data.swaps[i], data.hookData);
        }
        _settle(data.key.currency0, data.payer);
        _settle(data.key.currency1, data.payer);
        return abi.encode(deltas);
    }

    function _settle(Currency currency, address payer) private {
        int256 delta = manager.currencyDelta(address(this), currency);
        if (delta < 0) {
            manager.sync(currency);
            require(
                JITTestToken(Currency.unwrap(currency)).transferFrom(payer, address(manager), uint256(-delta)),
                "model transfer rejected"
            );
            manager.settle();
        } else if (delta > 0) {
            manager.take(currency, payer, uint256(delta));
        }
    }
}

library JITHookAddress {
    /// @dev Fixture-only mining. Reuse scratch memory so searching many salts cannot expand memory unboundedly.
    function mine(address deployer, bytes32 creationHash, uint160 flags) internal pure returns (bytes32 salt) {
        for (uint256 i; i < 300_000; ++i) {
            address predicted;
            assembly ("memory-safe") {
                let scratch := mload(0x40)
                mstore(scratch, shl(248, 0xff))
                mstore(add(scratch, 1), shl(96, deployer))
                mstore(add(scratch, 21), i)
                mstore(add(scratch, 53), creationHash)
                predicted := and(keccak256(scratch, 85), 0xffffffffffffffffffffffffffffffffffffffff)
            }
            if (uint160(predicted) & 0x3fff == flags) return bytes32(i);
        }
        revert("hook address mining limit");
    }
}

abstract contract JITFixture is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;

    uint24 internal constant POOL_FEE = 3_000;
    int24 internal constant SPACING = 60;
    uint128 internal constant BASELINE_LIQUIDITY = 1e17;
    uint128 internal constant JIT_LIQUIDITY = 2e18;
    uint160 internal constant HOOK_FLAGS = 0x2ae0;
    address internal constant FEE_RECIPIENT = address(0xFEE);
    address internal constant TRADER = address(0xA11CE);
    address internal constant SECOND_TRADER = address(0xB0B);
    bytes32 internal constant BASELINE_SALT = keccak256("ARCHITEX_BASELINE");
    bytes32 internal constant JIT_SALT = keccak256("ARCHITEX_JIT");

    IPoolManager internal manager;
    JITTestToken internal token;
    JITTestToken internal quote;
    JITTestToken internal asset0;
    JITTestToken internal asset1;
    uint256 internal unit0;
    uint256 internal unit1;
    ArchitexJITVault internal vault;
    ArchitexJITHook internal hook;
    ArchitexJITExecutor internal executor;
    JITDirectRouter internal directRouter;
    PoolKey internal key;
    PoolId internal poolId;
    ArchitexJITHook.Policy internal policy;

    function setUp() public virtual {
        _buildFixture(IPoolManager(address(new PoolManager(address(this)))), true, true);
    }

    function _buildFixture(IPoolManager manager_, bool enableJIT, bool fundJIT) internal {
        manager = manager_;
        token = new JITTestToken("Agent token TEST MODEL", "TEST", 18);
        quote = new JITTestToken("USDC TEST MODEL", "USDC_MODEL", 6);
        asset0 = address(token) < address(quote) ? token : quote;
        asset1 = address(token) < address(quote) ? quote : token;
        unit0 = 10 ** asset0.decimals();
        unit1 = 10 ** asset1.decimals();
        int24 initialTick = address(asset0) == address(token) ? int24(-276_360) : int24(276_360);
        policy = ArchitexJITHook.Policy({
            initialSqrtPriceX96: TickMath.getSqrtPriceAtTick(initialTick),
            baselineLower: initialTick - 60_000,
            baselineUpper: initialTick + 60_000,
            jitLower: initialTick - 600,
            jitUpper: initialTick + 600,
            baselineLiquidity: BASELINE_LIQUIDITY,
            jitLiquidity: JIT_LIQUIDITY,
            maxJITAmount0: uint128(200_000 * 10 ** asset0.decimals()),
            maxJITAmount1: uint128(200_000 * 10 ** asset1.decimals()),
            minSwapAmount0: enableJIT ? uint128(10 ** asset0.decimals() / 100) : type(uint128).max,
            minSwapAmount1: enableJIT ? uint128(10 ** asset1.decimals() / 100) : type(uint128).max,
            validUntil: uint64(block.timestamp + 1 days)
        });
        vault = new ArchitexJITVault(manager, address(token), address(quote), FEE_RECIPIENT);
        hook = _deployHook(vault, policy);
        vault.bindHook(address(hook));
        key = hook.getPoolKey();
        poolId = key.toId();
        directRouter = new JITDirectRouter(manager);
        _buildExecutor();
        _mintAndApprove(address(this));
        _mintAndApprove(TRADER);
        _mintAndApprove(SECOND_TRADER);
        uint256 amount0;
        uint256 amount1;
        if (fundJIT) {
            amount0 = 1_000_000 * 10 ** asset0.decimals();
            amount1 = 1_000_000 * 10 ** asset1.decimals();
        } else {
            (amount0, amount1) = _baselineAmounts();
        }
        asset0.approve(address(vault), type(uint256).max);
        asset1.approve(address(vault), type(uint256).max);
        vault.deposit(address(asset0), amount0);
        vault.deposit(address(asset1), amount1);
        hook.seedBaseline();
    }

    function _buildExecutor() internal {
        executor = new ArchitexJITExecutor(manager, hook);
    }

    function _mintAndApprove(address actor) internal {
        asset0.mint(actor, 10_000_000 * 10 ** asset0.decimals());
        asset1.mint(actor, 10_000_000 * 10 ** asset1.decimals());
        vm.startPrank(actor);
        asset0.approve(address(directRouter), type(uint256).max);
        asset1.approve(address(directRouter), type(uint256).max);
        asset0.approve(address(executor), type(uint256).max);
        asset1.approve(address(executor), type(uint256).max);
        vm.stopPrank();
    }

    function _deployHook(ArchitexJITVault vault_, ArchitexJITHook.Policy memory policy_)
        internal
        returns (ArchitexJITHook)
    {
        bytes memory creation = abi.encodePacked(
            type(ArchitexJITHook).creationCode, abi.encode(manager, vault_, POOL_FEE, SPACING, policy_)
        );
        bytes32 creationHash = keccak256(creation);
        bytes32 salt = JITHookAddress.mine(address(this), creationHash, HOOK_FLAGS);
        address deployed;
        assembly ("memory-safe") {
            deployed := create2(0, add(creation, 32), mload(creation), salt)
        }
        require(deployed != address(0), "hook CREATE2 failed");
        return ArchitexJITHook(deployed);
    }

    function _baselineAmounts() internal view returns (uint256 amount0, uint256 amount1) {
        amount0 = SqrtPriceMath.getAmount0Delta(
            policy.initialSqrtPriceX96, TickMath.getSqrtPriceAtTick(policy.baselineUpper), BASELINE_LIQUIDITY, true
        );
        amount1 = SqrtPriceMath.getAmount1Delta(
            TickMath.getSqrtPriceAtTick(policy.baselineLower), policy.initialSqrtPriceX96, BASELINE_LIQUIDITY, true
        );
    }

    function _params(bool zeroForOne, int256 specified) internal pure returns (IPoolManager.SwapParams memory) {
        return IPoolManager.SwapParams(
            zeroForOne, specified, zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        );
    }

    function _wholeInput(bool zeroForOne, uint256 whole) internal view returns (uint256) {
        return whole * (zeroForOne ? unit0 : unit1);
    }

    function _wholeOutput(bool zeroForOne, uint256 whole) internal view returns (uint256) {
        return whole * (zeroForOne ? unit1 : unit0);
    }

    function _directSwap(bool zeroForOne, int256 specified) internal returns (BalanceDelta) {
        vm.prank(TRADER);
        return directRouter.swap(key, _params(zeroForOne, specified));
    }

    function _request(bool zeroForOne, int256 specified)
        internal
        view
        returns (ArchitexJITExecutor.SwapRequest memory)
    {
        return ArchitexJITExecutor.SwapRequest({
            zeroForOne: zeroForOne,
            amountSpecified: specified,
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1,
            maximumInput: _wholeInput(zeroForOne, 1_000_000),
            minimumOutput: 1,
            recipient: TRADER,
            deadline: block.timestamp + 1 hours,
            allowPartialFill: false
        });
    }

    function _execute(bool zeroForOne, int256 specified) internal returns (uint256 amountIn, uint256 amountOut) {
        ArchitexJITExecutor.SwapRequest memory request = _request(zeroForOne, specified);
        vm.prank(TRADER);
        return executor.swap(request);
    }

    function _baselineLiquidity() internal view returns (uint128 liquidity) {
        (liquidity,,) =
            manager.getPositionInfo(poolId, address(hook), policy.baselineLower, policy.baselineUpper, BASELINE_SALT);
    }

    function _temporaryLiquidity() internal view returns (uint128 liquidity) {
        (liquidity,,) = manager.getPositionInfo(poolId, address(hook), policy.jitLower, policy.jitUpper, JIT_SALT);
    }

    function _assertRestingState() internal view {
        assertEq(hook.activeJITLiquidity(), 0, "temporary position remains active");
        assertEq(_temporaryLiquidity(), 0, "actual temporary position remains funded");
        assertEq(_baselineLiquidity(), policy.baselineLiquidity, "baseline depth changed");
        assertEq(hook.startedCycles(), hook.completedCycles(), "hook lifecycle incomplete");
        assertFalse(manager.isUnlocked(), "manager remains unlocked");
        assertEq(manager.getNonzeroDeltaCount(), 0, "unsettled currency delta");
        assertEq(manager.currencyDelta(address(hook), key.currency0), 0);
        assertEq(manager.currencyDelta(address(hook), key.currency1), 0);
        assertEq(manager.currencyDelta(address(vault), key.currency0), 0);
        assertEq(manager.currencyDelta(address(vault), key.currency1), 0);
        assertEq(manager.currencyDelta(address(executor), key.currency0), 0);
        assertEq(manager.currencyDelta(address(executor), key.currency1), 0);
        assertEq(vault.cashBalance(address(asset0)), asset0.balanceOf(address(vault)));
        assertEq(vault.cashBalance(address(asset1)), asset1.balanceOf(address(vault)));
        assertEq(vault.claimBalance(address(asset0)), manager.balanceOf(address(vault), uint160(address(asset0))));
        assertEq(vault.claimBalance(address(asset1)), manager.balanceOf(address(vault), uint160(address(asset1))));
    }

    function _assertTokenConservation() internal view {
        _assertTokenConservation(asset0);
        _assertTokenConservation(asset1);
    }

    function _assertTokenConservation(JITTestToken asset) internal view {
        uint256 observed = asset.balanceOf(address(this)) + asset.balanceOf(TRADER) + asset.balanceOf(SECOND_TRADER)
            + asset.balanceOf(FEE_RECIPIENT) + asset.balanceOf(address(manager)) + asset.balanceOf(address(vault))
            + asset.balanceOf(address(hook)) + asset.balanceOf(address(executor))
            + asset.balanceOf(address(directRouter));
        assertEq(observed, asset.totalSupply(), "model token supply not conserved");
    }
}

interface IJITNativeUSDC {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @notice Read-only Arc eth_call state-override harness; it never broadcasts or uses Foundry cheatcodes.
/// @dev Its launch token is a freely minted MODEL. USDC and PoolManager are actual Arc contracts.
///      State-overridden native balances are synthetic capital, not funded acceptance evidence.
contract ArcNativeJITSimulation {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    using TransientStateLibrary for IPoolManager;

    address public constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    address public constant ARC_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address public constant FEE_RECIPIENT = address(0xFEE);

    struct Result {
        address modelToken;
        address vault;
        address hook;
        address executor;
        uint256 firstInput;
        uint256 firstOutput;
        uint256 firstExecutionGas;
        uint256 secondInput;
        uint256 secondOutput;
        uint256 secondExecutionGas;
        // These balances are measured before fee payouts; postClaim fields are separate.
        uint256 tokenCash;
        uint256 tokenClaims;
        uint256 usdcCash;
        uint256 usdcClaims;
        uint256 tokenFees;
        uint256 usdcFees;
        uint256 tokenFeesClaimed;
        uint256 usdcFeesClaimed;
        uint256 postClaimTokenCash;
        uint256 postClaimTokenClaims;
        uint256 postClaimUSDCCash;
        uint256 postClaimUSDCClaims;
        uint256 completedJITCycles;
        uint256 activeJITLiquidity;
        uint256 baselineLiquidity;
        uint256 openDeltas;
    }

    function hookCreationCode(address modelToken, address vault_, uint64 validUntil)
        external
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            type(ArchitexJITHook).creationCode,
            abi.encode(
                IPoolManager(ARC_MANAGER),
                ArchitexJITVault(vault_),
                uint24(3_000),
                int24(60),
                _policy(modelToken, validUntil)
            )
        );
    }

    /// @dev Fresh overridden helper account: first CREATE is model token, second CREATE is vault.
    ///      The supplied salt must make the subsequent CREATE2 hook's low bits equal 0x2ae0.
    function run(bytes32 hookSalt, uint64 validUntil) external returns (Result memory result) {
        require(block.chainid == 5042, "Arc mainnet execution required");
        IPoolManager manager_ = IPoolManager(ARC_MANAGER);
        JITTestToken model = new JITTestToken("Agent token ARC SIMULATION MODEL", "MODEL", 18);
        ArchitexJITVault vault_ = new ArchitexJITVault(manager_, address(model), ARC_USDC, FEE_RECIPIENT);
        ArchitexJITHook.Policy memory p = _policy(address(model), validUntil);
        ArchitexJITHook hook_ = new ArchitexJITHook{salt: hookSalt}(manager_, vault_, 3_000, 60, p);
        vault_.bindHook(address(hook_));
        ArchitexJITExecutor executor_ = new ArchitexJITExecutor(manager_, hook_);
        model.mint(address(this), 10_000_000e18);
        model.approve(address(vault_), type(uint256).max);
        require(IJITNativeUSDC(ARC_USDC).approve(address(vault_), type(uint256).max), "native approve vault");
        vault_.deposit(address(model), 1_000_000e18);
        vault_.deposit(ARC_USDC, 1_000_000e6);
        hook_.seedBaseline();
        model.approve(address(executor_), type(uint256).max);
        require(IJITNativeUSDC(ARC_USDC).approve(address(executor_), type(uint256).max), "native approve executor");
        bool tokenIs0 = address(model) < ARC_USDC;
        uint256 gasBefore = gasleft();
        (result.firstInput, result.firstOutput) = executor_.swap(_request(true, tokenIs0 ? 1_000e18 : 1_000e6));
        result.firstExecutionGas = gasBefore - gasleft();
        gasBefore = gasleft();
        (result.secondInput, result.secondOutput) = executor_.swap(_request(false, tokenIs0 ? 1_000e6 : 1_000e18));
        result.secondExecutionGas = gasBefore - gasleft();
        result.modelToken = address(model);
        result.vault = address(vault_);
        result.hook = address(hook_);
        result.executor = address(executor_);
        result.tokenCash = vault_.cashBalance(address(model));
        result.tokenClaims = vault_.claimBalance(address(model));
        result.usdcCash = vault_.cashBalance(ARC_USDC);
        result.usdcClaims = vault_.claimBalance(ARC_USDC);
        result.tokenFees = vault_.feeCredits(address(model));
        result.usdcFees = vault_.feeCredits(ARC_USDC);
        uint256 tokenInventory = vault_.availableInventory(address(model));
        uint256 usdcInventory = vault_.availableInventory(ARC_USDC);
        if (result.tokenFees != 0) vault_.claimFees(address(model), result.tokenFees);
        if (result.usdcFees != 0) vault_.claimFees(ARC_USDC, result.usdcFees);
        result.tokenFeesClaimed = vault_.feesClaimed(address(model));
        result.usdcFeesClaimed = vault_.feesClaimed(ARC_USDC);
        result.postClaimTokenCash = vault_.cashBalance(address(model));
        result.postClaimTokenClaims = vault_.claimBalance(address(model));
        result.postClaimUSDCCash = vault_.cashBalance(ARC_USDC);
        result.postClaimUSDCClaims = vault_.claimBalance(ARC_USDC);
        require(
            vault_.availableInventory(address(model)) == tokenInventory
                && vault_.availableInventory(ARC_USDC) == usdcInventory,
            "native fee claim consumed inventory"
        );
        require(
            result.postClaimTokenCash + result.postClaimTokenClaims
                == result.tokenCash + result.tokenClaims - result.tokenFees,
            "native model asset reconciliation failed"
        );
        require(
            result.postClaimUSDCCash + result.postClaimUSDCClaims
                == result.usdcCash + result.usdcClaims - result.usdcFees,
            "native USDC reconciliation failed"
        );
        result.completedJITCycles = hook_.jitCycles();
        result.activeJITLiquidity = hook_.activeJITLiquidity();
        (uint128 baseline,,) = manager_.getPositionInfo(
            hook_.getPoolKey().toId(), address(hook_), p.baselineLower, p.baselineUpper, keccak256("ARCHITEX_BASELINE")
        );
        result.baselineLiquidity = baseline;
        result.openDeltas = manager_.getNonzeroDeltaCount();
        require(
            result.firstInput != 0 && result.firstOutput != 0 && result.secondInput != 0 && result.secondOutput != 0,
            "native simulation fill missing"
        );
        require(
            result.activeJITLiquidity == 0 && baseline == p.baselineLiquidity && result.openDeltas == 0,
            "native simulation unsettled"
        );
        require(
            vault_.feeCredits(address(model)) == 0 && vault_.feeCredits(ARC_USDC) == 0,
            "native simulation fee claim incomplete"
        );
        require(
            vault_.principalDeposited(address(model)) == 1_000_000e18
                && vault_.principalDeposited(ARC_USDC) == 1_000_000e6,
            "native simulation principal changed on fee claim"
        );
    }

    function _policy(address modelToken, uint64 validUntil) private pure returns (ArchitexJITHook.Policy memory) {
        bool tokenIs0 = modelToken < ARC_USDC;
        int24 tick = tokenIs0 ? int24(-276_360) : int24(276_360);
        return ArchitexJITHook.Policy({
            initialSqrtPriceX96: TickMath.getSqrtPriceAtTick(tick),
            baselineLower: tick - 60_000,
            baselineUpper: tick + 60_000,
            jitLower: tick - 600,
            jitUpper: tick + 600,
            baselineLiquidity: 1e17,
            jitLiquidity: 2e18,
            maxJITAmount0: tokenIs0 ? uint128(200_000e18) : uint128(200_000e6),
            maxJITAmount1: tokenIs0 ? uint128(200_000e6) : uint128(200_000e18),
            minSwapAmount0: tokenIs0 ? uint128(1e16) : uint128(1e4),
            minSwapAmount1: tokenIs0 ? uint128(1e4) : uint128(1e16),
            validUntil: validUntil
        });
    }

    function _request(bool zeroForOne, uint256 input) private view returns (ArchitexJITExecutor.SwapRequest memory) {
        return ArchitexJITExecutor.SwapRequest({
            zeroForOne: zeroForOne,
            amountSpecified: -int256(input),
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1,
            maximumInput: input,
            minimumOutput: 1,
            recipient: address(this),
            deadline: block.timestamp + 1 hours,
            allowPartialFill: false
        });
    }
}
