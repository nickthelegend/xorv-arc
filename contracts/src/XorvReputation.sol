// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IXorvOutcomeSink} from "./interfaces/IXorvOutcomeSink.sol";
import {IIdentityRegistry8004} from "./interfaces/IIdentityRegistry8004.sol";
import {IReputationRegistry8004} from "./interfaces/IReputationRegistry8004.sol";

/**
 * @title XorvReputation
 * @notice Turns every escrow settlement into ERC-8004 reputation on Arc.
 *
 *         Every Xorv provider can be an ERC-8004 agent on Arc's Identity
 *         Registry. A provider (or anyone) calls `bind(agentId)` once: the
 *         agent's verified payout wallet (`getAgentWallet`) is mapped to the
 *         agent. From then on, each time XorvEscrow releases or refunds a job
 *         for that wallet, this contract writes the outcome to Arc's ERC-8004
 *         Reputation Registry: `giveFeedback(agentId, 100 | 0, 0,
 *         "successRate", "xorv-escrow", "", "", jobId)`.
 *
 *         Because only the escrow can report, and the escrow only reports from
 *         a settlement transaction that moved real USDC, the feedback this
 *         contract writes (clientAddress == this contract) is "paid and
 *         delivered" reputation that cannot be inflated without paying for
 *         each job. Read it with
 *         `getSummary(agentId, [this], "successRate", "xorv-escrow")`.
 *
 * @dev
 *  - On-chain counters (completed, failed, earned, lastJobAt) are kept for
 *    every provider, bound or not, and give a Laplace-smoothed `score`.
 *  - Feedback is written only while the binding still holds: the agent's
 *    verified wallet must still equal the provider. ERC-8004 clears the wallet
 *    when the agent NFT changes hands, so a sold agent stops collecting this
 *    provider's history automatically.
 *  - `giveFeedback` reverts for the agent's owner and operators. This
 *    contract must therefore never own or operate an agent: `bind` refuses
 *    one that it is authorized for, and a failed feedback call is caught and
 *    reported (`feedbackWritten = false`), never bubbled into the escrow.
 *  - Owner powers: set the escrow address, and two-step ownership transfer.
 *    The contract holds no funds.
 */
