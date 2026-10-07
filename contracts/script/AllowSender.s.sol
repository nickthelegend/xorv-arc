// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {XorvCcipReceiver} from "../src/ccip/XorvCcipReceiver.sol";
import {ArcConfig} from "./ArcConfig.sol";

/**
 * On Arc: allowlist a deployed XorvCcipSender on the XorvCcipReceiver (owner only).
 *
 *   NETWORK=testnet|mainnet     which Arc (receiver read from deployments/arc-<NETWORK>.json
 *                               unless ARC_RECEIVER is set)
 *   SOURCE=base-sepolia|ethereum-sepolia|base|ethereum
 *   SENDER=0x…                  the XorvCcipSender on SOURCE (default: read from
 *                               deployments/arc-<NETWORK>-sender-<SOURCE>.json)
 *   ALLOWED=true|false          default true
 *   DEPLOYER_PRIVATE_KEY        the receiver's owner
 */
contract AllowSender is Script {
    function run() external {
        string memory network = vm.envOr("NETWORK", string("testnet"));
        ArcConfig.Source memory src = ArcConfig.source(vm.envString("SOURCE"));
        require(keccak256(bytes(src.arcNetwork)) == keccak256(bytes(network)), "AllowSender: SOURCE is not a lane of NETWORK");
        if (keccak256(bytes(network)) == keccak256("mainnet")) {
            require(vm.envOr("XORV_CONFIRM_MAINNET", uint256(0)) == 1, "AllowSender: set XORV_CONFIRM_MAINNET=1");
        }
        string memory root = string.concat(vm.projectRoot(), "/../deployments/arc-", network);
        address receiver = vm.envOr("ARC_RECEIVER", address(0));
        if (receiver == address(0)) {
            receiver = vm.parseJsonAddress(vm.readFile(string.concat(root, ".json")), ".contracts.XorvCcipReceiver");
        }
        address sender = vm.envOr("SENDER", address(0));
        if (sender == address(0)) {
            sender = vm.parseJsonAddress(
                vm.readFile(string.concat(root, "-sender-", src.name, ".json")), ".XorvCcipSender"
            );
        }
        bool allowed = vm.envOr("ALLOWED", true);

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        XorvCcipReceiver(receiver).allowSender(src.ccipChainSelector, sender, allowed);
        vm.stopBroadcast();

        console2.log("receiver", receiver);
        console2.log("source  ", src.name);
        console2.log("sender  ", sender);
        console2.log("allowed ", allowed);
    }
}
