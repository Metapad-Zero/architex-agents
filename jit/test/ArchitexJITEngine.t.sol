// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {JITFixture, JITTestToken, JITDirectRouter} from "./helpers/JITFixture.sol";
import {ArchitexJITVault} from "../src/ArchitexJITVault.sol";
import {ArchitexJITHook} from "../src/ArchitexJITHook.sol";
import {ArchitexJITExecutor} from "../src/ArchitexJITExecutor.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

contract ArchitexJITEngineTest is JITFixture {
    using BalanceDeltaLibrary for BalanceDelta;
    using StateLibrary for IPoolManager;

    bytes32 private constant MODIFY_EVENT = keccak256("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)");
    bytes32 private constant SWAP_EVENT = keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");

    struct Snapshot {
        uint160 price;
        uint256 cash0;
        uint256 cash1;
        uint256 claims0;
        uint256 claims1;
        uint256 fees0;
        uint256 fees1;
        uint256 trader0;
        uint256 trader1;
        uint256 manager0;
        uint256 manager1;
        uint256 cycles;
    }

    function test_exactInputBothDirectionsClosesTemporaryRange() public {
        _assertExactInput(true, 1_000);
        _assertExactInput(false, 1_000);
        assertEq(hook.jitCycles(), 2);
        _assertRestingState();
        _assertTokenConservation();
    }

    function test_exactOutputBothDirectionsFillsRequestedAmount() public {
        for (uint256 i; i < 2; ++i) {
            bool zeroForOne = i == 0;
            uint256 wanted = _wholeOutput(zeroForOne, 500);
            JITTestToken input = zeroForOne ? asset0 : asset1;
            JITTestToken output = zeroForOne ? asset1 : asset0;
            uint256 beforeInput = input.balanceOf(TRADER);
            uint256 beforeOutput = output.balanceOf(TRADER);
            (uint256 paid, uint256 received) = _execute(zeroForOne, int256(wanted));
            assertEq(received, wanted);
            assertEq(beforeInput - input.balanceOf(TRADER), paid);
            assertEq(output.balanceOf(TRADER) - beforeOutput, wanted);
            assertGt(paid, 0);
        }
        assertEq(hook.jitCycles(), 2);
        _assertRestingState();
        _assertTokenConservation();
    }

    function test_poolLogsProveAddSwapRemoveWithinSameExecution() public {
        vm.recordLogs();
        _execute(true, -int256(_wholeInput(true, 1_000)));
        Vm.Log[] memory records = vm.getRecordedLogs();
        uint256 addIndex = type(uint256).max;
        uint256 swapIndex = type(uint256).max;
        uint256 removeIndex = type(uint256).max;
        uint256 adds;
        uint256 removes;
        for (uint256 i; i < records.length; ++i) {
            if (records[i].emitter != address(manager)) continue;
            if (records[i].topics[0] == MODIFY_EVENT) {
                (int24 lower, int24 upper, int256 change, bytes32 salt) =
                    abi.decode(records[i].data, (int24, int24, int256, bytes32));
                if (salt != JIT_SALT) continue;
                assertEq(lower, policy.jitLower);
                assertEq(upper, policy.jitUpper);
                if (change > 0) {
                    ++adds;
                    addIndex = i;
                    assertEq(uint256(change), JIT_LIQUIDITY);
                }
                if (change < 0) {
                    ++removes;
                    removeIndex = i;
                    assertEq(uint256(-change), JIT_LIQUIDITY);
                }
            } else if (records[i].topics[0] == SWAP_EVENT) {
                (,,, uint128 duringLiquidity,,) =
                    abi.decode(records[i].data, (int128, int128, uint160, uint128, int24, uint24));
                assertEq(duringLiquidity, BASELINE_LIQUIDITY + JIT_LIQUIDITY);
                swapIndex = i;
            }
        }
        assertEq(adds, 1);
        assertEq(removes, 1);
        assertLt(addIndex, swapIndex);
        assertLt(swapIndex, removeIndex);
        _assertRestingState();
    }

    function test_directRouterGetsJITWithoutUsingArchitexExecutor() public {
        BalanceDelta delta = _directSwap(true, -int256(_wholeInput(true, 1_000)));
        assertLt(delta.amount0(), 0);
        assertGt(delta.amount1(), 0);
        assertEq(hook.jitCycles(), 1);
        _assertRestingState();
        _assertTokenConservation();
    }

    function test_repeatedSamePoolSwapsInOneUnlockReconcileClaims() public {
        IPoolManager.SwapParams[] memory swaps = new IPoolManager.SwapParams[](4);
        swaps[0] = _params(true, -int256(_wholeInput(true, 500)));
        swaps[1] = _params(false, -int256(_wholeInput(false, 700)));
        swaps[2] = _params(true, int256(_wholeOutput(true, 250)));
        swaps[3] = _params(false, int256(_wholeOutput(false, 200)));
        vm.prank(TRADER);
        BalanceDelta[] memory deltas = directRouter.swapMany(key, swaps);
        assertEq(deltas.length, 4);
        assertEq(hook.jitCycles(), 4);
        assertEq(hook.startedCycles(), 4);
        assertGt(vault.claimBalance(address(asset0)) + vault.claimBalance(address(asset1)), 0);
        _assertRestingState();
        _assertTokenConservation();
    }

    function test_emptyJITInventoryFallsBackToSeededBaseline() public {
        _buildFixture(IPoolManager(address(new PoolManager(address(this)))), true, false);
        assertEq(vault.availableInventory(address(asset0)), 0);
        assertEq(vault.availableInventory(address(asset1)), 0);
        _assertExactInput(true, 100);
        assertEq(hook.jitCycles(), 0);
        assertEq(hook.completedCycles(), 1);
        _assertRestingState();
        _assertTokenConservation();
    }

    function test_swapBelowMinimumUsesBaseline() public {
        uint256 input = policy.minSwapAmount0 / 2;
        _execute(true, -int256(input));
        assertEq(hook.jitCycles(), 0);
        _assertRestingState();
    }

    function test_stalePolicyUsesBaseline() public {
        vm.warp(uint256(policy.validUntil) + 1);
        _assertExactInput(true, 100);
        assertEq(hook.jitCycles(), 0);
        assertGt(vault.feeCredits(address(asset0)), 0, "fallback LP fees were not reserved automatically");
        _assertRestingState();
    }

    function test_nearInt128PrincipalAndAsset0FeesAreSeparatedBeforeRemoval() public {
        _assertNearDeltaLimit(true);
    }

    function test_nearInt128PrincipalAndAsset1FeesAreSeparatedBeforeRemoval() public {
        _assertNearDeltaLimit(false);
    }

    function test_priceAtJITBoundaryUsesBaselineAndCanTradeBackInside() public {
        ArchitexJITExecutor.SwapRequest memory request = _request(true, -int256(_wholeInput(true, 1_000_000)));
        request.sqrtPriceLimitX96 = TickMath.getSqrtPriceAtTick(policy.jitLower);
        request.allowPartialFill = true;
        vm.prank(TRADER);
        executor.swap(request);
        assertEq(hook.currentSqrtPriceX96(), request.sqrtPriceLimitX96);
        uint256 before = hook.jitCycles();
        _assertExactInput(false, 100);
        assertEq(hook.jitCycles(), before, "boundary trade unexpectedly activated JIT");
        assertGt(hook.currentSqrtPriceX96(), request.sqrtPriceLimitX96);
        _assertExactInput(true, 100);
        assertEq(hook.jitCycles(), before + 1);
        _assertRestingState();
    }

    function test_feeClaimsPreserveInventoryAndHistoricalPrincipal() public {
        _execute(true, -int256(_wholeInput(true, 1_000)));
        _execute(false, -int256(_wholeInput(false, 1_000)));
        hook.collectBaselineFees();
        for (uint256 i; i < 2; ++i) {
            JITTestToken asset = i == 0 ? asset0 : asset1;
            uint256 fees = vault.feeCredits(address(asset));
            uint256 historical = vault.principalDeposited(address(asset));
            uint256 principalInventory = vault.availableInventory(address(asset));
            uint256 owned = vault.cashBalance(address(asset)) + vault.claimBalance(address(asset));
            uint256 recipientBefore = asset.balanceOf(FEE_RECIPIENT);
            assertGt(fees, 0);
            vm.prank(SECOND_TRADER);
            vault.claimFees(address(asset), fees);
            assertEq(asset.balanceOf(FEE_RECIPIENT) - recipientBefore, fees);
            assertEq(vault.feeCredits(address(asset)), 0);
            assertEq(vault.feesClaimed(address(asset)), fees);
            assertEq(vault.principalDeposited(address(asset)), historical);
            assertEq(vault.availableInventory(address(asset)), principalInventory);
            assertEq(vault.cashBalance(address(asset)) + vault.claimBalance(address(asset)), owned - fees);
        }
        _assertRestingState();
        _assertTokenConservation();
    }

    function test_feeClaimsFromPoolManagerClaimsPreserveBaselineAndInventory() public {
        _buildFixture(IPoolManager(address(new PoolManager(address(this)))), true, false);
        _execute(true, -int256(_wholeInput(true, 100)));
        _execute(false, -int256(_wholeInput(false, 100)));
        hook.collectBaselineFees();
        for (uint256 i; i < 2; ++i) {
            JITTestToken asset = i == 0 ? asset0 : asset1;
            uint256 credit = vault.feeCredits(address(asset));
            uint256 inventory = vault.availableInventory(address(asset));
            uint256 claims = vault.claimBalance(address(asset));
            assertEq(vault.cashBalance(address(asset)), 0, "fixture must exercise claims payout");
            assertGt(credit, 0);
            vault.claimFees(address(asset), credit);
            assertEq(vault.claimBalance(address(asset)), claims - credit);
            assertEq(asset.balanceOf(FEE_RECIPIENT), credit);
            assertEq(vault.availableInventory(address(asset)), inventory);
        }
        _assertRestingState();
        _assertTokenConservation();
    }

    function test_cannotClaimPrincipalBeforeAnyFeeAccrual() public {
        Snapshot memory before = _snapshot();
        vm.expectRevert(ArchitexJITVault.InsufficientFees.selector);
        vault.claimFees(address(asset0), 1);
        _assertSnapshot(before);
    }

    function test_unsolicitedVaultAssetsAreInventoryNotTradingFees() public {
        uint256 previousInventory = vault.availableInventory(address(asset0));
        asset0.transfer(address(vault), 123);
        assertEq(vault.availableInventory(address(asset0)), previousInventory + 123);
        assertEq(vault.feeCredits(address(asset0)), 0);
        vm.expectRevert(ArchitexJITVault.InsufficientFees.selector);
        vault.claimFees(address(asset0), 123);
        _assertTokenConservation();
    }

    function test_poolDonationRejectedWithoutCreditingFees() public {
        Snapshot memory before = _snapshot();
        vm.expectRevert();
        vm.prank(TRADER);
        directRouter.donate(key, 100 * unit0, 100 * unit1);
        _assertSnapshot(before);
        assertEq(vault.feeCredits(address(asset0)) + vault.feeCredits(address(asset1)), 0);
    }

    function test_externalLiquidityAddAndRemovalCannotEnterEnginePool() public {
        Snapshot memory before = _snapshot();
        IPoolManager.ModifyLiquidityParams memory params = IPoolManager.ModifyLiquidityParams({
            tickLower: policy.jitLower,
            tickUpper: policy.jitUpper,
            liquidityDelta: int256(uint256(BASELINE_LIQUIDITY)),
            salt: keccak256("external actor")
        });
        vm.expectRevert();
        vm.prank(TRADER);
        directRouter.modifyLiquidity(key, params);
        _assertSnapshot(before);
        params.liquidityDelta = -int256(uint256(BASELINE_LIQUIDITY));
        params.salt = BASELINE_SALT;
        vm.expectRevert();
        vm.prank(TRADER);
        directRouter.modifyLiquidity(key, params);
        _assertSnapshot(before);
    }

    function test_outputGoesToExplicitRecipientWhilePayerSuppliesInput() public {
        uint256 input = _wholeInput(true, 1_000);
        ArchitexJITExecutor.SwapRequest memory request = _request(true, -int256(input));
        request.recipient = SECOND_TRADER;
        uint256 payerInput = asset0.balanceOf(TRADER);
        uint256 payerOutput = asset1.balanceOf(TRADER);
        uint256 recipientOutput = asset1.balanceOf(SECOND_TRADER);
        vm.prank(TRADER);
        (uint256 paid, uint256 received) = executor.swap(request);
        assertEq(payerInput - asset0.balanceOf(TRADER), paid);
        assertEq(asset1.balanceOf(TRADER), payerOutput);
        assertEq(asset1.balanceOf(SECOND_TRADER) - recipientOutput, received);
        _assertRestingState();
        _assertTokenConservation();
    }

    function test_forgedCallbacksAndFeeWritesRejected() public {
        Snapshot memory before = _snapshot();
        vm.expectRevert(ArchitexJITHook.Unauthorized.selector);
        hook.beforeSwap(TRADER, key, _params(true, -1), "");
        vm.expectRevert(ArchitexJITHook.Unauthorized.selector);
        hook.afterSwap(TRADER, key, _params(true, -1), BalanceDelta.wrap(0), "");
        vm.expectRevert(ArchitexJITHook.Unauthorized.selector);
        hook.unlockCallback(abi.encode(uint8(1)));
        vm.expectRevert(ArchitexJITVault.InvalidCallback.selector);
        vault.unlockCallback(abi.encode(address(asset0), 1));
        vm.expectRevert(ArchitexJITExecutor.InvalidCallback.selector);
        executor.unlockCallback(abi.encode(TRADER, _request(true, -1)));
        vm.expectRevert(ArchitexJITVault.Unauthorized.selector);
        vault.recordFees(BalanceDelta.wrap(1));
        vm.expectRevert(ArchitexJITVault.Unauthorized.selector);
        vault.settleCurrency(address(asset0), 1);
        _assertSnapshot(before);
    }

    function test_fakePoolCannotReuseHook() public {
        PoolKey memory wrong = key;
        ++wrong.fee;
        vm.expectRevert();
        manager.initialize(wrong, policy.initialSqrtPriceX96);
        _assertRestingState();
    }

    function test_unmatchedAfterSwapRejectedEvenFromManager() public {
        vm.expectRevert(ArchitexJITHook.InvalidLifecycle.selector);
        vm.prank(address(manager));
        hook.afterSwap(TRADER, key, _params(true, -1), BalanceDelta.wrap(0), "");
        _assertRestingState();
    }

    function test_policyRejectsBaselineAbovePinnedCorePerTickLimit() public {
        ArchitexJITHook.Policy memory bad = policy;
        bad.baselineLiquidity = _perTickLimit() + 1;
        vm.expectRevert(ArchitexJITHook.InvalidPolicy.selector);
        new ArchitexJITHook(manager, vault, POOL_FEE, SPACING, bad);
    }

    function test_policyRejectsTemporaryLiquidityAbovePinnedCorePerTickLimit() public {
        ArchitexJITHook.Policy memory bad = policy;
        bad.jitLiquidity = _perTickLimit() + 1;
        vm.expectRevert(ArchitexJITHook.InvalidPolicy.selector);
        new ArchitexJITHook(manager, vault, POOL_FEE, SPACING, bad);
    }

    function test_policyRejectsExtremeCombinedLiquidityAtConstruction() public {
        ArchitexJITHook.Policy memory bad = policy;
        bad.baselineLiquidity = type(uint128).max;
        bad.jitLiquidity = type(uint128).max;
        vm.expectRevert(ArchitexJITHook.InvalidPolicy.selector);
        new ArchitexJITHook(manager, vault, POOL_FEE, SPACING, bad);
    }

    function test_policyRejectsUnrepresentableBaselineDebtBeforeNonwithdrawableFunding() public {
        ArchitexJITHook.Policy memory bad = _extremeNegativePolicy();
        uint256 required0 = SqrtPriceMath.getAmount0Delta(
            bad.initialSqrtPriceX96, TickMath.getSqrtPriceAtTick(bad.baselineUpper), bad.baselineLiquidity, true
        );
        assertGt(required0, uint256(uint128(type(int128).max)), "regression must exceed v4 signed delta");
        vm.expectRevert(ArchitexJITHook.InvalidPolicy.selector);
        new ArchitexJITHook(manager, vault, POOL_FEE, 32_760, bad);
    }

    function test_policyRejectsUnrepresentableJITWholeRangeRemoval() public {
        ArchitexJITHook.Policy memory bad = _extremeNegativePolicy();
        bad.baselineLiquidity = 1;
        uint256 wholeRange0 = SqrtPriceMath.getAmount0Delta(
            TickMath.getSqrtPriceAtTick(bad.jitLower), TickMath.getSqrtPriceAtTick(bad.jitUpper), bad.jitLiquidity, true
        );
        assertGt(wholeRange0, uint256(uint128(type(int128).max)), "regression must exceed v4 signed delta");
        vm.expectRevert(ArchitexJITHook.InvalidPolicy.selector);
        new ArchitexJITHook(manager, vault, POOL_FEE, 32_760, bad);
    }

    function test_policyRejectsUnrepresentableBaselineAsset1Debt() public {
        ArchitexJITHook.Policy memory bad = _extremeNegativePolicy();
        bad.initialSqrtPriceX96 = TickMath.getSqrtPriceAtTick(802_620);
        bad.baselineLower = 753_480;
        bad.baselineUpper = 851_760;
        bad.jitLower = 786_240;
        bad.jitUpper = 819_000;
        uint256 required1 = SqrtPriceMath.getAmount1Delta(
            TickMath.getSqrtPriceAtTick(bad.baselineLower), bad.initialSqrtPriceX96, bad.baselineLiquidity, true
        );
        assertGt(required1, uint256(uint128(type(int128).max)), "regression must exceed v4 signed delta");
        vm.expectRevert(ArchitexJITHook.InvalidPolicy.selector);
        new ArchitexJITHook(manager, vault, POOL_FEE, 32_760, bad);
    }

    function test_policyRejectsUnrepresentableJITAsset1WholeRangeRemoval() public {
        ArchitexJITHook.Policy memory bad = _extremeNegativePolicy();
        bad.baselineLiquidity = 1;
        bad.initialSqrtPriceX96 = TickMath.getSqrtPriceAtTick(802_620);
        bad.baselineLower = 753_480;
        bad.baselineUpper = 851_760;
        bad.jitLower = 786_240;
        bad.jitUpper = 819_000;
        uint256 wholeRange1 = SqrtPriceMath.getAmount1Delta(
            TickMath.getSqrtPriceAtTick(bad.jitLower), TickMath.getSqrtPriceAtTick(bad.jitUpper), bad.jitLiquidity, true
        );
        assertGt(wholeRange1, uint256(uint128(type(int128).max)), "regression must exceed v4 signed delta");
        vm.expectRevert(ArchitexJITHook.InvalidPolicy.selector);
        new ArchitexJITHook(manager, vault, POOL_FEE, 32_760, bad);
    }

    function test_deadlineFailureDoesNotMutatePool() public {
        Snapshot memory before = _snapshot();
        ArchitexJITExecutor.SwapRequest memory request = _request(true, -int256(_wholeInput(true, 1_000)));
        request.deadline = block.timestamp - 1;
        vm.expectRevert(ArchitexJITExecutor.DeadlineExpired.selector);
        vm.prank(TRADER);
        executor.swap(request);
        _assertSnapshot(before);
    }

    function test_slippageFailureRollsBackJITAndAllBalances() public {
        Snapshot memory before = _snapshot();
        ArchitexJITExecutor.SwapRequest memory request = _request(true, -int256(_wholeInput(true, 1_000)));
        request.minimumOutput = _wholeOutput(true, 1_000_000);
        vm.expectRevert(ArchitexJITExecutor.MinimumOutputNotMet.selector);
        vm.prank(TRADER);
        executor.swap(request);
        _assertSnapshot(before);
    }

    function test_exactOutputMaximumInputFailureRollsBackJIT() public {
        Snapshot memory before = _snapshot();
        ArchitexJITExecutor.SwapRequest memory request = _request(false, int256(_wholeOutput(false, 1_000)));
        request.maximumInput = 1;
        vm.expectRevert(ArchitexJITExecutor.InputLimitExceeded.selector);
        vm.prank(TRADER);
        executor.swap(request);
        _assertSnapshot(before);
    }

    function test_priceLimitPartialExactInputRejectedAtomically() public {
        _assertPartialFillRollback(true, false);
        _assertPartialFillRollback(false, false);
    }

    function test_priceLimitPartialExactOutputRejectedAtomically() public {
        _assertPartialFillRollback(true, true);
        _assertPartialFillRollback(false, true);
    }

    function test_explicitPartialFillReportsActualInputAndOutput() public {
        uint256 intended = _wholeInput(true, 500_000);
        ArchitexJITExecutor.SwapRequest memory request = _request(true, -int256(intended));
        request.sqrtPriceLimitX96 = TickMath.getSqrtPriceAtTick(policy.jitLower + 60);
        request.allowPartialFill = true;
        vm.prank(TRADER);
        (uint256 paid, uint256 received) = executor.swap(request);
        assertGt(paid, 0);
        assertLt(paid, intended);
        assertGt(received, 0);
        assertEq(hook.currentSqrtPriceX96(), request.sqrtPriceLimitX96);
        _assertRestingState();
        _assertTokenConservation();
    }

    function test_feeOnTransferDepositRejectedWithoutAccountingChange() public {
        uint256 historical = vault.principalDeposited(address(asset0));
        uint256 cash = vault.cashBalance(address(asset0));
        asset0.configureTransfer(address(0), "", false, 100);
        vm.expectRevert(ArchitexJITVault.TransferMismatch.selector);
        vault.deposit(address(asset0), 10_000);
        assertEq(vault.cashBalance(address(asset0)), cash);
        assertEq(vault.principalDeposited(address(asset0)), historical);
    }

    function test_senderFeeDepositRejectedWithoutAccountingChange() public {
        uint256 historical = vault.principalDeposited(address(asset0));
        uint256 cash = vault.cashBalance(address(asset0));
        asset0.configureSenderFee(100);
        vm.expectRevert(ArchitexJITVault.TransferMismatch.selector);
        vault.deposit(address(asset0), 10_000);
        assertEq(vault.cashBalance(address(asset0)), cash);
        assertEq(vault.principalDeposited(address(asset0)), historical);
    }

    function test_senderFeeDuringJITSettlementRevertsAtomically() public {
        Snapshot memory before = _snapshot();
        asset0.configureSenderFee(100);
        vm.expectRevert();
        _execute(true, -int256(_wholeInput(true, 1_000)));
        _assertSnapshot(before);
    }

    function test_senderFeeOutputRejectedWithoutDebitingPoolReserves() public {
        vm.warp(uint256(policy.validUntil) + 1);
        Snapshot memory before = _snapshot();
        asset1.configureSenderFee(100);
        vm.expectRevert(ArchitexJITExecutor.TransferMismatch.selector);
        _execute(true, -int256(_wholeInput(true, 1_000)));
        _assertSnapshot(before);
    }

    function test_senderFeeClaimRejectedWithoutDebitingPrincipal() public {
        _execute(true, -int256(_wholeInput(true, 1_000)));
        uint256 fees = vault.feeCredits(address(asset0));
        Snapshot memory before = _snapshot();
        asset0.configureSenderFee(100);
        vm.expectRevert(ArchitexJITVault.TransferMismatch.selector);
        vault.claimFees(address(asset0), fees);
        _assertSnapshot(before);
        assertEq(asset0.balanceOf(FEE_RECIPIENT), 0);
    }

    function test_falseReturningInputTransferRollsBackFullCycle() public {
        Snapshot memory before = _snapshot();
        asset0.configureTransfer(address(0), "", true, 0);
        vm.expectRevert();
        _execute(true, -int256(_wholeInput(true, 1_000)));
        _assertSnapshot(before);
    }

    function test_reentrantExecutorCallBlockedDuringTokenTransfer() public {
        ArchitexJITExecutor.SwapRequest memory attack = _request(false, -int256(_wholeInput(false, 10)));
        asset0.configureTransfer(address(executor), abi.encodeCall(executor.swap, (attack)), false, 0);
        _assertExactInput(true, 1_000);
        assertTrue(asset0.callbackAttempted());
        assertFalse(asset0.callbackSucceeded());
        _assertRestingState();
    }

    function test_reentrantFeeClaimBlockedWhilePoolManagerUnlocked() public {
        _execute(true, -int256(_wholeInput(true, 1_000)));
        uint256 fees = vault.feeCredits(address(asset0));
        asset1.configureTransfer(address(vault), abi.encodeCall(vault.claimFees, (address(asset0), fees)), false, 0);
        asset1.setCallbackSender(address(vault));
        _assertExactInput(false, 1_000);
        assertTrue(asset1.callbackAttempted());
        assertFalse(asset1.callbackSucceeded());
        assertEq(vault.feesClaimed(address(asset0)), 0);
        _assertRestingState();
    }

    function test_equalCapitalJITEnabledVersusBaselineOnlyMeasured() public {
        _measureEqualCapital(true);
    }

    function test_equalCapitalJITEnabledVersusBaselineOnlyOppositeDirectionMeasured() public {
        _measureEqualCapital(false);
    }

    function _measureEqualCapital(bool zeroForOne) private {
        uint256 checkpoint = vm.snapshotState();
        uint256 input = _wholeInput(zeroForOne, 5_000);
        uint256 gasStart = gasleft();
        (uint256 jitPaid, uint256 jitOutput) = _execute(zeroForOne, -int256(input));
        uint256 jitGas = gasStart - gasleft();
        uint160 jitPrice = hook.currentSqrtPriceX96();
        uint256 jitCash0 = vault.cashBalance(address(asset0));
        uint256 jitClaims0 = vault.claimBalance(address(asset0));
        uint256 jitCash1 = vault.cashBalance(address(asset1));
        uint256 jitClaims1 = vault.claimBalance(address(asset1));
        uint256 allLPFees = vault.feeCredits(zeroForOne ? address(asset0) : address(asset1));
        assertTrue(vm.revertToState(checkpoint));
        vm.warp(uint256(policy.validUntil) + 1);
        gasStart = gasleft();
        (uint256 baselinePaid, uint256 baselineOutput) = _execute(zeroForOne, -int256(input));
        uint256 baselineGas = gasStart - gasleft();
        uint160 baselinePrice = hook.currentSqrtPriceX96();
        assertEq(jitPaid, baselinePaid);
        assertGt(jitOutput, baselineOutput, "fixture JIT did not improve output");
        if (zeroForOne) assertGt(jitPrice, baselinePrice, "fixture JIT price impact did not improve");
        else assertLt(jitPrice, baselinePrice, "fixture JIT price impact did not improve");
        emit log_named_uint("comparison.zeroForOne", zeroForOne ? 1 : 0);
        emit log_named_uint("comparison.input.raw", input);
        emit log_named_uint("comparison.jit.output.raw", jitOutput);
        emit log_named_uint("comparison.baseline.output.raw", baselineOutput);
        emit log_named_uint("comparison.jit.executionGas", jitGas);
        emit log_named_uint("comparison.baseline.executionGas", baselineGas);
        emit log_named_uint("comparison.jit.cash0.raw", jitCash0);
        emit log_named_uint("comparison.jit.claims0.raw", jitClaims0);
        emit log_named_uint("comparison.jit.cash1.raw", jitCash1);
        emit log_named_uint("comparison.jit.claims1.raw", jitClaims1);
        emit log_named_uint("comparison.jit.allLPInputFees.raw", allLPFees);
        emit log_named_uint("comparison.baseline.cash0.raw", vault.cashBalance(address(asset0)));
        emit log_named_uint("comparison.baseline.claims0.raw", vault.claimBalance(address(asset0)));
        emit log_named_uint("comparison.baseline.cash1.raw", vault.cashBalance(address(asset1)));
        emit log_named_uint("comparison.baseline.claims1.raw", vault.claimBalance(address(asset1)));
        _assertRestingState();
    }

    function testFuzz_exactInputConservesAssetsAndRestoresLiquidity(bool zeroForOne, uint16 wholeInput) public {
        _assertExactInput(zeroForOne, bound(uint256(wholeInput), 1, 5_000));
        _assertRestingState();
        _assertTokenConservation();
    }

    function _assertExactInput(bool zeroForOne, uint256 whole) private {
        uint256 input = _wholeInput(zeroForOne, whole);
        JITTestToken inAsset = zeroForOne ? asset0 : asset1;
        JITTestToken outAsset = zeroForOne ? asset1 : asset0;
        uint256 beforeInput = inAsset.balanceOf(TRADER);
        uint256 beforeOutput = outAsset.balanceOf(TRADER);
        (uint256 paid, uint256 received) = _execute(zeroForOne, -int256(input));
        assertEq(paid, input);
        assertGt(received, 0);
        assertEq(beforeInput - inAsset.balanceOf(TRADER), input);
        assertEq(outAsset.balanceOf(TRADER) - beforeOutput, received);
    }

    function _perTickLimit() private pure returns (uint128) {
        int24 lowerBucket = TickMath.MIN_TICK / SPACING;
        if (TickMath.MIN_TICK % SPACING != 0) --lowerBucket;
        int24 upperBucket = TickMath.MAX_TICK / SPACING;
        return type(uint128).max / uint128(uint24(upperBucket - lowerBucket + 1));
    }

    function _assertNearDeltaLimit(bool overflowingAsset0) private {
        manager = IPoolManager(address(new PoolManager(address(this))));
        token = new JITTestToken("Extreme accounting TEST MODEL", "EXTREME", 18);
        quote = new JITTestToken("Extreme USDC TEST MODEL", "EXTREME_USDC_MODEL", 6);
        asset0 = address(token) < address(quote) ? token : quote;
        asset1 = address(token) < address(quote) ? quote : token;
        unit0 = 10 ** asset0.decimals();
        unit1 = 10 ** asset1.decimals();
        // Synthetic raw-unit stress case; ordinary fixtures separately verify normalized token/USDC prices.
        int24 initialTick = overflowingAsset0 ? int24(-276_360) : int24(276_360);
        policy = ArchitexJITHook.Policy({
            initialSqrtPriceX96: TickMath.getSqrtPriceAtTick(initialTick),
            baselineLower: initialTick - 60_000,
            baselineUpper: initialTick + 60_000,
            jitLower: initialTick - 600,
            jitUpper: initialTick + 600,
            baselineLiquidity: 1,
            jitLiquidity: 1,
            maxJITAmount0: type(uint128).max,
            maxJITAmount1: type(uint128).max,
            minSwapAmount0: 0,
            minSwapAmount1: 0,
            validUntil: uint64(block.timestamp + 1 days)
        });
        uint256 deltaLimit = uint256(uint128(type(int128).max));
        uint256 targetPrincipal = deltaLimit - deltaLimit / 1_000;
        uint128 low;
        uint128 high = _perTickLimit();
        while (low < high) {
            uint128 middle = low + (high - low) / 2 + 1;
            uint256 amount = _wholeRangePrincipal(overflowingAsset0, middle, true);
            if (amount <= targetPrincipal) low = middle;
            else high = middle - 1;
        }
        policy.jitLiquidity = low;
        uint256 removalPrincipal = _wholeRangePrincipal(overflowingAsset0, low, false);
        assertLe(removalPrincipal, deltaLimit);
        assertGt(removalPrincipal, deltaLimit * 998 / 1_000);
        vault = new ArchitexJITVault(manager, address(token), address(quote), FEE_RECIPIENT);
        hook = _deployHook(vault, policy);
        vault.bindHook(address(hook));
        key = hook.getPoolKey();
        poolId = hook.poolId();
        executor = new ArchitexJITExecutor(manager, hook);
        directRouter = new JITDirectRouter(manager);
        _mintAndApprove(address(this));
        _mintAndApprove(TRADER);
        _mintAndApprove(SECOND_TRADER);
        for (uint256 i; i < 2; ++i) {
            JITTestToken asset = i == 0 ? asset0 : asset1;
            asset.mint(address(this), deltaLimit * 2);
            asset.mint(TRADER, deltaLimit * 2);
            asset.approve(address(vault), type(uint256).max);
            vault.deposit(address(asset), deltaLimit * 2);
        }
        hook.seedBaseline();
        ArchitexJITExecutor.SwapRequest memory request = _request(overflowingAsset0, -int256(deltaLimit));
        request.maximumInput = deltaLimit;
        request.allowPartialFill = true;
        request.sqrtPriceLimitX96 = TickMath.getSqrtPriceAtTick(overflowingAsset0 ? policy.jitLower : policy.jitUpper);
        vm.prank(TRADER);
        (uint256 paid, uint256 received) = executor.swap(request);
        assertGt(paid, 0);
        assertGt(received, 0);
        uint256 fees = vault.feeCredits(overflowingAsset0 ? address(asset0) : address(asset1));
        assertGt(
            removalPrincipal + fees, deltaLimit, "regression must prove combined principal and fees exceed signed delta"
        );
        assertEq(hook.jitCycles(), 1);
        assertEq(hook.currentSqrtPriceX96(), request.sqrtPriceLimitX96);
        _assertRestingState();
        _assertTokenConservation();
    }

    function _wholeRangePrincipal(bool firstAsset, uint128 liquidity, bool roundUp) private view returns (uint256) {
        uint160 lower = TickMath.getSqrtPriceAtTick(policy.jitLower);
        uint160 upper = TickMath.getSqrtPriceAtTick(policy.jitUpper);
        return firstAsset
            ? SqrtPriceMath.getAmount0Delta(lower, upper, liquidity, roundUp)
            : SqrtPriceMath.getAmount1Delta(lower, upper, liquidity, roundUp);
    }

    function _extremeNegativePolicy() private view returns (ArchitexJITHook.Policy memory) {
        return ArchitexJITHook.Policy({
            initialSqrtPriceX96: TickMath.getSqrtPriceAtTick(-802_620),
            baselineLower: -851_760,
            baselineUpper: -753_480,
            jitLower: -819_000,
            jitUpper: -786_240,
            baselineLiquidity: type(uint128).max / 56,
            jitLiquidity: type(uint128).max / 56,
            maxJITAmount0: type(uint128).max,
            maxJITAmount1: type(uint128).max,
            minSwapAmount0: 0,
            minSwapAmount1: 0,
            validUntil: uint64(block.timestamp + 1 days)
        });
    }

    function _assertPartialFillRollback(bool zeroForOne, bool exactOutput) private {
        Snapshot memory before = _snapshot();
        int256 specified =
            exactOutput ? int256(_wholeOutput(zeroForOne, 500_000)) : -int256(_wholeInput(zeroForOne, 500_000));
        ArchitexJITExecutor.SwapRequest memory request = _request(zeroForOne, specified);
        request.sqrtPriceLimitX96 =
            TickMath.getSqrtPriceAtTick(zeroForOne ? policy.jitLower + 60 : policy.jitUpper - 60);
        vm.expectRevert(ArchitexJITExecutor.PartialFillNotAllowed.selector);
        vm.prank(TRADER);
        executor.swap(request);
        _assertSnapshot(before);
    }

    function _snapshot() private view returns (Snapshot memory s) {
        s.price = hook.currentSqrtPriceX96();
        s.cash0 = vault.cashBalance(address(asset0));
        s.cash1 = vault.cashBalance(address(asset1));
        s.claims0 = vault.claimBalance(address(asset0));
        s.claims1 = vault.claimBalance(address(asset1));
        s.fees0 = vault.feeCredits(address(asset0));
        s.fees1 = vault.feeCredits(address(asset1));
        s.trader0 = asset0.balanceOf(TRADER);
        s.trader1 = asset1.balanceOf(TRADER);
        s.manager0 = asset0.balanceOf(address(manager));
        s.manager1 = asset1.balanceOf(address(manager));
        s.cycles = hook.completedCycles();
    }

    function _assertSnapshot(Snapshot memory s) private view {
        assertEq(hook.currentSqrtPriceX96(), s.price);
        assertEq(vault.cashBalance(address(asset0)), s.cash0);
        assertEq(vault.cashBalance(address(asset1)), s.cash1);
        assertEq(vault.claimBalance(address(asset0)), s.claims0);
        assertEq(vault.claimBalance(address(asset1)), s.claims1);
        assertEq(vault.feeCredits(address(asset0)), s.fees0);
        assertEq(vault.feeCredits(address(asset1)), s.fees1);
        assertEq(asset0.balanceOf(TRADER), s.trader0);
        assertEq(asset1.balanceOf(TRADER), s.trader1);
        assertEq(asset0.balanceOf(address(manager)), s.manager0);
        assertEq(asset1.balanceOf(address(manager)), s.manager1);
        assertEq(hook.completedCycles(), s.cycles);
        _assertRestingState();
    }
}
