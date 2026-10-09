// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {JITFixture, JITTestToken} from "./helpers/JITFixture.sol";
import {ArchitexJITVault} from "../src/ArchitexJITVault.sol";
import {ArchitexJITHook} from "../src/ArchitexJITHook.sol";
import {ArchitexJITExecutor} from "../src/ArchitexJITExecutor.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

contract JITInvariantHandler is Test {
    ArchitexJITVault public immutable vault;
    ArchitexJITHook public immutable hook;
    ArchitexJITExecutor public immutable executor;
    JITTestToken public immutable asset0;
    JITTestToken public immutable asset1;
    uint256 private immutable unit0;
    uint256 private immutable unit1;
    uint256 public paid0;
    uint256 public paid1;
    uint256 public swapCount;
    uint256 public claimed0;
    uint256 public claimed1;
    uint256 public donations0;
    uint256 public donations1;

    constructor(
        ArchitexJITVault vault_,
        ArchitexJITHook hook_,
        ArchitexJITExecutor executor_,
        JITTestToken asset0_,
        JITTestToken asset1_
    ) {
        vault = vault_;
        hook = hook_;
        executor = executor_;
        asset0 = asset0_;
        asset1 = asset1_;
        unit0 = 10 ** asset0_.decimals();
        unit1 = 10 ** asset1_.decimals();
        asset0_.approve(address(executor_), type(uint256).max);
        asset1_.approve(address(executor_), type(uint256).max);
    }

    function swapExactInput(bool zeroForOne, uint16 wholeSeed) external {
        uint256 input = bound(uint256(wholeSeed), 1, 500) * (zeroForOne ? unit0 : unit1);
        (uint256 paid, uint256 received) = executor.swap(_request(zeroForOne, -int256(input)));
        require(paid == input && received != 0, "invariant exact input fill mismatch");
        _record(zeroForOne, paid);
    }

    function swapExactOutput(bool zeroForOne, uint16 wholeSeed) external {
        uint256 output = bound(uint256(wholeSeed), 1, 400) * (zeroForOne ? unit1 : unit0);
        (uint256 paid, uint256 received) = executor.swap(_request(zeroForOne, int256(output)));
        require(paid != 0 && received == output, "invariant exact output fill mismatch");
        _record(zeroForOne, paid);
    }

    function collectBaselineFees() external {
        hook.collectBaselineFees();
    }

    function claimFees(bool firstAsset, uint96 fraction) external {
        address asset = firstAsset ? address(asset0) : address(asset1);
        uint256 credit = vault.feeCredits(asset);
        if (credit == 0) return;
        uint256 amount = bound(uint256(fraction), 1, credit);
        uint256 inventory = vault.availableInventory(asset);
        uint256 historical = vault.principalDeposited(asset);
        vault.claimFees(asset, amount);
        require(vault.availableInventory(asset) == inventory, "claim consumed principal inventory");
        require(vault.principalDeposited(asset) == historical, "claim changed historical principal");
        if (firstAsset) claimed0 += amount;
        else claimed1 += amount;
    }

    function donateInventory(bool firstAsset, uint8 wholeSeed) external {
        JITTestToken asset = firstAsset ? asset0 : asset1;
        uint256 amount = bound(uint256(wholeSeed), 1, 5) * (firstAsset ? unit0 : unit1);
        uint256 credit = vault.feeCredits(address(asset));
        asset.transfer(address(vault), amount);
        require(vault.feeCredits(address(asset)) == credit, "unsolicited assets counted as fees");
        if (firstAsset) donations0 += amount;
        else donations1 += amount;
    }

    function _record(bool zeroForOne, uint256 paid) private {
        if (zeroForOne) paid0 += paid;
        else paid1 += paid;
        ++swapCount;
    }

    function _request(bool zeroForOne, int256 specified) private view returns (ArchitexJITExecutor.SwapRequest memory) {
        return ArchitexJITExecutor.SwapRequest({
            zeroForOne: zeroForOne,
            amountSpecified: specified,
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1,
            maximumInput: 1_000_000 * (zeroForOne ? unit0 : unit1),
            minimumOutput: 1,
            recipient: address(this),
            deadline: block.timestamp + 1 hours,
            allowPartialFill: false
        });
    }
}

contract ArchitexJITInvariantTest is JITFixture {
    JITInvariantHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new JITInvariantHandler(vault, hook, executor, asset0, asset1);
        asset0.mint(address(handler), 1_000_000 * unit0);
        asset1.mint(address(handler), 1_000_000 * unit1);
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = JITInvariantHandler.swapExactInput.selector;
        selectors[1] = JITInvariantHandler.swapExactOutput.selector;
        selectors[2] = JITInvariantHandler.collectBaselineFees.selector;
        selectors[3] = JITInvariantHandler.claimFees.selector;
        selectors[4] = JITInvariantHandler.donateInventory.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_noTemporaryPositionOrUnsettledDeltasAtRest() public view {
        _assertRestingState();
    }

    function invariant_actualModelAssetsAreConservedWithoutCountingClaimsTwice() public view {
        _conserved(asset0);
        _conserved(asset1);
    }

    function invariant_feeLiabilitiesAreBackedByActualCashAndClaims() public view {
        assertLe(
            vault.feeCredits(address(asset0)), vault.cashBalance(address(asset0)) + vault.claimBalance(address(asset0))
        );
        assertLe(
            vault.feeCredits(address(asset1)), vault.cashBalance(address(asset1)) + vault.claimBalance(address(asset1))
        );
        assertEq(vault.feesClaimed(address(asset0)), handler.claimed0());
        assertEq(vault.feesClaimed(address(asset1)), handler.claimed1());
        assertEq(asset0.balanceOf(FEE_RECIPIENT), handler.claimed0());
        assertEq(asset1.balanceOf(FEE_RECIPIENT), handler.claimed1());
    }

    function invariant_claimedAndCreditedFeesDoNotExceedTraderFundedSwapFees() public view {
        // Two fixed ranges imply at most three charged swap steps; allow four raw units per cycle for rounding.
        uint256 feeBound0 = handler.paid0() * POOL_FEE / 1_000_000 + handler.swapCount() * 4;
        uint256 feeBound1 = handler.paid1() * POOL_FEE / 1_000_000 + handler.swapCount() * 4;
        assertLe(vault.feeCredits(address(asset0)) + vault.feesClaimed(address(asset0)), feeBound0);
        assertLe(vault.feeCredits(address(asset1)) + vault.feesClaimed(address(asset1)), feeBound1);
    }

    function invariant_historicalPrincipalCannotBeClaimedOrInflatedByUnsolicitedAssets() public view {
        assertEq(vault.principalDeposited(address(asset0)), 1_000_000 * unit0);
        assertEq(vault.principalDeposited(address(asset1)), 1_000_000 * unit1);
    }

    function _conserved(JITTestToken asset) private view {
        uint256 actual = asset.balanceOf(address(this)) + asset.balanceOf(TRADER) + asset.balanceOf(SECOND_TRADER)
            + asset.balanceOf(FEE_RECIPIENT) + asset.balanceOf(address(manager)) + asset.balanceOf(address(vault))
            + asset.balanceOf(address(hook)) + asset.balanceOf(address(executor))
            + asset.balanceOf(address(directRouter)) + asset.balanceOf(address(handler));
        assertEq(actual, asset.totalSupply());
    }
}
