// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AuthorizationFixture, Mock1271Wallet} from "./helpers/AuthorizationFixture.sol";
import {IERC3009} from "../interfaces/IERC3009.sol";
import {IArchitexLaunchpad} from "../interfaces/IArchitexLaunchpad.sol";
import {AuthorizationGate} from "../agents/AuthorizationGate.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract AgentsAuthorizationTest is AuthorizationFixture {
    bytes32 constant RECEIPT = keccak256("externally settled USDC receipt inspected by relayer");

    function _launchPayment(bool bound) private returns (IArchitexLaunchpad.LaunchParams memory p, bytes32 salt, IERC3009.Authorization memory auth, bytes memory sig) {
        p = _params(0);
        salt = _nextNonce();
        auth = _auth(alice, pad.launchFee() + pad.launchRelayFee(), bound ? pad.launchNonce(p, salt) : _nextNonce());
        sig = _signature(address(usdc), address(pad), auth, ALICE_KEY);
    }
    function test_randomNonceRequiresRelayer() public {
        (IArchitexLaunchpad.LaunchParams memory p, bytes32 salt, IERC3009.Authorization memory auth, bytes memory sig) = _launchPayment(false);
        vm.prank(mallory);
        vm.expectRevert(IArchitexLaunchpad.Forbidden.selector);
        pad.launchWithAuthorization(p, salt, auth, sig, bytes32(0));
    }
    function test_boundNonceTamperedLaunchParametersFails() public {
        (IArchitexLaunchpad.LaunchParams memory p, bytes32 salt, IERC3009.Authorization memory auth, bytes memory sig) = _launchPayment(true);
        p.symbol = "OTHER";
        vm.prank(mallory);
        vm.expectRevert(AuthorizationGate.BoundNonceMismatch.selector);
        pad.launchWithAuthorization(p, salt, auth, sig, bytes32(0));
    }
    function test_allowedRelayerCannotDowngradeTamperedBoundLaunch() public {
        (IArchitexLaunchpad.LaunchParams memory p, bytes32 salt, IERC3009.Authorization memory auth, bytes memory sig) = _launchPayment(true);
        assertEq(bytes8(auth.nonce), bytes8(0x4152435458424e44));
        p.name = "Relayer changed it";
        vm.prank(relayer);
        vm.expectRevert(AuthorizationGate.BoundNonceMismatch.selector);
        pad.launchWithAuthorization(p, salt, auth, sig, bytes32(0));
        assertFalse(usdc.authorizationState(alice, auth.nonce));
    }
    function test_allowedRelayerCannotDowngradeTamperedBoundBuy() public {
        (address token,) = _launch(0, false);
        bytes32 salt = _nextNonce();
        IERC3009.Authorization memory auth = _auth(alice, 1e6 + pad.tradeRelayFee(), pad.buyNonce(token, 1, salt));
        bytes memory sig = _signature(address(usdc), address(pad), auth, ALICE_KEY);
        vm.prank(relayer);
        vm.expectRevert(AuthorizationGate.BoundNonceMismatch.selector);
        pad.buyWithAuthorization(token, 0, salt, auth, sig, bytes32(0));
        assertFalse(usdc.authorizationState(alice, auth.nonce));
    }
    function test_allowedRelayerCannotDowngradeTamperedBoundSell() public {
        (address token, uint256 held) = _launch(10e6, false);
        bytes32 salt = _nextNonce();
        IERC3009.Authorization memory auth = _auth(alice, held, pad.sellNonce(token, 1, salt));
        bytes memory sig = _signature(token, address(pad), auth, ALICE_KEY);
        vm.prank(relayer);
        vm.expectRevert(AuthorizationGate.BoundNonceMismatch.selector);
        pad.sellWithAuthorization(token, 0, salt, auth, sig);
        assertFalse(pad.paymentConsumed(token, alice, auth.nonce));
    }
    function test_allowedRelayerCannotDowngradeTamperedBoundPost() public {
        bytes32 salt = _nextNonce();
        IERC3009.Authorization memory auth = _auth(alice, 20_000, bbs.postNonce("author's words", salt));
        bytes memory sig = _signature(address(usdc), address(bbs), auth, ALICE_KEY);
        vm.prank(relayer);
        vm.expectRevert(AuthorizationGate.BoundNonceMismatch.selector);
        bbs.postWithAuthorization("relayer's words", salt, auth, sig, bytes32(0));
        assertEq(bbs.messageCount(), 0);
    }
    function test_reservedRandomNonceCannotBeSilentlyRelayed() public {
        (IArchitexLaunchpad.LaunchParams memory p, bytes32 salt, IERC3009.Authorization memory auth,) = _launchPayment(false);
        auth.nonce = bytes32(uint256(uint64(0x4152435458424e44)) << 192);
        bytes memory sig = _signature(address(usdc), address(pad), auth, ALICE_KEY);
        vm.prank(relayer);
        vm.expectRevert(AuthorizationGate.BoundNonceMismatch.selector);
        pad.launchWithAuthorization(p, salt, auth, sig, bytes32(0));
        assertFalse(usdc.authorizationState(alice, auth.nonce));
    }
    function test_launchValueMustExactlyMatchCurrentFeesAndInitialBuy() public {
        (IArchitexLaunchpad.LaunchParams memory p, bytes32 salt, IERC3009.Authorization memory auth,) = _launchPayment(false);
        auth.value++;
        bytes memory sig = _signature(address(usdc), address(pad), auth, ALICE_KEY);
        vm.prank(relayer);
        vm.expectPartialRevert(AuthorizationGate.PaymentValueMismatch.selector);
        pad.launchWithAuthorization(p, salt, auth, sig, bytes32(0));
        assertFalse(usdc.authorizationState(alice, auth.nonce));
    }
    function test_expiredAndNotYetValidAuthorizations() public {
        (IArchitexLaunchpad.LaunchParams memory p, bytes32 salt, IERC3009.Authorization memory auth,) = _launchPayment(false);
        auth.validBefore = block.timestamp;
        bytes memory sig = _signature(address(usdc), address(pad), auth, ALICE_KEY);
        vm.prank(relayer);
        vm.expectPartialRevert(IERC3009.AuthorizationExpired.selector);
        pad.launchWithAuthorization(p, salt, auth, sig, bytes32(0));
        auth.validBefore = block.timestamp + 1;
        auth.validAfter = block.timestamp;
        sig = _signature(address(usdc), address(pad), auth, ALICE_KEY);
        vm.prank(relayer);
        vm.expectPartialRevert(IERC3009.AuthorizationNotYetValid.selector);
        pad.launchWithAuthorization(p, salt, auth, sig, bytes32(0));
    }
    function test_localReplayFailsAndCannotPayTwice() public {
        (IArchitexLaunchpad.LaunchParams memory p, bytes32 salt, IERC3009.Authorization memory auth, bytes memory sig) = _launchPayment(false);
        vm.prank(relayer);
        pad.launchWithAuthorization(p, salt, auth, sig, bytes32(0));
        uint256 before = usdc.balanceOf(alice);
        vm.prank(relayer);
        vm.expectPartialRevert(IERC3009.AuthorizationAlreadyUsed.selector);
        pad.launchWithAuthorization(p, salt, auth, sig, bytes32(0));
        assertEq(usdc.balanceOf(alice), before);
        assertTrue(pad.paymentConsumed(address(usdc), alice, auth.nonce));
    }
    function test_failureRollsBackPaymentAndBothReplayMarkers() public {
        (address token,) = _launch(0, false);
        IERC3009.Authorization memory auth = _auth(alice, 10e6 + pad.tradeRelayFee(), _nextNonce());
        bytes memory sig = _signature(address(usdc), address(pad), auth, ALICE_KEY);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(relayer);
        vm.expectRevert(IArchitexLaunchpad.SlippageExceeded.selector);
        pad.buyWithAuthorization(token, type(uint256).max, bytes32(0), auth, sig, bytes32(0));
        assertEq(usdc.balanceOf(alice), before);
        assertFalse(usdc.authorizationState(alice, auth.nonce));
        assertFalse(pad.paymentConsumed(address(usdc), alice, auth.nonce));
    }
    function test_externalTransferDoesNotImplicitlyCreditOnUsedNonce() public {
        (IArchitexLaunchpad.LaunchParams memory p, bytes32 salt, IERC3009.Authorization memory auth, bytes memory sig) = _launchPayment(false);
        _externallySettle(address(pad), auth, sig);
        vm.prank(relayer);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        pad.launchWithAuthorization(p, salt, auth, sig, bytes32(0));
        assertEq(pad.tokensLength(), 0);
        assertFalse(pad.paymentConsumed(address(usdc), alice, auth.nonce));
    }
    function test_attestedRecoveryRunsActionExactlyOnce() public {
        (IArchitexLaunchpad.LaunchParams memory p, bytes32 salt, IERC3009.Authorization memory auth, bytes memory sig) = _launchPayment(false);
        _externallySettle(address(pad), auth, sig);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(relayer);
        (address token,) = pad.launchWithAuthorization(p, salt, auth, sig, RECEIPT);
        assertEq(pad.curves(token).creator, alice);
        assertEq(usdc.balanceOf(alice), before);
        assertEq(usdc.balanceOf(address(pad)), pad.pendingFees());
        vm.prank(relayer);
        vm.expectPartialRevert(IERC3009.AuthorizationAlreadyUsed.selector);
        pad.launchWithAuthorization(p, salt, auth, sig, RECEIPT);
    }
    function test_boundRecoveryStillRequiresTrustedRelayer() public {
        (IArchitexLaunchpad.LaunchParams memory p, bytes32 salt, IERC3009.Authorization memory auth, bytes memory sig) = _launchPayment(true);
        _externallySettle(address(pad), auth, sig);
        vm.prank(mallory);
        vm.expectRevert(AuthorizationGate.RecoveryRelayerRequired.selector);
        pad.launchWithAuthorization(p, salt, auth, sig, RECEIPT);
        vm.prank(relayer);
        pad.launchWithAuthorization(p, salt, auth, sig, RECEIPT);
    }
    function test_attestationNeedsConsumedTokenAuthorization() public {
        (IArchitexLaunchpad.LaunchParams memory p, bytes32 salt, IERC3009.Authorization memory auth, bytes memory sig) = _launchPayment(false);
        usdc.mint(address(pad), auth.value);
        vm.prank(relayer);
        vm.expectRevert(AuthorizationGate.SettlementNotConsumed.selector);
        pad.launchWithAuthorization(p, salt, auth, sig, RECEIPT);
    }
    function test_recoveryIndependentlyChecksExactRecipientSignature() public {
        (IArchitexLaunchpad.LaunchParams memory p, bytes32 salt, IERC3009.Authorization memory auth,) = _launchPayment(false);
        _cancel(alice, auth.nonce, ALICE_KEY);
        usdc.mint(address(pad), auth.value);
        bytes memory wrongRecipientSig = _signature(address(usdc), bob, auth, ALICE_KEY);
        vm.prank(relayer);
        vm.expectRevert(IERC3009.InvalidSignature.selector);
        pad.launchWithAuthorization(p, salt, auth, wrongRecipientSig, RECEIPT);
    }
    function test_usedStateCannotSpendAccountedCurveReservesOrFees() public {
        (address token,) = _launch(10e6, false);
        (IArchitexLaunchpad.LaunchParams memory p, bytes32 salt, IERC3009.Authorization memory auth, bytes memory sig) = _launchPayment(false);
        _cancel(alice, auth.nonce, ALICE_KEY);
        uint256 reserve = pad.liveCurveReserves();
        vm.prank(relayer);
        vm.expectPartialRevert(AuthorizationGate.InsufficientUnaccountedBalance.selector);
        pad.launchWithAuthorization(p, salt, auth, sig, RECEIPT);
        assertEq(pad.liveCurveReserves(), reserve);
        assertFalse(pad.curves(token).graduated);
        _assertAccounting();
    }
    function test_cancelledNonceCannotStealOtherDepositWithoutTrustedRole() public {
        (IArchitexLaunchpad.LaunchParams memory p, bytes32 salt, IERC3009.Authorization memory auth, bytes memory sig) = _launchPayment(true);
        _cancel(alice, auth.nonce, ALICE_KEY);
        IERC3009.Authorization memory bobAuth = _auth(bob, auth.value, _nextNonce());
        _externallySettle(address(pad), bobAuth, _signature(address(usdc), address(pad), bobAuth, BOB_KEY));
        vm.prank(mallory);
        vm.expectRevert(AuthorizationGate.RecoveryRelayerRequired.selector);
        pad.launchWithAuthorization(p, salt, auth, sig, RECEIPT);
        assertEq(usdc.balanceOf(address(pad)), bobAuth.value);
    }
    /// @notice This deliberately demonstrates the disclosed trust risk: the contract cannot verify
    ///         a receipt hash. A dishonest allowed relayer can allocate someone else's surplus.
    function test_dishonestRelayerCanStealUnaccountedDepositButNotReserves() public {
        (IArchitexLaunchpad.LaunchParams memory p, bytes32 salt, IERC3009.Authorization memory auth, bytes memory sig) = _launchPayment(false);
        _cancel(alice, auth.nonce, ALICE_KEY);
        IERC3009.Authorization memory bobAuth = _auth(bob, auth.value, _nextNonce());
        _externallySettle(address(pad), bobAuth, _signature(address(usdc), address(pad), bobAuth, BOB_KEY));
        vm.prank(relayer);
        pad.launchWithAuthorization(p, salt, auth, sig, RECEIPT);
        assertEq(pad.tokensLength(), 1);
        assertFalse(pad.paymentConsumed(address(usdc), bob, bobAuth.nonce));
        assertEq(usdc.balanceOf(address(pad)), pad.pendingFees());
    }
    function test_twoExternalPaymentsAreCreditedWithoutMixingObligations() public {
        (IArchitexLaunchpad.LaunchParams memory p, bytes32 salt, IERC3009.Authorization memory a, bytes memory aSig) = _launchPayment(false);
        IERC3009.Authorization memory b = _auth(bob, a.value, _nextNonce());
        bytes memory bSig = _signature(address(usdc), address(pad), b, BOB_KEY);
        _externallySettle(address(pad), a, aSig);
        _externallySettle(address(pad), b, bSig);
        vm.prank(relayer);
        pad.launchWithAuthorization(p, salt, a, aSig, RECEIPT);
        assertEq(usdc.balanceOf(address(pad)) - pad.accountedUsdc(), b.value);
        vm.prank(relayer);
        pad.launchWithAuthorization(p, salt, b, bSig, keccak256("second receipt"));
        assertEq(usdc.balanceOf(address(pad)), pad.accountedUsdc());
    }
    function test_failedRecoveryActionDoesNotConsumeCredit() public {
        (address token,) = _launch(0, false);
        IERC3009.Authorization memory auth = _auth(alice, 10e6 + pad.tradeRelayFee(), _nextNonce());
        bytes memory sig = _signature(address(usdc), address(pad), auth, ALICE_KEY);
        _externallySettle(address(pad), auth, sig);
        vm.prank(relayer);
        vm.expectRevert(IArchitexLaunchpad.SlippageExceeded.selector);
        pad.buyWithAuthorization(token, type(uint256).max, bytes32(0), auth, sig, RECEIPT);
        assertFalse(pad.paymentConsumed(address(usdc), alice, auth.nonce));
        assertEq(usdc.balanceOf(address(pad)) - pad.accountedUsdc(), auth.value);
        vm.prank(relayer);
        pad.buyWithAuthorization(token, 0, bytes32(0), auth, sig, RECEIPT);
        _assertAccounting();
    }
    function test_expiredExternalPaymentRefundsEntireAmountToPayer() public {
        (IArchitexLaunchpad.LaunchParams memory p, bytes32 salt, IERC3009.Authorization memory auth, bytes memory sig) = _launchPayment(false);
        _externallySettle(address(pad), auth, sig);
        vm.warp(auth.validBefore);
        vm.prank(relayer);
        vm.expectPartialRevert(IERC3009.AuthorizationExpired.selector);
        pad.launchWithAuthorization(p, salt, auth, sig, RECEIPT);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(relayer);
        assertEq(pad.refundExternalPayment(auth, sig, RECEIPT), auth.value);
        assertEq(usdc.balanceOf(alice) - before, auth.value);
        assertEq(usdc.balanceOf(relayer), 0);
        assertEq(pad.tokensLength(), 0);
        vm.prank(relayer);
        vm.expectPartialRevert(IERC3009.AuthorizationAlreadyUsed.selector);
        pad.refundExternalPayment(auth, sig, RECEIPT);
    }
    function test_refundNeedsReceiptReferenceAndRelayer() public {
        (,, IERC3009.Authorization memory auth, bytes memory sig) = _launchPayment(true);
        _externallySettle(address(pad), auth, sig);
        vm.prank(relayer);
        vm.expectRevert(AuthorizationGate.SettlementAttestationRequired.selector);
        pad.refundExternalPayment(auth, sig, bytes32(0));
        vm.prank(mallory);
        vm.expectRevert(AuthorizationGate.RecoveryRelayerRequired.selector);
        pad.refundExternalPayment(auth, sig, RECEIPT);
    }
    function test_refundCannotUseAnAlreadyExecutedPayment() public {
        (IArchitexLaunchpad.LaunchParams memory p, bytes32 salt, IERC3009.Authorization memory auth, bytes memory sig) = _launchPayment(false);
        vm.prank(relayer);
        pad.launchWithAuthorization(p, salt, auth, sig, bytes32(0));
        vm.prank(relayer);
        vm.expectPartialRevert(IERC3009.AuthorizationAlreadyUsed.selector);
        pad.refundExternalPayment(auth, sig, RECEIPT);
    }
    function test_smartWalletLaunchAndExternalRecovery() public {
        Mock1271Wallet wallet = new Mock1271Wallet();
        usdc.mint(address(wallet), 2e6);
        IArchitexLaunchpad.LaunchParams memory p = _params(0);
        IERC3009.Authorization memory auth = _auth(address(wallet), 400_000, _nextNonce());
        wallet.approveDigest(_digest(address(usdc), address(pad), auth));
        vm.prank(relayer);
        pad.launchWithAuthorization(p, bytes32(0), auth, hex"deadbeef", bytes32(0));
        auth.nonce = _nextNonce();
        wallet.approveDigest(_digest(address(usdc), address(pad), auth));
        _externallySettle(address(pad), auth, hex"deadbeef");
        vm.prank(relayer);
        (address token,) = pad.launchWithAuthorization(p, bytes32(0), auth, hex"deadbeef", RECEIPT);
        assertEq(pad.curves(token).creator, address(wallet));
    }
    function test_revokedSmartWalletSignatureCannotRecover() public {
        Mock1271Wallet wallet = new Mock1271Wallet();
        usdc.mint(address(wallet), 1e6);
        IERC3009.Authorization memory auth = _auth(address(wallet), 400_000, _nextNonce());
        wallet.approveDigest(_digest(address(usdc), address(pad), auth));
        _externallySettle(address(pad), auth, hex"deadbeef");
        wallet.setRevoked(true);
        vm.prank(relayer);
        vm.expectRevert(IERC3009.InvalidSignature.selector);
        pad.refundExternalPayment(auth, hex"deadbeef", RECEIPT);
        assertFalse(pad.paymentConsumed(address(usdc), address(wallet), auth.nonce));
    }
}
