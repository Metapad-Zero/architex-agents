// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AuthorizationFixture, Mock1271Wallet} from "./helpers/AuthorizationFixture.sol";
import {LaunchToken} from "../launchpad/LaunchToken.sol";
import {ILaunchToken} from "../interfaces/ILaunchToken.sol";
import {IERC3009} from "../interfaces/IERC3009.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract LaunchTokenAuthorizationTest is AuthorizationFixture {
    LaunchToken internal token;
    function setUp() public override {
        super.setUp();
        (address t,) = _launch(100e6, false);
        token = LaunchToken(t);
    }
    function _typed(bytes32 typeHash, address to, IERC3009.Authorization memory auth) private view returns (bytes32) {
        return MessageHashUtils.toTypedDataHash(token.DOMAIN_SEPARATOR(), keccak256(abi.encode(typeHash, auth.from, to, auth.value, auth.validAfter, auth.validBefore, auth.nonce)));
    }
    function _transfer(IERC3009.Authorization memory auth, address to, bytes memory sig) private {
        token.transferWithAuthorization(auth.from, to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, sig);
    }
    function test_fixedSupplyAndNoAdministrativeMint() public {
        assertEq(token.totalSupply(), 1_000_000_000e18);
        assertEq(token.launchpad(), address(pad));
        (bool success,) = address(token).call(abi.encodeWithSignature("mint(address,uint256)", mallory, 1e18));
        assertFalse(success);
        (success,) = address(token).call(abi.encodeWithSignature("launchpadPull(address,uint256)", alice, 1e18));
        assertFalse(success);
    }
    function test_transferBytesAuthorization() public {
        IERC3009.Authorization memory auth = _auth(alice, 1e18, _nextNonce());
        bytes memory sig = _signature(address(token), bob, auth, ALICE_KEY);
        vm.prank(mallory);
        _transfer(auth, bob, sig);
        assertEq(token.balanceOf(bob), 1e18);
        assertTrue(token.authorizationState(alice, auth.nonce));
    }
    function test_transferVrsAuthorization() public {
        IERC3009.Authorization memory auth = _auth(alice, 1e18, _nextNonce());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ALICE_KEY, _digest(address(token), bob, auth));
        token.transferWithAuthorization(alice, bob, auth.value, auth.validAfter, auth.validBefore, auth.nonce, v, r, s);
        assertEq(token.balanceOf(bob), 1e18);
    }
    function test_receiveOnlyPayeeAndDistinctTypeHash() public {
        IERC3009.Authorization memory auth = _auth(alice, 1e18, _nextNonce());
        bytes memory receiveSig = _signDigest(_typed(token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), bob, auth), ALICE_KEY);
        vm.prank(mallory);
        vm.expectRevert(IERC3009.CallerMustBePayee.selector);
        token.receiveWithAuthorization(alice, bob, auth.value, auth.validAfter, auth.validBefore, auth.nonce, receiveSig);
        vm.prank(bob);
        token.receiveWithAuthorization(alice, bob, auth.value, auth.validAfter, auth.validBefore, auth.nonce, receiveSig);
        auth.nonce = _nextNonce();
        bytes memory transferSig = _signature(address(token), bob, auth, ALICE_KEY);
        vm.prank(bob);
        vm.expectRevert(IERC3009.InvalidSignature.selector);
        token.receiveWithAuthorization(alice, bob, auth.value, auth.validAfter, auth.validBefore, auth.nonce, transferSig);
    }
    function test_receiveVrsAuthorization() public {
        IERC3009.Authorization memory auth = _auth(alice, 1e18, _nextNonce());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ALICE_KEY, _typed(token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), bob, auth));
        vm.prank(bob);
        token.receiveWithAuthorization(alice, bob, auth.value, auth.validAfter, auth.validBefore, auth.nonce, v, r, s);
        assertEq(token.balanceOf(bob), 1e18);
    }
    function test_thirdPartyCannotDetachSellerPaymentToLaunchpad() public {
        IERC3009.Authorization memory auth = _auth(alice, 1e18, _nextNonce());
        bytes memory sig = _signature(address(token), address(pad), auth, ALICE_KEY);
        vm.prank(mallory);
        vm.expectRevert(ILaunchToken.OnlyLaunchpad.selector);
        _transfer(auth, address(pad), sig);
        assertFalse(token.authorizationState(alice, auth.nonce));
        vm.prank(address(pad));
        _transfer(auth, address(pad), sig);
        assertTrue(token.authorizationState(alice, auth.nonce));
    }
    function test_replayAndCancelledNonceReject() public {
        IERC3009.Authorization memory auth = _auth(alice, 1e18, _nextNonce());
        bytes memory sig = _signature(address(token), bob, auth, ALICE_KEY);
        _transfer(auth, bob, sig);
        vm.expectPartialRevert(IERC3009.AuthorizationAlreadyUsed.selector);
        _transfer(auth, bob, sig);
        auth.nonce = _nextNonce();
        bytes32 cancelHash = keccak256(abi.encode(token.CANCEL_AUTHORIZATION_TYPEHASH(), alice, auth.nonce));
        bytes memory cancelSig = _signDigest(MessageHashUtils.toTypedDataHash(token.DOMAIN_SEPARATOR(), cancelHash), ALICE_KEY);
        token.cancelAuthorization(alice, auth.nonce, cancelSig);
        sig = _signature(address(token), bob, auth, ALICE_KEY);
        vm.expectPartialRevert(IERC3009.AuthorizationAlreadyUsed.selector);
        _transfer(auth, bob, sig);
    }
    function test_cancelVrsAndInvalidCancelSignature() public {
        bytes32 nonce = _nextNonce();
        bytes32 hash = MessageHashUtils.toTypedDataHash(token.DOMAIN_SEPARATOR(), keccak256(abi.encode(token.CANCEL_AUTHORIZATION_TYPEHASH(), alice, nonce)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MALLORY_KEY, hash);
        vm.expectRevert(IERC3009.InvalidSignature.selector);
        token.cancelAuthorization(alice, nonce, v, r, s);
        (v,r,s) = vm.sign(ALICE_KEY, hash);
        token.cancelAuthorization(alice, nonce, v, r, s);
        assertTrue(token.authorizationState(alice, nonce));
    }
    function test_expiryAndNotBeforeBoundaryAreStrict() public {
        IERC3009.Authorization memory auth = _auth(alice, 1e18, _nextNonce());
        auth.validBefore = block.timestamp;
        bytes memory sig = _signature(address(token), bob, auth, ALICE_KEY);
        vm.expectPartialRevert(IERC3009.AuthorizationExpired.selector);
        _transfer(auth, bob, sig);
        auth.validBefore = block.timestamp + 1;
        auth.validAfter = block.timestamp;
        sig = _signature(address(token), bob, auth, ALICE_KEY);
        vm.expectPartialRevert(IERC3009.AuthorizationNotYetValid.selector);
        _transfer(auth, bob, sig);
    }
    function test_tamperedRecipientValueAndSignerAreRejected() public {
        IERC3009.Authorization memory auth = _auth(alice, 1e18, _nextNonce());
        bytes memory sig = _signature(address(token), bob, auth, ALICE_KEY);
        vm.expectRevert(IERC3009.InvalidSignature.selector);
        _transfer(auth, mallory, sig);
        auth.value++;
        vm.expectRevert(IERC3009.InvalidSignature.selector);
        _transfer(auth, bob, sig);
        auth.value--;
        sig = _signature(address(token), bob, auth, MALLORY_KEY);
        vm.expectRevert(IERC3009.InvalidSignature.selector);
        _transfer(auth, bob, sig);
    }
    function test_domainChangesWithChainAndDifferentToken() public {
        IERC3009.Authorization memory auth = _auth(alice, 1e18, _nextNonce());
        bytes memory sig = _signature(address(token), bob, auth, ALICE_KEY);
        uint256 original = block.chainid;
        vm.chainId(original + 1);
        vm.expectRevert(IERC3009.InvalidSignature.selector);
        _transfer(auth, bob, sig);
        vm.chainId(original);
        (address other,) = _launch(100e6, false);
        vm.expectRevert(IERC3009.InvalidSignature.selector);
        LaunchToken(other).transferWithAuthorization(alice, bob, auth.value, auth.validAfter, auth.validBefore, auth.nonce, sig);
    }
    function test_transferFailureRollsBackNonceState() public {
        IERC3009.Authorization memory auth = _auth(alice, token.balanceOf(alice) + 1, _nextNonce());
        bytes memory sig = _signature(address(token), bob, auth, ALICE_KEY);
        vm.expectRevert();
        _transfer(auth, bob, sig);
        assertFalse(token.authorizationState(alice, auth.nonce));
    }
    function test_smartWalletTransferAndCancel() public {
        Mock1271Wallet wallet = new Mock1271Wallet();
        vm.prank(alice);
        token.transfer(address(wallet), 2e18);
        IERC3009.Authorization memory auth = _auth(address(wallet), 1e18, _nextNonce());
        wallet.approveDigest(_digest(address(token), bob, auth));
        _transfer(auth, bob, hex"deadbeef");
        bytes32 nonce = _nextNonce();
        wallet.approveDigest(MessageHashUtils.toTypedDataHash(token.DOMAIN_SEPARATOR(), keccak256(abi.encode(token.CANCEL_AUTHORIZATION_TYPEHASH(), address(wallet), nonce))));
        token.cancelAuthorization(address(wallet), nonce, hex"deadbeef");
        assertTrue(token.authorizationState(address(wallet), nonce));
    }
    function _permitDigest(address owner, address spender, uint256 amount, uint256 nonce, uint256 deadline) private view returns (bytes32) {
        return MessageHashUtils.toTypedDataHash(token.DOMAIN_SEPARATOR(), keccak256(abi.encode(token.PERMIT_TYPEHASH(), owner, spender, amount, nonce, deadline)));
    }
    function test_permitVrsAndReplay() public {
        uint256 deadline = block.timestamp + 1;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ALICE_KEY, _permitDigest(alice, bob, 1e18, 0, deadline));
        token.permit(alice, bob, 1e18, deadline, v, r, s);
        assertEq(token.nonces(alice), 1);
        assertEq(token.allowance(alice, bob), 1e18);
        vm.prank(bob);
        token.transferFrom(alice, bob, 1e18);
        vm.expectRevert(IERC3009.InvalidSignature.selector);
        token.permit(alice, bob, 1e18, deadline, v, r, s);
    }
    function test_permitBytesAndSmartWallet() public {
        uint256 deadline = block.timestamp;
        bytes memory sig = _signDigest(_permitDigest(alice, bob, 1e18, 0, deadline), ALICE_KEY);
        token.permit(alice, bob, 1e18, deadline, sig);
        assertEq(token.allowance(alice, bob), 1e18);
        Mock1271Wallet wallet = new Mock1271Wallet();
        wallet.approveDigest(_permitDigest(address(wallet), bob, 2e18, 0, deadline));
        token.permit(address(wallet), bob, 2e18, deadline, hex"deadbeef");
        assertEq(token.allowance(address(wallet), bob), 2e18);
    }
    function test_expiredInvalidPermitDoesNotIncrementNonce() public {
        uint256 deadline = block.timestamp - 1;
        bytes memory sig = _signDigest(_permitDigest(alice, bob, 1e18, 0, deadline), ALICE_KEY);
        vm.expectPartialRevert(LaunchToken.PermitExpired.selector);
        token.permit(alice, bob, 1e18, deadline, sig);
        assertEq(token.nonces(alice), 0);
        deadline = block.timestamp + 1;
        sig = _signDigest(_permitDigest(alice, bob, 1e18, 0, deadline), MALLORY_KEY);
        vm.expectRevert(IERC3009.InvalidSignature.selector);
        token.permit(alice, bob, 1e18, deadline, sig);
        assertEq(token.nonces(alice), 0);
    }
    function test_pairLockAppliesToSignedTransfer() public {
        IERC3009.Authorization memory auth = _auth(alice, 1e18, _nextNonce());
        address pair = token.pair();
        bytes memory sig = _signature(address(token), pair, auth, ALICE_KEY);
        vm.expectRevert(ILaunchToken.PairLockedUntilGraduation.selector);
        _transfer(auth, pair, sig);
        assertFalse(token.authorizationState(alice, auth.nonce));
        _buy(address(token), 30_000e6, BOB_KEY, false);
        _transfer(auth, pair, sig);
        assertTrue(token.authorizationState(alice, auth.nonce));
    }
    function test_zeroAuthorizerCannotUseEmptySignature() public {
        IERC3009.Authorization memory auth = _auth(address(0), 0, _nextNonce());
        vm.expectRevert(IERC3009.InvalidSignature.selector);
        _transfer(auth, bob, hex"");
    }
}
