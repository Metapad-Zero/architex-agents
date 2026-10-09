// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ArchitexJITHook} from "./ArchitexJITHook.sol";

/// @notice A separate swap caller so v4 executes the hook's before/after callbacks.
/// @dev This first milestone uses caller-owned ERC20 approvals; signed gateway orders are separate scope.
contract ArchitexJITExecutor is IUnlockCallback {
    using BalanceDeltaLibrary for BalanceDelta;

    struct SwapRequest {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
        uint256 maximumInput;
        uint256 minimumOutput;
        address recipient;
        uint256 deadline;
        bool allowPartialFill;
    }

    error InvalidConfiguration();
    error InvalidRequest();
    error DeadlineExpired();
    error Reentrancy();
    error InvalidCallback();
    error InvalidSwapDelta();
    error InputLimitExceeded();
    error MinimumOutputNotMet();
    error PartialFillNotAllowed();
    error TransferFailed();
    error TransferMismatch();

    IPoolManager public immutable poolManager;
    ArchitexJITHook public immutable hook;
    PoolKey private key;
    bool private entered;
    bytes32 private swapContext;

    event SwapExecuted(
        address indexed payer, address indexed recipient, bool zeroForOne, uint256 amountIn, uint256 amountOut
    );

    constructor(IPoolManager manager, ArchitexJITHook hook_) {
        if (address(manager).code.length == 0 || address(hook_).code.length == 0 || hook_.poolManager() != manager) {
            revert InvalidConfiguration();
        }
        poolManager = manager;
        hook = hook_;
        key = hook_.getPoolKey();
    }

    function getPoolKey() external view returns (PoolKey memory) {
        return key;
    }

    function swap(SwapRequest calldata request) external returns (uint256 amountIn, uint256 amountOut) {
        if (entered) revert Reentrancy();
        if (block.timestamp > request.deadline) revert DeadlineExpired();
        if (
            request.amountSpecified == 0 || request.amountSpecified == type(int256).min || request.maximumInput == 0
                || request.minimumOutput == 0 || request.recipient == address(0)
                || request.recipient == address(poolManager) || request.recipient == address(this)
        ) revert InvalidRequest();
        if (request.amountSpecified < 0 && uint256(-request.amountSpecified) > request.maximumInput) {
            revert InputLimitExceeded();
        }
        entered = true;
        bytes memory data = abi.encode(msg.sender, request);
        swapContext = keccak256(data);
        (amountIn, amountOut) = abi.decode(poolManager.unlock(data), (uint256, uint256));
        swapContext = bytes32(0);
        entered = false;
        emit SwapExecuted(msg.sender, request.recipient, request.zeroForOne, amountIn, amountOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (
            msg.sender != address(poolManager) || !entered || swapContext == bytes32(0)
                || keccak256(data) != swapContext
        ) {
            revert InvalidCallback();
        }
        swapContext = bytes32(0);
        (address payer, SwapRequest memory request) = abi.decode(data, (address, SwapRequest));
        BalanceDelta delta = poolManager.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: request.zeroForOne,
                amountSpecified: request.amountSpecified,
                sqrtPriceLimitX96: request.sqrtPriceLimitX96
            }),
            bytes("")
        );
        int128 inputDelta = request.zeroForOne ? delta.amount0() : delta.amount1();
        int128 outputDelta = request.zeroForOne ? delta.amount1() : delta.amount0();
        if (inputDelta >= 0 || outputDelta <= 0) revert InvalidSwapDelta();
        uint256 amountIn = uint256(-int256(inputDelta));
        uint256 amountOut = uint256(uint128(outputDelta));
        if (amountIn > request.maximumInput) revert InputLimitExceeded();
        if (amountOut < request.minimumOutput) revert MinimumOutputNotMet();
        if (!request.allowPartialFill) {
            uint256 specified =
                uint256(request.amountSpecified < 0 ? -request.amountSpecified : request.amountSpecified);
            if ((request.amountSpecified < 0 ? amountIn : amountOut) != specified) revert PartialFillNotAllowed();
        }

        Currency input = request.zeroForOne ? key.currency0 : key.currency1;
        Currency output = request.zeroForOne ? key.currency1 : key.currency0;
        address inputAsset = Currency.unwrap(input);
        uint256 payerBalance = _balanceOf(inputAsset, payer);
        poolManager.sync(input);
        _callToken(
            inputAsset,
            abi.encodeWithSignature("transferFrom(address,address,uint256)", payer, address(poolManager), amountIn)
        );
        if (
            payerBalance < amountIn || _balanceOf(inputAsset, payer) != payerBalance - amountIn
                || poolManager.settle() != amountIn
        ) revert TransferMismatch();

        address outputAsset = Currency.unwrap(output);
        uint256 recipientBalance = _balanceOf(outputAsset, request.recipient);
        uint256 managerBalance = _balanceOf(outputAsset, address(poolManager));
        poolManager.take(output, request.recipient, amountOut);
        if (
            managerBalance < amountOut || _balanceOf(outputAsset, request.recipient) != recipientBalance + amountOut
                || _balanceOf(outputAsset, address(poolManager)) != managerBalance - amountOut
        ) revert TransferMismatch();
        return abi.encode(amountIn, amountOut);
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
}
