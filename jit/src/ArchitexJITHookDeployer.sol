// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {ArchitexJITVault} from "./ArchitexJITVault.sol";
import {ArchitexJITHook} from "./ArchitexJITHook.sol";

/// @notice Typed CREATE2 deployment only. This module cannot bind a vault or move its inventory.
contract ArchitexJITHookDeployer {
    error InvalidConfiguration();

    // Constructor-set storage, with no setter, keeps runtime identical across deployments.
    // The factory can therefore authenticate this exact module's runtime in its constructor.
    IPoolManager public poolManager;

    constructor(IPoolManager manager) {
        if (address(manager).code.length == 0) revert InvalidConfiguration();
        poolManager = manager;
    }

    function hookInitCodeHash(
        ArchitexJITVault vault,
        uint24 fee,
        int24 tickSpacing,
        ArchitexJITHook.Policy calldata policy
    ) external view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                type(ArchitexJITHook).creationCode, abi.encode(poolManager, vault, fee, tickSpacing, policy)
            )
        );
    }

    function deploy(
        bytes32 salt,
        ArchitexJITVault vault,
        uint24 fee,
        int24 tickSpacing,
        ArchitexJITHook.Policy calldata policy
    ) external returns (ArchitexJITHook hook) {
        hook = new ArchitexJITHook{salt: salt}(poolManager, vault, fee, tickSpacing, policy);
    }
}
