// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {ArchitexJITHookDeployer} from "../src/ArchitexJITHookDeployer.sol";
import {ArchitexJITFactory} from "../src/ArchitexJITFactory.sol";

/// @notice Dry-run by default. Broadcasting requires an externally supplied approved signing account.
contract DeployJIT is Script {
    address internal constant MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    bytes32 internal constant MANAGER_CODE_HASH = 0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626;

    function run() external returns (ArchitexJITHookDeployer deployer, ArchitexJITFactory factory) {
        require(block.chainid == 5042, "Arc mainnet only");
        require(MANAGER.codehash == MANAGER_CODE_HASH, "unverified PoolManager runtime");
        vm.startBroadcast();
        deployer = new ArchitexJITHookDeployer(IPoolManager(MANAGER));
        factory = new ArchitexJITFactory(IPoolManager(MANAGER), USDC, deployer);
        vm.stopBroadcast();
        require(address(deployer).code.length <= 24_576 && address(factory).code.length <= 24_576, "runtime limit");
        require(factory.quote() == USDC && address(factory.poolManager()) == MANAGER, "deployment mismatch");
    }
}
