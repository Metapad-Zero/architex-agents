// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC3009} from "../interfaces/IERC3009.sol";
import {IArchitexFactory} from "../interfaces/IArchitexFactory.sol";
import {IArchitexRouter} from "../interfaces/IArchitexRouter.sol";
import {IArchitexLens} from "../interfaces/IArchitexLens.sol";
import {ArchitexFactory} from "../ArchitexFactory.sol";
import {ArchitexRouter} from "../ArchitexRouter.sol";
import {ArchitexLens} from "../ArchitexLens.sol";
import {ArchitexLaunchpad} from "../launchpad/ArchitexLaunchpad.sol";
import {ArchitexBBS} from "../ArchitexBBS.sol";

/// @notice Mainnet-only deployment. Without --broadcast this is a free simulation.
/// @dev No keys in this script. Configure DEPLOYER, FEE_TO, FEE_TO_SETTER and RELAYER explicitly.
///      By default FACTORY, ROUTER and LENS must point to reviewed compatible existing core
///      contracts. Only DEPLOY_NEW_CORE=true creates a separate base AMM. No testnet defaults.
///      New agent contracts remain distinct from the human launchpad and its fee plugins.
contract DeployAgents is Script {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external {
        require(block.chainid == 5042, "Arc MAINNET (5042) required");
        address deployer = vm.envAddress("DEPLOYER");
        address feeTo = vm.envAddress("FEE_TO");
        address setter = vm.envAddress("FEE_TO_SETTER");
        address relayer = vm.envAddress("RELAYER");
        require(deployer != address(0) && feeTo != address(0) && setter != address(0) && relayer != address(0), "explicit nonzero roles required");
        uint256 launchFee = vm.envOr("LAUNCH_FEE", uint256(250_000));
        require(launchFee <= 100e6, "launch fee exceeds cap");
        require(ARC_USDC.code.length > 0 && IERC20Metadata(ARC_USDC).decimals() == 6, "mainnet USDC missing");
        bytes32 expectedDomain = keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), keccak256("USDC"), keccak256("2"), uint256(5042), ARC_USDC));
        require(IERC3009(ARC_USDC).DOMAIN_SEPARATOR() == expectedDomain, "unexpected USDC domain");

        bool deployNew = vm.envOr("DEPLOY_NEW_CORE", false);
        address factory;
        address router;
        address lens;
        if (!deployNew) {
            factory = vm.envAddress("FACTORY");
            router = vm.envAddress("ROUTER");
            lens = vm.envAddress("LENS");
            _checkCore(factory, router, lens);
        }

        vm.startBroadcast(deployer);
        if (deployNew) {
            factory = address(new ArchitexFactory(setter));
            router = address(new ArchitexRouter(factory));
            lens = address(new ArchitexLens(factory, router));
        }
        ArchitexLaunchpad pad = new ArchitexLaunchpad(ARC_USDC, factory, feeTo, deployer, launchFee);
        pad.setRelayer(relayer, true);
        // The deployment signer configures the initial relayer and then hands the fee role to
        // the explicitly configured admin. It retains no additional agent-contract privileges.
        pad.setFeeToSetter(setter);
        ArchitexBBS bbs = new ArchitexBBS(ARC_USDC, address(pad), feeTo, setter);
        vm.stopBroadcast();

        _checkCore(factory, router, lens);
        require(pad.usdc() == ARC_USDC && pad.factory() == factory && pad.isRelayer(relayer), "launchpad wiring mismatch");
        require(pad.feeToSetter() == setter && bbs.feeToSetter() == setter && bbs.launchpad() == address(pad), "admin/board wiring mismatch");
        console.log(string.concat('{"chainId":5042,"factory":"', vm.toString(factory), '","router":"', vm.toString(router), '","lens":"', vm.toString(lens), '","launchpad":"', vm.toString(address(pad)), '","bbs":"', vm.toString(address(bbs)), '","feeTo":"', vm.toString(feeTo), '","feeToSetter":"', vm.toString(setter), '","relayer":"', vm.toString(relayer), '","usdc":"', vm.toString(ARC_USDC), '","constructorFeeToSetter":"', vm.toString(deployer), '","launchFee":"', vm.toString(launchFee), '","launchRelayFee":"', vm.toString(pad.launchRelayFee()), '","tradeRelayFee":"', vm.toString(pad.tradeRelayFee()), '","postFee":"', vm.toString(bbs.postFee()), '"}'));
    }

    function _checkCore(address factory, address router, address lens) private view {
        require(factory.code.length > 0 && router.code.length > 0 && lens.code.length > 0, "configured core is not deployed");
        IArchitexFactory(factory).allPairsLength();
        require(IArchitexRouter(router).factory() == factory, "router factory mismatch");
        require(IArchitexLens(lens).factory() == factory && IArchitexLens(lens).router() == router, "lens core mismatch");
    }
}
