// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AuthorizationFixture, MockUSDCAuth} from "../helpers/AuthorizationFixture.sol";
import {IERC3009} from "../../interfaces/IERC3009.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IArchitexFactory} from "../../interfaces/IArchitexFactory.sol";
import {IArchitexPair} from "../../interfaces/IArchitexPair.sol";
import {IArchitexRouter} from "../../interfaces/IArchitexRouter.sol";
import {IArchitexLens} from "../../interfaces/IArchitexLens.sol";
import {ArchitexLaunchpad} from "../../launchpad/ArchitexLaunchpad.sol";
import {ArchitexBBS} from "../../ArchitexBBS.sol";

/// @notice ARC_MAINNET_RPC=https://rpc.mainnet.arc.io forge test --match-contract AgentsMainnetForkTest
/// @dev Native-USDC domain and refusal tests use the actual mainnet bytecode. Positive payment
///      integration uses an explicitly named USDC MODEL at a different address because a local EVM
///      cannot execute Arc's native balance precompile. This is not mainnet acceptance evidence.
contract AgentsMainnetForkTest is AuthorizationFixture {
    address constant NATIVE_USDC = 0x3600000000000000000000000000000000000000;
    bool internal forked;
    address internal existingFactory;
    address internal existingRouter;
    address internal existingLens;

    function setUp() public override {
        string memory rpc = vm.envOr("ARC_MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        require(block.chainid == 5042, "expected Arc MAINNET 5042");
        forked = true;
        super.setUp();
        existingFactory = vm.envOr("ARC_MAINNET_FACTORY", address(0));
        existingRouter = vm.envOr("ARC_MAINNET_ROUTER", address(0));
        existingLens = vm.envOr("ARC_MAINNET_LENS", address(0));
        if (existingFactory != address(0)) {
            assertGt(existingFactory.code.length, 0);
            // Modelled USDC remains separate from native USDC, and core bytecode comes from mainnet.
            pad = new ArchitexLaunchpad(address(usdc), existingFactory, feeTo, setter, 250_000);
            vm.prank(setter);
            pad.setRelayer(relayer, true);
            bbs = new ArchitexBBS(address(usdc), address(pad), feeTo, setter);
        }
    }
    modifier onlyFork() {
        if (!forked) { vm.skip(true); return; }
        _;
    }
    function test_fork_actualUsdcDomainAndDecimals() public onlyFork {
        assertGt(NATIVE_USDC.code.length, 0);
        assertEq(IERC20Metadata(NATIVE_USDC).name(), "USDC");
        assertEq(IERC20Metadata(NATIVE_USDC).decimals(), 6);
        bytes32 expected = keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), keccak256("USDC"), keccak256("2"), uint256(5042), NATIVE_USDC));
        assertEq(IERC3009(NATIVE_USDC).DOMAIN_SEPARATOR(), expected);
    }
    function test_fork_actualUsdcReceiveIsRecipientOnly() public onlyFork {
        vm.expectRevert(bytes("FiatTokenV2: caller must be the payee"));
        IERC3009(NATIVE_USDC).receiveWithAuthorization(alice, bob, 1, 0, type(uint256).max, keccak256("native receive refusal"), hex"");
    }
    function test_fork_actualUsdcBytesTransferRejectsInvalidSignature() public onlyFork {
        vm.expectRevert(bytes("ECRecover: invalid signature length"));
        IERC3009(NATIVE_USDC).transferWithAuthorization(alice, bob, 1, 0, type(uint256).max, keccak256("native transfer refusal"), hex"");
    }
    function test_fork_modelledPaymentsGraduateIntoFactoryPair() public onlyFork {
        (address token,) = _launch(0, false);
        _buy(token, 30_000e6, ALICE_KEY, true);
        address pair = pad.curves(token).pair;
        assertTrue(pad.curves(token).graduated);
        assertGt(pair.code.length, 0);
        assertEq(IArchitexFactory(pad.factory()).getPair(token, address(usdc)), pair);
        assertEq(usdc.balanceOf(pair), 24_999_999_968);
        _assertAccounting();
    }
    function test_fork_existingCoreWiringWhenConfigured() public onlyFork {
        if (existingFactory == address(0) || existingRouter == address(0) || existingLens == address(0)) { vm.skip(true); return; }
        assertEq(IArchitexRouter(existingRouter).factory(), existingFactory);
        assertEq(IArchitexLens(existingLens).factory(), existingFactory);
        assertEq(IArchitexLens(existingLens).router(), existingRouter);
    }
}
