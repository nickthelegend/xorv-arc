// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {XorvEscrow} from "../XorvEscrow.sol";
import {XorvCcipIntent} from "./XorvCcipIntent.sol";

/**
 * @title XorvCcipReceiver
 * @notice Xorv's escrow on Arc, for buyer agents on other chains.
 *
 *         XorvCcipSender on Base / Ethereum burns the buyer's USDC with
 *         Circle CCTP V2 (minted here, on Arc) and sends the instruction here
 *         with Chainlink CCIP. This contract is the escrow's buyer of record
 *         for those jobs (an allowlisted `fundDirect` funder): it funds them,
 *         releases them when the original requester says so, and forwards
 *         refunds to the requester's address on Arc.
 *
 * ## Messages
 *
 *  - POST_JOB (jobId, requester, provider, price, deadline): recorded as a
 *    Pending intent; funded in the escrow at once if the dollars are here,
 *    otherwise by `executePending` (anyone) once the CCTP mint lands. CCIP
 *    and CCTP are independent, so the instruction can arrive first.
 *  - RELEASE (jobId, requester, resultHash): only from the same source chain
 *    and sender contract the job was posted through, and only for the same
 *    requester; calls `escrow.release`.
 *
 * ## Defensive receiving
 *
 * `ccipReceive` (router only) rejects any (source chain, sender) pair not on
 * the owner's allowlist. Then it runs the message in `try this.processMessage`
 * and, if that reverts, stores the message as Failed (`MessageFailed`) instead
 * of failing the CCIP execution. Anyone may `retryFailedMessage`; the owner
 * may mark a message resolved, but only one that still cannot be processed.
 *
 * ## Money accounting (every USDC unit this contract holds has an owner)
 *
 *  - `pendingTotal`: prices of Pending intents (their dollars are here or in
 *    flight on CCTP).
 *  - `fundedTotal`: prices of jobs funded in the escrow and not yet closed
 *    out here. When the escrow refunds one, its dollars land here and
 *    `claimRefund` forwards them to the beneficiary exactly once; a released
 *    one is closed by the RELEASE message or `markReleased`.
 *  - `owedTotal`: credits for instructions that could not become a job (a
 *    duplicate job id, an invalid provider or price), payable with
 *    `withdrawOwed` to the requester's address on Arc.
 *
 * An intent is funded only from `available() = balance - owedTotal`. CCTP
 * mints arrive independently of CCIP, so in the short run one intent's
 * dollars (or a refund waiting to be claimed) may fund another intent whose
 * mint is still in flight. Every POST_JOB is sent by an allowlisted sender in
 * the same transaction as its CCTP burn (`price + maxFee`, minted here as at
 * least `price`), and completing a CCTP mint is permissionless, so in
 * aggregate the balance always catches up; a `claimRefund` or `cancelPending`
 * that finds the balance short simply reverts until the in-flight mint lands.
 *
 * The owner's `sweep` reaches only
 * `balance - (pendingTotal + fundedTotal + owedTotal)`. Buyers' dollars here
 * are at most pending prices, credits owed, and refunds of funded jobs (each
 * at most its price, so at most `fundedTotal`), so the sweep can only ever
 * take CCTP max-fee dust or tokens sent by mistake. The owner's other powers
 * are the sender allowlist and resolving messages that cannot be processed.
 *
 * The beneficiary is the requester's address on Arc (an EOA has the same
 * address on every EVM chain; a smart account must exist on Arc too).
 */
