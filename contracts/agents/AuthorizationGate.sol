// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC3009} from "../interfaces/IERC3009.sol";

/// @notice Payment/replay rules shared by the launchpad and board.
/// @dev External settlement is a TRUSTED RELAYER ATTESTATION, not an on-chain receipt proof.
///      A dishonest relayer can steal unaccounted deposits by lying about a receipt. The
///      balance check protects accounted curve reserves and fees, not other stranded deposits.
abstract contract AuthorizationGate is ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 private constant TRANSFER_TYPEHASH = keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    bytes8 public constant BOUND_NONCE_PREFIX = 0x4152435458424e44; // ARCTXBND
    mapping(address => mapping(address => mapping(bytes32 => bool))) private _consumed;

    error RecoveryRelayerRequired();
    error SettlementAttestationRequired();
    error SettlementNotConsumed();
    error InsufficientUnaccountedBalance(uint256 available, uint256 required);
    error PaymentAmountMismatch(uint256 received, uint256 required);
    error PaymentValueMismatch(uint256 expected, uint256 actual);
    error BoundNonceMismatch();

    event ExternalSettlementCredited(address indexed from, bytes32 indexed nonce, bytes32 indexed settlementTransaction, uint256 value);
    event ExternalSettlementRefunded(address indexed from, bytes32 indexed nonce, bytes32 indexed settlementTransaction, uint256 value);

    function _paymentUsdc() internal view virtual returns (address);
    function _allowedRelayer(address caller) internal view virtual returns (bool);
    function accountedUsdc() public view virtual returns (uint256);

    function paymentConsumed(address asset, address from, bytes32 nonce) public view returns (bool) {
        return _consumed[asset][from][nonce];
    }

    function _boundNonce(bytes32 commitment) internal pure returns (bytes32) {
        return bytes32((uint256(uint64(BOUND_NONCE_PREFIX)) << 192) | (uint256(commitment) & type(uint192).max));
    }

    /// @dev A reserved marker lets us distinguish commitments from stock random nonces.
    ///      Otherwise an allowed relayer could change parameters and classify a bound payment
    ///      as a random nonce, bypassing the actor's intended commitment.
    function _boundAuthorization(bytes32 commitment, bytes32 nonce) internal pure returns (bool) {
        if (bytes8(nonce) != BOUND_NONCE_PREFIX) return false;
        if (nonce != commitment) revert BoundNonceMismatch();
        return true;
    }

    function _requireUnused(address asset, IERC3009.Authorization calldata auth) private view {
        if (_consumed[asset][auth.from][auth.nonce]) revert IERC3009.AuthorizationAlreadyUsed(auth.from, auth.nonce);
    }

    function _requireCurrent(IERC3009.Authorization calldata auth) internal view {
        if (block.timestamp <= auth.validAfter) revert IERC3009.AuthorizationNotYetValid(auth.validAfter);
        if (block.timestamp >= auth.validBefore) revert IERC3009.AuthorizationExpired(auth.validBefore);
    }

    /// @dev A normal authorization must actually move the exact asset amount in THIS call.
    function _pullAuthorization(address asset, IERC3009.Authorization calldata auth, bytes calldata signature) internal {
        _requireUnused(asset, auth);
        _requireCurrent(auth);
        uint256 beforeBalance = IERC20(asset).balanceOf(address(this));
        _consumed[asset][auth.from][auth.nonce] = true;
        IERC3009(asset).transferWithAuthorization(auth.from, address(this), auth.value, auth.validAfter, auth.validBefore, auth.nonce, signature);
        uint256 afterBalance = IERC20(asset).balanceOf(address(this));
        uint256 received = afterBalance >= beforeBalance ? afterBalance - beforeBalance : 0;
        if (received != auth.value) revert PaymentAmountMismatch(received, auth.value);
    }

    function _takeUsdc(IERC3009.Authorization calldata auth, bytes calldata signature, bytes32 settlementTransaction) internal {
        if (settlementTransaction == bytes32(0)) {
            _pullAuthorization(_paymentUsdc(), auth, signature);
        } else {
            _requireCurrent(auth);
            _creditExternal(auth, signature, settlementTransaction);
        }
    }

    function _creditExternal(IERC3009.Authorization calldata auth, bytes calldata signature, bytes32 settlementTransaction) private {
        if (!_allowedRelayer(msg.sender)) revert RecoveryRelayerRequired();
        if (settlementTransaction == bytes32(0)) revert SettlementAttestationRequired();
        address asset = _paymentUsdc();
        _requireUnused(asset, auth);
        // A used state also includes cancellation. Only the relayer's independently inspected
        // successful receipt establishes settlement; these checks do not prove it on chain.
        if (!IERC3009(asset).authorizationState(auth.from, auth.nonce)) revert SettlementNotConsumed();
        bytes32 structHash = keccak256(abi.encode(TRANSFER_TYPEHASH, auth.from, address(this), auth.value, auth.validAfter, auth.validBefore, auth.nonce));
        bytes32 digest = MessageHashUtils.toTypedDataHash(IERC3009(asset).DOMAIN_SEPARATOR(), structHash);
        if (auth.from == address(0) || !SignatureChecker.isValidSignatureNow(auth.from, digest, signature)) revert IERC3009.InvalidSignature();
        uint256 balance = IERC20(asset).balanceOf(address(this));
        uint256 accounted = accountedUsdc();
        uint256 available = balance > accounted ? balance - accounted : 0;
        if (available < auth.value) revert InsufficientUnaccountedBalance(available, auth.value);
        _consumed[asset][auth.from][auth.nonce] = true;
        emit ExternalSettlementCredited(auth.from, auth.nonce, settlementTransaction, auth.value);
    }

    /// @notice Trusted relayer refund for an externally settled payment whose action cannot run.
    /// @dev Accepts expired authorizations, but verifies the signature now and always refunds the
    ///      entire payment to its authorizer. A revoked EIP-1271 signature cannot be recovered here.
    function refundExternalPayment(IERC3009.Authorization calldata auth, bytes calldata signature, bytes32 settlementTransaction)
        external nonReentrant returns (uint256 amount)
    {
        _creditExternal(auth, signature, settlementTransaction);
        amount = auth.value;
        IERC20(_paymentUsdc()).safeTransfer(auth.from, amount);
        emit ExternalSettlementRefunded(auth.from, auth.nonce, settlementTransaction, amount);
    }
}
