// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {IXorvOutcomeSink} from "./interfaces/IXorvOutcomeSink.sol";
import {IIdentityGate} from "./interfaces/IIdentityGate.sol";

/**
 * @title XorvEscrow
 * @notice Holds the payment for one AI job between "the buyer signed" and
 *         "the provider delivered", so neither side has to trust the other or
 *         the broker in between.
 *
 * ## Why escrow at all
 *
 * The first versions of Xorv paid the provider directly at the moment of
 * purchase. That is simple and it is backwards: the buyer takes all the risk.
 * If the provider's machine dies mid-job, the money has already moved and the
 * only remedy is an off-chain promise. Here the money waits, and there are
 * exactly three ways out of a funded job:
 *
 *   1. `release`  — the job delivered. The provider is paid, and the hash of
 *                   the result is recorded next to the payment.
 *   2. `refund`   — the job failed (attester, at any time) or nobody settled
 *                   it before the deadline (anyone, after it). The buyer gets
 *                   every unit back.
 *   3. `reassign` — the provider failed but another can take the job. The
 *                   money stays put; only the payee changes.
 *
 * ## The buyer never needs gas, and their signature can't be misused
 *
 * Funding uses EIP-3009 `receiveWithAuthorization`. The buyer signs typed data
 * off-chain; the broker's attester submits it. Two properties make that safe:
 *
 * - `receiveWithAuthorization` requires `msg.sender == to`. The payee is this
 *   contract, so the authorization can only be redeemed *through* `fund` —
 *   it cannot be front-run into a bare transfer that lands money without a job.
 * - The authorization's nonce is not random: it is `fundingNonce(jobId,
 *   deadline)`, derived from the job's identity, this chain and this contract.
 *   The buyer's one signature therefore commits to the amount, the token, the
 *   payee, the job and its refund deadline. A relayer that changes any of them
 *   produces a nonce the signature does not cover, and the token rejects it.
 *
 * ## Contract buyers: direct funding
 *
 * A contract cannot sign EIP-3009, so an owner-allowlisted *funder* (the
 * Chainlink CCIP receiver that posts jobs for buyer agents on other chains)
 * funds with `fundDirect`: it is the buyer of record, and the escrow pulls the
 * amount with `transferFrom`. Funding is allowlisted rather than open so that
 * nobody can front-run a broker job id and squat on it.
 *
 * ## Caps
 *
 * Every job, on both funding paths, is capped at `maxJobAmount` (100 USDC by
 * default on Arc mainnet). A job also lasts at most `MAX_JOB_DURATION`, so no
 * buyer's money is parked for longer than seven days.
 *
 * ## What the owner can and cannot do
 *
 * The owner can: allow or disallow tokens for new jobs; rotate the attester;
 * set the outcome sink (registry); set or clear the optional identity gate;
 * allow or remove direct funders; set the per-job cap; set a fee of at most
 * `MAX_FEE_BPS` (5%) for jobs funded afterwards; pause new funding; and sweep
 * tokens sent here by mistake. The owner can never move escrowed funds: there
 * is no admin withdrawal, `sweep` only reaches the balance above
 * `totalEscrowed`, fees are snapshotted per job at funding, `pause` never
 * blocks a release, refund or cancel, and ownership cannot be renounced (it
 * moves in two steps).
 *
 * ## Reputation is a side effect of settlement
 *
 * Every release, attester refund and reassignment reports an outcome to the
 * outcome sink (`XorvReputation`, which writes it to Arc's ERC-8004
 * Reputation Registry). A sink that reverts or runs out of gas is caught and
 * logged; it can never hold a payment hostage.
 */