contract XorvCcipReceiver is CCIPReceiver, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Pending,
        Funded,
        Released,
        Refunded,
        Cancelled
    }

    enum MessageStatus {
        None,
        Failed,
        Resolved
    }

    /// slot 0: beneficiary (20) | deadline (5) | status (1)
    /// slot 1: sourceSender (20) | sourceChainSelector (8)
    /// slot 2: provider (20) | price (12)
    struct Intent {
        address beneficiary;
        uint40 deadline;
        Status status;
        address sourceSender;
        uint64 sourceChainSelector;
        address provider;
        uint96 price;
    }

    struct FailedMessage {
        MessageStatus status;
        uint64 sourceChainSelector;
        bytes sender;
        bytes data;
    }

    XorvEscrow public immutable escrow;
    IERC20 public immutable usdc;

    /// sourceChainSelector => sender contract on that chain => allowed
    mapping(uint64 => mapping(address => bool)) public allowedSenders;
    mapping(bytes32 jobId => Intent) private _intents;
    mapping(bytes32 messageId => FailedMessage) private _failed;
    mapping(address beneficiary => uint256) public owed;

    uint256 public pendingTotal;
    uint256 public fundedTotal;
    uint256 public owedTotal;

    event SenderAllowed(uint64 indexed sourceChainSelector, address indexed sender, bool allowed);
    event IntentReceived(
        bytes32 indexed jobId,
        bytes32 indexed messageId,
        uint64 indexed sourceChainSelector,
        address requester,
        address provider,
        uint256 price,
        uint40 deadline
    );
    event IntentFunded(bytes32 indexed jobId, address indexed provider, uint256 price);
    event IntentPending(bytes32 indexed jobId, uint256 available, uint256 price, bytes reason);
    event IntentRejected(bytes32 indexed jobId, bytes32 indexed messageId, address indexed requester, uint256 price);
    event IntentCancelled(bytes32 indexed jobId, address indexed beneficiary, uint256 price);
    event IntentReleased(bytes32 indexed jobId, bytes32 indexed messageId, bytes32 resultHash);
    event RefundClaimed(bytes32 indexed jobId, address indexed beneficiary, uint256 amount);
    event OwedWithdrawn(address indexed beneficiary, uint256 amount);
    event MessageFailed(bytes32 indexed messageId, bytes reason);
    event MessageRecovered(bytes32 indexed messageId);
    event MessageResolved(bytes32 indexed messageId);
    event Swept(address indexed to, uint256 amount);

    error SourceNotAllowed(uint64 sourceChainSelector, address sender);
    error OnlySelf();
    error UnknownAction(uint8 action);
    error ZeroAddress();
    error WrongStatus(bytes32 jobId, Status status);
    error NotFunded(uint256 available, uint256 price);
    error NotRequester(bytes32 jobId, address requester);
    error WrongOrigin(bytes32 jobId, uint64 sourceChainSelector, address sender);
    error NotCancellable(bytes32 jobId);
    error EscrowNotRefunded(bytes32 jobId);
    error EscrowNotReleased(bytes32 jobId);
    error NotFailed(bytes32 messageId);
    error StillProcessable(bytes32 messageId);
    error NothingOwed(address beneficiary);
    error NothingToSweep();
    error RenounceDisabled();
    error InsufficientGas();

    constructor(address router, address escrow_, address usdc_, address initialOwner)
        CCIPReceiver(router)
        Ownable(initialOwner)
    {
        if (escrow_ == address(0) || usdc_ == address(0)) revert ZeroAddress();
        escrow = XorvEscrow(escrow_);
        usdc = IERC20(usdc_);
    }

    // -----------------------------------------------------------------
    // Owner
    // -----------------------------------------------------------------

    function allowSender(uint64 sourceChainSelector, address sender, bool allowed) external onlyOwner {
        if (sender == address(0)) revert ZeroAddress();
        allowedSenders[sourceChainSelector][sender] = allowed;
        emit SenderAllowed(sourceChainSelector, sender, allowed);
    }

    /// Recover USDC above everything committed (CCTP max-fee dust). Never reaches buyers' money:
    /// `fundedTotal` is held back too, because an open job's refund may already have landed here.
    function sweep(address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 committed = pendingTotal + fundedTotal + owedTotal;
        uint256 bal = usdc.balanceOf(address(this));
        if (bal <= committed) revert NothingToSweep();
        uint256 excess = bal - committed;
        usdc.safeTransfer(to, excess);
        emit Swept(to, excess);
    }

    /**
     * Mark a failed message resolved without processing it. Only for a message
     * that still cannot be processed: it is run once more first, and if that
     * succeeds this call reverts, so the owner can never discard a message
     * that would have funded, released or credited someone.
     */
    function resolveFailedMessage(bytes32 messageId) external onlyOwner {
        FailedMessage storage f = _failed[messageId];
        if (f.status != MessageStatus.Failed) revert NotFailed(messageId);
        uint256 gasBefore = gasleft();
        try this.processMessage(_rebuild(messageId, f)) {
            revert StillProcessable(messageId);
        } catch {
            // A call starved of gas proves nothing: refuse to resolve on it.
            if (gasleft() <= gasBefore / 63) revert InsufficientGas();
        }
        f.status = MessageStatus.Resolved;
        emit MessageResolved(messageId);
    }

    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // -----------------------------------------------------------------
    // CCIP
    // -----------------------------------------------------------------

    function _ccipReceive(Client.Any2EVMMessage memory message) internal override {
        address sender = abi.decode(message.sender, (address));
        if (!allowedSenders[message.sourceChainSelector][sender]) {
            revert SourceNotAllowed(message.sourceChainSelector, sender);
        }
        try this.processMessage(message) {}
        catch (bytes memory reason) {
            _failed[message.messageId] = FailedMessage({
                status: MessageStatus.Failed,
                sourceChainSelector: message.sourceChainSelector,
                sender: message.sender,
                data: message.data
            });
            emit MessageFailed(message.messageId, reason);
        }
    }

    /// Run a failed message again. Anyone may; it reverts (and stays Failed) if it still fails.
    function retryFailedMessage(bytes32 messageId) external nonReentrant {
        FailedMessage storage f = _failed[messageId];
        if (f.status != MessageStatus.Failed) revert NotFailed(messageId);
        address sender = abi.decode(f.sender, (address));
        if (!allowedSenders[f.sourceChainSelector][sender]) revert SourceNotAllowed(f.sourceChainSelector, sender);
        f.status = MessageStatus.Resolved;
        this.processMessage(_rebuild(messageId, f));
        emit MessageRecovered(messageId);
    }

    /// Decode and act on a message. Only this contract calls it, so a revert can be caught.
    function processMessage(Client.Any2EVMMessage calldata message) external {
        if (msg.sender != address(this)) revert OnlySelf();
        (uint8 action, bytes memory body) = abi.decode(message.data, (uint8, bytes));
        address sender = abi.decode(message.sender, (address));
        if (action == XorvCcipIntent.POST_JOB) {
            _postJob(message.messageId, message.sourceChainSelector, sender, body);
        } else if (action == XorvCcipIntent.RELEASE) {
            _release(message.messageId, message.sourceChainSelector, sender, body);
        } else {
            revert UnknownAction(action);
        }
    }

    // -----------------------------------------------------------------
    // Permissionless follow-ups
    // -----------------------------------------------------------------

    /// Fund a Pending intent once its dollars are here. Reverts (state unchanged) if it can't be funded.
    function executePending(bytes32 jobId) external nonReentrant {
        Intent storage it = _intents[jobId];
        if (it.status != Status.Pending) revert WrongStatus(jobId, it.status);
        uint256 avail = available();
        if (avail < it.price) revert NotFunded(avail, it.price);
        usdc.forceApprove(address(escrow), it.price);
        escrow.fundDirect(jobId, it.provider, address(usdc), it.price, it.deadline);
        _markFunded(jobId, it);
    }

    /**
     * Give a Pending intent's dollars back to its beneficiary on Arc. The
     * beneficiary may do it at any time; anyone may once the intent can no
     * longer be funded (its deadline is inside the escrow's minimum duration).
     */
    function cancelPending(bytes32 jobId) external nonReentrant {
        Intent storage it = _intents[jobId];
        if (it.status != Status.Pending) revert WrongStatus(jobId, it.status);
        if (msg.sender != it.beneficiary && block.timestamp + escrow.MIN_JOB_DURATION() <= it.deadline) {
            revert NotCancellable(jobId);
        }
        uint256 price = it.price;
        uint256 avail = available();
        if (avail < price) revert NotFunded(avail, price);
        it.status = Status.Cancelled;
        pendingTotal -= price;
        usdc.safeTransfer(it.beneficiary, price);
        emit IntentCancelled(jobId, it.beneficiary, price);
    }

    /// Forward a job the escrow refunded (to this contract, its buyer of record) to its beneficiary. Once.
    function claimRefund(bytes32 jobId) external nonReentrant {
        Intent storage it = _intents[jobId];
        if (it.status != Status.Funded) revert WrongStatus(jobId, it.status);
        if (escrow.getJob(jobId).status != XorvEscrow.Status.Refunded) revert EscrowNotRefunded(jobId);
        uint256 price = it.price;
        it.status = Status.Refunded;
        fundedTotal -= price;
        usdc.safeTransfer(it.beneficiary, price);
        emit RefundClaimed(jobId, it.beneficiary, price);
    }

    /// Close out a job the escrow released some other way (the attester, before the deadline).
    function markReleased(bytes32 jobId) external {
        Intent storage it = _intents[jobId];
        if (it.status != Status.Funded) revert WrongStatus(jobId, it.status);
        if (escrow.getJob(jobId).status != XorvEscrow.Status.Released) revert EscrowNotReleased(jobId);
        it.status = Status.Released;
        fundedTotal -= it.price;
        emit IntentReleased(jobId, bytes32(0), bytes32(0));
    }

    /// Pay out credits for instructions that could not become a job.
    function withdrawOwed(address beneficiary) external nonReentrant {
        uint256 amount = owed[beneficiary];
        if (amount == 0) revert NothingOwed(beneficiary);
        owed[beneficiary] = 0;
        owedTotal -= amount;
        usdc.safeTransfer(beneficiary, amount);
        emit OwedWithdrawn(beneficiary, amount);
    }

    // -----------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------

    /// USDC free to fund intents: the balance less credits owed.
    function available() public view returns (uint256) {
        uint256 bal = usdc.balanceOf(address(this));
        return bal > owedTotal ? bal - owedTotal : 0;
    }

    function getIntent(bytes32 jobId) external view returns (Intent memory) {
        return _intents[jobId];
    }

    function getFailedMessage(bytes32 messageId) external view returns (FailedMessage memory) {
        return _failed[messageId];
    }

    // -----------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------

    function _postJob(bytes32 messageId, uint64 selector, address sender, bytes memory body) private {
        (bytes32 jobId, address requester, address provider, uint256 price, uint40 deadline) =
            abi.decode(body, (bytes32, address, address, uint256, uint40));
        if (requester == address(0)) revert ZeroAddress();

        // Its dollars are on their way regardless: anything that can't become a job is owed back.
        if (
            _intents[jobId].status != Status.None || provider == address(0) || provider == address(this)
                || price == 0 || price > type(uint96).max
        ) {
            owed[requester] += price;
            owedTotal += price;
            emit IntentRejected(jobId, messageId, requester, price);
            return;
        }

        Intent storage it = _intents[jobId];
        it.beneficiary = requester;
        it.deadline = deadline;
        it.status = Status.Pending;
        it.sourceSender = sender;
        it.sourceChainSelector = selector;
        it.provider = provider;
        it.price = uint96(price);
        pendingTotal += price;
        emit IntentReceived(jobId, messageId, selector, requester, provider, price, deadline);

        uint256 avail = available();
        if (avail < price) {
            emit IntentPending(jobId, avail, price, "");
            return;
        }
        usdc.forceApprove(address(escrow), price);
        try escrow.fundDirect(jobId, provider, address(usdc), price, deadline) {
            _markFunded(jobId, it);
        } catch (bytes memory reason) {
            usdc.forceApprove(address(escrow), 0);
            emit IntentPending(jobId, avail, price, reason);
        }
    }

    function _release(bytes32 messageId, uint64 selector, address sender, bytes memory body) private {
        (bytes32 jobId, address requester, bytes32 resultHash) = abi.decode(body, (bytes32, address, bytes32));
        Intent storage it = _intents[jobId];
        if (it.status != Status.Funded) revert WrongStatus(jobId, it.status);
        if (requester != it.beneficiary) revert NotRequester(jobId, requester);
        if (selector != it.sourceChainSelector || sender != it.sourceSender) {
            revert WrongOrigin(jobId, selector, sender);
        }
        it.status = Status.Released;
        fundedTotal -= it.price;
        // The broker's attester may have released it already; then there is nothing left to pay.
        if (escrow.getJob(jobId).status != XorvEscrow.Status.Released) escrow.release(jobId, resultHash);
        emit IntentReleased(jobId, messageId, resultHash);
    }

    function _markFunded(bytes32 jobId, Intent storage it) private {
        uint256 price = it.price;
        it.status = Status.Funded;
        pendingTotal -= price;
        fundedTotal += price;
        emit IntentFunded(jobId, it.provider, price);
    }

    function _rebuild(bytes32 messageId, FailedMessage storage f)
        private
        view
        returns (Client.Any2EVMMessage memory)
    {
        return Client.Any2EVMMessage({
            messageId: messageId,
            sourceChainSelector: f.sourceChainSelector,
            sender: f.sender,
            data: f.data,
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });
    }
}
