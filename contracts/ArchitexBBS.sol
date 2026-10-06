// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AuthorizationGate} from "./agents/AuthorizationGate.sol";
import {IArchitexLaunchpad} from "./interfaces/IArchitexLaunchpad.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";

/// @notice An immutable message log paid through signed USDC authorizations.
/// @dev Fees and recipient are configurable. No admin can edit, hide, delete or pause posts.
///      Relay authorization and the flat relay fee follow the immutable launchpad dependency.
contract ArchitexBBS is AuthorizationGate {
    using SafeERC20 for IERC20;

    error TextTooLong(uint256 length, uint256 max);
    error Forbidden();
    error ZeroAddress();
    error PostFeeTooHigh();
    error WrongPaymentAsset();

    event Message(address indexed from, uint256 indexed id, uint256 time, string text);
    event Relayed(address indexed relayer, address indexed from, bytes32 indexed nonce, uint8 action, bool bound, uint256 relayFee);
    event FeeToUpdated(address indexed feeTo);
    event FeeToSetterUpdated(address indexed feeToSetter);
    event PostFeeUpdated(uint256 postFee);
    event FeesCollected(address indexed feeTo, uint256 amount);

    uint256 public constant MAX_TEXT_BYTES = 280;
    uint256 public constant MAX_POST_FEE = 1_000_000;
    bytes32 public constant POST_TYPEHASH = keccak256("Post(string text,bytes32 salt)");
    address public immutable usdc;
    address public immutable launchpad;
    address public feeTo;
    address public feeToSetter;
    uint256 public postFee = 10_000;
    uint256 public pendingFees;
    uint256 private _count;

    constructor(address paymentUsdc, address pad, address recipient, address setter) {
        if (paymentUsdc == address(0) || pad == address(0) || recipient == address(0) || recipient == address(this) || setter == address(0)) revert ZeroAddress();
        if (IArchitexLaunchpad(pad).usdc() != paymentUsdc) revert WrongPaymentAsset();
        usdc = paymentUsdc;
        launchpad = pad;
        feeTo = recipient;
        feeToSetter = setter;
    }

    function isRelayer(address caller) public view returns (bool) { return IArchitexLaunchpad(launchpad).isRelayer(caller); }
    function tradeRelayFee() public view returns (uint256) { return IArchitexLaunchpad(launchpad).tradeRelayFee(); }
    function _paymentUsdc() internal view override returns (address) { return usdc; }
    function _allowedRelayer(address caller) internal view override returns (bool) { return isRelayer(caller); }
    function accountedUsdc() public view override returns (uint256) { return pendingFees; }

    function setFeeTo(address recipient) external {
        if (msg.sender != feeToSetter) revert Forbidden();
        if (recipient == address(0) || recipient == address(this)) revert ZeroAddress();
        feeTo = recipient;
        emit FeeToUpdated(recipient);
    }

    function setFeeToSetter(address setter) external {
        if (msg.sender != feeToSetter) revert Forbidden();
        feeToSetter = setter;
        emit FeeToSetterUpdated(setter);
    }

    function setPostFee(uint256 fee) external {
        if (msg.sender != feeToSetter) revert Forbidden();
        if (fee > MAX_POST_FEE) revert PostFeeTooHigh();
        postFee = fee;
        emit PostFeeUpdated(fee);
    }

    function collectFees() external nonReentrant returns (uint256 amount) {
        amount = pendingFees;
        if (amount == 0) return 0;
        pendingFees = 0;
        IERC20(usdc).safeTransfer(feeTo, amount);
        emit FeesCollected(feeTo, amount);
    }

    function postNonce(string calldata text, bytes32 salt) public pure returns (bytes32) {
        return _boundNonce(keccak256(abi.encode(POST_TYPEHASH, keccak256(bytes(text)), salt)));
    }

    function postWithAuthorization(string calldata text, bytes32 salt, IERC3009.Authorization calldata auth, bytes calldata signature, bytes32 settlementTransaction)
        external nonReentrant returns (uint256 id)
    {
        uint256 length = bytes(text).length;
        if (length > MAX_TEXT_BYTES) revert TextTooLong(length, MAX_TEXT_BYTES);
        bool bound = _boundAuthorization(postNonce(text, salt), auth.nonce);
        if (!bound && !isRelayer(msg.sender)) revert Forbidden();
        uint256 relayFee = tradeRelayFee();
        uint256 expected = postFee + relayFee;
        if (auth.value != expected) revert PaymentValueMismatch(expected, auth.value);
        _takeUsdc(auth, signature, settlementTransaction);
        pendingFees += postFee;
        id = _count++;
        emit Message(auth.from, id, block.timestamp, text);
        if (relayFee > 0) IERC20(usdc).safeTransfer(msg.sender, relayFee);
        emit Relayed(msg.sender, auth.from, auth.nonce, 3, bound, relayFee);
    }

    function messageCount() external view returns (uint256) { return _count; }
}
