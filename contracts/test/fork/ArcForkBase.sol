// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

/**
 * Shared setup for the Arc testnet fork tests. Opt-in, so `forge test` stays offline:
 *
 *   ARC_FORK_TESTS=1 <arc-foundry>/forge test --match-path 'test/fork/*' --network arc
 *
 * Arc Foundry's forge (`--network arc`) runs Arc's precompiles, so the native USDC
 * balance (18 decimals) and its ERC-20 view at 0x3600…0000 (6 decimals) move together,
 * exactly as on chain.
 */
abstract contract ArcForkBase is Test {
    // Arc testnet (5042002): Circle + ERC-8004 + Chainlink CCIP, from docs.arc.io / docs.chain.link.
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address internal constant REPUTATION = 0x8004B663056A597Dffe9eCcC1965A193B7388713;
    address internal constant CCIP_ROUTER = 0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8;
    uint64 internal constant ARC_SELECTOR = 3034092155422581607;
    uint64 internal constant BASE_SEPOLIA = 10344971235874465080;
    uint64 internal constant ETHEREUM_SEPOLIA = 16015286601757825753;
    address internal constant TOKEN_MESSENGER_V2 = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;
    uint32 internal constant BASE_SEPOLIA_CCTP_DOMAIN = 6;

    function setUp() public virtual {
        if (!vm.envOr("ARC_FORK_TESTS", false)) vm.skip(true);
        vm.createSelectFork(vm.envOr("ARC_TESTNET_RPC_URL", string("https://rpc.testnet.arc.io")));
        assertEq(block.chainid, 5042002, "not Arc testnet");
    }

    /// Give `who` `amount6` USDC (6 decimals) the Arc way: set the native balance (18 decimals),
    /// which is the same balance the ERC-20 at 0x3600…0000 reports.
    function _giveUsdc(address who, uint256 amount6) internal {
        vm.deal(who, amount6 * 1e12);
    }
}
