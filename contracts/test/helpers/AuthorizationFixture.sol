// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArchitexFactory} from "../../ArchitexFactory.sol";
import {ArchitexLaunchpad} from "../../launchpad/ArchitexLaunchpad.sol";
import {LaunchToken} from "../../launchpad/LaunchToken.sol";
import {ArchitexBBS} from "../../ArchitexBBS.sol";
import {IERC3009} from "../../interfaces/IERC3009.sol";
import {IArchitexLaunchpad} from "../../interfaces/IArchitexLaunchpad.sol";
import {IArchitexPair} from "../../interfaces/IArchitexPair.sol";
import {AuthorizationGate} from "../../agents/AuthorizationGate.sol";

interface IUsdcHook { function onUsdcReceived() external; }

/// @dev USDC model: six decimals, independent EIP-712 signatures, canceled/used shared state.
///      It does not stand in for Arc's native balance precompile in mainnet acceptance evidence.
contract MockUSDCAuth is ERC20, EIP712 {
    bytes32 public constant TRANSFER_TYPEHASH = keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    bytes32 public constant CANCEL_TYPEHASH = keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    mapping(address => bool) public blocked;
    bool public underpay;
    address public hook;
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    constructor() ERC20("USDC", "USDC") EIP712("USDC", "2") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function DOMAIN_SEPARATOR() external view returns (bytes32) { return _domainSeparatorV4(); }
    function mint(address recipient, uint256 amount) external { _mint(recipient, amount); }
    function setBlocked(address who, bool status) external { blocked[who] = status; }
    function setUnderpay(bool status) external { underpay = status; }
    function setHook(address who) external { hook = who; }

    function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata signature) external {
        require(block.timestamp > validAfter, "FiatTokenV2: authorization is not yet valid");
        require(block.timestamp < validBefore, "FiatTokenV2: authorization is expired");
        require(!authorizationState[from][nonce], "FiatTokenV2: authorization is used or canceled");
        bytes32 hash = keccak256(abi.encode(TRANSFER_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        require(from != address(0) && SignatureChecker.isValidSignatureNow(from, _hashTypedDataV4(hash), signature), "FiatTokenV2: invalid signature");
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, underpay && value > 0 ? value - 1 : value);
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, bytes calldata signature) external {
        require(!authorizationState[authorizer][nonce], "used or canceled");
        bytes32 hash = keccak256(abi.encode(CANCEL_TYPEHASH, authorizer, nonce));
        require(SignatureChecker.isValidSignatureNow(authorizer, _hashTypedDataV4(hash), signature), "invalid signature");
        authorizationState[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[from] && !blocked[to], "blocklisted");
        super._update(from, to, value);
        if (to == hook && to != address(0) && from != address(0)) IUsdcHook(to).onUsdcReceived();
    }
}

contract Mock1271Wallet is IERC1271 {
    mapping(bytes32 => bool) public approved;
    bool public revoked;
    function approveDigest(bytes32 hash) external { approved[hash] = true; }
    function setRevoked(bool status) external { revoked = status; }
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        return !revoked && approved[hash] && keccak256(signature) == keccak256(hex"deadbeef") ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}

