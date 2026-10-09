// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {JITFixture, ArcNativeJITSimulation, IJITNativeUSDC, JITHookAddress} from "../helpers/JITFixture.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

interface IArcUSDCMetadata {
    function name() external view returns (string memory);
    function decimals() external view returns (uint8);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
}

/// @notice Pinned deployed-contract checks. Ordinary Forge executes liquidity against a distinct USDC MODEL.
/// @dev Real native-USDC positive simulation additionally requires verified Arc Forge --network arc.
///      All capital is fork/state-override capital; nothing here constitutes funded mainnet acceptance.
contract ArchitexJITArcForkTest is JITFixture {
    address private constant NATIVE_USDC = 0x3600000000000000000000000000000000000000;
    address private constant DEPLOYED_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    bytes32 private constant MANAGER_CODE_HASH = 0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626;
    uint256 private constant PINNED_BLOCK = 25_019_963;
    bool private forked;

    function setUp() public override {
        string memory rpc = vm.envOr("ARC_MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc, PINNED_BLOCK);
        require(block.chainid == 5042 && block.number == PINNED_BLOCK, "wrong Arc fork");
        forked = true;
        _buildFixture(IPoolManager(DEPLOYED_MANAGER), true, true);
    }

    modifier onlyFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    function test_fork_deployedPoolManagerRuntimePinned() public onlyFork {
        assertEq(DEPLOYED_MANAGER.code.length, 24_009);
        assertEq(DEPLOYED_MANAGER.codehash, MANAGER_CODE_HASH);
        assertEq(address(manager), DEPLOYED_MANAGER);
    }

    function test_fork_realNativeUSDCMetadataAndDomain() public onlyFork {
        assertGt(NATIVE_USDC.code.length, 0);
        assertEq(IArcUSDCMetadata(NATIVE_USDC).name(), "USDC");
        assertEq(IArcUSDCMetadata(NATIVE_USDC).decimals(), 6);
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("USDC"),
                keccak256("2"),
                uint256(5042),
                NATIVE_USDC
            )
        );
        assertEq(IArcUSDCMetadata(NATIVE_USDC).DOMAIN_SEPARATOR(), expected);
    }

    function test_fork_realNativeUSDCRejectsWrongPayeeAndInvalidSignature() public onlyFork {
        vm.expectRevert(bytes("FiatTokenV2: caller must be the payee"));
        IArcUSDCMetadata(NATIVE_USDC)
            .receiveWithAuthorization(
                TRADER, SECOND_TRADER, 1, 0, type(uint256).max, keccak256("JIT native refusal payee"), hex""
            );
        vm.expectRevert(bytes("ECRecover: invalid signature length"));
        IArcUSDCMetadata(NATIVE_USDC)
            .transferWithAuthorization(
                TRADER, SECOND_TRADER, 1, 0, type(uint256).max, keccak256("JIT native refusal signature"), hex""
            );
    }

    function test_fork_distinctUSDCModelExecutesFourSwapModesAgainstActualManager() public onlyFork {
        assertTrue(address(quote) != NATIVE_USDC, "do not replace native USDC with model");
        assertEq(token.decimals(), 18);
        assertEq(quote.decimals(), 6);
        for (uint256 i; i < 2; ++i) {
            bool zeroForOne = i == 0;
            uint256 input = _wholeInput(zeroForOne, 1_000);
            (uint256 paid, uint256 output) = _execute(zeroForOne, -int256(input));
            assertEq(paid, input);
            assertGt(output, 0);
            uint256 wanted = _wholeOutput(zeroForOne, 500);
            (paid, output) = _execute(zeroForOne, int256(wanted));
            assertGt(paid, 0);
            assertEq(output, wanted);
        }
        assertEq(hook.jitCycles(), 4);
        _assertRestingState();
        _assertTokenConservation();
    }

    function test_fork_distinctUSDCModelFeeClaimsDoNotConsumeInventory() public onlyFork {
        _execute(true, -int256(_wholeInput(true, 1_000)));
        _execute(false, -int256(_wholeInput(false, 1_000)));
        hook.collectBaselineFees();
        for (uint256 i; i < 2; ++i) {
            address asset = i == 0 ? address(asset0) : address(asset1);
            uint256 inventory = vault.availableInventory(asset);
            uint256 credit = vault.feeCredits(asset);
            assertGt(credit, 0);
            vault.claimFees(asset, credit);
            assertEq(vault.availableInventory(asset), inventory);
            assertEq(vault.feeCredits(asset), 0);
        }
        _assertRestingState();
        _assertTokenConservation();
    }

    function test_fork_realNativeUSDCPositiveLifecycleOnArcRuntime() public onlyFork {
        if (!vm.envOr("ARC_NATIVE_FORK", false)) {
            vm.skip(true);
            return;
        }
        address harnessAddress = address(0xA000000000000000000000000000000000000001);
        vm.etch(harnessAddress, type(ArcNativeJITSimulation).runtimeCode);
        vm.setNonce(harnessAddress, 1);
        vm.deal(harnessAddress, 1_100_000e18);
        // This assertion fails on a stock local EVM, proving the native-USDC bridge is actually running.
        assertEq(IJITNativeUSDC(NATIVE_USDC).balanceOf(harnessAddress), 1_100_000e6);
        ArcNativeJITSimulation harness = ArcNativeJITSimulation(harnessAddress);
        address predictedModel = vm.computeCreateAddress(harnessAddress, 1);
        address predictedVault = vm.computeCreateAddress(harnessAddress, 2);
        uint64 validity = uint64(block.timestamp + 1 days);
        bytes32 initHash = keccak256(harness.hookCreationCode(predictedModel, predictedVault, validity));
        bytes32 salt = JITHookAddress.mine(harnessAddress, initHash, HOOK_FLAGS);
        ArcNativeJITSimulation.Result memory result = harness.run(salt, validity);
        assertEq(result.modelToken, predictedModel);
        assertEq(result.vault, predictedVault);
        assertGt(result.firstInput, 0);
        assertGt(result.firstOutput, 0);
        assertGt(result.secondInput, 0);
        assertGt(result.secondOutput, 0);
        assertEq(result.completedJITCycles, 2);
        assertEq(result.activeJITLiquidity, 0);
        assertEq(result.baselineLiquidity, BASELINE_LIQUIDITY);
        assertEq(result.openDeltas, 0);
        assertEq(result.tokenFeesClaimed, result.tokenFees);
        assertEq(result.usdcFeesClaimed, result.usdcFees);
        emit log_named_uint("Arc.native.USDC.firstInput.raw", result.firstInput);
        emit log_named_uint("Arc.native.USDC.firstOutput.raw", result.firstOutput);
        emit log_named_uint("Arc.native.USDC.secondInput.raw", result.secondInput);
        emit log_named_uint("Arc.native.USDC.secondOutput.raw", result.secondOutput);
        emit log_named_uint("Arc.native.firstExecutionGas", result.firstExecutionGas);
        emit log_named_uint("Arc.native.secondExecutionGas", result.secondExecutionGas);
        emit log_named_uint("Arc.native.modelToken.cash.preClaim.raw", result.tokenCash);
        emit log_named_uint("Arc.native.modelToken.claims.preClaim.raw", result.tokenClaims);
        emit log_named_uint("Arc.native.USDC.cash.preClaim.raw", result.usdcCash);
        emit log_named_uint("Arc.native.USDC.claims.preClaim.raw", result.usdcClaims);
        emit log_named_uint("Arc.native.modelToken.allLPFees.raw", result.tokenFees);
        emit log_named_uint("Arc.native.USDC.allLPFees.raw", result.usdcFees);
        emit log_named_uint("Arc.native.modelToken.cash.postClaim.raw", result.postClaimTokenCash);
        emit log_named_uint("Arc.native.modelToken.claims.postClaim.raw", result.postClaimTokenClaims);
        emit log_named_uint("Arc.native.USDC.cash.postClaim.raw", result.postClaimUSDCCash);
        emit log_named_uint("Arc.native.USDC.claims.postClaim.raw", result.postClaimUSDCClaims);
    }
}
