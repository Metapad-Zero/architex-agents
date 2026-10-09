// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {ArchitexJITFactory} from "../../src/ArchitexJITFactory.sol";
import {ArchitexJITVault} from "../../src/ArchitexJITVault.sol";
import {ArchitexJITHook} from "../../src/ArchitexJITHook.sol";
import {JITFactoryFixture} from "../ArchitexJITFactory.t.sol";
import {JITTestToken} from "../helpers/JITFixture.sol";
import {IArcJITQuoter} from "./ArchitexJITArcFork.t.sol";

/// @notice Fork capital is synthetic. No broadcast, funded acceptance, audit or Firepan approval is implied.
contract ArchitexJITFactoryArcForkTest is JITFactoryFixture {
    address private constant NATIVE_USDC = 0x3600000000000000000000000000000000000000;
    address private constant DEPLOYED_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    bytes32 private constant MANAGER_CODE_HASH = 0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626;
    uint256 private constant PINNED_BLOCK = 25_019_963;
    address private constant DEPLOYED_QUOTER = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;
    bool private forked;
    bool private native;

    function setUp() public {
        string memory rpc = vm.envOr("ARC_MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc, PINNED_BLOCK);
        require(block.chainid == 5042 && block.number == PINNED_BLOCK, "wrong Arc fork");
        require(DEPLOYED_MANAGER.codehash == MANAGER_CODE_HASH, "wrong manager runtime");
        forked = true;
        native = vm.envOr("ARC_NATIVE_FORK", false);
        IERC20 quote_;
        if (native) {
            vm.deal(CREATOR, 1_000_000e18);
            quote_ = IERC20(NATIVE_USDC);
            require(quote_.balanceOf(CREATOR) == 1_000_000e6, "Arc native balance precompile required");
        } else {
            JITTestToken model = new JITTestToken("USDC FORK TEST MODEL", "USDC_MODEL", 6);
            model.mint(CREATOR, 1_000_000e6);
            quote_ = IERC20(address(model));
        }
        _buildFactory(IPoolManager(DEPLOYED_MANAGER), quote_);
    }

    modifier onlyFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    function test_fork_predictionAndAtomicFactoryLaunchAgainstUntouchedDeployedManager() public onlyFork {
        ArchitexJITFactory.LaunchPrediction memory predicted = factory.predictLaunch(CREATOR, config);
        ArchitexJITFactory.LaunchRecord memory record = _launch(CREATOR, config);
        assertEq(record.token, predicted.token);
        assertEq(record.vault, predicted.vault);
        assertEq(record.hook, predicted.hook);
        assertEq(record.executor, predicted.executor);
        assertEq(ArchitexJITVault(record.vault).principalDeposited(record.token), SUPPLY);
        assertEq(ArchitexJITVault(record.vault).principalDeposited(address(quote)), SEED_USDC);
        assertEq(DEPLOYED_MANAGER.codehash, MANAGER_CODE_HASH);
        assertEq(IERC20(record.token).balanceOf(CREATOR), 0);
        _assertResting(record);
    }

    function test_fork_buySellAndFeeClaimsWithProductionFixedSupplyToken() public onlyFork {
        ArchitexJITFactory.LaunchRecord memory record = _launch(CREATOR, config);
        (, uint256 bought) = _swap(record, true, 1_000e6);
        _swap(record, false, bought / 2);
        ArchitexJITVault vault = ArchitexJITVault(record.vault);
        assertEq(ArchitexJITHook(record.hook).jitCycles(), 2);
        for (uint256 i; i < 2; ++i) {
            address asset = i == 0 ? record.token : address(quote);
            uint256 principal = vault.availableInventory(asset);
            uint256 credit = vault.feeCredits(asset);
            uint256 recipientBalance = IERC20(asset).balanceOf(FEE_RECIPIENT);
            assertGt(credit, 0);
            vault.claimFees(asset, credit);
            assertEq(IERC20(asset).balanceOf(FEE_RECIPIENT), recipientBalance + credit);
            assertEq(vault.availableInventory(asset), principal);
        }
        _assertResting(record);
        assertEq(DEPLOYED_MANAGER.codehash, MANAGER_CODE_HASH);
        if (native) assertEq(address(quote), NATIVE_USDC);
        else assertTrue(address(quote) != NATIVE_USDC, "model evidence must remain labeled");
    }

    function test_fork_underfundedInitialJITRollsBackCodeCapitalAndNonce() public onlyFork {
        (uint256 baseline0, uint256 baseline1) = _amounts(config, false);
        (uint256 jit0, uint256 jit1) = _amounts(config, true);
        bool quoteIs0 = address(quote) < factory.predictLaunch(CREATOR, config).token;
        config.seedUSDC = quoteIs0 ? baseline0 + jit0 - 1 : baseline1 + jit1 - 1;
        ArchitexJITFactory.LaunchPrediction memory p = factory.predictLaunch(CREATOR, config);
        uint256 beforeBalance = quote.balanceOf(CREATOR);
        vm.prank(CREATOR);
        quote.approve(address(factory), config.seedUSDC);
        vm.prank(CREATOR);
        vm.expectRevert(ArchitexJITFactory.InsufficientInitialCapital.selector);
        factory.launch(config);
        _assertRollback(p, beforeBalance);
    }

    function test_fork_officialQuoterMatchesProductionTokenBothDirectionsWithoutPersistingState() public onlyFork {
        assertEq(DEPLOYED_QUOTER.codehash, 0xd707b1da8cb165e5ea35a3b4450d971eb562ec171e23492aa117036b78a868f6);
        assertEq(address(IArcJITQuoter(DEPLOYED_QUOTER).poolManager()), address(manager));
        ArchitexJITFactory.LaunchRecord memory record = _launch(CREATOR, config);
        ArchitexJITHook hook = ArchitexJITHook(record.hook);
        ArchitexJITVault vault = ArchitexJITVault(record.vault);
        for (uint256 i; i < 2; ++i) {
            bool quoteInput = i == 0;
            uint256 input = quoteInput ? 1_000e6 : IERC20(record.token).balanceOf(CREATOR) / 2;
            uint256 inventory0 = vault.availableInventory(vault.currency0());
            uint256 inventory1 = vault.availableInventory(vault.currency1());
            uint256 fees0 = vault.feeCredits(vault.currency0());
            uint256 fees1 = vault.feeCredits(vault.currency1());
            uint160 price = hook.currentSqrtPriceX96();
            uint256 cycles = hook.jitCycles();
            bool zeroForOne = quoteInput ? address(quote) < record.token : record.token < address(quote);
            (uint256 quoted, uint256 quoteGas) = IArcJITQuoter(DEPLOYED_QUOTER)
                .quoteExactInputSingle(
                    IArcJITQuoter.ExactInputSingle(hook.getPoolKey(), zeroForOne, uint128(input), bytes(""))
                );
            assertGt(quoted, 0);
            assertGt(quoteGas, 0);
            assertEq(hook.currentSqrtPriceX96(), price);
            assertEq(hook.jitCycles(), cycles);
            assertEq(vault.availableInventory(vault.currency0()), inventory0);
            assertEq(vault.availableInventory(vault.currency1()), inventory1);
            assertEq(vault.feeCredits(vault.currency0()), fees0);
            assertEq(vault.feeCredits(vault.currency1()), fees1);
            (, uint256 actual) = _swap(record, quoteInput, input);
            assertEq(actual, quoted);
            assertEq(hook.jitCycles(), cycles + 1);
            _assertResting(record);
        }
        if (native) assertEq(address(quote), NATIVE_USDC);
        else assertTrue(address(quote) != NATIVE_USDC, "model evidence must remain labeled");
    }
}