abstract contract AuthorizationFixture is Test {
    bytes32 internal constant TRANSFER_TYPEHASH = keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    uint256 internal constant ALICE_KEY = 0xA11CE;
    uint256 internal constant BOB_KEY = 0xB0B;
    uint256 internal constant MALLORY_KEY = 0xBAD;
    uint256 internal sequence;
    address internal alice;
    address internal bob;
    address internal mallory;
    address internal relayer;
    address internal setter;
    address internal feeTo;
    MockUSDCAuth internal usdc;
    ArchitexFactory internal factory;
    ArchitexLaunchpad internal pad;
    ArchitexBBS internal bbs;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        alice = vm.addr(ALICE_KEY);
        bob = vm.addr(BOB_KEY);
        mallory = vm.addr(MALLORY_KEY);
        relayer = makeAddr("relayer");
        setter = makeAddr("setter");
        feeTo = makeAddr("feeTo");
        usdc = new MockUSDCAuth();
        factory = new ArchitexFactory(setter);
        pad = new ArchitexLaunchpad(address(usdc), address(factory), feeTo, setter, 250_000);
        bbs = new ArchitexBBS(address(usdc), address(pad), feeTo, setter);
        vm.prank(setter);
        pad.setRelayer(relayer, true);
        usdc.mint(alice, 10_000_000e6);
        usdc.mint(bob, 10_000_000e6);
        usdc.mint(mallory, 10_000_000e6);
    }

    function _nextNonce() internal returns (bytes32) { return keccak256(abi.encode(++sequence)); }
    function _auth(address actor, uint256 value, bytes32 nonce) internal view returns (IERC3009.Authorization memory) {
        return IERC3009.Authorization(actor, value, block.timestamp - 1, block.timestamp + 3600, nonce);
    }
    function _digest(address asset, address to, IERC3009.Authorization memory auth) internal view returns (bytes32) {
        return MessageHashUtils.toTypedDataHash(IERC3009(asset).DOMAIN_SEPARATOR(), keccak256(abi.encode(TRANSFER_TYPEHASH, auth.from, to, auth.value, auth.validAfter, auth.validBefore, auth.nonce)));
    }
    function _signDigest(bytes32 digest, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
    function _signature(address asset, address to, IERC3009.Authorization memory auth, uint256 key) internal view returns (bytes memory) {
        return _signDigest(_digest(asset, to, auth), key);
    }
    function _params(uint256 initial) internal pure returns (IArchitexLaunchpad.LaunchParams memory) {
        return IArchitexLaunchpad.LaunchParams("Agent Coin", "AGENT", "ipfs://agent", initial, 0);
    }
    function _launch(uint256 initial, bool bound) internal returns (address token, uint256 tokens) {
        IArchitexLaunchpad.LaunchParams memory p = _params(initial);
        bytes32 salt = _nextNonce();
        IERC3009.Authorization memory auth = _auth(alice, pad.launchFee() + pad.launchRelayFee() + initial, bound ? pad.launchNonce(p, salt) : _nextNonce());
        bytes memory sig = _signature(address(usdc), address(pad), auth, ALICE_KEY);
        vm.prank(bound ? mallory : relayer);
        return pad.launchWithAuthorization(p, salt, auth, sig, bytes32(0));
    }
    function _buy(address token, uint256 amount, uint256 key, bool bound) internal returns (uint256 tokens, uint256 spent) {
        address actor = vm.addr(key);
        bytes32 salt = _nextNonce();
        IERC3009.Authorization memory auth = _auth(actor, amount + pad.tradeRelayFee(), bound ? pad.buyNonce(token, 0, salt) : _nextNonce());
        bytes memory sig = _signature(address(usdc), address(pad), auth, key);
        vm.prank(bound ? mallory : relayer);
        return pad.buyWithAuthorization(token, 0, salt, auth, sig, bytes32(0));
    }
    function _sell(address token, uint256 amount, uint256 key, bool bound) internal returns (uint256 out) {
        bytes32 salt = _nextNonce();
        IERC3009.Authorization memory auth = _auth(vm.addr(key), amount, bound ? pad.sellNonce(token, 0, salt) : _nextNonce());
        bytes memory sig = _signature(token, address(pad), auth, key);
        vm.prank(bound ? mallory : relayer);
        return pad.sellWithAuthorization(token, 0, salt, auth, sig);
    }
    function _post(string memory text, bool bound) internal returns (uint256 id) {
        bytes32 salt = _nextNonce();
        IERC3009.Authorization memory auth = _auth(alice, bbs.postFee() + bbs.tradeRelayFee(), bound ? bbs.postNonce(text, salt) : _nextNonce());
        bytes memory sig = _signature(address(usdc), address(bbs), auth, ALICE_KEY);
        vm.prank(bound ? mallory : relayer);
        return bbs.postWithAuthorization(text, salt, auth, sig, bytes32(0));
    }
    function _cancel(address actor, bytes32 nonce, uint256 key) internal {
        bytes32 hash = keccak256(abi.encode(usdc.CANCEL_TYPEHASH(), actor, nonce));
        bytes memory sig = _signDigest(MessageHashUtils.toTypedDataHash(usdc.DOMAIN_SEPARATOR(), hash), key);
        usdc.cancelAuthorization(actor, nonce, sig);
    }
    function _externallySettle(address to, IERC3009.Authorization memory auth, bytes memory sig) internal {
        vm.prank(mallory);
        usdc.transferWithAuthorization(auth.from, to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, sig);
    }
    function _assertAccounting() internal view {
        uint256 owed = pad.pendingFees();
        for (uint256 i; i < pad.tokensLength(); ++i) {
            IArchitexLaunchpad.Curve memory c = pad.curves(pad.tokenAt(i));
            if (!c.graduated) owed += uint256(c.virtualUsdc) - pad.VIRTUAL_USDC_0();
            assertEq(uint256(c.virtualTokens) + uint256(c.tokensSold), pad.VIRTUAL_TOKENS_0());
        }
        assertEq(pad.accountedUsdc(), owed);
        assertGe(usdc.balanceOf(address(pad)), owed);
    }
}
