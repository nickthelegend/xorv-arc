// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * IXorvOutcomeSink — where XorvEscrow reports how each job ended.
 *
 * The escrow calls this from the same transaction that pays or refunds, so a
 * provider's track record is written by settlement itself: it cannot be
 * claimed, only earned. On Arc the sink is `XorvReputation`, which keeps
 * on-chain counters and writes each outcome to the ERC-8004 Reputation
 * Registry for the provider's agent.
 *
 * The escrow gives the call a fixed gas budget (`REGISTRY_GAS_LIMIT`) inside
 * try/catch, so a sink that reverts or runs out of gas never blocks a payment.
 */
interface IXorvOutcomeSink {
    /**
     * @param jobId    the escrow job that settled (used as the ERC-8004 feedbackHash)
     * @param provider the provider's payout address
     * @param success  true for a release, false for a provider-at-fault refund or a reassignment
     * @param amount   what the provider was paid (0 on failure)
     */
    function recordOutcome(bytes32 jobId, address provider, bool success, uint256 amount) external;
}
