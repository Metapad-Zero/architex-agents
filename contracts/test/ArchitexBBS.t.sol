// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AuthorizationFixture, Mock1271Wallet} from "./helpers/AuthorizationFixture.sol";
import {Vm} from "forge-std/Test.sol";
import {ArchitexBBS} from "../ArchitexBBS.sol";
import {IERC3009} from "../interfaces/IERC3009.sol";
import {IArchitexLaunchpad} from "../interfaces/IArchitexLaunchpad.sol";
import {AuthorizationGate} from "../agents/AuthorizationGate.sol";

contract ArchitexBBSTest is AuthorizationFixture {
    function doPost(string memory text, bool bound) external returns (uint256) { return _post(text, bound); }
    function _text(uint256 length) private pure returns (string memory) {
        bytes memory value = new bytes(length);
        for (uint256 i; i < length; ++i) value[i] = "a";
        return string(value);
    }
    function test_postBothModesSequentialIDsAndAccounting() public {
        assertEq(_post("gm agents", false), 0);
        assertEq(_post("gm humans", true), 1);
        assertEq(bbs.messageCount(), 2);
        assertEq(bbs.pendingFees(), 20_000);
        assertEq(usdc.balanceOf(address(bbs)), bbs.pendingFees());
    }
    function test_exactMaxBytesEmptyAndTooLong() public {
        _post(_text(280), false);
        _post("", true);
        vm.expectRevert(abi.encodeWithSelector(ArchitexBBS.TextTooLong.selector, 281, 280));
        this.doPost(_text(281), false);
        assertEq(bbs.messageCount(), 2);
    }
    function testFuzz_textBoundary(uint16 raw) public {
        uint256 length = bound(raw, 0, 400);
        string memory text = _text(length);
        if (length <= 280) assertEq(_post(text, true), 0);
        else {
            vm.expectPartialRevert(ArchitexBBS.TextTooLong.selector);
            this.doPost(text, true);
        }
    }
    function test_messageEventRetainsAuthorizerIDTimestampAndText() public {
        string memory text = "a real signed post";
        vm.recordLogs();
        _post(text, false);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(bbs) && logs[i].topics[0] == keccak256("Message(address,uint256,uint256,string)")) {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), alice);
                assertEq(uint256(logs[i].topics[2]), 0);
                (uint256 time, string memory emitted) = abi.decode(logs[i].data, (uint256, string));
                assertEq(time, block.timestamp);
                assertEq(emitted, text);
                found = true;
            }
        }
        assertTrue(found);
    }
    function test_randomNonRelayerAndBoundTamperingFail() public {
        bytes32 salt = _nextNonce();
        IERC3009.Authorization memory auth = _auth(alice, 20_000, bbs.postNonce("original", salt));
        bytes memory sig = _signature(address(usdc), address(bbs), auth, ALICE_KEY);
        vm.prank(mallory);
        vm.expectRevert(AuthorizationGate.BoundNonceMismatch.selector);
        bbs.postWithAuthorization("changed", salt, auth, sig, bytes32(0));
        auth.nonce = _nextNonce();
        sig = _signature(address(usdc), address(bbs), auth, ALICE_KEY);
        vm.prank(mallory);
        vm.expectRevert(ArchitexBBS.Forbidden.selector);
        bbs.postWithAuthorization("original", salt, auth, sig, bytes32(0));
    }
    function test_exactPriceAndFeeChangesInvalidateOldPrice() public {
        IERC3009.Authorization memory auth = _auth(alice, 20_000, _nextNonce());
        bytes memory sig = _signature(address(usdc), address(bbs), auth, ALICE_KEY);
        vm.prank(setter);
        bbs.setPostFee(20_000);
        vm.prank(relayer);
        vm.expectPartialRevert(AuthorizationGate.PaymentValueMismatch.selector);
        bbs.postWithAuthorization("old price", bytes32(0), auth, sig, bytes32(0));
        assertFalse(usdc.authorizationState(alice, auth.nonce));
    }
    function test_roleAndRelayFeeFollowLaunchpad() public {
        vm.prank(setter);
        pad.setRelayFees(30_000, 150_000);
        assertEq(bbs.tradeRelayFee(), 30_000);
        vm.prank(setter);
        pad.setRelayer(relayer, false);
        assertFalse(bbs.isRelayer(relayer));
        vm.expectRevert(ArchitexBBS.Forbidden.selector);
        this.doPost("disallowed relay", false);
        _post("bound still works", true);
    }
    function test_permissionsCapsAndRenounce() public {
        vm.prank(mallory);
        vm.expectRevert(ArchitexBBS.Forbidden.selector);
        bbs.setPostFee(0);
        vm.startPrank(setter);
        vm.expectRevert(ArchitexBBS.PostFeeTooHigh.selector);
        bbs.setPostFee(1_000_001);
        bbs.setPostFee(1_000_000);
        vm.expectRevert(ArchitexBBS.ZeroAddress.selector);
        bbs.setFeeTo(address(bbs));
        bbs.setFeeTo(bob);
        bbs.setFeeToSetter(address(0));
        vm.expectRevert(ArchitexBBS.Forbidden.selector);
        bbs.setPostFee(1);
        vm.stopPrank();
    }
    function test_feeCollectionCannotBlockPosting() public {
        usdc.setBlocked(feeTo, true);
        _post("blocked fee recipient", false);
        vm.expectRevert(bytes("blocklisted"));
        bbs.collectFees();
        assertEq(bbs.pendingFees(), 10_000);
        _post("still posts", true);
        usdc.setBlocked(feeTo, false);
        vm.prank(mallory);
        assertEq(bbs.collectFees(), 20_000);
        assertEq(usdc.balanceOf(feeTo), 20_000);
        assertEq(bbs.pendingFees(), 0);
    }
    function test_replayAndWrongAssetSignatureFail() public {
        IERC3009.Authorization memory auth = _auth(alice, 20_000, _nextNonce());
        bytes memory sig = _signature(address(usdc), address(bbs), auth, ALICE_KEY);
        vm.prank(relayer);
        bbs.postWithAuthorization("gm", bytes32(0), auth, sig, bytes32(0));
        vm.prank(relayer);
        vm.expectPartialRevert(IERC3009.AuthorizationAlreadyUsed.selector);
        bbs.postWithAuthorization("gm", bytes32(0), auth, sig, bytes32(0));
        auth.nonce = _nextNonce();
        sig = _signature(address(usdc), address(pad), auth, ALICE_KEY);
        vm.prank(relayer);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        bbs.postWithAuthorization("gm", bytes32(0), auth, sig, bytes32(0));
    }
    function test_externalPaymentRecoveryAndExpiredRefund() public {
        IERC3009.Authorization memory auth = _auth(alice, 20_000, _nextNonce());
        bytes memory sig = _signature(address(usdc), address(bbs), auth, ALICE_KEY);
        _externallySettle(address(bbs), auth, sig);
        vm.prank(relayer);
        bbs.postWithAuthorization("recovered", bytes32(0), auth, sig, keccak256("receipt"));
        assertEq(bbs.messageCount(), 1);
        assertEq(usdc.balanceOf(address(bbs)), bbs.accountedUsdc());
        auth.nonce = _nextNonce();
        sig = _signature(address(usdc), address(bbs), auth, ALICE_KEY);
        _externallySettle(address(bbs), auth, sig);
        vm.warp(auth.validBefore);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(relayer);
        bbs.refundExternalPayment(auth, sig, keccak256("refund receipt"));
        assertEq(usdc.balanceOf(alice) - before, auth.value);
        assertEq(bbs.messageCount(), 1);
    }
    function test_boundExternalRecoveryRequiresRelayer() public {
        bytes32 salt = _nextNonce();
        IERC3009.Authorization memory auth = _auth(alice, 20_000, bbs.postNonce("gm", salt));
        bytes memory sig = _signature(address(usdc), address(bbs), auth, ALICE_KEY);
        _externallySettle(address(bbs), auth, sig);
        vm.prank(mallory);
        vm.expectRevert(AuthorizationGate.RecoveryRelayerRequired.selector);
        bbs.postWithAuthorization("gm", salt, auth, sig, keccak256("receipt"));
    }
    function test_boardFeesCannotBeStolenAsSurplus() public {
        _post("accrued fee", false);
        IERC3009.Authorization memory auth = _auth(alice, 20_000, _nextNonce());
        bytes memory sig = _signature(address(usdc), address(bbs), auth, ALICE_KEY);
        _cancel(alice, auth.nonce, ALICE_KEY);
        vm.prank(relayer);
        vm.expectPartialRevert(AuthorizationGate.InsufficientUnaccountedBalance.selector);
        bbs.refundExternalPayment(auth, sig, keccak256("dishonest claim"));
        assertEq(bbs.pendingFees(), 10_000);
    }
    function test_smartWalletPost() public {
        Mock1271Wallet wallet = new Mock1271Wallet();
        usdc.mint(address(wallet), 20_000);
        IERC3009.Authorization memory auth = _auth(address(wallet), 20_000, _nextNonce());
        wallet.approveDigest(_digest(address(usdc), address(bbs), auth));
        vm.prank(relayer);
        bbs.postWithAuthorization("1271 author", bytes32(0), auth, hex"deadbeef", bytes32(0));
        assertEq(bbs.messageCount(), 1);
    }
    function test_noUnsignedPostOrContentAdministration() public {
        bytes4[6] memory selectors = [bytes4(keccak256("post(string)")), bytes4(keccak256("deleteMessage(uint256)")), bytes4(keccak256("editMessage(uint256,string)")), bytes4(keccak256("pause()")), bytes4(keccak256("unpause()")), bytes4(keccak256("upgradeTo(address)"))];
        for (uint256 i; i < selectors.length; ++i) {
            (bool success,) = address(bbs).call(abi.encodeWithSelector(selectors[i]));
            assertFalse(success);
        }
    }
}
