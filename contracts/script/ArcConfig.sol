// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * Every external address Xorv uses, per network. One table for Deploy.s.sol,
 * DeploySender.s.sol and AllowSender.s.sol, copied into deployments/*.json so
 * the apps read the same values.
 *
 * Sources (checked 2026-10-07): docs.arc.io contract-addresses (Circle,
 * ERC-8004, Memo), docs.chain.link CCIP directory (routers, selectors). Read
 * back on chain: Arc testnet USDC name/version/decimals ("USDC"/"2"/6) and
 * DOMAIN_SEPARATOR, ERC-8004 getVersion() "2.0.0", and isChainSupported on
 * every source router for the Arc selector and on the Arc routers for the
 * source selectors.
 */
library ArcConfig {
    struct Arc {
        string name;
        uint256 chainId;
        address usdc;
        address identityRegistry;
        address reputationRegistry;
        address validationRegistry;
        address ccipRouter;
        uint64 ccipChainSelector;
        address memo;
        address tokenMessengerV2;
        address messageTransmitterV2;
        uint32 cctpDomain;
        address gatewayWallet;
        address gatewayMinter;
    }

    struct Source {
        string name;
        uint256 chainId;
        address ccipRouter;
        uint64 ccipChainSelector;
        address usdc;
        address tokenMessengerV2;
        uint32 cctpDomain;
        /// "testnet" or "mainnet": which Arc network this chain pairs with.
        string arcNetwork;
    }

    uint32 internal constant ARC_CCTP_DOMAIN = 26;

    function testnet() internal pure returns (Arc memory) {
        return Arc({
            name: "testnet",
            chainId: 5042002,
            usdc: 0x3600000000000000000000000000000000000000,
            identityRegistry: 0x8004A818BFB912233c491871b3d84c89A494BD9e,
            reputationRegistry: 0x8004B663056A597Dffe9eCcC1965A193B7388713,
            validationRegistry: 0x8004Cb1BF31DAf7788923b405b754f57acEB4272,
            ccipRouter: 0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8,
            ccipChainSelector: 3034092155422581607,
            memo: 0x5294E9927c3306DcBaDb03fe70b92e01cCede505,
            tokenMessengerV2: 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA,
            messageTransmitterV2: 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275,
            cctpDomain: ARC_CCTP_DOMAIN,
            gatewayWallet: 0x0077777d7EBA4688BDeF3E311b846F25870A19B9,
            gatewayMinter: 0x0022222ABE238Cc2C7Bb1f21003F0a260052475B
        });
    }

    function mainnet() internal pure returns (Arc memory) {
        return Arc({
            name: "mainnet",
            chainId: 5042,
            usdc: 0x3600000000000000000000000000000000000000,
            identityRegistry: 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432,
            reputationRegistry: 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63,
            validationRegistry: 0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58,
            ccipRouter: 0xB79791184973589c38e114D43Eb8E4588C283A18,
            ccipChainSelector: 6370580034781731079,
            memo: 0x5294E9927c3306DcBaDb03fe70b92e01cCede505,
            tokenMessengerV2: 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d,
            messageTransmitterV2: 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64,
            cctpDomain: ARC_CCTP_DOMAIN,
            gatewayWallet: 0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE,
            gatewayMinter: 0x2222222d7164433c4C09B0b0D809a9b52C04C205
        });
    }

    function source(string memory key) internal pure returns (Source memory) {
        bytes32 k = keccak256(bytes(key));
        if (k == keccak256("base-sepolia")) {
            return Source({
                name: "base-sepolia",
                chainId: 84532,
                ccipRouter: 0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93,
                ccipChainSelector: 10344971235874465080,
                usdc: 0x036CbD53842c5426634e7929541eC2318f3dCF7e,
                tokenMessengerV2: 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA,
                cctpDomain: 6,
                arcNetwork: "testnet"
            });
        }
        if (k == keccak256("ethereum-sepolia")) {
            return Source({
                name: "ethereum-sepolia",
                chainId: 11155111,
                ccipRouter: 0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59,
                ccipChainSelector: 16015286601757825753,
                usdc: 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238,
                tokenMessengerV2: 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA,
                cctpDomain: 0,
                arcNetwork: "testnet"
            });
        }
        if (k == keccak256("base")) {
            return Source({
                name: "base",
                chainId: 8453,
                ccipRouter: 0x881e3A65B4d4a04dD529061dd0071cf975F58bCD,
                ccipChainSelector: 15971525489660198786,
                usdc: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,
                tokenMessengerV2: 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d,
                cctpDomain: 6,
                arcNetwork: "mainnet"
            });
        }
        if (k == keccak256("ethereum")) {
            return Source({
                name: "ethereum",
                chainId: 1,
                ccipRouter: 0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D,
                ccipChainSelector: 5009297550715157269,
                usdc: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48,
                tokenMessengerV2: 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d,
                cctpDomain: 0,
                arcNetwork: "mainnet"
            });
        }
        revert("ArcConfig: SOURCE must be base-sepolia, ethereum-sepolia, base or ethereum");
    }
}
