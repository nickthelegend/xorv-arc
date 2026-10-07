// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {CCIPLocalSimulator, IRouterClient} from "@chainlink/local/src/ccip/CCIPLocalSimulator.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {XorvEscrow} from "../src/XorvEscrow.sol";
import {XorvReputation} from "../src/XorvReputation.sol";
import {XorvCcipSender} from "../src/ccip/XorvCcipSender.sol";
import {XorvCcipReceiver} from "../src/ccip/XorvCcipReceiver.sol";
import {XorvCcipIntent} from "../src/ccip/XorvCcipIntent.sol";
import {MockERC3009} from "./mocks/MockERC3009.sol";
import {MockTokenMessengerV2} from "./mocks/MockTokenMessengerV2.sol";
import {MockIdentityRegistry, MockReputationRegistry} from "./mocks/MockERC8004.sol";

interface ILocalRouter {
    function setFee(uint256 feeAmount) external;
}

/**
 * A buyer agent on another chain posts and settles Xorv jobs on Arc.
 *
 * Chainlink Local's CCIPLocalSimulator routes every message for real through its
 * router (onlyRouter, the receiver's gas limit, ReceiverError on a revert), and
 * MockTokenMessengerV2 stands in for CCTP V2's burn and mint. The escrow,
 * XorvReputation and both CCIP contracts are the real ones.
 */
