// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ILaunchToken} from "../interfaces/ILaunchToken.sol";

/// @title LaunchToken
/// @notice Fixed-supply ERC-20 minted entirely to the launchpad at construction.
///         No owner, no mint/burn after construction.
///         Transfer to the registered Architex pair is blocked until graduation so the
///         launchpad controls the pool opening price.
contract LaunchToken is ERC20, EIP712, ILaunchToken {
    /// @inheritdoc ILaunchToken
    address public immutable launchpad;

    /// @inheritdoc ILaunchToken
    address public pair;

    /// @inheritdoc ILaunchToken
    bool public graduated;

    uint256 private constant _TOTAL = 1_000_000_000e18;
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH = keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");
    bytes32 public constant PERMIT_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;
    mapping(address => uint256) public nonces;
    error PermitExpired(uint256 deadline);

    constructor(string memory _name, string memory _symbol) ERC20(_name, _symbol) EIP712(_name, "1") {
        launchpad = msg.sender;
        _mint(msg.sender, _TOTAL);
    }

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyLaunchpad() {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        _;
    }

    // ─── Launchpad-only state setters ─────────────────────────────────────────

    /// @inheritdoc ILaunchToken
    /// @notice Launchpad only, callable once: register the Architex pair.
    function initPair(address _pair) external onlyLaunchpad {
        if (pair != address(0)) revert PairAlreadySet();
        pair = _pair;
    }

    /// @inheritdoc ILaunchToken
    /// @notice Launchpad only, callable once: open transfers to the pair.
    function markGraduated() external onlyLaunchpad {
        if (graduated) revert AlreadyGraduated();
        graduated = true;
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata signature) external {
        _transferAuthorization(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature);
    }

    function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        _transferAuthorization(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v));
    }

    function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata signature) external {
        if (to != msg.sender) revert CallerMustBePayee();
        _transferAuthorization(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature);
    }

    function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        if (to != msg.sender) revert CallerMustBePayee();
        _transferAuthorization(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v));
    }

    function _transferAuthorization(bytes32 typeHash, address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes memory signature) private {
        // Unlike native USDC, this token can prevent a detached payment to the launchpad.
        if (to == launchpad && msg.sender != launchpad) revert OnlyLaunchpad();
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid(validAfter);
        if (block.timestamp >= validBefore) revert AuthorizationExpired(validBefore);
        _requireUnused(from, nonce);
        _verify(from, keccak256(abi.encode(typeHash, from, to, value, validAfter, validBefore, nonce)), signature);
        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, bytes calldata signature) external {
        _cancel(authorizer, nonce, signature);
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        _cancel(authorizer, nonce, abi.encodePacked(r, s, v));
    }

    function _cancel(address authorizer, bytes32 nonce, bytes memory signature) private {
        _requireUnused(authorizer, nonce);
        _verify(authorizer, keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)), signature);
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _requireUnused(address authorizer, bytes32 nonce) private view {
        if (_authorizationStates[authorizer][nonce]) revert AuthorizationAlreadyUsed(authorizer, nonce);
    }

    function _verify(address signer, bytes32 structHash, bytes memory signature) private view {
        if (signer == address(0) || !SignatureChecker.isValidSignatureNow(signer, _hashTypedDataV4(structHash), signature)) revert InvalidSignature();
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        _permit(owner, spender, value, deadline, abi.encodePacked(r, s, v));
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, bytes calldata signature) external {
        _permit(owner, spender, value, deadline, signature);
    }

    function _permit(address owner, address spender, uint256 value, uint256 deadline, bytes memory signature) private {
        if (block.timestamp > deadline) revert PermitExpired(deadline);
        uint256 nonce = nonces[owner];
        _verify(owner, keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonce, deadline)), signature);
        nonces[owner] = nonce + 1;
        _approve(owner, spender, value);
    }

    // ─── Transfer hook ────────────────────────────────────────────────────────

    /// @dev Reverts any transfer TO `pair` before graduation.
    function _update(address from, address to, uint256 value) internal override {
        if (to == pair && pair != address(0) && !graduated) {
            revert PairLockedUntilGraduation();
        }
        super._update(from, to, value);
    }
}
