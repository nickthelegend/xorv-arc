// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {XorvEscrow} from "../src/XorvEscrow.sol";
import {XorvReputation} from "../src/XorvReputation.sol";
import {XorvCcipReceiver} from "../src/ccip/XorvCcipReceiver.sol";
// ../packages/contracts/contracts/XorvLedger.sol, via the @xorv/ledger remapping (foundry.toml).
import {XorvLedger} from "@xorv/ledger/XorvLedger.sol";
import {ArcConfig} from "./ArcConfig.sol";

/**
 * Deploy Xorv on Arc: XorvLedger, XorvReputation, XorvEscrow and XorvCcipReceiver,
 * wired together, and write deployments/arc-<network>.json at the repo root.
 *
 *   NETWORK=testnet|mainnet|local  (local = whatever chain --rpc-url is, e.g. an Arc fork;
 *                                   testnet addresses unless overridden by XORV_ADDR_* env)
 *   DEPLOYER_PRIVATE_KEY           pays for and owns everything (never logged)
 *   XORV_BROKER_ADDRESS            the broker's settlement key: escrow attester and ledger writer
 *                                  (required; on mainnet it must differ from the deployer)
 *   XORV_MAX_JOB_AMOUNT            per-job cap in USDC base units (6 dec), default 100e6 = 100 USDC
 *   XORV_CONFIRM_MAINNET=1         required for NETWORK=mainnet
 *   XORV_DEPLOYMENT_OUT            output path (default ../deployments/arc-<network>.json)
 *
 * Run it through scripts/deploy.sh, which builds, holds the shared deployer lock only for
 * the broadcast, and moves the record into place only once the broadcast succeeded.
 */