contract XorvCcipTest is Test {
    CCIPLocalSimulator internal sim;
    IRouterClient internal router;
    uint64 internal selector;

    MockERC3009 internal usdc;
    MockTokenMessengerV2 internal cctp;
    MockIdentityRegistry internal identity;
    MockReputationRegistry internal reputation;
    XorvReputation internal rep;
    XorvEscrow internal escrow;
    XorvCcipReceiver internal receiver;
    XorvCcipSender internal sender;

    address internal owner = makeAddr("owner");
    address internal attester = makeAddr("broker");
    address internal provider = makeAddr("provider");
    address internal buyer = makeAddr("buyer agent on Base");
    address internal other = makeAddr("someone else on Base");
    address internal treasury = makeAddr("treasury");

    uint256 internal constant PRICE = 5e6;
    uint256 internal constant CCIP_FEE = 0.01 ether;
    uint32 internal constant STANDARD = 2000;
    uint32 internal constant FAST = 1000;
    uint256 internal agentId;

    function setUp() public {
        vm.warp(1_800_000_000);
        sim = new CCIPLocalSimulator();
        (uint64 chainSelector, IRouterClient sourceRouter, IRouterClient destinationRouter,,,,) = sim.configuration();
        selector = chainSelector;
        router = sourceRouter;
        ILocalRouter(address(router)).setFee(CCIP_FEE); // fees in the native coin

        usdc = new MockERC3009("USDC", "2");
        cctp = new MockTokenMessengerV2(usdc);
        identity = new MockIdentityRegistry();
        reputation = new MockReputationRegistry(identity);
        rep = new XorvReputation(address(identity), address(reputation), owner);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        escrow = new XorvEscrow(owner, attester, address(rep), tokens, 100e6);
        receiver = new XorvCcipReceiver(address(destinationRouter), address(escrow), address(usdc), owner);
        sender = new XorvCcipSender(
            address(sourceRouter), address(usdc), address(cctp), selector, address(receiver), 400_000, 700_000
        );
        vm.startPrank(owner);
        rep.setEscrow(address(escrow));
        escrow.setFunder(address(receiver), true);
        receiver.allowSender(selector, address(sender), true);
        vm.stopPrank();

        vm.prank(provider);
        agentId = identity.register("ipfs://provider");
        rep.bind(agentId);

        for (uint256 i; i < 2; ++i) {
            address a = i == 0 ? buyer : other;
            usdc.mint(a, 1_000e6);
            vm.deal(a, 1 ether);
            vm.prank(a);
            usdc.approve(address(sender), type(uint256).max);
        }
    }

    function _deadline() internal view returns (uint40) {
        return uint40(block.timestamp + 1 hours);
    }

    function _post(address who, bytes32 jobId, uint256 maxFee, uint32 finality) internal returns (bytes32 id) {
        uint40 deadline = _deadline();
        vm.prank(who);
        uint256 fee = sender.quotePostJob(jobId, provider, PRICE, deadline);
        assertEq(fee, CCIP_FEE);
        vm.prank(who);
        id = sender.postJob{value: fee + 0.05 ether}(jobId, provider, PRICE, deadline, maxFee, finality);
    }

    function _post(bytes32 jobId) internal returns (bytes32) {
        return _post(buyer, jobId, 0, STANDARD);
    }

    function _settle(address who, bytes32 jobId) internal {
        vm.prank(who);
        sender.settle{value: CCIP_FEE}(jobId, keccak256("result"));
    }

    function _status(bytes32 jobId) internal view returns (XorvCcipReceiver.Status) {
        return receiver.getIntent(jobId).status;
    }

    // -----------------------------------------------------------------
    // Post a job
    // -----------------------------------------------------------------

    function test_postJob_fundsTheEscrowOnArc() public {
        bytes32 jobId = keccak256("job-1");
        uint256 ethBefore = buyer.balance;
        _post(jobId);

        XorvEscrow.Job memory job = escrow.getJob(jobId);
        assertEq(uint8(job.status), uint8(XorvEscrow.Status.Funded));
        assertEq(job.buyer, address(receiver), "receiver is the buyer of record");
        assertEq(job.provider, provider);
        assertEq(job.amount, PRICE);
        assertEq(usdc.balanceOf(address(escrow)), PRICE);
        assertEq(usdc.balanceOf(buyer), 1_000e6 - PRICE);

        XorvCcipReceiver.Intent memory it = receiver.getIntent(jobId);
        assertEq(uint8(it.status), uint8(XorvCcipReceiver.Status.Funded));
        assertEq(it.beneficiary, buyer);
        assertEq(it.sourceChainSelector, selector);
        assertEq(it.sourceSender, address(sender));
        assertEq(receiver.fundedTotal(), PRICE);
        assertEq(receiver.pendingTotal(), 0);

        // CCTP: to Arc (26), the receiver as mint recipient, anyone may finish the mint.
        assertEq(cctp.lastDestinationDomain(), 26);
        assertEq(cctp.lastMintRecipient(), bytes32(uint256(uint160(address(receiver)))));
        assertEq(cctp.lastDestinationCaller(), bytes32(0));
        assertEq(cctp.lastMinFinality(), STANDARD);
        // CCIP fee paid in native, excess refunded.
        assertEq(buyer.balance, ethBefore - CCIP_FEE);
        assertEq(address(router).balance, CCIP_FEE);
    }

    function test_postJob_insufficientNativeFeeReverts() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(XorvCcipSender.InsufficientFee.selector, CCIP_FEE - 1, CCIP_FEE));
        sender.postJob{value: CCIP_FEE - 1}(keccak256("j"), provider, PRICE, _deadline(), 0, STANDARD);
    }

    function test_postJob_fastTransferFeeLeavesSweepableDust() public {
        cctp.setFee(3_000); // CCTP fast-transfer fee, below the buyer's maxFee
        bytes32 jobId = keccak256("fast");
        _post(buyer, jobId, 10_000, FAST);
        assertEq(cctp.lastAmount(), PRICE + 10_000);
        assertEq(cctp.lastMaxFee(), 10_000);
        assertEq(cctp.lastMinFinality(), FAST);
        assertEq(uint8(_status(jobId)), uint8(XorvCcipReceiver.Status.Funded));
        assertEq(usdc.balanceOf(address(receiver)), 7_000, "maxFee - fee is dust");

        // While the job is open its refund could land here: the dust is held back with it.
        vm.prank(owner);
        vm.expectRevert(XorvCcipReceiver.NothingToSweep.selector);
        receiver.sweep(treasury);

        _settle(buyer, jobId);
        vm.prank(owner);
        receiver.sweep(treasury);
        assertEq(usdc.balanceOf(treasury), 7_000);
        vm.prank(owner);
        vm.expectRevert(XorvCcipReceiver.NothingToSweep.selector);
        receiver.sweep(treasury);
    }

    function test_messageBeforeDollars_waitsThenExecutes() public {
        cctp.setDeferred(true);
        bytes32 jobId = keccak256("job-2");
        _post(jobId);
        assertEq(uint8(_status(jobId)), uint8(XorvCcipReceiver.Status.Pending));
        assertEq(receiver.pendingTotal(), PRICE);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(XorvEscrow.Status.None));

        vm.expectRevert(abi.encodeWithSelector(XorvCcipReceiver.NotFunded.selector, 0, PRICE));
        receiver.executePending(jobId);

        cctp.releaseAll(); // the CCTP mint lands on Arc
        vm.prank(makeAddr("anyone"));
        receiver.executePending(jobId);
        assertEq(uint8(_status(jobId)), uint8(XorvCcipReceiver.Status.Funded));
        assertEq(uint8(escrow.getJob(jobId).status), uint8(XorvEscrow.Status.Funded));
        assertEq(receiver.pendingTotal(), 0);
        assertEq(receiver.fundedTotal(), PRICE);

        vm.expectRevert(
            abi.encodeWithSelector(XorvCcipReceiver.WrongStatus.selector, jobId, XorvCcipReceiver.Status.Funded)
        );
        receiver.executePending(jobId);
    }

    function test_pendingPastItsWindow_cancelsToTheBeneficiaryOnArc() public {
        cctp.setDeferred(true);
        bytes32 jobId = keccak256("late");
        _post(jobId);
        // Too early, and not the beneficiary: refused.
        vm.expectRevert(abi.encodeWithSelector(XorvCcipReceiver.NotCancellable.selector, jobId));
        receiver.cancelPending(jobId);

        vm.warp(block.timestamp + 2 hours); // the job can no longer be funded
        cctp.releaseAll();
        vm.expectRevert(); // InvalidDeadline from the escrow
        receiver.executePending(jobId);

        receiver.cancelPending(jobId);
        assertEq(uint8(_status(jobId)), uint8(XorvCcipReceiver.Status.Cancelled));
        assertEq(usdc.balanceOf(buyer), 1_000e6, "the buyer's dollars are back, on Arc");
        assertEq(receiver.pendingTotal(), 0);
        assertEq(usdc.balanceOf(address(receiver)), 0);
    }

    function test_duplicateJobId_isOwedBackNotLost() public {
        bytes32 jobId = keccak256("dup");
        _post(jobId);
        _post(other, jobId, 0, STANDARD);
        assertEq(receiver.owed(other), PRICE);
        assertEq(receiver.owedTotal(), PRICE);
        // The second requester can't touch the first job.
        assertEq(receiver.getIntent(jobId).beneficiary, buyer);
        // Owed money is not sweepable, and isn't used to fund intents.
        assertEq(receiver.available(), 0);
        vm.prank(owner);
        vm.expectRevert(XorvCcipReceiver.NothingToSweep.selector);
        receiver.sweep(treasury);

        receiver.withdrawOwed(other);
        assertEq(usdc.balanceOf(other), 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(XorvCcipReceiver.NothingOwed.selector, other));
        receiver.withdrawOwed(other);
    }

    // -----------------------------------------------------------------
    // Allowlist and router guard
    // -----------------------------------------------------------------

    function test_nonAllowlistedSender_isRefused() public {
        XorvCcipSender rogue = new XorvCcipSender(
            address(router), address(usdc), address(cctp), selector, address(receiver), 400_000, 700_000
        );
        vm.prank(buyer);
        usdc.approve(address(rogue), type(uint256).max);
        vm.prank(buyer);
        vm.expectRevert(); // ReceiverError(SourceNotAllowed) from the router
        rogue.postJob{value: CCIP_FEE}(keccak256("rogue"), provider, PRICE, _deadline(), 0, STANDARD);
        assertEq(uint8(_status(keccak256("rogue"))), uint8(XorvCcipReceiver.Status.None));
    }

    function test_nonAllowlistedSelector_isRefused() public {
        uint64 otherChain = selector == 10344971235874465080 ? 16015286601757825753 : 10344971235874465080;
        Client.Any2EVMMessage memory m = Client.Any2EVMMessage({
            messageId: keccak256("m"),
            sourceChainSelector: otherChain,
            sender: abi.encode(address(sender)),
            data: XorvCcipIntent.postJob(keccak256("x"), buyer, provider, PRICE, _deadline()),
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });
        vm.prank(address(router));
        vm.expectRevert(
            abi.encodeWithSelector(XorvCcipReceiver.SourceNotAllowed.selector, otherChain, address(sender))
        );
        receiver.ccipReceive(m);
    }

    function test_onlyTheRouterDelivers() public {
        Client.Any2EVMMessage memory m = Client.Any2EVMMessage({
            messageId: keccak256("m"),
            sourceChainSelector: selector,
            sender: abi.encode(address(sender)),
            data: XorvCcipIntent.postJob(keccak256("x"), buyer, provider, PRICE, _deadline()),
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });
        vm.expectRevert(); // InvalidRouter
        receiver.ccipReceive(m);
        vm.expectRevert(XorvCcipReceiver.OnlySelf.selector);
        receiver.processMessage(m);
    }

    function test_allowSender_isOwnerOnly() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        receiver.allowSender(selector, buyer, true);
        vm.expectEmit(address(receiver));
        emit XorvCcipReceiver.SenderAllowed(selector, address(sender), false);
        vm.prank(owner);
        receiver.allowSender(selector, address(sender), false);
        assertFalse(receiver.allowedSenders(selector, address(sender)));
    }

    // -----------------------------------------------------------------
    // Settle
    // -----------------------------------------------------------------

    function test_release_paysTheProviderAndWritesReputation() public {
        bytes32 jobId = keccak256("job-3");
        _post(jobId);
        _settle(buyer, jobId);
        assertEq(usdc.balanceOf(provider), PRICE);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(XorvEscrow.Status.Released));
        assertEq(uint8(_status(jobId)), uint8(XorvCcipReceiver.Status.Released));
        assertEq(receiver.fundedTotal(), 0);
        // The 700k settle gas limit covered the ERC-8004 write.
        (int128 value,,,,) = reputation.readFeedback(agentId, address(rep), 1);
        assertEq(value, 100);
    }

    function test_releaseFromAnotherRequester_isStoredAsFailed_andRetryStillFails() public {
        bytes32 jobId = keccak256("job-4");
        _post(jobId);

        vm.recordLogs();
        _settle(other, jobId);
        bytes32 messageId = _failedMessageId();
        assertEq(uint8(receiver.getFailedMessage(messageId).status), uint8(XorvCcipReceiver.MessageStatus.Failed));
        assertEq(usdc.balanceOf(provider), 0);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(XorvEscrow.Status.Funded));

        vm.expectRevert(abi.encodeWithSelector(XorvCcipReceiver.NotRequester.selector, jobId, other));
        receiver.retryFailedMessage(messageId);
        assertEq(uint8(receiver.getFailedMessage(messageId).status), uint8(XorvCcipReceiver.MessageStatus.Failed));

        // The owner can only resolve a message that still cannot be processed.
        vm.prank(owner);
        receiver.resolveFailedMessage(messageId);
        assertEq(uint8(receiver.getFailedMessage(messageId).status), uint8(XorvCcipReceiver.MessageStatus.Resolved));
        vm.expectRevert(abi.encodeWithSelector(XorvCcipReceiver.NotFailed.selector, messageId));
        receiver.retryFailedMessage(messageId);

        // The real requester still settles.
        _settle(buyer, jobId);
        assertEq(usdc.balanceOf(provider), PRICE);
    }

    function test_releaseBeforeFunding_failsThenRetrySucceeds() public {
        cctp.setDeferred(true);
        bytes32 jobId = keccak256("job-5");
        _post(jobId);
        vm.recordLogs();
        _settle(buyer, jobId); // arrives while the intent is still Pending
        bytes32 messageId = _failedMessageId();

        // The owner can't discard it: once funded it would succeed.
        cctp.releaseAll();
        receiver.executePending(jobId);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(XorvCcipReceiver.StillProcessable.selector, messageId));
        receiver.resolveFailedMessage(messageId);

        vm.prank(makeAddr("anyone"));
        receiver.retryFailedMessage(messageId);
        assertEq(usdc.balanceOf(provider), PRICE);
        assertEq(uint8(receiver.getFailedMessage(messageId).status), uint8(XorvCcipReceiver.MessageStatus.Resolved));
    }

    function test_releaseFromAnotherOrigin_fails() public {
        bytes32 jobId = keccak256("job-6");
        _post(jobId);
        // A second allowlisted sender (e.g. on another chain) can't release a job posted via the first.
        XorvCcipSender second = new XorvCcipSender(
            address(router), address(usdc), address(cctp), selector, address(receiver), 400_000, 700_000
        );
        vm.prank(owner);
        receiver.allowSender(selector, address(second), true);
        vm.recordLogs();
        vm.prank(buyer);
        second.settle{value: CCIP_FEE}(jobId, keccak256("result"));
        bytes32 messageId = _failedMessageId();
        vm.expectRevert(
            abi.encodeWithSelector(XorvCcipReceiver.WrongOrigin.selector, jobId, selector, address(second))
        );
        receiver.retryFailedMessage(messageId);
        assertEq(usdc.balanceOf(provider), 0);
    }

    function test_attesterReleasedFirst_releaseMessageJustClosesIt() public {
        bytes32 jobId = keccak256("job-7");
        _post(jobId);
        vm.prank(attester);
        escrow.release(jobId, keccak256("result"));
        _settle(buyer, jobId);
        assertEq(uint8(_status(jobId)), uint8(XorvCcipReceiver.Status.Released));
        assertEq(receiver.fundedTotal(), 0);
        assertEq(usdc.balanceOf(provider), PRICE);
    }

    function test_markReleased_closesAnAttesterRelease() public {
        bytes32 jobId = keccak256("job-8");
        _post(jobId);
        vm.expectRevert(abi.encodeWithSelector(XorvCcipReceiver.EscrowNotReleased.selector, jobId));
        receiver.markReleased(jobId);
        vm.prank(attester);
        escrow.release(jobId, keccak256("result"));
        receiver.markReleased(jobId);
        assertEq(receiver.fundedTotal(), 0);
    }

    // -----------------------------------------------------------------
    // Refunds
    // -----------------------------------------------------------------

    function test_refundAfterDeadline_claimRefundPaysTheBeneficiaryOnce() public {
        bytes32 jobId = keccak256("job-9");
        _post(jobId);
        vm.expectRevert(abi.encodeWithSelector(XorvCcipReceiver.EscrowNotRefunded.selector, jobId));
        receiver.claimRefund(jobId);

        vm.warp(block.timestamp + 2 hours);
        escrow.refund(jobId); // anyone, after the deadline: the dollars land on the receiver
        assertEq(usdc.balanceOf(address(receiver)), PRICE);
        // Committed to the beneficiary: the owner can't sweep it.
        vm.prank(owner);
        vm.expectRevert(XorvCcipReceiver.NothingToSweep.selector);
        receiver.sweep(treasury);

        vm.prank(makeAddr("keeper"));
        receiver.claimRefund(jobId);
        assertEq(usdc.balanceOf(buyer), 1_000e6);
        assertEq(receiver.fundedTotal(), 0);
        vm.expectRevert(
            abi.encodeWithSelector(XorvCcipReceiver.WrongStatus.selector, jobId, XorvCcipReceiver.Status.Refunded)
        );
        receiver.claimRefund(jobId);
    }

    function test_attesterRefund_alsoClaimable() public {
        bytes32 jobId = keccak256("job-10");
        _post(jobId);
        vm.prank(attester);
        escrow.refund(jobId);
        receiver.claimRefund(jobId);
        assertEq(usdc.balanceOf(buyer), 1_000e6);
    }

    // -----------------------------------------------------------------
    // Owner can't reach buyers' money
    // -----------------------------------------------------------------

    function test_sweep_neverTouchesCommittedFunds() public {
        cctp.setDeferred(true);
        _post(keccak256("p1"));
        cctp.releaseAll(); // a pending intent's dollars are here
        usdc.mint(address(receiver), 123); // stray dust
        vm.prank(owner);
        receiver.sweep(treasury);
        assertEq(usdc.balanceOf(treasury), 123);
        assertEq(usdc.balanceOf(address(receiver)), PRICE);
        receiver.executePending(keccak256("p1"));
        assertEq(uint8(_status(keccak256("p1"))), uint8(XorvCcipReceiver.Status.Funded));

        // A refund that landed but hasn't been claimed is never sweepable.
        vm.warp(block.timestamp + 2 hours);
        escrow.refund(keccak256("p1"));
        usdc.mint(address(receiver), 50);
        vm.prank(owner);
        receiver.sweep(treasury);
        assertEq(usdc.balanceOf(treasury), 173);
        receiver.claimRefund(keccak256("p1"));
        assertEq(usdc.balanceOf(buyer), 1_000e6);
    }

    function test_sweep_isOwnerOnly_andRenounceDisabled() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        receiver.sweep(buyer);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        receiver.resolveFailedMessage(bytes32(0));
        vm.prank(owner);
        vm.expectRevert(XorvCcipReceiver.RenounceDisabled.selector);
        receiver.renounceOwnership();
    }

    function test_quoteSettle_isNative() public {
        vm.prank(buyer);
        assertEq(sender.quoteSettle(keccak256("x"), bytes32(0)), CCIP_FEE);
    }

    // -----------------------------------------------------------------

    function _failedMessageId() internal returns (bytes32) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = XorvCcipReceiver.MessageFailed.selector;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(receiver) && logs[i].topics[0] == topic) return logs[i].topics[1];
        }
        revert("no MessageFailed");
    }
}

