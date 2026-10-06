// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AuthorizationFixture, MockUSDCAuth} from "./helpers/AuthorizationFixture.sol";
import {ArchitexLaunchpad} from "../launchpad/ArchitexLaunchpad.sol";
import {IArchitexLaunchpad} from "../interfaces/IArchitexLaunchpad.sol";
import {IERC3009} from "../interfaces/IERC3009.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice Historical curve vectors now executed through real signed-payment entrypoints.
contract ArchitexLaunchpadV11Test is AuthorizationFixture {
    function setUp() public override {
        super.setUp();
        vm.startPrank(setter);
        pad.setRelayFees(0, 0);
        pad.setLaunchFee(0);
        vm.stopPrank();
    }
    function test_vector_start() public {
        (address token,) = _launch(0, false);
        assertEq(pad.spotPrice(token), 7812499997246093750);
        assertEq(pad.marketCap(token), 6249999997);
        assertEq(pad.progressBps(token), 0);
    }
    function test_vector_V1_buyThenV3Sell() public {
        (address token,) = _launch(0, false);
        (uint256 quoted, uint256 fee,,) = pad.quoteBuy(token, 100e6);
        (uint256 got, uint256 spent) = _buy(token, 100e6, ALICE_KEY, false);
        assertEq(got, 12633223243987393624730920);
        assertEq(got, quoted);
        assertEq(spent, 100e6);
        assertEq(fee, 120_000);
        assertEq(pad.curves(token).virtualUsdc, 8433213333);
        assertEq(pad.curves(token).virtualTokens, 1054033443756012606375269080);
        (uint256 qOut, uint256 sellFee) = pad.quoteSell(token, got);
        assertEq(_sell(token, got, ALICE_KEY, true), 99_760_143);
        assertEq(qOut, 99_760_143);
        assertEq(sellFee, 119_856);
        assertEq(pad.pendingFees(), 239_856);
        assertEq(pad.curves(token).tokensSold, 0);
        _assertAccounting();
    }
    function test_vector_V2SellOutAndV4Boundary() public {
        (address below,) = _launch(0, false);
        (address at,) = _launch(0, true);
        (uint256 tokensBelow, uint256 spentBelow) = _buy(below, 25_030_036_011, ALICE_KEY, false);
        assertLt(tokensBelow, pad.CURVE_SUPPLY());
        assertEq(spentBelow, 25_030_036_011);
        assertFalse(pad.curves(below).graduated);
        (uint256 tokensAt, uint256 spentAt) = _buy(at, 25_030_036_012, BOB_KEY, true);
        assertEq(tokensAt, pad.CURVE_SUPPLY());
        assertEq(spentAt, 25_030_036_012);
        assertEq(pad.curves(at).virtualUsdc, 33_333_333_301);
        assertEq(pad.marketCap(at), 99_999_999_778);
        assertEq(pad.spotPrice(at), 124999999722500000346);
        assertTrue(pad.curves(at).graduated);
        _assertAccounting();
    }
    function test_vector_V5Dust() public {
        (address token,) = _launch(0, false);
        (uint256 got, uint256 spent) = _buy(token, 199, ALICE_KEY, false);
        assertEq(got, 25343999406760334071);
        assertEq(spent, 199);
        assertEq(pad.pendingFees(), 1);
        vm.expectRevert(IArchitexLaunchpad.ZeroAmount.selector);
        pad.quoteBuy(token, 1);
    }
    function test_donatedUsdcCannotAlterGraduationAmount() public {
        (address token,) = _launch(0, false);
        usdc.mint(address(pad), 100e6);
        _buy(token, 30_000e6, ALICE_KEY, false);
        assertEq(usdc.balanceOf(pad.curves(token).pair), 24_999_999_968);
        assertEq(usdc.balanceOf(address(pad)) - pad.pendingFees(), 100e6);
        _assertAccounting();
    }
    function testFuzz_roundTripNeverExtractsCurveValue(uint64 raw) public {
        uint256 amount = bound(raw, 1e4, 10_000e6);
        (address token,) = _launch(0, false);
        (uint256 got, uint256 spent) = _buy(token, amount, ALICE_KEY, true);
        uint256 returned = _sell(token, got, ALICE_KEY, false);
        assertLt(returned, spent);
        assertEq(pad.curves(token).tokensSold, 0);
        _assertAccounting();
    }
    function testFuzz_cappedSellOutNeverOverCredits(uint64 rawFirst) public {
        (address token,) = _launch(0, false);
        uint256 first = bound(rawFirst, 1e6, 8700e6);
        _buy(token, first, ALICE_KEY, false);
        (,,uint256 gross,) = pad.quoteBuy(token, 1_000_000e6);
        (,uint256 fee,uint256 spent,bool graduates) = pad.quoteBuy(token, gross - 1);
        if (!graduates) return;
        uint256 before = usdc.balanceOf(address(pad));
        uint256 feesBefore = pad.pendingFees();
        (,uint256 pulled) = _buy(token, gross - 1, BOB_KEY, true);
        uint256 seeded = usdc.balanceOf(pad.curves(token).pair);
        assertEq(pulled, spent);
        assertEq(spent, gross - 1);
        assertEq(pad.pendingFees() - feesBefore, fee);
        assertEq(before + pulled - seeded, usdc.balanceOf(address(pad)));
        assertEq(usdc.balanceOf(address(pad)), pad.pendingFees());
        _assertAccounting();
    }
}