contract XorvReputation is IXorvOutcomeSink, Ownable2Step {
    /// One slot per provider: 64 + 64 + 40 + 80 bits.
    struct Stats {
        uint64 completed;
        uint64 failed;
        uint40 lastJobAt;
        uint80 earned;
    }

    string public constant TAG_SUCCESS_RATE = "successRate";
    string public constant TAG_SOURCE = "xorv-escrow";

    IIdentityRegistry8004 public immutable identity;
    IReputationRegistry8004 public immutable reputation;

    /// The only address that may report outcomes.
    address public escrow;

    /// provider wallet => agentId + 1 (0 = unbound).
    mapping(address provider => uint256) private _agentPlusOne;
    mapping(address provider => Stats) private _stats;

    event EscrowUpdated(address indexed previous, address indexed escrow);
    event AgentBound(address indexed wallet, uint256 indexed agentId);
    event OutcomeRecorded(
        bytes32 indexed jobId,
        address indexed provider,
        uint256 indexed agentId,
        bool success,
        uint256 amount,
        bool feedbackWritten
    );
    event FeedbackFailed(bytes32 indexed jobId, uint256 indexed agentId, bytes reason);

    error NotEscrow(address caller);
    error ZeroAddress();
    error NoAgentWallet(uint256 agentId);
    error SelfAuthorized(uint256 agentId);
    error AlreadyBound(address wallet, uint256 agentId);
    error RenounceDisabled();

    constructor(address identity_, address reputation_, address initialOwner) Ownable(initialOwner) {
        if (identity_ == address(0) || reputation_ == address(0)) revert ZeroAddress();
        identity = IIdentityRegistry8004(identity_);
        reputation = IReputationRegistry8004(reputation_);
    }

    // -----------------------------------------------------------------
    // Owner
    // -----------------------------------------------------------------

    /// The escrow and this contract reference each other, so the escrow is set after both deploy.
    function setEscrow(address newEscrow) external onlyOwner {
        emit EscrowUpdated(escrow, newEscrow);
        escrow = newEscrow;
    }

    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // -----------------------------------------------------------------
    // Binding providers to ERC-8004 agents
    // -----------------------------------------------------------------

    /**
     * Map `agentId`'s verified payout wallet to the agent, so escrow outcomes
     * for that wallet become ERC-8004 feedback for it. Permissionless: the
     * Identity Registry already proves the wallet consented (it is the
     * registrant, or signed `setAgentWallet`).
     *
     * @dev A wallet may be the verified wallet of several agents. Re-binding a
     *      wallet to a different agent while its current binding still holds
     *      is only allowed to the wallet itself, so nobody else can move a
     *      provider's history between its agents.
     */
    function bind(uint256 agentId) external {
        address wallet = identity.getAgentWallet(agentId);
        if (wallet == address(0)) revert NoAgentWallet(agentId);
        // Feedback from an owner/operator reverts in ERC-8004, so it would never be written.
        if (identity.isAuthorizedOrOwner(address(this), agentId)) revert SelfAuthorized(agentId);

        uint256 current = _agentPlusOne[wallet];
        if (current != 0 && current - 1 != agentId && msg.sender != wallet) {
            if (_walletOf(current - 1) == wallet) revert AlreadyBound(wallet, current - 1);
        }
        _agentPlusOne[wallet] = agentId + 1;
        emit AgentBound(wallet, agentId);
    }

    // -----------------------------------------------------------------
    // Escrow hook
    // -----------------------------------------------------------------

    /// @inheritdoc IXorvOutcomeSink
    function recordOutcome(bytes32 jobId, address provider, bool success, uint256 amount) external {
        if (msg.sender != escrow) revert NotEscrow(msg.sender);

        Stats storage st = _stats[provider];
        if (success) {
            st.completed += 1;
            st.earned += uint80(amount);
        } else {
            st.failed += 1;
        }
        st.lastJobAt = uint40(block.timestamp);

        uint256 plusOne = _agentPlusOne[provider];
        uint256 agentId;
        bool written;
        if (plusOne != 0) {
            agentId = plusOne - 1;
            if (_walletOf(agentId) == provider) {
                try reputation.giveFeedback(
                    agentId, success ? int128(100) : int128(0), 0, TAG_SUCCESS_RATE, TAG_SOURCE, "", "", jobId
                ) {
                    written = true;
                } catch (bytes memory reason) {
                    emit FeedbackFailed(jobId, agentId, reason);
                }
            }
        }
        emit OutcomeRecorded(jobId, provider, agentId, success, amount, written);
    }

    // -----------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------

    /// The agent `provider` is bound to. `bound` is false when never bound; a binding whose agent
    /// wallet has since changed still reports the agent (see `isLive`).
    function agentOf(address provider) external view returns (bool bound, uint256 agentId) {
        uint256 plusOne = _agentPlusOne[provider];
        if (plusOne == 0) return (false, 0);
        return (true, plusOne - 1);
    }

    /// True when outcomes for `provider` are being written to ERC-8004 right now.
    function isLive(address provider) external view returns (bool) {
        uint256 plusOne = _agentPlusOne[provider];
        return plusOne != 0 && _walletOf(plusOne - 1) == provider;
    }

    function stats(address provider)
        external
        view
        returns (uint64 completed, uint64 failed, uint256 earned, uint40 lastJobAt)
    {
        Stats memory st = _stats[provider];
        return (st.completed, st.failed, st.earned, st.lastJobAt);
    }

    /// Laplace-smoothed success rate in basis points: (completed+1)*10000/(completed+failed+2).
    /// A provider with no history scores 5000; it moves with evidence, never jumps to 100%.
    function score(address provider) external view returns (uint256) {
        Stats memory st = _stats[provider];
        return (uint256(st.completed) + 1) * 10_000 / (uint256(st.completed) + st.failed + 2);
    }

    function _walletOf(uint256 agentId) private view returns (address wallet) {
        try identity.getAgentWallet(agentId) returns (address w) {
            wallet = w;
        } catch {}
    }
}
