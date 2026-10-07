// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * A minimal stand-in for the ERC-8004 v2.0.0 Identity Registry, faithful to
 * what XorvReputation relies on: sequential agent ids from 0, agentWallet
 * defaulting to the registrant, cleared on transfer, address(0) for an
 * unknown id, and `isAuthorizedOrOwner` reverting for an unknown id.
 * (The real registries run in test/fork/*.t.sol against Arc testnet.)
 */
contract MockIdentityRegistry {
    uint256 public nextId;
    mapping(uint256 => address) public ownerOfId;
    mapping(uint256 => address) private _wallet;
    mapping(uint256 => mapping(address => bool)) public operator;

    error ERC721NonexistentToken(uint256 tokenId);

    function register(string calldata) external returns (uint256 agentId) {
        agentId = nextId++;
        ownerOfId[agentId] = msg.sender;
        _wallet[agentId] = msg.sender;
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return _wallet[agentId];
    }

    /// Test helper: the real registry needs the new wallet's EIP-712 signature.
    function setAgentWallet(uint256 agentId, address w) external {
        require(msg.sender == ownerOfId[agentId], "Not authorized");
        _wallet[agentId] = w;
    }

    function transfer(uint256 agentId, address to) external {
        require(msg.sender == ownerOfId[agentId], "Not authorized");
        ownerOfId[agentId] = to;
        _wallet[agentId] = address(0);
    }

    function approveOperator(uint256 agentId, address op) external {
        require(msg.sender == ownerOfId[agentId], "Not authorized");
        operator[agentId][op] = true;
    }

    function ownerOf(uint256 agentId) public view returns (address o) {
        o = ownerOfId[agentId];
        if (o == address(0)) revert ERC721NonexistentToken(agentId);
    }

    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool) {
        address o = ownerOf(agentId);
        return spender == o || operator[agentId][spender];
    }
}

/// The ERC-8004 v2.0.0 Reputation Registry's giveFeedback/readFeedback, with its self-feedback guard.
contract MockReputationRegistry {
    struct Feedback {
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        bytes32 feedbackHash;
    }

    MockIdentityRegistry public immutable identity;
    mapping(uint256 => mapping(address => uint64)) public lastIndex;
    mapping(uint256 => mapping(address => mapping(uint64 => Feedback))) private _fb;
    bool public broken;

    constructor(MockIdentityRegistry identity_) {
        identity = identity_;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata,
        string calldata,
        bytes32 feedbackHash
    ) external {
        require(!broken, "registry down");
        require(!identity.isAuthorizedOrOwner(msg.sender, agentId), "Self-feedback not allowed");
        uint64 i = ++lastIndex[agentId][msg.sender];
        _fb[agentId][msg.sender][i] = Feedback(value, valueDecimals, tag1, tag2, feedbackHash);
    }

    function getLastIndex(uint256 agentId, address client) external view returns (uint64) {
        return lastIndex[agentId][client];
    }

    function readFeedback(uint256 agentId, address client, uint64 index)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked)
    {
        Feedback storage f = _fb[agentId][client][index];
        return (f.value, f.valueDecimals, f.tag1, f.tag2, false);
    }

    function hashOf(uint256 agentId, address client, uint64 index) external view returns (bytes32) {
        return _fb[agentId][client][index].feedbackHash;
    }
}