contract SignedAccountingHandler is Test {
    ArchitexLaunchpad public immutable pad;
    MockUSDCAuth public immutable usdc;
    address[2] public tokens;
    address public immutable relayer;
    uint256 public donations;
    uint256 private sequence;
    uint256 constant KEY = 0xA11CE;
    address private immutable actor;
    bytes32 constant TYPEHASH = keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    constructor(ArchitexLaunchpad p, MockUSDCAuth u, address a, address b, address r) {
        pad = p; usdc = u; tokens = [a,b]; relayer = r; actor = vm.addr(KEY);
    }
    function _signed(address asset, uint256 amount) private returns (IERC3009.Authorization memory auth, bytes memory sig) {
        auth = IERC3009.Authorization(actor, amount, 0, type(uint256).max, keccak256(abi.encode(address(this), ++sequence)));
        bytes32 hash = keccak256(abi.encode(TYPEHASH, actor, address(pad), amount, auth.validAfter, auth.validBefore, auth.nonce));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, MessageHashUtils.toTypedDataHash(IERC3009(asset).DOMAIN_SEPARATOR(), hash));
        sig = abi.encodePacked(r,s,v);
    }
    function buy(uint8 which, uint64 raw) external {
        address token = tokens[which % 2];
        if (pad.curves(token).graduated) return;
        uint256 amount = bound(raw, 1, 4_000e6);
        (IERC3009.Authorization memory auth, bytes memory sig) = _signed(address(usdc), amount + pad.tradeRelayFee());
        vm.prank(relayer);
        try pad.buyWithAuthorization(token, 0, bytes32(0), auth, sig, bytes32(0)) {} catch {}
    }
    function sell(uint8 which, uint96 raw) external {
        address token = tokens[which % 2];
        if (pad.curves(token).graduated) return;
        uint256 held = IERC20(token).balanceOf(actor);
        if (held == 0) return;
        (IERC3009.Authorization memory auth, bytes memory sig) = _signed(token, bound(raw, 1, held));
        vm.prank(relayer);
        try pad.sellWithAuthorization(token, 0, bytes32(0), auth, sig) {} catch {}
    }
    function collect() external { pad.collectFees(); }
    function donate(uint64 raw) external {
        uint256 amount = bound(raw, 0, 1_000e6);
        usdc.mint(address(pad), amount);
        donations += amount;
    }
}

contract LaunchpadAccountingInvariant is AuthorizationFixture {
    SignedAccountingHandler internal handler;
    function setUp() public override {
        super.setUp();
        (address a,) = _launch(0, false);
        (address b,) = _launch(0, true);
        handler = new SignedAccountingHandler(pad, usdc, a, b, relayer);
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = handler.buy.selector;
        selectors[1] = handler.sell.selector;
        selectors[2] = handler.collect.selector;
        selectors[3] = handler.donate.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
        targetContract(address(handler));
    }
    function invariant_exactObligationsAndDonationsAcrossCurves() public view {
        _assertAccounting();
        assertEq(usdc.balanceOf(address(pad)), pad.accountedUsdc() + handler.donations());
        for (uint256 i; i < pad.tokensLength(); ++i) {
            address token = pad.tokenAt(i);
            IArchitexLaunchpad.Curve memory c = pad.curves(token);
            assertLe(c.tokensSold, pad.CURVE_SUPPLY());
            uint256 expected = c.graduated ? 0 : pad.TOTAL_SUPPLY() - c.tokensSold;
            assertEq(IERC20(token).balanceOf(address(pad)), expected);
        }
    }
}
