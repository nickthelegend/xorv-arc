// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {XorvCcipSender} from "../src/ccip/XorvCcipSender.sol";
import {ArcConfig} from "./ArcConfig.sol";

/**
 * Deploy XorvCcipSender on a source chain, pointed at the XorvCcipReceiver on Arc.
 *
 *   SOURCE=base-sepolia|ethereum-sepolia (Arc testnet) or base|ethereum (Arc mainnet)
 *   ARC_RECEIVER=0x…            the XorvCcipReceiver on Arc (default: read from
 *                               deployments/arc-<testnet|mainnet>.json)
 *   DEPLOYER_PRIVATE_KEY        pays on the source chain (needs its native coin)
 *   XORV_POST_JOB_GAS / XORV_SETTLE_GAS   CCIP gas limits on Arc (default 400k / 700k)
 *   XORV_CONFIRM_MAINNET=1      required for base / ethereum
 *
 *   forge script script/DeploySender.s.sol --rpc-url <source rpc> --broadcast
 *
 * Then allowlist it on Arc with AllowSender.s.sol. The record goes to
 * deployments/arc-<network>-sender-<source>.json.
 */
contract DeploySender is Script {
    function run() external returns (XorvCcipSender sender) {
        ArcConfig.Source memory src = ArcConfig.source(vm.envString("SOURCE"));
        require(block.chainid == src.chainId, "DeploySender: --rpc-url is not on SOURCE's chain");
        bool mainnet = keccak256(bytes(src.arcNetwork)) == keccak256("mainnet");
        if (mainnet) {
            require(vm.envOr("XORV_CONFIRM_MAINNET", uint256(0)) == 1, "DeploySender: set XORV_CONFIRM_MAINNET=1");
            console2.log("=== MAINNET source chain:", src.name, "===");
        }
        ArcConfig.Arc memory arc = mainnet ? ArcConfig.mainnet() : ArcConfig.testnet();
        address receiver = vm.envOr("ARC_RECEIVER", address(0));
        if (receiver == address(0)) {
            string memory record = vm.readFile(
                string.concat(vm.projectRoot(), "/../deployments/arc-", src.arcNetwork, ".json")
            );
            receiver = vm.parseJsonAddress(record, ".contracts.XorvCcipReceiver");
        }
        require(receiver != address(0), "DeploySender: no ARC_RECEIVER");

        uint256 postGas = vm.envOr("XORV_POST_JOB_GAS", uint256(400_000));
        uint256 settleGas = vm.envOr("XORV_SETTLE_GAS", uint256(700_000));

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        sender = new XorvCcipSender(
            src.ccipRouter, src.usdc, src.tokenMessengerV2, arc.ccipChainSelector, receiver, postGas, settleGas
        );
        vm.stopBroadcast();

        console2.log("source          ", src.name);
        console2.log("XorvCcipSender  ", address(sender));
        console2.log("-> Arc receiver ", receiver);

        string memory k = "sender";
        vm.serializeString(k, "source", src.name);
        vm.serializeUint(k, "chainId", src.chainId);
        vm.serializeString(k, "ccipChainSelector", vm.toString(src.ccipChainSelector));
        vm.serializeAddress(k, "ccipRouter", src.ccipRouter);
        vm.serializeAddress(k, "usdc", src.usdc);
        vm.serializeAddress(k, "cctpTokenMessengerV2", src.tokenMessengerV2);
        vm.serializeAddress(k, "arcReceiver", receiver);
        vm.serializeUint(k, "postJobGasLimit", postGas);
        vm.serializeUint(k, "settleGasLimit", settleGas);
        vm.serializeUint(k, "blockNumber", block.number);
        string memory json = vm.serializeAddress(k, "XorvCcipSender", address(sender));
        vm.writeJson(
            json,
            vm.envOr(
                "XORV_DEPLOYMENT_OUT",
                string.concat(vm.projectRoot(), "/../deployments/arc-", src.arcNetwork, "-sender-", src.name, ".json")
            )
        );
    }
}
