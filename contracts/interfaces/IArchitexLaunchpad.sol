// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC3009} from "./IERC3009.sol";

/// @notice Authorization-only launchpad. Read views and indexing event shapes retain the curve ABI.
interface IArchitexLaunchpad {
    struct LaunchParams {
        string name;
        string symbol;
        string metadataURI;
        uint256 initialBuyUsdc;
        uint256 minTokensOut;
    }

    struct Curve {
        address token;
        address creator;
        address pair; // Architex pair for (token, USDC); holds liquidity only after graduation
        uint128 virtualUsdc; // 6 decimals
        uint128 virtualTokens; // 18 decimals
        uint128 tokensSold; // 18 decimals, at most CURVE_SUPPLY
        uint64 createdAt;
        bool graduated;
        string metadataURI;
    }

    event TokenCreated(address indexed token, address indexed creator, address indexed pair, string name, string symbol, string metadataURI);
    event Trade(
        address indexed token,
        address indexed trader,
        bool isBuy,
        uint256 usdcAmount, // gross USDC paid by a buyer, or gross USDC leaving the curve on a sell
        uint256 tokenAmount,
        uint256 fee,
        uint256 virtualUsdc,
        uint256 virtualTokens
    );
    event Graduated(address indexed token, address indexed pair, uint256 usdcSeeded, uint256 tokensSeeded, uint256 liquidityLocked);
    event FeeToUpdated(address indexed feeTo);
    event FeeToSetterUpdated(address indexed feeToSetter);
    event LaunchFeeUpdated(uint256 launchFee);
    event FeesCollected(address indexed feeTo, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error Forbidden();
    error UnknownToken();
    error CurveGraduated();
    error SlippageExceeded();
    /// @notice A sell (or its quote) for more tokens than the curve has sold.
    error ExceedsSold();
    error InvalidName();
    error InvalidSymbol();
    error InvalidMetadata();
    error LaunchFeeTooHigh();

    function usdc() external view returns (address);
    function factory() external view returns (address);
    function feeTo() external view returns (address);
    function feeToSetter() external view returns (address);
    function launchFee() external view returns (uint256);
    /// @notice Trade and launch fees accrued in the launchpad and not yet sent to `feeTo`.
    function pendingFees() external view returns (uint256);

    function TOTAL_SUPPLY() external view returns (uint256);
    function CURVE_SUPPLY() external view returns (uint256);
    function POOL_SUPPLY() external view returns (uint256);
    function VIRTUAL_TOKENS_0() external view returns (uint256);
    function VIRTUAL_USDC_0() external view returns (uint256);
    function FEE_BPS() external view returns (uint256);
    function MAX_LAUNCH_FEE() external view returns (uint256);

    event Relayed(address indexed relayer, address indexed from, bytes32 indexed nonce, uint8 action, bool bound, uint256 relayFee);
    event RelayerUpdated(address indexed relayer, bool allowed);
    event RelayFeesUpdated(uint256 tradeRelayFee, uint256 launchRelayFee);
    error RelayFeeTooHigh();
    error RelayFeeExceedsProceeds();

    function launchWithAuthorization(LaunchParams calldata params, bytes32 salt, IERC3009.Authorization calldata auth, bytes calldata signature, bytes32 settlementTransaction) external returns (address token, uint256 tokensOut);
    function buyWithAuthorization(address token, uint256 minTokensOut, bytes32 salt, IERC3009.Authorization calldata auth, bytes calldata signature, bytes32 settlementTransaction) external returns (uint256 tokensOut, uint256 usdcSpent);
    function sellWithAuthorization(address token, uint256 minUsdcOut, bytes32 salt, IERC3009.Authorization calldata auth, bytes calldata signature) external returns (uint256 usdcOut);
    function launchNonce(LaunchParams calldata params, bytes32 salt) external pure returns (bytes32);
    function buyNonce(address token, uint256 minTokensOut, bytes32 salt) external pure returns (bytes32);
    function sellNonce(address token, uint256 minUsdcOut, bytes32 salt) external pure returns (bytes32);
    function isRelayer(address caller) external view returns (bool);
    function tradeRelayFee() external view returns (uint256);
    function launchRelayFee() external view returns (uint256);
    function setRelayer(address relayer, bool allowed) external;
    function setRelayFees(uint256 tradeFee, uint256 launchFee_) external;

    function quoteBuy(address token, uint256 usdcIn) external view returns (uint256 tokensOut, uint256 fee, uint256 usdcSpent, bool graduates);
    function quoteSell(address token, uint256 tokensIn) external view returns (uint256 usdcOut, uint256 fee);

    function curves(address token) external view returns (Curve memory);
    function tokensLength() external view returns (uint256);
    function tokenAt(uint256 index) external view returns (address);
    function curvesPage(uint256 start, uint256 count) external view returns (Curve[] memory);

    /// @return USDC (6 decimals) per whole token, scaled by 1e18
    function spotPrice(address token) external view returns (uint256);
    /// @return spot price times CURVE_SUPPLY, in USDC (6 decimals)
    function marketCap(address token) external view returns (uint256);
    /// @return tokensSold / CURVE_SUPPLY in basis points
    function progressBps(address token) external view returns (uint256);

    /// @notice Permissionless: sends `pendingFees` to `feeTo`. Fees are never pushed during a trade, so a
    ///         reverting or blocklisted `feeTo` cannot stop trading.
    function collectFees() external returns (uint256 amount);

    function setFeeTo(address feeTo) external;
    function setFeeToSetter(address feeToSetter) external;
    function setLaunchFee(uint256 launchFee) external;
}
