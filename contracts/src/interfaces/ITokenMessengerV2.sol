// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Circle's CCTP V2 TokenMessengerV2 (the subset Xorv calls).
/// Arc testnet: 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA (also Base Sepolia, Ethereum Sepolia).
/// Arc mainnet: 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d (also Base, Ethereum). Arc is CCTP domain 26.
interface ITokenMessengerV2 {
    event DepositForBurn(
        address indexed burnToken,
        uint256 amount,
        address indexed depositor,
        bytes32 mintRecipient,
        uint32 destinationDomain,
        bytes32 destinationTokenMessenger,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 indexed minFinalityThreshold,
        bytes hookData
    );

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;
}
