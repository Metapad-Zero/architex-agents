// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

interface IJITVaultHook {
    function poolManager() external view returns (IPoolManager);
    function vault() external view returns (ArchitexJITVault);
}

/// @notice Pool-specific inventory and earned LP fee custody. Deposits confer no withdrawal right.
/// @dev Cash and PoolManager claims represent the same asset in different locations, never two assets.
contract ArchitexJITVault is IUnlockCallback {
    using BalanceDeltaLibrary for BalanceDelta;

    error InvalidConfiguration();
    error UnsupportedCurrency();
    error HookNotBound();
    error AlreadyBound();
    error Unauthorized();
    error Reentrancy();
    error InvalidAmount();
    error TransferFailed();
    error TransferMismatch();
    error InsufficientInventory();
    error InsufficientFees();
    error InvalidCallback();
    error InvalidFeeDelta();
    error ManagerUnlocked();

    IPoolManager public immutable poolManager;
    address public immutable token;
    address public immutable quote;
    address public immutable currency0;
    address public immutable currency1;
    address public immutable feeRecipient;
    address private immutable binder;
    address public hook;

    /// @notice Historical deposits, not a redeemable balance or a guarantee against trading losses.
    mapping(address => uint256) public principalDeposited;
    mapping(address => uint256) public feeCredits;
    mapping(address => uint256) public feesClaimed;

    bool private entered;
    bytes32 private claimContext;
    bytes32 private constant UNLOCKED_SLOT = bytes32(uint256(keccak256("Unlocked")) - 1);

    event HookBound(address indexed hook);
    event InventoryDeposited(address indexed depositor, address indexed currency, uint256 amount);
    event FeesAccrued(uint256 amount0, uint256 amount1);
    event FeesClaimed(address indexed currency, address indexed recipient, uint256 amount);

    constructor(IPoolManager manager, address token_, address quote_, address recipient) {
        if (
            address(manager).code.length == 0 || token_ == quote_ || token_.code.length == 0 || quote_.code.length == 0
                || recipient == address(0) || recipient == address(this) || recipient == address(manager)
        ) revert InvalidConfiguration();
        (bool ok, bytes memory data) = quote_.staticcall(abi.encodeWithSignature("decimals()"));
        if (!ok || data.length != 32 || abi.decode(data, (uint256)) != 6) revert InvalidConfiguration();
        poolManager = manager;
        token = token_;
        quote = quote_;
        (currency0, currency1) = token_ < quote_ ? (token_, quote_) : (quote_, token_);
        feeRecipient = recipient;
        binder = msg.sender;
    }

    modifier onlyHook() {
        if (msg.sender != hook || hook == address(0)) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    /// @notice One-time deployment binding; this authority cannot rotate the engine afterward.
    function bindHook(address hook_) external {
        if (msg.sender != binder) revert Unauthorized();
        if (hook != address(0)) revert AlreadyBound();
        if (
            hook_.code.length == 0 || hook_ == feeRecipient || IJITVaultHook(hook_).poolManager() != poolManager
                || address(IJITVaultHook(hook_).vault()) != address(this)
        ) revert InvalidConfiguration();
        hook = hook_;
        poolManager.setOperator(hook_, true);
        emit HookBound(hook_);
    }

    function deposit(address currency, uint256 amount) external nonReentrant {
        if (hook == address(0)) revert HookNotBound();
        _requireManagerLocked();
        _checkCurrency(currency);
        if (amount == 0) revert InvalidAmount();
        uint256 beforeBalance = cashBalance(currency);
        uint256 senderBalance = _balanceOf(currency, msg.sender);
        _callToken(
            currency,
            abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), amount)
        );
        if (
            senderBalance < amount || cashBalance(currency) != beforeBalance + amount
                || _balanceOf(currency, msg.sender) != senderBalance - amount
        ) revert TransferMismatch();
        principalDeposited[currency] += amount;
        emit InventoryDeposited(msg.sender, currency, amount);
    }

    function cashBalance(address currency) public view returns (uint256) {
        _checkCurrency(currency);
        (bool ok, bytes memory data) = currency.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        if (!ok || data.length != 32) revert TransferFailed();
        return abi.decode(data, (uint256));
    }

    function claimBalance(address currency) public view returns (uint256) {
        _checkCurrency(currency);
        return poolManager.balanceOf(address(this), uint256(uint160(currency)));
    }

    /// @notice Uncommitted inventory only; excludes both active positions and already earned fees.
    function availableInventory(address currency) public view returns (uint256) {
        uint256 balance = cashBalance(currency) + claimBalance(currency);
        uint256 reserved = feeCredits[currency];
        if (balance < reserved) revert InsufficientInventory();
        return balance - reserved;
    }

    function inventoryOperationActive() external view returns (bool) {
        return entered;
    }

    /// @dev The hook burns claims itself to discharge its own delta. This settles the cash remainder.
    function settleCurrency(address currency, uint256 amount) external onlyHook nonReentrant {
        _checkCurrency(currency);
        if (amount == 0 || amount > availableInventory(currency) || amount > cashBalance(currency)) {
            revert InsufficientInventory();
        }
        Currency asset = Currency.wrap(currency);
        uint256 beforeBalance = cashBalance(currency);
        poolManager.sync(asset);
        _callToken(currency, abi.encodeWithSignature("transfer(address,uint256)", address(poolManager), amount));
        if (cashBalance(currency) != beforeBalance - amount || poolManager.settleFor(hook) != amount) {
            revert TransferMismatch();
        }
    }

    /// @dev Only settled modifyLiquidity fee deltas enter this ledger; unsolicited assets do not.
    function recordFees(BalanceDelta fees) external onlyHook {
        int128 amount0 = fees.amount0();
        int128 amount1 = fees.amount1();
        if (amount0 < 0 || amount1 < 0) revert InvalidFeeDelta();
        uint256 earned0 = uint256(uint128(amount0));
        uint256 earned1 = uint256(uint128(amount1));
        if (earned0 > availableInventory(currency0) || earned1 > availableInventory(currency1)) {
            revert InsufficientInventory();
        }
        feeCredits[currency0] += earned0;
        feeCredits[currency1] += earned1;
        if (earned0 != 0 || earned1 != 0) emit FeesAccrued(earned0, earned1);
    }

    /// @notice Anyone can deliver earned fees, but only to the immutable recipient.
    function claimFees(address currency, uint256 amount) external nonReentrant {
        _requireManagerLocked();
        _checkCurrency(currency);
        if (amount == 0 || amount > feeCredits[currency]) revert InsufficientFees();
        feeCredits[currency] -= amount;
        feesClaimed[currency] += amount;
        uint256 cash = cashBalance(currency);
        uint256 fromCash = cash < amount ? cash : amount;
        if (fromCash != 0) _transferExact(currency, feeRecipient, fromCash);
        uint256 fromClaims = amount - fromCash;
        if (fromClaims != 0) {
            if (fromClaims > claimBalance(currency)) revert InsufficientInventory();
            bytes memory data = abi.encode(currency, fromClaims);
            claimContext = keccak256(data);
            poolManager.unlock(data);
            claimContext = bytes32(0);
        }
        emit FeesClaimed(currency, feeRecipient, amount);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (
            msg.sender != address(poolManager) || !entered || claimContext == bytes32(0)
                || keccak256(data) != claimContext
        ) {
            revert InvalidCallback();
        }
        (address currency, uint256 amount) = abi.decode(data, (address, uint256));
        claimContext = bytes32(0);
        uint256 beforeBalance = _balanceOf(currency, feeRecipient);
        uint256 managerBalance = _balanceOf(currency, address(poolManager));
        poolManager.burn(address(this), uint256(uint160(currency)), amount);
        poolManager.take(Currency.wrap(currency), feeRecipient, amount);
        if (
            managerBalance < amount || _balanceOf(currency, feeRecipient) != beforeBalance + amount
                || _balanceOf(currency, address(poolManager)) != managerBalance - amount
        ) revert TransferMismatch();
        return bytes("");
    }

    function _transferExact(address currency, address recipient, uint256 amount) private {
        uint256 beforeBalance = _balanceOf(currency, recipient);
        uint256 senderBalance = cashBalance(currency);
        _callToken(currency, abi.encodeWithSignature("transfer(address,uint256)", recipient, amount));
        if (
            senderBalance < amount || _balanceOf(currency, recipient) != beforeBalance + amount
                || cashBalance(currency) != senderBalance - amount
        ) revert TransferMismatch();
    }

    function _balanceOf(address currency, address account) private view returns (uint256) {
        (bool ok, bytes memory data) = currency.staticcall(abi.encodeWithSignature("balanceOf(address)", account));
        if (!ok || data.length != 32) revert TransferFailed();
        return abi.decode(data, (uint256));
    }

    function _callToken(address currency, bytes memory data) private {
        (bool ok, bytes memory result) = currency.call(data);
        if (!ok || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) {
            revert TransferFailed();
        }
    }

    function _checkCurrency(address currency) private view {
        if (currency != currency0 && currency != currency1) revert UnsupportedCurrency();
    }

    /// @dev Explicitly pinned to the verified PoolManager release's transient lock layout.
    function _requireManagerLocked() private view {
        if (poolManager.exttload(UNLOCKED_SLOT) != bytes32(0)) revert ManagerUnlocked();
    }
}
