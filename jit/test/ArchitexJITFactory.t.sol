// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {ArchitexJITFactory} from "../src/ArchitexJITFactory.sol";
import {ArchitexJITToken} from "../src/ArchitexJITToken.sol";
import {ArchitexJITHookDeployer} from "../src/ArchitexJITHookDeployer.sol";
import {ArchitexJITVault} from "../src/ArchitexJITVault.sol";
import {ArchitexJITHook} from "../src/ArchitexJITHook.sol";
import {ArchitexJITExecutor} from "../src/ArchitexJITExecutor.sol";
import {JITTestToken} from "./helpers/JITFixture.sol";

/// @dev Shared fixture also used against the untouched deployed Arc manager and native USDC.
abstract contract JITFactoryFixture is Test {
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;

    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant SECOND_CREATOR = address(0xB0B);
    address internal constant FEE_RECIPIENT = address(0xFEE);
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant SEED_USDC = 200_000e6;
    bytes32 internal constant CREATOR_NONCE = keccak256("approved direct JIT release");
    bytes32 private constant HOOK_DOMAIN = keccak256("ARCHITEX_JIT_HOOK");

    IPoolManager internal manager;
    IERC20 internal quote;
    ArchitexJITHookDeployer internal deployer;
    ArchitexJITFactory internal factory;
    ArchitexJITFactory.LaunchConfig internal config;

    function _buildFactory(IPoolManager manager_, IERC20 quote_) internal {
        manager = manager_;
        quote = quote_;
        deployer = new ArchitexJITHookDeployer(manager);
        factory = new ArchitexJITFactory(manager, address(quote), deployer);
        config = _config(CREATOR, CREATOR_NONCE);
        config.hookSaltNonce = _mine(CREATOR, config);
    }

    function _config(address creator, bytes32 nonce) internal view returns (ArchitexJITFactory.LaunchConfig memory c) {
        c.name = "Direct JIT test launch";
        c.symbol = "JITTEST";
        c.metadataURI = "ipfs://factory-regression-fixture";
        c.seedUSDC = SEED_USDC;
        c.feeRecipient = FEE_RECIPIENT;
        c.poolFee = 3_000;
        c.tickSpacing = 60;
        c.creatorNonce = nonce;
        c.deadline = uint64(block.timestamp + 1 hours);
        // Supply and capital are artificial test values; this is not a recommended opening valuation.
        address predictedToken = factory.predictLaunch(creator, c).token;
        bool tokenIs0 = predictedToken < address(quote);
        int24 tick = tokenIs0 ? int24(-276_360) : int24(276_360);
        c.policy = ArchitexJITHook.Policy({
            initialSqrtPriceX96: TickMath.getSqrtPriceAtTick(tick),
            baselineLower: tick - 60_000,
            baselineUpper: tick + 60_000,
            jitLower: tick - 600,
            jitUpper: tick + 600,
            baselineLiquidity: 1e17,
            jitLiquidity: 2e18,
            maxJITAmount0: uint128(tokenIs0 ? SUPPLY : SEED_USDC),
            maxJITAmount1: uint128(tokenIs0 ? SEED_USDC : SUPPLY),
            minSwapAmount0: uint128(tokenIs0 ? 1e16 : 1e4),
            minSwapAmount1: uint128(tokenIs0 ? 1e4 : 1e16),
            validUntil: type(uint64).max
        });
    }

    /// @dev Independent CREATE2 address mining, without a production on-chain search or memory expansion.
    function _mine(address creator, ArchitexJITFactory.LaunchConfig memory c) internal view returns (uint256) {
        ArchitexJITFactory.LaunchPrediction memory p = factory.predictLaunch(creator, c);
        bytes32 domain = HOOK_DOMAIN;
        bytes32 id = p.launchId;
        bytes32 initHash = p.hookInitCodeHash;
        address deploying = address(deployer);
        for (uint256 nonce; nonce < 300_000; ++nonce) {
            address predicted;
            assembly ("memory-safe") {
                let scratch := mload(0x40)
                mstore(scratch, domain)
                mstore(add(scratch, 32), id)
                mstore(add(scratch, 64), nonce)
                let salt := keccak256(scratch, 96)
                mstore(scratch, shl(248, 0xff))
                mstore(add(scratch, 1), shl(96, deploying))
                mstore(add(scratch, 21), salt)
                mstore(add(scratch, 53), initHash)
                predicted := and(keccak256(scratch, 85), 0xffffffffffffffffffffffffffffffffffffffff)
            }
            if ((uint160(predicted) & 0x3fff) == 0x2ae0) return nonce;
        }
        revert("factory fixture mining limit");
    }

    function _launch(address creator, ArchitexJITFactory.LaunchConfig memory c)
        internal
        returns (ArchitexJITFactory.LaunchRecord memory record)
    {
        vm.startPrank(creator);
        quote.approve(address(factory), c.seedUSDC);
        record = factory.launch(c);
        vm.stopPrank();
    }

    function _amounts(ArchitexJITFactory.LaunchConfig memory c, bool temporary)
        internal
        pure
        returns (uint256 amount0, uint256 amount1)
    {
        int24 lower = temporary ? c.policy.jitLower : c.policy.baselineLower;
        int24 upper = temporary ? c.policy.jitUpper : c.policy.baselineUpper;
        uint128 liquidity = temporary ? c.policy.jitLiquidity : c.policy.baselineLiquidity;
        amount0 = SqrtPriceMath.getAmount0Delta(
            c.policy.initialSqrtPriceX96, TickMath.getSqrtPriceAtTick(upper), liquidity, true
        );
        amount1 = SqrtPriceMath.getAmount1Delta(
            TickMath.getSqrtPriceAtTick(lower), c.policy.initialSqrtPriceX96, liquidity, true
        );
    }

    function _assertResting(ArchitexJITFactory.LaunchRecord memory record) internal view {
        ArchitexJITHook hook = ArchitexJITHook(record.hook);
        assertEq(hook.activeJITLiquidity(), 0);
        assertTrue(hook.baselineSeeded());
        (uint128 baseline,,) = manager.getPositionInfo(
            PoolId.wrap(record.poolId), record.hook, hook.baselineLower(), hook.baselineUpper(), hook.BASELINE_SALT()
        );
        (uint128 temporary,,) = manager.getPositionInfo(
            PoolId.wrap(record.poolId), record.hook, hook.jitLower(), hook.jitUpper(), hook.JIT_SALT()
        );
        assertEq(baseline, config.policy.baselineLiquidity);
        assertEq(temporary, 0);
        assertEq(manager.currencyDelta(record.hook, hook.getPoolKey().currency0), 0);
        assertEq(manager.currencyDelta(record.hook, hook.getPoolKey().currency1), 0);
        assertEq(manager.getNonzeroDeltaCount(), 0);
    }

    function _swap(ArchitexJITFactory.LaunchRecord memory record, bool quoteInput, uint256 input)
        internal
        returns (uint256 amountIn, uint256 amountOut)
    {
        ArchitexJITHook hook = ArchitexJITHook(record.hook);
        ArchitexJITExecutor executor = ArchitexJITExecutor(record.executor);
        bool zeroForOne = quoteInput ? address(quote) < record.token : record.token < address(quote);
        IERC20 inputAsset = quoteInput ? quote : IERC20(record.token);
        vm.startPrank(CREATOR);
        inputAsset.approve(record.executor, input);
        (amountIn, amountOut) = executor.swap(
            ArchitexJITExecutor.SwapRequest({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(input),
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(
                    zeroForOne ? hook.jitLower() + 60 : hook.jitUpper() - 60
                ),
                maximumInput: input,
                minimumOutput: 1,
                recipient: CREATOR,
                deadline: block.timestamp + 1 hours,
                allowPartialFill: false
            })
        );
        vm.stopPrank();
        assertEq(amountIn, input);
        assertGt(amountOut, 0);
    }

    function _assertRollback(ArchitexJITFactory.LaunchPrediction memory p, uint256 creatorBalance) internal view {
        assertEq(p.token.code.length, 0);
        assertEq(p.vault.code.length, 0);
        assertEq(p.hook.code.length, 0);
        assertEq(p.executor.code.length, 0);
        assertEq(quote.balanceOf(CREATOR), creatorBalance);
        assertEq(factory.launchesLength(), 0);
        assertFalse(factory.usedNonce(CREATOR, config.creatorNonce));
    }
}

