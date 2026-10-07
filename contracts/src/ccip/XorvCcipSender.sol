// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ITokenMessengerV2} from "../interfaces/ITokenMessengerV2.sol";
import {XorvCcipIntent} from "./XorvCcipIntent.sol";

/**
 * @title XorvCcipSender
 * @notice Deployed on a source chain (Base Sepolia / Ethereum Sepolia; Base /
 *         Ethereum later). Lets a buyer agent that holds USDC there post an AI
 *         job to Xorv's escrow on Arc, and later settle it, without ever
 *         holding anything on Arc.
 *
 *         "CCTP moves the dollars, CCIP carries the instruction" (USDC is not
 *         a CCIP token on Arc):
 *           1. `postJob` burns `price + maxFee` USDC here with Circle CCTP V2,
 *              minted on Arc (domain 26) to XorvCcipReceiver;
 *           2. and sends the POST_JOB instruction there with Chainlink CCIP.
 *         The receiver funds the escrow job once both have arrived, in either
 *         order. `settle` sends a RELEASE instruction, which pays the provider.
 *
 *         CCIP fees are paid in this chain's native coin (`msg.value`,
 *         `feeToken = address(0)`); any excess is refunded.
 *
 * @dev Ownerless: every destination parameter is immutable, so the contract
 *      can only ever send to the one Arc receiver it was built for.
 */
contract XorvCcipSender is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IRouterClient public immutable router;
    IERC20 public immutable usdc;
    ITokenMessengerV2 public immutable tokenMessenger;
    uint64 public immutable arcChainSelector;
    address public immutable arcReceiver;
    /// Gas for the receiver's `ccipReceive` on Arc: record the intent and fund the escrow.
    uint256 public immutable postJobGasLimit;
    /// Gas for a RELEASE: the escrow release plus its reputation write (ERC-8004 feedback).
    uint256 public immutable settleGasLimit;

    uint32 public constant ARC_CCTP_DOMAIN = XorvCcipIntent.ARC_CCTP_DOMAIN;

    event JobPosted(
        bytes32 indexed messageId,
        bytes32 indexed jobId,
        address indexed requester,
        address provider,
        uint256 price,
        uint40 deadline,
        uint256 maxFee,
        uint256 ccipFee
    );
    event SettleSent(bytes32 indexed messageId, bytes32 indexed jobId, address indexed requester, bytes32 resultHash, uint256 ccipFee);

    error ZeroAddress();
    error InvalidPrice(uint256 price);
    error InsufficientFee(uint256 sent, uint256 fee);
    error RefundFailed();

    constructor(
        address router_,
        address usdc_,
        address tokenMessenger_,
        uint64 arcChainSelector_,
        address arcReceiver_,
        uint256 postJobGasLimit_,
        uint256 settleGasLimit_
    ) {
        if (router_ == address(0) || usdc_ == address(0) || tokenMessenger_ == address(0) || arcReceiver_ == address(0)) {
            revert ZeroAddress();
        }
        router = IRouterClient(router_);
        usdc = IERC20(usdc_);
        tokenMessenger = ITokenMessengerV2(tokenMessenger_);
        arcChainSelector = arcChainSelector_;
        arcReceiver = arcReceiver_;
        postJobGasLimit = postJobGasLimit_;
        settleGasLimit = settleGasLimit_;
    }

    // -----------------------------------------------------------------
    // Quotes (CCIP fee in this chain's native coin)
    // -----------------------------------------------------------------

    function quotePostJob(bytes32 jobId, address provider, uint256 price, uint40 deadline)
        external
        view
        returns (uint256)
    {
        return router.getFee(
            arcChainSelector,
            _message(XorvCcipIntent.postJob(jobId, msg.sender, provider, price, deadline), postJobGasLimit)
        );
    }

    function quoteSettle(bytes32 jobId, bytes32 resultHash) external view returns (uint256) {
        return router.getFee(
            arcChainSelector, _message(XorvCcipIntent.release(jobId, msg.sender, resultHash), settleGasLimit)
        );
    }

    // -----------------------------------------------------------------
    // Actions
    // -----------------------------------------------------------------

    /**
     * Post job `jobId` to Xorv's escrow on Arc, paying `price` USDC from this chain.
     *
     * Approve this contract for `price + maxFee` first. `maxFee` and
     * `minFinalityThreshold` pass straight to CCTP V2: `(0, 2000)` is a
     * standard transfer (no fee, waits for finality); a fast transfer uses
     * `minFinalityThreshold <= 1000` and a `maxFee` from Circle's fee API.
     * The receiver on Arc gets `price + maxFee - actualFee >= price`.
     *
     * If the job can't be funded on Arc (its deadline window closed, or the
     * job id is taken), the dollars stay claimable by `msg.sender`'s address
     * on Arc (XorvCcipReceiver.cancelPending / withdrawOwed).
     */
    function postJob(
        bytes32 jobId,
        address provider,
        uint256 price,
        uint40 deadline,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external payable nonReentrant returns (bytes32 messageId) {
        if (provider == address(0)) revert ZeroAddress();
        if (price == 0 || price > type(uint96).max) revert InvalidPrice(price);

        uint256 total = price + maxFee;
        usdc.safeTransferFrom(msg.sender, address(this), total);
        usdc.forceApprove(address(tokenMessenger), total);
        tokenMessenger.depositForBurn(
            total,
            ARC_CCTP_DOMAIN,
            bytes32(uint256(uint160(arcReceiver))),
            address(usdc),
            bytes32(0), // anyone may complete the mint on Arc
            maxFee,
            minFinalityThreshold
        );

        uint256 fee;
        (messageId, fee) =
            _send(XorvCcipIntent.postJob(jobId, msg.sender, provider, price, deadline), postJobGasLimit);
        emit JobPosted(messageId, jobId, msg.sender, provider, price, deadline, maxFee, fee);
    }

    /// Release job `jobId` on Arc to its provider. Only the account that posted it can.
    function settle(bytes32 jobId, bytes32 resultHash) external payable nonReentrant returns (bytes32 messageId) {
        uint256 fee;
        (messageId, fee) = _send(XorvCcipIntent.release(jobId, msg.sender, resultHash), settleGasLimit);
        emit SettleSent(messageId, jobId, msg.sender, resultHash, fee);
    }

    // -----------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------

    function _send(bytes memory data, uint256 gasLimit) private returns (bytes32 messageId, uint256 fee) {
        Client.EVM2AnyMessage memory m = _message(data, gasLimit);
        fee = router.getFee(arcChainSelector, m);
        if (msg.value < fee) revert InsufficientFee(msg.value, fee);
        messageId = router.ccipSend{value: fee}(arcChainSelector, m);
        if (msg.value > fee) {
            (bool ok,) = msg.sender.call{value: msg.value - fee}("");
            if (!ok) revert RefundFailed();
        }
    }

    function _message(bytes memory data, uint256 gasLimit) private view returns (Client.EVM2AnyMessage memory) {
        return Client.EVM2AnyMessage({
            receiver: abi.encode(arcReceiver),
            data: data,
            tokenAmounts: new Client.EVMTokenAmount[](0),
            extraArgs: Client._argsToBytes(
                Client.GenericExtraArgsV2({gasLimit: gasLimit, allowOutOfOrderExecution: true})
            ),
            feeToken: address(0)
        });
    }
}
