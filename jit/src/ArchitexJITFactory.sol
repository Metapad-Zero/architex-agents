// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {ArchitexJITToken} from "./ArchitexJITToken.sol";
import {ArchitexJITVault} from "./ArchitexJITVault.sol";
import {ArchitexJITHook} from "./ArchitexJITHook.sol";
import {ArchitexJITExecutor} from "./ArchitexJITExecutor.sol";
import {ArchitexJITHookDeployer} from "./ArchitexJITHookDeployer.sol";

/// @notice Atomic fixed-supply token launches with nonredeemable capital and immutable JIT terms.
/// @dev Direct caller is creator and capital payer. No relay, privileged withdrawal or upgrade exists.
contract ArchitexJITFactory {
    using SafeERC20 for IERC20;

    struct LaunchConfig {
        string name;
        string symbol;
        string metadataURI;
        uint256 seedUSDC;
        address feeRecipient;
        uint24 poolFee;
        int24 tickSpacing;
        ArchitexJITHook.Policy policy;
        bytes32 creatorNonce;
        uint256 hookSaltNonce;
        uint64 deadline;
    }

    struct LaunchPrediction {
        bytes32 launchId;
        bytes32 configHash;
        address token;
        address vault;
        address hook;
        address executor;
        bytes32 hookInitCodeHash;
    }

    struct LaunchRecord {
        address creator;
        address token;
        address vault;
        address hook;
        address executor;
        bytes32 poolId;
        bytes32 configHash;
        uint256 seedUSDC;
        uint64 createdAt;
    }

    error InvalidConfiguration();
    error InvalidLaunch();
    error DeadlineExpired();
    error NonceAlreadyUsed();
    error InvalidHookAddress();
    error InsufficientInitialCapital();
    error TransferMismatch();
    error DeploymentMismatch();
    error Reentrancy();
    error UnknownLaunch();

    uint24 public constant POOL_FEE = 3_000;
    int24 public constant TICK_SPACING = 60;
    uint256 public constant TOKEN_SUPPLY = 1_000_000_000e18;
    bytes32 private constant TOKEN_DOMAIN = keccak256("ARCHITEX_JIT_TOKEN");
    bytes32 private constant VAULT_DOMAIN = keccak256("ARCHITEX_JIT_VAULT");
    bytes32 private constant HOOK_DOMAIN = keccak256("ARCHITEX_JIT_HOOK");
    bytes32 private constant EXECUTOR_DOMAIN = keccak256("ARCHITEX_JIT_EXECUTOR");

    IPoolManager public immutable poolManager;
    address public immutable quote;
    ArchitexJITHookDeployer public immutable hookDeployer;
    mapping(address => mapping(bytes32 => bool)) public usedNonce;
    mapping(address => bytes32) public launchIdOfToken;
    mapping(bytes32 => LaunchRecord) private launches;
    bytes32[] private launchIds;
    bool private entered;

    event LaunchCreated(
        bytes32 indexed launchId,
        address indexed creator,
        address indexed token,
        address vault,
        address hook,
        address executor,
        bytes32 poolId,
        bytes32 configHash,
        uint256 seedUSDC,
        string metadataURI
    );

    constructor(IPoolManager manager, address quote_, ArchitexJITHookDeployer deployer) {
        if (
            address(manager).code.length == 0 || quote_.code.length == 0
                || address(deployer).codehash != keccak256(type(ArchitexJITHookDeployer).runtimeCode)
                || deployer.poolManager() != manager
        ) revert InvalidConfiguration();
        (bool ok, bytes memory result) = quote_.staticcall(abi.encodeWithSignature("decimals()"));
        if (!ok || result.length != 32 || abi.decode(result, (uint256)) != 6) revert InvalidConfiguration();
        poolManager = manager;
        quote = quote_;
        hookDeployer = deployer;
    }

    function configHash(LaunchConfig calldata config) public pure returns (bytes32) {
        return keccak256(abi.encode(config));
    }

    function tokenSalt(bytes32 launchId) public pure returns (bytes32) {
        return keccak256(abi.encode(TOKEN_DOMAIN, launchId));
    }

    function vaultSalt(bytes32 launchId) public pure returns (bytes32) {
        return keccak256(abi.encode(VAULT_DOMAIN, launchId));
    }

    function executorSalt(bytes32 launchId) public pure returns (bytes32) {
        return keccak256(abi.encode(EXECUTOR_DOMAIN, launchId));
    }

    function hookSalt(bytes32 launchId, uint256 nonce) public pure returns (bytes32) {
        return keccak256(abi.encode(HOOK_DOMAIN, launchId, nonce));
    }

    /// @notice Purely predictive: deadlines, nonce use and capital are validated by launch, not this view.
    function predictLaunch(address creator, LaunchConfig calldata config)
        public
        view
        returns (LaunchPrediction memory predicted)
    {
        predicted.launchId = keccak256(abi.encode(creator, config.creatorNonce));
        predicted.configHash = configHash(config);
        predicted.token = _create2Address(
            address(this),
            tokenSalt(predicted.launchId),
            keccak256(abi.encodePacked(type(ArchitexJITToken).creationCode, abi.encode(config.name, config.symbol)))
        );
        predicted.vault = _create2Address(
            address(this),
            vaultSalt(predicted.launchId),
            keccak256(
                abi.encodePacked(
                    type(ArchitexJITVault).creationCode,
                    abi.encode(poolManager, predicted.token, quote, config.feeRecipient)
                )
            )
        );
        predicted.hookInitCodeHash = hookDeployer.hookInitCodeHash(
            ArchitexJITVault(predicted.vault), config.poolFee, config.tickSpacing, config.policy
        );
        predicted.hook = _create2Address(
            address(hookDeployer), hookSalt(predicted.launchId, config.hookSaltNonce), predicted.hookInitCodeHash
        );
        predicted.executor = _create2Address(
            address(this),
            executorSalt(predicted.launchId),
            keccak256(
                abi.encodePacked(
                    type(ArchitexJITExecutor).creationCode, abi.encode(poolManager, ArchitexJITHook(predicted.hook))
                )
            )
        );
    }

    function launch(LaunchConfig calldata config) external returns (LaunchRecord memory record) {
        if (entered) revert Reentrancy();
        entered = true;
        _validate(config);
        if (usedNonce[msg.sender][config.creatorNonce]) revert NonceAlreadyUsed();
        LaunchPrediction memory predicted = predictLaunch(msg.sender, config);
        if ((uint160(predicted.hook) & 0x3fff) != 0x2ae0) revert InvalidHookAddress();
        if (
            config.feeRecipient == predicted.token || config.feeRecipient == predicted.vault
                || config.feeRecipient == predicted.hook || config.feeRecipient == predicted.executor
        ) revert InvalidLaunch();
        usedNonce[msg.sender][config.creatorNonce] = true;

        ArchitexJITToken token = new ArchitexJITToken{salt: tokenSalt(predicted.launchId)}(config.name, config.symbol);
        ArchitexJITVault vault = new ArchitexJITVault{salt: vaultSalt(predicted.launchId)}(
            poolManager, address(token), quote, config.feeRecipient
        );
        ArchitexJITHook hook = hookDeployer.deploy(
            hookSalt(predicted.launchId, config.hookSaltNonce), vault, config.poolFee, config.tickSpacing, config.policy
        );
        ArchitexJITExecutor executor =
            new ArchitexJITExecutor{salt: executorSalt(predicted.launchId)}(poolManager, hook);
        if (
            address(token) != predicted.token || address(vault) != predicted.vault || address(hook) != predicted.hook
                || address(executor) != predicted.executor
        ) revert DeploymentMismatch();

        (uint256 jitAmount0, uint256 jitAmount1) = _validateCapital(config, address(token));
        vault.bindHook(address(hook));
        IERC20 usdc = IERC20(quote);
        uint256 cashBefore = usdc.balanceOf(address(this));
        uint256 creatorBefore = usdc.balanceOf(msg.sender);
        usdc.safeTransferFrom(msg.sender, address(this), config.seedUSDC);
        if (
            creatorBefore < config.seedUSDC || usdc.balanceOf(msg.sender) != creatorBefore - config.seedUSDC
                || usdc.balanceOf(address(this)) != cashBefore + config.seedUSDC
        ) revert TransferMismatch();

        IERC20(address(token)).forceApprove(address(vault), TOKEN_SUPPLY);
        vault.deposit(address(token), TOKEN_SUPPLY);
        IERC20(address(token)).forceApprove(address(vault), 0);
        usdc.forceApprove(address(vault), config.seedUSDC);
        vault.deposit(quote, config.seedUSDC);
        usdc.forceApprove(address(vault), 0);
        if (token.balanceOf(address(this)) != 0 || usdc.balanceOf(address(this)) != cashBefore) {
            revert TransferMismatch();
        }

        hook.seedBaseline();
        if (
            vault.availableInventory(vault.currency0()) < jitAmount0
                || vault.availableInventory(vault.currency1()) < jitAmount1 || !hook.baselineSeeded()
        ) revert InsufficientInitialCapital();

        record = LaunchRecord({
            creator: msg.sender,
            token: address(token),
            vault: address(vault),
            hook: address(hook),
            executor: address(executor),
            poolId: PoolId.unwrap(hook.poolId()),
            configHash: predicted.configHash,
            seedUSDC: config.seedUSDC,
            createdAt: uint64(block.timestamp)
        });
        launches[predicted.launchId] = record;
        launchIds.push(predicted.launchId);
        launchIdOfToken[address(token)] = predicted.launchId;
        emit LaunchCreated(
            predicted.launchId,
            msg.sender,
            address(token),
            address(vault),
            address(hook),
            address(executor),
            record.poolId,
            record.configHash,
            config.seedUSDC,
            config.metadataURI
        );
        entered = false;
    }

    function launchesLength() external view returns (uint256) {
        return launchIds.length;
    }

    function launchIdAt(uint256 index) external view returns (bytes32) {
        return launchIds[index];
    }

    function getLaunch(bytes32 launchId) external view returns (LaunchRecord memory record) {
        record = launches[launchId];
        if (record.creator == address(0)) revert UnknownLaunch();
    }

    function _validate(LaunchConfig calldata config) private view {
        if (block.timestamp > config.deadline) revert DeadlineExpired();
        if (
            bytes(config.name).length == 0 || bytes(config.name).length > 32 || bytes(config.symbol).length == 0
                || bytes(config.symbol).length > 10 || bytes(config.metadataURI).length > 256 || config.seedUSDC == 0
                || config.feeRecipient == address(0) || config.feeRecipient == address(this)
                || config.feeRecipient == address(poolManager) || config.feeRecipient == address(hookDeployer)
                || config.feeRecipient == quote || config.poolFee != POOL_FEE || config.tickSpacing != TICK_SPACING
                || config.policy.validUntil != type(uint64).max
        ) revert InvalidLaunch();
    }

    function _validateCapital(LaunchConfig calldata config, address token)
        private
        view
        returns (uint256 jitAmount0, uint256 jitAmount1)
    {
        ArchitexJITHook.Policy calldata policy = config.policy;
        (uint256 baseline0, uint256 baseline1) = _requiredAmounts(
            policy.initialSqrtPriceX96, policy.baselineLower, policy.baselineUpper, policy.baselineLiquidity
        );
        (jitAmount0, jitAmount1) =
            _requiredAmounts(policy.initialSqrtPriceX96, policy.jitLower, policy.jitUpper, policy.jitLiquidity);
        uint256 capital0 = token < quote ? TOKEN_SUPPLY : config.seedUSDC;
        uint256 capital1 = token < quote ? config.seedUSDC : TOKEN_SUPPLY;
        if (
            baseline0 + jitAmount0 > capital0 || baseline1 + jitAmount1 > capital1 || jitAmount0 > policy.maxJITAmount0
                || jitAmount1 > policy.maxJITAmount1
        ) revert InsufficientInitialCapital();
    }

    function _requiredAmounts(uint160 price, int24 lower, int24 upper, uint128 liquidity)
        private
        pure
        returns (uint256 amount0, uint256 amount1)
    {
        // Hook constructor has already proved the initial price lies strictly within both positions.
        amount0 = SqrtPriceMath.getAmount0Delta(price, TickMath.getSqrtPriceAtTick(upper), liquidity, true);
        amount1 = SqrtPriceMath.getAmount1Delta(TickMath.getSqrtPriceAtTick(lower), price, liquidity, true);
    }

    function _create2Address(address deployer, bytes32 salt, bytes32 initHash) private pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initHash)))));
    }
}