contract LookalikeHookDeployer {
    IPoolManager public poolManager;

    constructor(IPoolManager manager) {
        poolManager = manager;
    }
}

contract ArchitexJITFactoryTest is JITFactoryFixture {
    JITTestToken private modelQuote;

    function setUp() public {
        modelQuote = new JITTestToken("USDC TEST MODEL", "USDC_MODEL", 6);
        modelQuote.mint(CREATOR, 1_000_000e6);
        modelQuote.mint(SECOND_CREATOR, 1_000_000e6);
        _buildFactory(IPoolManager(address(new PoolManager(address(this)))), IERC20(address(modelQuote)));
    }

    function test_factoryAuthenticatesExactDeployerAndQuoteDecimals() public {
        LookalikeHookDeployer lookalike = new LookalikeHookDeployer(manager);
        vm.expectRevert(ArchitexJITFactory.InvalidConfiguration.selector);
        new ArchitexJITFactory(manager, address(quote), ArchitexJITHookDeployer(address(lookalike)));
        JITTestToken wrongDecimals = new JITTestToken("wrong", "WRONG", 18);
        vm.expectRevert(ArchitexJITFactory.InvalidConfiguration.selector);
        new ArchitexJITFactory(manager, address(wrongDecimals), deployer);
        IPoolManager other = IPoolManager(address(new PoolManager(address(this))));
        vm.expectRevert(ArchitexJITFactory.InvalidConfiguration.selector);
        new ArchitexJITFactory(other, address(quote), deployer);
    }

    function test_predictionMatchesRegistryAndFullLaunchEvent() public {
        ArchitexJITFactory.LaunchPrediction memory predicted = factory.predictLaunch(CREATOR, config);
        assertEq(predicted.launchId, keccak256(abi.encode(CREATOR, CREATOR_NONCE)));
        assertEq(predicted.configHash, keccak256(abi.encode(config)));
        assertEq(uint160(predicted.hook) & 0x3fff, 0x2ae0);
        vm.recordLogs();
        ArchitexJITFactory.LaunchRecord memory record = _launch(CREATOR, config);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic =
            keccak256("LaunchCreated(bytes32,address,address,address,address,address,bytes32,bytes32,uint256,string)");
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(factory) || logs[i].topics[0] != topic) continue;
            assertEq(logs[i].topics[1], predicted.launchId);
            assertEq(address(uint160(uint256(logs[i].topics[2]))), CREATOR);
            assertEq(address(uint160(uint256(logs[i].topics[3]))), predicted.token);
            (
                address vault_,
                address hook_,
                address executor_,
                bytes32 pool_,
                bytes32 hash_,
                uint256 seed_,
                string memory uri_
            ) = abi.decode(logs[i].data, (address, address, address, bytes32, bytes32, uint256, string));
            assertEq(vault_, predicted.vault);
            assertEq(hook_, predicted.hook);
            assertEq(executor_, predicted.executor);
            assertEq(pool_, record.poolId);
            assertEq(hash_, predicted.configHash);
            assertEq(seed_, config.seedUSDC);
            assertEq(uri_, config.metadataURI);
            found = true;
        }
        assertTrue(found, "durable launch event required");
        assertEq(record.creator, CREATOR);
        assertEq(record.token, predicted.token);
        assertEq(record.vault, predicted.vault);
        assertEq(record.hook, predicted.hook);
        assertEq(record.executor, predicted.executor);
        assertEq(factory.launchIdAt(0), predicted.launchId);
        assertEq(factory.launchIdOfToken(record.token), predicted.launchId);
        assertEq(factory.getLaunch(predicted.launchId).configHash, predicted.configHash);
        assertTrue(factory.usedNonce(CREATOR, CREATOR_NONCE));
        assertEq(factory.launchesLength(), 1);
    }

    function test_entireFixedSupplyAndSeedEnterBoundEngineWithoutCreatorAllocation() public {
        uint256 beforeBalance = quote.balanceOf(CREATOR);
        ArchitexJITFactory.LaunchRecord memory record = _launch(CREATOR, config);
        ArchitexJITToken token = ArchitexJITToken(record.token);
        ArchitexJITVault vault = ArchitexJITVault(record.vault);
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.decimals(), 18);
        assertEq(token.balanceOf(CREATOR), 0);
        assertEq(token.balanceOf(address(factory)), 0);
        assertEq(quote.balanceOf(address(factory)), 0);
        assertEq(quote.balanceOf(CREATOR), beforeBalance - config.seedUSDC);
        assertEq(vault.principalDeposited(record.token), SUPPLY);
        assertEq(vault.principalDeposited(address(quote)), config.seedUSDC);
        assertEq(token.balanceOf(record.vault) + token.balanceOf(address(manager)), SUPPLY);
        assertEq(vault.hook(), record.hook);
        assertEq(vault.feeRecipient(), FEE_RECIPIENT);
        assertEq(ArchitexJITHook(record.hook).validUntil(), type(uint64).max);
        assertEq(quote.allowance(CREATOR, address(factory)), 0);
        assertEq(quote.allowance(address(factory), record.vault), 0);
        assertEq(token.allowance(address(factory), record.vault), 0);
        vm.expectRevert(ArchitexJITVault.Unauthorized.selector);
        vault.bindHook(address(deployer));
        (bool mintSucceeded,) = record.token.call(abi.encodeWithSignature("mint(address,uint256)", CREATOR, 1));
        assertFalse(mintSucceeded);
        _assertResting(record);
    }

    function test_firstBuyAndSellUseTemporaryLiquidityAndDeliverOnlyAccruedFees() public {
        ArchitexJITFactory.LaunchRecord memory record = _launch(CREATOR, config);
        (, uint256 bought) = _swap(record, true, 1_000e6);
        _swap(record, false, bought / 2);
        ArchitexJITVault vault = ArchitexJITVault(record.vault);
        ArchitexJITHook hook = ArchitexJITHook(record.hook);
        assertEq(hook.jitCycles(), 2);
        assertEq(hook.completedCycles(), 2);
        for (uint256 i; i < 2; ++i) {
            address asset = i == 0 ? record.token : address(quote);
            uint256 principalBefore = vault.availableInventory(asset);
            uint256 credit = vault.feeCredits(asset);
            uint256 recipientBefore = IERC20(asset).balanceOf(FEE_RECIPIENT);
            assertGt(credit, 0);
            vault.claimFees(asset, credit);
            assertEq(IERC20(asset).balanceOf(FEE_RECIPIENT), recipientBefore + credit);
            assertEq(vault.availableInventory(asset), principalBefore);
            assertEq(vault.feeCredits(asset), 0);
        }
        assertEq(
            IERC20(record.token).balanceOf(record.vault) + IERC20(record.token).balanceOf(address(manager))
                + IERC20(record.token).balanceOf(CREATOR) + IERC20(record.token).balanceOf(FEE_RECIPIENT),
            SUPPLY
        );
        _assertResting(record);
    }

    function test_nonceCannotBeReusedEvenForChangedConfig() public {
        _launch(CREATOR, config);
        config.name = "Different token";
        vm.prank(CREATOR);
        vm.expectRevert(ArchitexJITFactory.NonceAlreadyUsed.selector);
        factory.launch(config);
        assertEq(factory.launchesLength(), 1);
    }

    function test_sameNonceForDifferentCreatorsIsIsolated() public {
        ArchitexJITFactory.LaunchPrediction memory first = factory.predictLaunch(CREATOR, config);
        ArchitexJITFactory.LaunchConfig memory secondConfig = _config(SECOND_CREATOR, CREATOR_NONCE);
        secondConfig.hookSaltNonce = _mine(SECOND_CREATOR, secondConfig);
        ArchitexJITFactory.LaunchPrediction memory second = factory.predictLaunch(SECOND_CREATOR, secondConfig);
        assertTrue(first.launchId != second.launchId);
        assertTrue(first.token != second.token && first.vault != second.vault && first.hook != second.hook);
        _launch(SECOND_CREATOR, secondConfig);
        assertFalse(factory.usedNonce(CREATOR, CREATOR_NONCE));
        ArchitexJITFactory.LaunchRecord memory record = _launch(CREATOR, config);
        assertEq(record.token, first.token);
        assertEq(factory.launchesLength(), 2);
    }

    function test_copiedLaunchCannotConsumeCreatorsNonceOrPredictedContracts() public {
        ArchitexJITFactory.LaunchPrediction memory expected = factory.predictLaunch(CREATOR, config);
        vm.startPrank(SECOND_CREATOR);
        quote.approve(address(factory), config.seedUSDC);
        // Copied calldata may fail its hook-address/capital checks, or create a different caller's pool.
        // Neither outcome can consume the original creator's nonce or deploy their predicted contracts.
        (bool copiedLaunched,) = address(factory).call(abi.encodeCall(factory.launch, (config)));
        vm.stopPrank();
        if (copiedLaunched) assertTrue(factory.usedNonce(SECOND_CREATOR, CREATOR_NONCE));
        assertFalse(factory.usedNonce(CREATOR, CREATOR_NONCE));
        assertEq(expected.token.code.length, 0);
        assertEq(expected.vault.code.length, 0);
        assertEq(expected.hook.code.length, 0);
        ArchitexJITFactory.LaunchRecord memory record = _launch(CREATOR, config);
        assertEq(record.token, expected.token);
    }

    function test_outsiderCannotDeployHookBeforeAtomicFactoryCreatesVault() public {
        ArchitexJITFactory.LaunchPrediction memory expected = factory.predictLaunch(CREATOR, config);
        bytes32 salt = factory.hookSalt(expected.launchId, config.hookSaltNonce);
        vm.prank(SECOND_CREATOR);
        vm.expectRevert(ArchitexJITHook.InvalidConfiguration.selector);
        deployer.deploy(salt, ArchitexJITVault(expected.vault), config.poolFee, config.tickSpacing, config.policy);
        assertEq(expected.hook.code.length, 0);
        ArchitexJITFactory.LaunchRecord memory record = _launch(CREATOR, config);
        assertEq(record.hook, expected.hook);
    }

    function test_hookMiningDoesNotChangeTokenOrVaultPrediction() public view {
        ArchitexJITFactory.LaunchConfig memory other = config;
        other.hookSaltNonce += 1;
        ArchitexJITFactory.LaunchPrediction memory first = factory.predictLaunch(CREATOR, config);
        ArchitexJITFactory.LaunchPrediction memory second = factory.predictLaunch(CREATOR, other);
        assertEq(first.token, second.token);
        assertEq(first.vault, second.vault);
        assertEq(first.hookInitCodeHash, second.hookInitCodeHash);
        assertTrue(first.hook != second.hook);
        assertTrue(first.executor != second.executor);
        assertTrue(first.configHash != second.configHash);
    }

    function test_metadataAndDeadlineAreIncludedInConfigHash() public view {
        bytes32 original = factory.configHash(config);
        ArchitexJITFactory.LaunchConfig memory other = config;
        other.metadataURI = "ipfs://changed";
        assertTrue(factory.configHash(other) != original);
        other = config;
        other.deadline -= 1;
        assertTrue(factory.configHash(other) != original);
    }

    function test_launchWithoutMetadataUploadIsSupported() public {
        config.metadataURI = "";
        ArchitexJITFactory.LaunchRecord memory record = _launch(CREATOR, config);
        assertEq(record.configHash, factory.configHash(config));
        assertEq(factory.launchesLength(), 1);
    }

    function test_expiredLaunchRollsBackBeforeCapitalMoves() public {
        vm.warp(uint256(config.deadline) + 1);
        _expectRollback(ArchitexJITFactory.DeadlineExpired.selector);
    }

    function test_zeroSeedAndUnsupportedTermsAreRejected() public {
        config.seedUSDC = 0;
        _expectRollback(ArchitexJITFactory.InvalidLaunch.selector);
        config.seedUSDC = SEED_USDC;
        config.poolFee = 7_000;
        _expectRollback(ArchitexJITFactory.InvalidLaunch.selector);
        config.poolFee = 3_000;
        config.tickSpacing = 10;
        _expectRollback(ArchitexJITFactory.InvalidLaunch.selector);
    }

    function test_finitePolicyExpiryIsRejected() public {
        config.policy.validUntil = uint64(block.timestamp + 365 days);
        _expectRollback(ArchitexJITFactory.InvalidLaunch.selector);
    }

    function test_metadataAndRecipientLimitsAreEnforced() public {
        config.name = "";
        _expectRollback(ArchitexJITFactory.InvalidLaunch.selector);
        config.name = "012345678901234567890123456789012";
        config.symbol = "01234567890";
        _expectRollback(ArchitexJITFactory.InvalidLaunch.selector);
        config.symbol = "JITTEST";
        config.metadataURI = string(new bytes(257));
        _expectRollback(ArchitexJITFactory.InvalidLaunch.selector);
        config.metadataURI = "ipfs://fixture";
        config.feeRecipient = address(0);
        _expectRollback(ArchitexJITFactory.InvalidLaunch.selector);
        config.feeRecipient = address(factory);
        _expectRollback(ArchitexJITFactory.InvalidLaunch.selector);
    }

    function test_feeRecipientCannotBeTheNewToken() public {
        config.feeRecipient = factory.predictLaunch(CREATOR, config).token;
        config.hookSaltNonce = _mine(CREATOR, config);
        _expectRollback(ArchitexJITFactory.InvalidLaunch.selector);
    }

    function test_underfundingJITDespiteSufficientBaselineRollsEverythingBack() public {
        (uint256 baseline0, uint256 baseline1) = _amounts(config, false);
        (uint256 jit0, uint256 jit1) = _amounts(config, true);
        bool quoteIs0 = address(quote) < factory.predictLaunch(CREATOR, config).token;
        uint256 baselineQuote = quoteIs0 ? baseline0 : baseline1;
        uint256 jitQuote = quoteIs0 ? jit0 : jit1;
        config.seedUSDC = baselineQuote + jitQuote - 1;
        assertGe(config.seedUSDC, baselineQuote);
        _expectRollback(ArchitexJITFactory.InsufficientInitialCapital.selector);
    }

    function test_initialJITMustFitItsBudget() public {
        (uint256 jit0,) = _amounts(config, true);
        config.policy.maxJITAmount0 = uint128(jit0 - 1);
        config.hookSaltNonce = _mine(CREATOR, config);
        _expectRollback(ArchitexJITFactory.InsufficientInitialCapital.selector);
    }

    function test_inadequateAllowanceRollsBackDeploymentsAndNonce() public {
        ArchitexJITFactory.LaunchPrediction memory predicted = factory.predictLaunch(CREATOR, config);
        uint256 beforeBalance = quote.balanceOf(CREATOR);
        vm.prank(CREATOR);
        quote.approve(address(factory), config.seedUSDC - 1);
        vm.prank(CREATOR);
        vm.expectRevert();
        factory.launch(config);
        _assertRollback(predicted, beforeBalance);
    }

    function test_receiverChargingQuoteIsRejectedAtomically() public {
        modelQuote.configureTransfer(address(0), "", false, 100);
        _expectRollback(ArchitexJITFactory.TransferMismatch.selector);
    }

    function test_senderChargingQuoteIsRejectedAtomically() public {
        modelQuote.configureSenderFee(100);
        _expectRollback(ArchitexJITFactory.TransferMismatch.selector);
    }

    function test_failedQuoteTransferRollsBackEverything() public {
        modelQuote.configureTransfer(address(0), "", true, 0);
        ArchitexJITFactory.LaunchPrediction memory predicted = factory.predictLaunch(CREATOR, config);
        uint256 beforeBalance = quote.balanceOf(CREATOR);
        vm.prank(CREATOR);
        quote.approve(address(factory), config.seedUSDC);
        vm.prank(CREATOR);
        vm.expectRevert();
        factory.launch(config);
        _assertRollback(predicted, beforeBalance);
    }

    function test_quoteCallbackCannotReenterLaunch() public {
        modelQuote.configureTransfer(address(factory), abi.encodeCall(factory.launch, (config)), false, 0);
        modelQuote.setCallbackSender(CREATOR);
        _launch(CREATOR, config);
        assertTrue(modelQuote.callbackAttempted());
        assertFalse(modelQuote.callbackSucceeded());
        assertEq(factory.launchesLength(), 1);
    }

    function test_unsolicitedFactoryQuoteIsNotSpentByLaunch() public {
        modelQuote.mint(address(factory), 123e6);
        _launch(CREATOR, config);
        assertEq(quote.balanceOf(address(factory)), 123e6);
    }

    function test_unminedHookAddressRevertsWithoutCapitalOrCode() public {
        config.hookSaltNonce = 0;
        if ((uint160(factory.predictLaunch(CREATOR, config).hook) & 0x3fff) == 0x2ae0) config.hookSaltNonce = 1;
        _expectRollback(ArchitexJITFactory.InvalidHookAddress.selector);
    }

    function test_unknownRegistryRecordIsExplicitAndModuleSizesAreDeployable() public {
        vm.expectRevert(ArchitexJITFactory.UnknownLaunch.selector);
        factory.getLaunch(keccak256("unknown launch"));
        assertLe(address(factory).code.length, 24_576);
        assertLe(address(deployer).code.length, 24_576);
        assertLe(type(ArchitexJITFactory).creationCode.length + 96, 49_152);
        assertLe(type(ArchitexJITHookDeployer).creationCode.length + 32, 49_152);
    }

    function _expectRollback(bytes4 selector) private {
        ArchitexJITFactory.LaunchPrediction memory predicted = factory.predictLaunch(CREATOR, config);
        uint256 beforeBalance = quote.balanceOf(CREATOR);
        vm.prank(CREATOR);
        quote.approve(address(factory), config.seedUSDC);
        vm.prank(CREATOR);
        vm.expectRevert(selector);
        factory.launch(config);
        _assertRollback(predicted, beforeBalance);
    }
}
