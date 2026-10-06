// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Test.sol";

import {AuthorizationFixture, Mock1271Wallet, MockUSDCAuth, IUsdcHook} from "./helpers/AuthorizationFixture.sol";
import {ArchitexLaunchpad} from "../launchpad/ArchitexLaunchpad.sol";
import {LaunchToken} from "../launchpad/LaunchToken.sol";
import {IArchitexLaunchpad} from "../interfaces/IArchitexLaunchpad.sol";
import {IERC3009} from "../interfaces/IERC3009.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IArchitexPair} from "../interfaces/IArchitexPair.sol";
import {AuthorizationGate} from "../agents/AuthorizationGate.sol";

contract CollectReentryProbe is IUsdcHook {
    ArchitexLaunchpad immutable pad;
    bool public refused;
    constructor(ArchitexLaunchpad p) { pad = p; }
    function onUsdcReceived() external {
        (bool success,) = address(pad).call(abi.encodeCall(pad.collectFees, ()));
        refused = !success;
        require(!success, "reentrancy succeeded");
    }
}

contract ArchitexLaunchpadTest is AuthorizationFixture {
    function doLaunch(uint256 initial, bool bound) external returns (address, uint256) { return _launch(initial, bound); }
    function doBuy(address token, uint256 amount) external returns (uint256, uint256) { return _buy(token, amount, ALICE_KEY, false); }
    function doSell(address token, uint256 amount) external returns (uint256) { return _sell(token, amount, ALICE_KEY, false); }

    function test_constantsAndDefaults() public view {
        assertEq(pad.TOTAL_SUPPLY(), 1_000_000_000e18);
        assertEq(pad.CURVE_SUPPLY(), 800_000_000e18);
        assertEq(pad.POOL_SUPPLY(), 200_000_000e18);
        assertEq(pad.VIRTUAL_USDC_0(), 8_333_333_333);
        assertEq(pad.FEE_BPS(), 12);
        assertEq(pad.launchRelayFee(), 150_000);
        assertEq(pad.tradeRelayFee(), 10_000);
    }
    function test_zeroAddressConstructor() public {
        vm.expectRevert(IArchitexLaunchpad.ZeroAddress.selector);
        new ArchitexLaunchpad(address(0), address(factory), feeTo, setter, 0);
    }
    function test_launchFeeCapConstructor() public {
        vm.expectRevert(IArchitexLaunchpad.LaunchFeeTooHigh.selector);
        new ArchitexLaunchpad(address(usdc), address(factory), feeTo, setter, 100e6 + 1);
    }
    function test_relayedLaunchActorAndInitialBuy() public {
        uint256 before = usdc.balanceOf(alice);
        (address token, uint256 got) = _launch(100e6, false);
        assertEq(pad.curves(token).creator, alice);
        assertEq(IERC20(token).balanceOf(alice), got);
        assertEq(before - usdc.balanceOf(alice), 100e6 + 400_000);
        assertEq(usdc.balanceOf(relayer), 150_000);
        assertEq(pad.pendingFees(), 250_000 + 120_000);
        _assertAccounting();
    }
    function test_boundLaunchAnySubmitterReceivesOnlyRelayFee() public {
        (address token,) = _launch(10e6, true);
        assertEq(pad.curves(token).creator, alice);
        assertGt(IERC20(token).balanceOf(alice), 0);
        assertEq(IERC20(token).balanceOf(mallory), 0);
        assertEq(usdc.balanceOf(mallory), 10_000_000e6 + 150_000);
    }
    function test_buyBothRelayModes() public {
        (address token,) = _launch(0, false);
        (uint256 first,) = _buy(token, 20e6, ALICE_KEY, false);
        (uint256 second,) = _buy(token, 20e6, BOB_KEY, true);
        assertEq(IERC20(token).balanceOf(alice), first);
        assertEq(IERC20(token).balanceOf(bob), second);
        assertEq(IERC20(token).balanceOf(relayer), 0);
        _assertAccounting();
    }
    function test_sellBothRelayModes() public {
        (address token,) = _launch(0, false);
        (uint256 held,) = _buy(token, 100e6, ALICE_KEY, true);
        uint256 before = usdc.balanceOf(alice);
        uint256 outA = _sell(token, held / 2, ALICE_KEY, false);
        uint256 outB = _sell(token, held - held / 2, ALICE_KEY, true);
        assertEq(usdc.balanceOf(alice) - before, outA + outB);
        assertEq(pad.curves(token).tokensSold, 0);
        assertEq(IERC20(token).balanceOf(alice), 0);
        _assertAccounting();
    }
    function test_sellNetSlippageIncludesRelayFee() public {
        (address token,) = _launch(0, false);
        (uint256 held,) = _buy(token, 100e6, ALICE_KEY, false);
        (uint256 quoted,) = pad.quoteSell(token, held);
        IERC3009.Authorization memory auth = _auth(alice, held, _nextNonce());
        bytes memory sig = _signature(token, address(pad), auth, ALICE_KEY);
        vm.prank(relayer);
        vm.expectRevert(IArchitexLaunchpad.SlippageExceeded.selector);
        pad.sellWithAuthorization(token, quoted, bytes32(0), auth, sig);
        assertFalse(LaunchToken(token).authorizationState(alice, auth.nonce));
    }
    function test_sellProceedsMustCoverRelayFee() public {
        (address token,) = _launch(0, false);
        (uint256 held,) = _buy(token, 100e6, ALICE_KEY, false);
        vm.expectRevert(IArchitexLaunchpad.RelayFeeExceedsProceeds.selector);
        this.doSell(token, held / 100_000);
    }
    function test_sellCannotPullOtherHoldersTokens() public {
        (address token,) = _launch(0, false);
        (uint256 held,) = _buy(token, 100e6, ALICE_KEY, false);
        IERC3009.Authorization memory auth = _auth(alice, held, _nextNonce());
        bytes memory sig = _signature(token, address(pad), auth, MALLORY_KEY);
        vm.prank(relayer);
        vm.expectRevert(IERC3009.InvalidSignature.selector);
        pad.sellWithAuthorization(token, 0, bytes32(0), auth, sig);
        assertEq(IERC20(token).balanceOf(alice), held);
    }
    function test_unknownTokenAndZeroAmount() public {
        vm.expectRevert(IArchitexLaunchpad.UnknownToken.selector);
        this.doBuy(address(0xBAD), 1e6);
        (address token,) = _launch(0, false);
        vm.expectRevert(IArchitexLaunchpad.ZeroAmount.selector);
        this.doBuy(token, 0);
        vm.expectRevert(IArchitexLaunchpad.ZeroAmount.selector);
        this.doSell(token, 0);
    }
    function test_sellOutRefundAndGraduation() public {
        (address token,) = _launch(0, false);
        uint256 before = usdc.balanceOf(alice);
        (uint256 tokens, uint256 spent) = _buy(token, 30_000e6, ALICE_KEY, false);
        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        assertEq(tokens, pad.CURVE_SUPPLY());
        assertEq(before - usdc.balanceOf(alice), spent + pad.tradeRelayFee());
        assertEq(spent, 25_030_036_012);
        assertTrue(c.graduated);
        assertEq(usdc.balanceOf(c.pair), 24_999_999_968);
        assertEq(IERC20(token).balanceOf(c.pair), pad.POOL_SUPPLY());
        IArchitexPair pair = IArchitexPair(c.pair);
        assertEq(pair.balanceOf(0x000000000000000000000000000000000000dEaD), pair.totalSupply());
        assertEq(pad.liveCurveReserves(), 0);
        assertEq(usdc.balanceOf(address(pad)), pad.pendingFees());
    }
    function test_initialBuyCanGraduateAndRefund() public {
        uint256 before = usdc.balanceOf(alice);
        (address token, uint256 got) = _launch(30_000e6, true);
        assertEq(got, pad.CURVE_SUPPLY());
        assertEq(before - usdc.balanceOf(alice), 25_030_036_012 + 400_000);
        assertTrue(pad.curves(token).graduated);
        _assertAccounting();
    }
    function test_graduatedCurveRejectsTrading() public {
        (address token,) = _launch(30_000e6, false);
        vm.expectRevert(IArchitexLaunchpad.CurveGraduated.selector);
        this.doBuy(token, 1e6);
        vm.expectRevert(IArchitexLaunchpad.CurveGraduated.selector);
        this.doSell(token, 1e18);
        assertEq(pad.progressBps(token), 10_000);
    }
    function test_secondCurveStaysSolventWhenFirstGraduates() public {
        (address a,) = _launch(0, false);
        (address b,) = _launch(0, true);
        (uint256 held,) = _buy(b, 4_000e6, BOB_KEY, false);
        _buy(a, 30_000e6, ALICE_KEY, true);
        _sell(b, held, BOB_KEY, false);
        _assertAccounting();
        assertEq(pad.curves(b).tokensSold, 0);
    }
    function test_blocklistedFeeRecipientDoesNotFreezeActions() public {
        usdc.setBlocked(feeTo, true);
        (address token,) = _launch(100e6, false);
        _buy(token, 200e6, BOB_KEY, false);
        _sell(token, IERC20(token).balanceOf(alice), ALICE_KEY, false);
        _buy(token, 30_000e6, BOB_KEY, true);
        uint256 fees = pad.pendingFees();
        vm.expectRevert(bytes("blocklisted"));
        pad.collectFees();
        assertEq(pad.pendingFees(), fees);
    }
    function test_feeCollectionIsPermissionlessAndExact() public {
        (address token,) = _launch(100e6, false);
        _buy(token, 20e6, BOB_KEY, false);
        uint256 amount = pad.pendingFees();
        vm.prank(mallory);
        assertEq(pad.collectFees(), amount);
        assertEq(usdc.balanceOf(feeTo), amount);
        assertEq(pad.pendingFees(), 0);
        _assertAccounting();
    }
    function test_flatFeeAdminAndCaps() public {
        vm.prank(mallory);
        vm.expectRevert(IArchitexLaunchpad.Forbidden.selector);
        pad.setRelayFees(1, 1);
        vm.startPrank(setter);
        vm.expectRevert(IArchitexLaunchpad.RelayFeeTooHigh.selector);
        pad.setRelayFees(50_001, 1);
        vm.expectRevert(IArchitexLaunchpad.RelayFeeTooHigh.selector);
        pad.setRelayFees(1, 500_001);
        pad.setRelayFees(50_000, 500_000);
        vm.stopPrank();
        assertEq(pad.tradeRelayFee(), 50_000);
        assertEq(pad.launchRelayFee(), 500_000);
    }
    function test_recipientSetterAndLaunchFeeAdmin() public {
        vm.startPrank(setter);
        vm.expectRevert(IArchitexLaunchpad.ZeroAddress.selector);
        pad.setFeeTo(address(pad));
        vm.expectRevert(IArchitexLaunchpad.LaunchFeeTooHigh.selector);
        pad.setLaunchFee(100e6 + 1);
        pad.setFeeTo(bob);
        pad.setLaunchFee(100e6);
        pad.setFeeToSetter(bob);
        vm.stopPrank();
        vm.prank(setter);
        vm.expectRevert(IArchitexLaunchpad.Forbidden.selector);
        pad.setRelayer(mallory, true);
        assertEq(pad.feeTo(), bob);
    }
    function test_feeAdminRenounceIsIrreversible() public {
        vm.prank(setter);
        pad.setFeeToSetter(address(0));
        vm.prank(setter);
        vm.expectRevert(IArchitexLaunchpad.Forbidden.selector);
        pad.setLaunchFee(1);
    }
    function test_paymentUnderpaymentRevertsAtomically() public {
        usdc.setUnderpay(true);
        vm.expectPartialRevert(AuthorizationGate.PaymentAmountMismatch.selector);
        this.doLaunch(0, false);
        assertEq(pad.tokensLength(), 0);
        assertEq(pad.pendingFees(), 0);
    }
    function test_reentrancyCannotCollectUnfinishedAccounting() public {
        CollectReentryProbe probe = new CollectReentryProbe(pad);
        usdc.setHook(address(probe));
        (address token,) = _launch(0, false);
        bytes32 salt = _nextNonce();
        IERC3009.Authorization memory auth = _auth(alice, 1e6 + pad.tradeRelayFee(), pad.buyNonce(token, 0, salt));
        bytes memory sig = _signature(address(usdc), address(pad), auth, ALICE_KEY);
        vm.prank(address(probe));
        pad.buyWithAuthorization(token, 0, salt, auth, sig, bytes32(0));
        assertTrue(probe.refused());
        _assertAccounting();
    }
    function test_readPaginationAndUnknownCurve() public {
        for (uint256 i; i < 3; ++i) _launch(0, false);
        assertEq(pad.curvesPage(0, type(uint256).max).length, 3);
        assertEq(pad.curvesPage(2, 100).length, 1);
        assertEq(pad.curvesPage(4, 100).length, 0);
        vm.expectRevert(IArchitexLaunchpad.UnknownToken.selector);
        pad.curves(address(0xDEAD));
    }
    function test_legacyUnsignedEntrypointsAreAbsent() public {
        bytes4[3] memory selectors = [bytes4(keccak256("createToken(string,string,string,uint256,uint256)")), bytes4(keccak256("buy(address,uint256,uint256,address)")), bytes4(keccak256("sell(address,uint256,uint256,address)"))];
        for (uint256 i; i < selectors.length; ++i) {
            (bool success,) = address(pad).call(abi.encodeWithSelector(selectors[i]));
            assertFalse(success);
        }
    }
    function test_actorInIndexingEventsIsAuthorizer() public {
        vm.recordLogs();
        (address token,) = _launch(10e6, false);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 created = keccak256("TokenCreated(address,address,address,string,string,string)");
        bytes32 trade = keccak256("Trade(address,address,bool,uint256,uint256,uint256,uint256,uint256)");
        bool sawCreated;
        bool sawTrade;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(pad)) continue;
            if (logs[i].topics[0] == created || logs[i].topics[0] == trade) {
                assertEq(address(uint160(uint256(logs[i].topics[2]))), alice);
                if (logs[i].topics[0] == created) sawCreated = true;
                else sawTrade = true;
            }
        }
        assertTrue(sawCreated && sawTrade);
        assertEq(pad.curves(token).creator, alice);
    }
    function test_gasActionEstimatesWithUsdcModel() public {
        IArchitexLaunchpad.LaunchParams memory p = _params(0);
        IERC3009.Authorization memory auth = _auth(alice, 400_000, _nextNonce());
        bytes memory sig = _signature(address(usdc), address(pad), auth, ALICE_KEY);
        vm.prank(relayer);
        uint256 start = gasleft();
        (address token,) = pad.launchWithAuthorization(p, bytes32(0), auth, sig, bytes32(0));
        emit log_named_uint("model gas: launch", start - gasleft());
        auth = _auth(alice, 100e6 + pad.tradeRelayFee(), _nextNonce());
        sig = _signature(address(usdc), address(pad), auth, ALICE_KEY);
        vm.prank(relayer);
        start = gasleft();
        (uint256 held,) = pad.buyWithAuthorization(token, 0, bytes32(0), auth, sig, bytes32(0));
        emit log_named_uint("model gas: buy", start - gasleft());
        auth = _auth(alice, held, _nextNonce());
        sig = _signature(token, address(pad), auth, ALICE_KEY);
        vm.prank(relayer);
        start = gasleft();
        pad.sellWithAuthorization(token, 0, bytes32(0), auth, sig);
        emit log_named_uint("model gas: sell", start - gasleft());
        auth = _auth(alice, 20_000, _nextNonce());
        sig = _signature(address(usdc), address(bbs), auth, ALICE_KEY);
        vm.prank(relayer);
        start = gasleft();
        bbs.postWithAuthorization("a gas estimate is not a mainnet receipt", bytes32(0), auth, sig, bytes32(0));
        emit log_named_uint("model gas: post", start - gasleft());
    }

}