contract Deploy is Script {
    struct Deployed {
        address deployer;
        address broker;
        uint256 maxJobAmount;
        address ledger;
        address reputation;
        address escrow;
        address ccipReceiver;
    }

    function run() external returns (Deployed memory d) {
        string memory network = vm.envOr("NETWORK", string("testnet"));
        ArcConfig.Arc memory arc = _arc(network);

        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        d.deployer = vm.addr(key);
        d.broker = vm.envAddress("XORV_BROKER_ADDRESS");
        require(d.broker != address(0), "Deploy: XORV_BROKER_ADDRESS is zero");
        d.maxJobAmount = vm.envOr("XORV_MAX_JOB_AMOUNT", uint256(100e6));
        require(d.maxJobAmount > 0, "Deploy: XORV_MAX_JOB_AMOUNT must be > 0");

        if (_eq(network, "mainnet")) {
            require(vm.envOr("XORV_CONFIRM_MAINNET", uint256(0)) == 1, "Deploy: set XORV_CONFIRM_MAINNET=1 to deploy to Arc MAINNET");
            require(d.broker != d.deployer, "Deploy: on mainnet the broker key must not be the deployer/owner key");
            console2.log("==============================================================");
            console2.log("  ARC MAINNET (chain 5042). REAL USDC. Owner:", d.deployer);
            console2.log("==============================================================");
        }
        if (!_eq(network, "local")) require(block.chainid == arc.chainId, "Deploy: --rpc-url is not on the NETWORK's chain");

        vm.startBroadcast(key);
        _deploy(arc, d);
        vm.stopBroadcast();

        console2.log("network         ", network);
        console2.log("chain id        ", block.chainid);
        console2.log("deployer/owner  ", d.deployer);
        console2.log("broker          ", d.broker);
        console2.log("XorvLedger      ", d.ledger);
        console2.log("XorvReputation  ", d.reputation);
        console2.log("XorvEscrow      ", d.escrow);
        console2.log("XorvCcipReceiver", d.ccipReceiver);

        _write(network, arc, d);
    }

    function _deploy(ArcConfig.Arc memory arc, Deployed memory d) internal {
        address[] memory tokens = new address[](1);
        tokens[0] = arc.usdc;
        d.ledger = address(new XorvLedger(arc.identityRegistry, arc.reputationRegistry, d.broker, d.deployer));
        XorvReputation reputation = new XorvReputation(arc.identityRegistry, arc.reputationRegistry, d.deployer);
        XorvEscrow escrow = new XorvEscrow(d.deployer, d.broker, address(reputation), tokens, d.maxJobAmount);
        reputation.setEscrow(address(escrow));
        XorvCcipReceiver receiver = new XorvCcipReceiver(arc.ccipRouter, address(escrow), arc.usdc, d.deployer);
        escrow.setFunder(address(receiver), true);
        d.reputation = address(reputation);
        d.escrow = address(escrow);
        d.ccipReceiver = address(receiver);
    }

    function _arc(string memory network) internal view returns (ArcConfig.Arc memory arc) {
        if (_eq(network, "mainnet")) return ArcConfig.mainnet();
        if (_eq(network, "testnet")) return ArcConfig.testnet();
        require(_eq(network, "local"), "Deploy: NETWORK must be testnet, mainnet or local");
        arc = ArcConfig.testnet();
        arc.name = "local";
        arc.chainId = block.chainid;
        arc.usdc = vm.envOr("XORV_ADDR_USDC", arc.usdc);
        arc.identityRegistry = vm.envOr("XORV_ADDR_IDENTITY", arc.identityRegistry);
        arc.reputationRegistry = vm.envOr("XORV_ADDR_REPUTATION", arc.reputationRegistry);
        arc.ccipRouter = vm.envOr("XORV_ADDR_CCIP_ROUTER", arc.ccipRouter);
    }

    function _write(string memory network, ArcConfig.Arc memory arc, Deployed memory d) internal {
        string memory c = "contracts";
        vm.serializeAddress(c, "XorvLedger", d.ledger);
        vm.serializeAddress(c, "XorvReputation", d.reputation);
        vm.serializeAddress(c, "XorvEscrow", d.escrow);
        string memory contractsJson = vm.serializeAddress(c, "XorvCcipReceiver", d.ccipReceiver);

        string memory e = "external";
        vm.serializeAddress(e, "usdc", arc.usdc);
        vm.serializeAddress(e, "erc8004IdentityRegistry", arc.identityRegistry);
        vm.serializeAddress(e, "erc8004ReputationRegistry", arc.reputationRegistry);
        vm.serializeAddress(e, "erc8004ValidationRegistry", arc.validationRegistry);
        vm.serializeAddress(e, "ccipRouter", arc.ccipRouter);
        vm.serializeString(e, "ccipChainSelector", vm.toString(arc.ccipChainSelector));
        vm.serializeAddress(e, "memo", arc.memo);
        vm.serializeAddress(e, "cctpTokenMessengerV2", arc.tokenMessengerV2);
        vm.serializeAddress(e, "cctpMessageTransmitterV2", arc.messageTransmitterV2);
        vm.serializeUint(e, "cctpDomain", arc.cctpDomain);
        vm.serializeAddress(e, "gatewayWallet", arc.gatewayWallet);
        string memory externalJson = vm.serializeAddress(e, "gatewayMinter", arc.gatewayMinter);

        string memory r = "root";
        vm.serializeString(r, "network", network);
        vm.serializeUint(r, "chainId", block.chainid);
        vm.serializeString(r, "status", "deployed");
        vm.serializeAddress(r, "deployer", d.deployer);
        vm.serializeAddress(r, "owner", d.deployer);
        vm.serializeAddress(r, "broker", d.broker);
        vm.serializeUint(r, "maxJobAmount", d.maxJobAmount);
        vm.serializeUint(r, "blockNumber", block.number);
        vm.serializeUint(r, "timestamp", block.timestamp);
        vm.serializeString(r, "contracts", contractsJson);
        string memory json = vm.serializeString(r, "external", externalJson);

        string memory out = vm.envOr(
            "XORV_DEPLOYMENT_OUT", string.concat(vm.projectRoot(), "/../deployments/arc-", network, ".json")
        );
        vm.writeJson(json, out);
        console2.log("record          ", out);
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