contract XorvEscrow is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum Status {
        None,
        Funded,
        Released,
        Refunded
    }

    /**
     * One job's escrow record, packed into three slots.
     *
     * slot 0: buyer (20) | deadline (5) | status (1) | feeBps (2)
     * slot 1: provider (20) | amount (12)
     * slot 2: token (20)
     */
    struct Job {
        address buyer;
        uint40 deadline;
        Status status;
        uint16 feeBps;
        address provider;
        uint96 amount;
        address token;
    }

    /// Everything `fund` needs, grouped to keep the call site readable and the stack shallow.
    struct Funding {
        bytes32 jobId;
        address buyer;
        address provider;
        address token;
        uint256 amount;
        uint40 deadline;
        uint256 validAfter;
        uint256 validBefore;
        bytes signature;
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// Hard ceiling on the protocol fee: 5%. The live fee is 0.
    uint16 public constant MAX_FEE_BPS = 500;

    uint16 private constant BPS = 10_000;

    /// A job must leave the provider at least this long to deliver.
    uint40 public constant MIN_JOB_DURATION = 1 minutes;

    /// And may not park a buyer's money for longer than this.
    uint40 public constant MAX_JOB_DURATION = 7 days;

    /// Gas forwarded to the outcome sink. Sized for XorvReputation's worst case: a provider's first
    /// outcome (a fresh stats slot) plus the first ERC-8004 `giveFeedback` from this client for the
    /// agent (new feedback, index, client-list entries). Measured on an Arc testnet fork; see README.
    uint256 public constant REGISTRY_GAS_LIMIT = 400_000;

    /// Gas that must remain before the registry call so it receives its whole budget:
    /// the budget, the 1/64 EIP-150 withholds from it, and room for the CALL itself.
    uint256 public constant REGISTRY_GAS_RESERVE = REGISTRY_GAS_LIMIT + REGISTRY_GAS_LIMIT / 63 + 10_000;

    /// Domain tag for `fundingNonce`, so the nonce cannot collide with one minted elsewhere.
    bytes32 public constant FUNDING_NONCE_TYPEHASH =
        keccak256("XorvFunding(uint256 chainId,address escrow,bytes32 jobId,uint40 deadline)");

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    mapping(bytes32 jobId => Job) private _jobs;

    /// Stablecoins jobs can be funded in. Only EIP-3009 tokens without transfer fees belong here.
    mapping(address token => bool) public tokenAllowed;

    /// Sum of all funded-but-unsettled amounts per token. `sweep` can never touch this.
    mapping(address token => uint256) public totalEscrowed;

    /// The broker's settlement key: funds jobs, releases on delivery, refunds on failure.
    address public attester;

    /// Outcome sink (XorvReputation). Zero disables outcome reporting.
    IXorvOutcomeSink public registry;

    /// Optional identity gate. Zero (the default) lets anyone transact.
    IIdentityGate public identityGate;

    /// Contracts allowed to fund jobs with `fundDirect` as their own buyer (the CCIP receiver).
    mapping(address funder => bool) public funderAllowed;

    /// Largest amount a single job may hold, in the token's base units, on either funding path.
    uint256 public maxJobAmount;

    /// Protocol fee applied to jobs funded from now on, and who receives it.
    uint16 public feeBps;
    address public feeRecipient;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event JobFunded(
        bytes32 indexed jobId,
        address indexed buyer,
        address indexed provider,
        address token,
        uint256 amount,
        uint40 deadline
    );
    event JobReleased(
        bytes32 indexed jobId,
        address indexed provider,
        uint256 providerAmount,
        uint256 fee,
        bytes32 resultHash,
        address releasedBy
    );
    event JobRefunded(
        bytes32 indexed jobId, address indexed buyer, uint256 amount, bool providerAtFault
    );
    event JobReassigned(
        bytes32 indexed jobId, address indexed previousProvider, address indexed newProvider
    );
    event RegistryCallFailed(bytes32 indexed jobId, address indexed provider, bytes reason);

    event AttesterUpdated(address indexed previous, address indexed attester);
    event RegistryUpdated(address indexed previous, address indexed registry);
    event IdentityGateUpdated(address indexed previous, address indexed gate);
    event TokenAllowed(address indexed token, bool allowed);
    event FeeUpdated(uint16 feeBps, address indexed recipient);
    event Swept(address indexed token, address indexed to, uint256 amount);
    event FunderUpdated(address indexed funder, bool allowed);
    event MaxJobAmountUpdated(uint256 previous, uint256 maxJobAmount);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotAttester(address caller);
    error NotAuthorized(address caller);
    error ZeroAddress();
    error JobExists(bytes32 jobId);
    error JobNotFunded(bytes32 jobId, Status status);
    error TokenNotAllowed(address token);
    error InvalidAmount(uint256 amount);
    error InvalidParties(address buyer, address provider);
    error InvalidDeadline(uint40 deadline);
    error DeadlinePassed(bytes32 jobId, uint40 deadline);
    error DeadlineNotReached(bytes32 jobId, uint40 deadline);
    error AmountMismatch(uint256 expected, uint256 received);
    error FeeTooHigh(uint16 feeBps);
    error NothingToSweep(address token);
    error RenounceDisabled();
    error InsufficientGasForRegistry();
    error IdentityNotVerified(address account);
    error NotFunder(address caller);
    error AmountAboveCap(uint256 amount, uint256 cap);

    // ---------------------------------------------------------------------
    // Construction and admin
    // ---------------------------------------------------------------------

    constructor(
        address initialOwner,
        address initialAttester,
        address initialRegistry,
        address[] memory tokens,
        uint256 initialMaxJobAmount
    ) Ownable(initialOwner) {
        _setAttester(initialAttester);
        _setMaxJobAmount(initialMaxJobAmount);
        registry = IXorvOutcomeSink(initialRegistry);
        emit RegistryUpdated(address(0), initialRegistry);
        for (uint256 i = 0; i < tokens.length; ++i) {
            _setTokenAllowed(tokens[i], true);
        }
    }

    modifier onlyAttester() {
        if (msg.sender != attester) revert NotAttester(msg.sender);
        _;
    }

    function setAttester(address newAttester) external onlyOwner {
        _setAttester(newAttester);
    }

    /// Zero disables outcome reporting; payments are unaffected either way.
    function setRegistry(address newRegistry) external onlyOwner {
        emit RegistryUpdated(address(registry), newRegistry);
        registry = IXorvOutcomeSink(newRegistry);
    }

    /// Allow or remove a contract that funds jobs as their own buyer (`fundDirect`).
    function setFunder(address funder, bool allowed) external onlyOwner {
        if (funder == address(0)) revert ZeroAddress();
        funderAllowed[funder] = allowed;
        emit FunderUpdated(funder, allowed);
    }

    /// Per-job cap for jobs funded from now on. Must be non-zero; funded jobs are unaffected.
    function setMaxJobAmount(uint256 newMax) external onlyOwner {
        _setMaxJobAmount(newMax);
    }

    /**
     * Require a verified identity of everyone value moves toward: both parties
     * at funding, the payee at release and reassignment. Zero turns it off.
     * @dev Refunds stay ungated on purpose. A buyer whose credential lapses
     *      mid-job still gets their money back; gating the way out would trap it.
     */
    function setIdentityGate(address gate) external onlyOwner {
        emit IdentityGateUpdated(address(identityGate), gate);
        identityGate = IIdentityGate(gate);
    }

    /// Disallowing a token stops new jobs in it. Jobs already funded settle normally.
    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        _setTokenAllowed(token, allowed);
    }

    /// Applies to jobs funded after this call; funded jobs keep the fee they were funded under.
    function setFee(uint16 newFeeBps, address recipient) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh(newFeeBps);
        if (newFeeBps != 0 && recipient == address(0)) revert ZeroAddress();
        feeBps = newFeeBps;
        feeRecipient = recipient;
        emit FeeUpdated(newFeeBps, recipient);
    }

    /// Stops new jobs from being funded. Never blocks a release or a refund.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * Recover tokens sent here by mistake: anything above what funded jobs hold.
     * @dev `totalEscrowed` is subtracted first, so buyers' money is unreachable.
     */
    function sweep(address token, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 excess = IERC20(token).balanceOf(address(this)) - totalEscrowed[token];
        if (excess == 0) revert NothingToSweep(token);
        IERC20(token).safeTransfer(to, excess);
        emit Swept(token, to, excess);
    }

    /// An escrow without an owner could never add a token or rotate a leaked attester key.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // ---------------------------------------------------------------------
    // Job lifecycle
    // ---------------------------------------------------------------------

    /**
     * The EIP-3009 nonce a buyer must sign to fund `jobId` with this `deadline`.
     * @dev Binding the nonce to the job is what lets one signature commit to
     *      the job's identity and refund deadline, on top of the amount, token
     *      and payee that `ReceiveWithAuthorization` already covers.
     */
    function fundingNonce(bytes32 jobId, uint40 deadline) public view returns (bytes32) {
        return keccak256(
            abi.encode(FUNDING_NONCE_TYPEHASH, block.chainid, address(this), jobId, deadline)
        );
    }

    /**
     * Pull the buyer's payment into escrow for `f.jobId`.
     *
     * @dev The balance is measured on both sides of the pull, so a token that
     *      skims a transfer fee (none on the allowlist do) reverts instead of
     *      leaving the escrow short of what it owes.
     */
    function fund(Funding calldata f) external onlyAttester whenNotPaused nonReentrant {
        _open(f.jobId, f.buyer, f.provider, f.token, f.amount, f.deadline);

        uint256 before = IERC20(f.token).balanceOf(address(this));
        IERC3009(f.token).receiveWithAuthorization(
            f.buyer,
            address(this),
            f.amount,
            f.validAfter,
            f.validBefore,
            fundingNonce(f.jobId, f.deadline),
            f.signature
        );
        _checkReceived(f.token, before, f.amount);

        emit JobFunded(f.jobId, f.buyer, f.provider, f.token, f.amount, f.deadline);
    }

    /**
     * Fund `jobId` from an allowlisted contract buyer (the CCIP receiver), which
     * becomes the job's buyer of record: refunds go back to it and it may
     * release. Pulls `amount` with `transferFrom`, so approve this contract first.
     *
     * @dev Same checks as `fund`: the job must be new, the token allowed, the
     *      amount within (0, maxJobAmount], the parties distinct, the deadline
     *      inside [now + MIN_JOB_DURATION, now + MAX_JOB_DURATION], and both
     *      parties verified when an identity gate is set.
     */
    function fundDirect(
        bytes32 jobId,
        address provider,
        address token,
        uint256 amount,
        uint40 deadline
    ) external whenNotPaused nonReentrant {
        if (!funderAllowed[msg.sender]) revert NotFunder(msg.sender);
        _open(jobId, msg.sender, provider, token, amount, deadline);

        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        _checkReceived(token, before, amount);

        emit JobFunded(jobId, msg.sender, provider, token, amount, deadline);
    }

    /**
     * Pay the provider for a delivered job.
     *
     * @param resultHash SHA-256 of the result the provider returned, so anyone
     *        holding the result can prove it is the one that was paid for,
     *        without the result ever being public.
     * @dev Callable by the attester until the deadline, or by the buyer at any
     *      time while funded (a buyer happy with the work can always pay).
     */
    function release(bytes32 jobId, bytes32 resultHash) external nonReentrant {
        Job storage job = _funded(jobId);
        if (msg.sender == attester) {
            if (block.timestamp > job.deadline) revert DeadlinePassed(jobId, job.deadline);
        } else if (msg.sender != job.buyer) {
            revert NotAuthorized(msg.sender);
        }

        address provider = job.provider;
        // A provider frozen or revoked since funding can't be paid; the attester refunds instead.
        _requireVerified(provider);
        address token = job.token;
        uint256 amount = job.amount;
        uint256 fee = (amount * job.feeBps) / BPS;
        uint256 providerAmount = amount - fee;

        job.status = Status.Released;
        totalEscrowed[token] -= amount;

        IERC20(token).safeTransfer(provider, providerAmount);
        if (fee != 0) IERC20(token).safeTransfer(feeRecipient, fee);

        emit JobReleased(jobId, provider, providerAmount, fee, resultHash, msg.sender);
        _reportOutcome(jobId, provider, true, providerAmount);
    }

    /**
     * Return a job's full amount to its buyer.
     *
     * - The attester may refund at any time: the provider failed and no other
     *   could take the job. This counts against the provider's reputation.
     * - Anyone may refund once the deadline has passed. The money can only go
     *   to the buyer, so letting a keeper trigger it costs the buyer nothing.
     *   It does not count against the provider: an unsettled job may equally be
     *   the broker's fault.
     */
    function refund(bytes32 jobId) external nonReentrant {
        Job storage job = _funded(jobId);
        bool providerAtFault = msg.sender == attester;
        if (!providerAtFault && block.timestamp <= job.deadline) {
            revert DeadlineNotReached(jobId, job.deadline);
        }

        address buyer = job.buyer;
        address token = job.token;
        uint256 amount = job.amount;

        job.status = Status.Refunded;
        totalEscrowed[token] -= amount;

        IERC20(token).safeTransfer(buyer, amount);

        emit JobRefunded(jobId, buyer, amount, providerAtFault);
        if (providerAtFault) _reportOutcome(jobId, job.provider, false, 0);
    }

    /**
     * Return a job's full amount to its buyer because the *buyer* called it off.
     *
     * The same money movement as `refund`, without the mark: a buyer changing
     * their mind is not the provider failing, and reputation is permanent. It
     * is attester-only rather than open to the buyer on chain, because a buyer
     * who could cancel directly could void payment for work already delivered
     * in the moments before its release; the broker, which sees the job's
     * state, is the one that decides a cancel is still honest.
     */
    function cancel(bytes32 jobId) external onlyAttester nonReentrant {
        Job storage job = _funded(jobId);
        address buyer = job.buyer;
        address token = job.token;
        uint256 amount = job.amount;

        job.status = Status.Refunded;
        totalEscrowed[token] -= amount;

        IERC20(token).safeTransfer(buyer, amount);
        emit JobRefunded(jobId, buyer, amount, false);
    }

    /**
     * Hand a funded job to a different provider after the first one failed.
     * @dev The buyer's money never moves; only the eventual payee changes. The
     *      deadline is unchanged, so reassignment can never extend how long a
     *      buyer waits for a refund.
     */
    function reassign(bytes32 jobId, address newProvider) external onlyAttester nonReentrant {
        Job storage job = _funded(jobId);
        if (block.timestamp > job.deadline) revert DeadlinePassed(jobId, job.deadline);
        address previous = job.provider;
        if (newProvider == address(0) || newProvider == job.buyer || newProvider == previous) {
            revert InvalidParties(job.buyer, newProvider);
        }
        _requireVerified(newProvider);
        job.provider = newProvider;
        emit JobReassigned(jobId, previous, newProvider);
        _reportOutcome(jobId, previous, false, 0);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getJob(bytes32 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    /// True when `refund` would succeed for a caller that is not the attester.
    function isRefundable(bytes32 jobId) external view returns (bool) {
        Job storage job = _jobs[jobId];
        return job.status == Status.Funded && block.timestamp > job.deadline;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /**
     * Checks and effects shared by both funding paths. Effects come before the
     * pull: if the pull fails the whole transaction reverts, so there is no
     * half-funded state to unwind.
     */
    function _open(
        bytes32 jobId,
        address buyer,
        address provider,
        address token,
        uint256 amount,
        uint40 deadline
    ) private {
        Job storage job = _jobs[jobId];
        if (job.status != Status.None) revert JobExists(jobId);
        if (!tokenAllowed[token]) revert TokenNotAllowed(token);
        if (amount == 0 || amount > type(uint96).max) revert InvalidAmount(amount);
        if (amount > maxJobAmount) revert AmountAboveCap(amount, maxJobAmount);
        if (buyer == address(0) || provider == address(0) || buyer == provider) {
            revert InvalidParties(buyer, provider);
        }
        if (
            deadline < block.timestamp + MIN_JOB_DURATION
                || deadline > block.timestamp + MAX_JOB_DURATION
        ) revert InvalidDeadline(deadline);
        _requireVerified(buyer);
        _requireVerified(provider);

        job.buyer = buyer;
        job.deadline = deadline;
        job.status = Status.Funded;
        job.feeBps = feeBps;
        job.provider = provider;
        job.amount = uint96(amount);
        job.token = token;
        totalEscrowed[token] += amount;
    }

    /// The balance is measured on both sides of the pull, so a token that skims a transfer fee
    /// (none on the allowlist do) reverts instead of leaving the escrow short of what it owes.
    function _checkReceived(address token, uint256 before, uint256 amount) private view {
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received != amount) revert AmountMismatch(amount, received);
    }

    function _funded(bytes32 jobId) private view returns (Job storage job) {
        job = _jobs[jobId];
        if (job.status != Status.Funded) revert JobNotFunded(jobId, job.status);
    }

    /**
     * Report an outcome to the registry without ever letting it block settlement.
     *
     * @dev The call gets a fixed gas budget and any failure is caught, so a
     *      broken registry can't hold a payment hostage.
     *
     *      That `try/catch` has a trap: the transaction succeeds whether or not
     *      the registry call does, so a caller — or simply a gas *estimator*,
     *      which searches for the smallest limit at which the transaction
     *      succeeds — can supply enough gas for the payment but too little for
     *      the registry. Under EIP-150 the callee then gets 63/64 of whatever
     *      is left, runs out, and the provider's reputation silently never
     *      moves. This was found on a live dev node, where `estimateGas`
     *      produced exactly that transaction every time.
     *
     *      So the full budget is required *before* the call: with less than
     *      `REGISTRY_GAS_RESERVE` remaining the whole transaction reverts, and
     *      an estimator is forced to include the registry's share.
     */
    function _reportOutcome(bytes32 jobId, address provider, bool success, uint256 amount) private {
        IXorvOutcomeSink reg = registry;
        if (address(reg) == address(0)) return;
        if (gasleft() < REGISTRY_GAS_RESERVE) revert InsufficientGasForRegistry();
        try reg.recordOutcome{gas: REGISTRY_GAS_LIMIT}(jobId, provider, success, amount) {}
        catch (bytes memory reason) {
            emit RegistryCallFailed(jobId, provider, reason);
        }
    }

    function _requireVerified(address account) private view {
        IIdentityGate gate = identityGate;
        if (address(gate) != address(0) && !gate.isVerified(account)) revert IdentityNotVerified(account);
    }

    function _setAttester(address newAttester) private {
        emit AttesterUpdated(attester, newAttester);
        attester = newAttester;
    }

    function _setMaxJobAmount(uint256 newMax) private {
        if (newMax == 0) revert InvalidAmount(0);
        emit MaxJobAmountUpdated(maxJobAmount, newMax);
        maxJobAmount = newMax;
    }

    function _setTokenAllowed(address token, bool allowed) private {
        if (token == address(0)) revert ZeroAddress();
        tokenAllowed[token] = allowed;
        emit TokenAllowed(token, allowed);
    }
}
