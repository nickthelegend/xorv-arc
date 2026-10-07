// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IReputationRegistry8004
/// @notice The slice of the canonical ERC-8004 v2.0.0 Reputation Registry that Xorv uses.
/// @dev    giveFeedback needs no pre-authorisation: any address may call it, and the caller is
///         recorded as `clientAddress`. The single exception is self-feedback: the call reverts
///         with "Self-feedback not allowed" when msg.sender is the agent's owner or an approved
///         operator, and with ERC721NonexistentToken for an unknown agentId. value/valueDecimals
///         and tag1/tag2 are stored on-chain (one slot per short tag); endpoint, feedbackURI and
///         feedbackHash are only emitted in NewFeedback.
///
///         Arc mainnet (5042):    0x8004BAa17C55a88189AE136b182e5fdA19dE9b63
///         Arc testnet (5042002): 0x8004B663056A597Dffe9eCcC1965A193B7388713
interface IReputationRegistry8004 {
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;

    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64);

    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked);

    function getSummary(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);

    function getClients(uint256 agentId) external view returns (address[] memory);

    function getIdentityRegistry() external view returns (address);
}
