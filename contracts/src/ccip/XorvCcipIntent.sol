// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * The instruction format XorvCcipSender sends to XorvCcipReceiver over Chainlink CCIP.
 *
 * `message.data = abi.encode(uint8 action, bytes body)`:
 *   POST_JOB: body = abi.encode(bytes32 jobId, address requester, address provider, uint256 price, uint40 deadline)
 *   RELEASE:  body = abi.encode(bytes32 jobId, address requester, bytes32 resultHash)
 *
 * `requester` is always the source-chain msg.sender of the sender contract, so a
 * job can only be released by the account that posted it.
 */
library XorvCcipIntent {
    uint8 internal constant POST_JOB = 1;
    uint8 internal constant RELEASE = 2;

    /// Arc's CCTP V2 domain.
    uint32 internal constant ARC_CCTP_DOMAIN = 26;

    function postJob(bytes32 jobId, address requester, address provider, uint256 price, uint40 deadline)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(POST_JOB, abi.encode(jobId, requester, provider, price, deadline));
    }

    function release(bytes32 jobId, address requester, bytes32 resultHash) internal pure returns (bytes memory) {
        return abi.encode(RELEASE, abi.encode(jobId, requester, resultHash));
    }
}
