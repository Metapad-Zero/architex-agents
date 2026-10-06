// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC3009} from "./IERC3009.sol";

/// @notice A token launched on the Architex launchpad: fixed 1B supply, no owner, no mint after construction.
interface ILaunchToken is IERC20, IERC3009 {
    error OnlyLaunchpad();
    error PairAlreadySet();
    error AlreadyGraduated();
    error PairLockedUntilGraduation();

    function launchpad() external view returns (address);
    function pair() external view returns (address);
    function graduated() external view returns (bool);

    /// @notice Launchpad only, once: the Architex pair that stays closed to deposits until graduation.
    function initPair(address pair) external;
    /// @notice Launchpad only, once: opens transfers to the pair.
    function markGraduated() external;
    function nonces(address owner) external view returns (uint256);
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
    function permit(address owner, address spender, uint256 value, uint256 deadline, bytes calldata signature) external;
}
