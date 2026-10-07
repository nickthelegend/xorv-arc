// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {XorvEscrow} from "../src/XorvEscrow.sol";
import {MockERC3009} from "./mocks/MockERC3009.sol";
import {MockRegistry, MockSmartWallet} from "./mocks/MockRegistry.sol";

contract XorvEscrowTestBase is Test {
    XorvEscrow internal escrow;
    MockERC3009 internal usdc;
    MockRegistry internal registry;

    address internal owner = makeAddr("owner");
    address internal attester = makeAddr("attester");
    address internal provider = makeAddr("provider");
    address internal provider2 = makeAddr("provider2");
    address internal stranger = makeAddr("stranger");
    address internal treasury = makeAddr("treasury");
    uint256 internal buyerKey = 0xB0B;
    address internal buyer;

    uint256 internal constant PRICE = 250_000; // $0.25 at 6 decimals
    uint256 internal constant CAP = 1_000e6;
    bytes32 internal constant JOB = keccak256("job-1");
    // keccak, not sha256: sha256 is a precompile *call*, which would consume a vm.prank.
    bytes32 internal constant RESULT = keccak256("the answer");

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        buyer = vm.addr(buyerKey);
        usdc = new MockERC3009("USDC", "2");
        registry = new MockRegistry();
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        escrow = new XorvEscrow(owner, attester, address(registry), tokens, CAP);
        registry.setEscrow(address(escrow));
        usdc.mint(buyer, 1_000e6);
    }

    function _deadline() internal view returns (uint40) {
        return uint40(block.timestamp + 30 minutes);
    }

    /// The buyer's signature, exactly as a wallet would produce it off-chain.
    function _sign(uint256 key, address from, uint256 amount, bytes32 jobId, uint40 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = usdc.hashReceive(
            from,
            address(escrow),
            amount,
            0,
            block.timestamp + 1 hours,
            escrow.fundingNonce(jobId, deadline)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _funding(bytes32 jobId, uint256 amount, uint40 deadline)
        internal
        view
        returns (XorvEscrow.Funding memory)
    {
        return XorvEscrow.Funding({
            jobId: jobId,
            buyer: buyer,
            provider: provider,
            token: address(usdc),
            amount: amount,
            deadline: deadline,
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            signature: _sign(buyerKey, buyer, amount, jobId, deadline)
        });
    }

    function _fund(bytes32 jobId, uint256 amount) internal returns (uint40 deadline) {
        deadline = _deadline();
        XorvEscrow.Funding memory f = _funding(jobId, amount, deadline);
        vm.prank(attester);
        escrow.fund(f);
    }
}

contract XorvEscrowFundTest is XorvEscrowTestBase {
    function test_fund_movesMoneyIntoEscrowAndRecordsJob() public {
        uint40 deadline = _deadline();
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, deadline);

        vm.expectEmit(address(escrow));
        emit XorvEscrow.JobFunded(JOB, buyer, provider, address(usdc), PRICE, deadline);
        vm.prank(attester);
        escrow.fund(f);

        assertEq(usdc.balanceOf(address(escrow)), PRICE);
        assertEq(usdc.balanceOf(buyer), 1_000e6 - PRICE);
        assertEq(escrow.totalEscrowed(address(usdc)), PRICE);

        XorvEscrow.Job memory job = escrow.getJob(JOB);
        assertEq(job.buyer, buyer);
        assertEq(job.provider, provider);
        assertEq(job.token, address(usdc));
        assertEq(job.amount, PRICE);
        assertEq(job.deadline, deadline);
        assertEq(uint8(job.status), uint8(XorvEscrow.Status.Funded));
    }

    function test_fund_buyerNeedsNoGas() public {
        // The buyer never sends a transaction and holds no ETH.
        assertEq(buyer.balance, 0);
        _fund(JOB, PRICE);
        assertEq(buyer.balance, 0);
    }

    function test_fund_onlyAttester() public {
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, _deadline());
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.NotAttester.selector, stranger));
        escrow.fund(f);
    }

    function test_fund_revertsOnDuplicateJob() public {
        _fund(JOB, PRICE);
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, _deadline());
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.JobExists.selector, JOB));
        escrow.fund(f);
    }

    function test_fund_signatureCommitsToDeadline() public {
        // A relayer that moves the refund deadline changes the nonce, and the
        // buyer's signature no longer covers it.
        uint40 deadline = _deadline();
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, deadline);
        f.deadline = deadline + 1 days;
        vm.prank(attester);
        vm.expectRevert("FiatTokenV2: invalid signature");
        escrow.fund(f);
    }

    function test_fund_signatureCommitsToJobId() public {
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, _deadline());
        f.jobId = keccak256("some-other-job");
        vm.prank(attester);
        vm.expectRevert("FiatTokenV2: invalid signature");
        escrow.fund(f);
    }

    function test_fund_signatureCommitsToAmount() public {
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, _deadline());
        f.amount = PRICE * 4;
        vm.prank(attester);
        vm.expectRevert("FiatTokenV2: invalid signature");
        escrow.fund(f);
    }

    function test_fund_authorizationCannotBeFrontRun() public {
        // Someone who sees the signature cannot redeem it directly with the
        // token: receiveWithAuthorization only pays out to its caller.
        uint40 deadline = _deadline();
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, deadline);
        bytes32 nonce = escrow.fundingNonce(JOB, deadline);
        vm.prank(stranger);
        vm.expectRevert("FiatTokenV2: caller must be the payee");
        usdc.receiveWithAuthorization(
            buyer, address(escrow), PRICE, f.validAfter, f.validBefore, nonce, f.signature
        );
    }

    function test_fund_rejectsDisallowedToken() public {
        MockERC3009 other = new MockERC3009("Other", "1");
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, _deadline());
        f.token = address(other);
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.TokenNotAllowed.selector, address(other)));
        escrow.fund(f);
    }

    function test_fund_rejectsZeroAndOversizedAmounts() public {
        XorvEscrow.Funding memory f = _funding(JOB, 0, _deadline());
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.InvalidAmount.selector, 0));
        escrow.fund(f);

        uint256 huge = uint256(type(uint96).max) + 1;
        f = _funding(JOB, huge, _deadline());
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.InvalidAmount.selector, huge));
        escrow.fund(f);

        f = _funding(JOB, CAP + 1, _deadline());
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.AmountAboveCap.selector, CAP + 1, CAP));
        escrow.fund(f);
    }

    function test_fund_rejectsSelfDealing() public {
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, _deadline());
        f.provider = buyer;
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.InvalidParties.selector, buyer, buyer));
        escrow.fund(f);
    }

    function test_fund_rejectsDeadlinesOutsideWindow() public {
        uint40 tooSoon = uint40(block.timestamp + 30 seconds);
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, tooSoon);
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.InvalidDeadline.selector, tooSoon));
        escrow.fund(f);

        uint40 tooLate = uint40(block.timestamp + 8 days);
        f = _funding(JOB, PRICE, tooLate);
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.InvalidDeadline.selector, tooLate));
        escrow.fund(f);
    }

    function test_fund_rejectsFeeOnTransferToken() public {
        usdc.setTransferFeeBps(100);
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, _deadline());
        vm.prank(attester);
        vm.expectRevert(
            abi.encodeWithSelector(XorvEscrow.AmountMismatch.selector, PRICE, PRICE - PRICE / 100)
        );
        escrow.fund(f);
    }

    function test_fund_blockedWhenPaused() public {
        vm.prank(owner);
        escrow.pause();
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, _deadline());
        vm.prank(attester);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.fund(f);
    }

    function test_fund_fromSmartContractWallet() public {
        // ERC-1271: a buyer paying from a smart account (e.g. an ERC-4337 wallet).
        MockSmartWallet wallet = new MockSmartWallet(buyer);
        usdc.mint(address(wallet), 10e6);
        uint40 deadline = _deadline();
        bytes32 digest = usdc.hashReceive(
            address(wallet),
            address(escrow),
            PRICE,
            0,
            block.timestamp + 1 hours,
            escrow.fundingNonce(JOB, deadline)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerKey, digest);

        XorvEscrow.Funding memory f = XorvEscrow.Funding({
            jobId: JOB,
            buyer: address(wallet),
            provider: provider,
            token: address(usdc),
            amount: PRICE,
            deadline: deadline,
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            signature: abi.encode(v, r, s)
        });
        vm.prank(attester);
        escrow.fund(f);
        assertEq(escrow.getJob(JOB).buyer, address(wallet));
        assertEq(usdc.balanceOf(address(escrow)), PRICE);
    }

    function test_fundingNonce_isBoundToChainAndContract() public {
        bytes32 here = escrow.fundingNonce(JOB, 100);
        vm.chainId(46630);
        assertTrue(escrow.fundingNonce(JOB, 100) != here);
        vm.chainId(421614);
        address[] memory tokens = new address[](0);
        XorvEscrow twin = new XorvEscrow(owner, attester, address(0), tokens, CAP);
        assertTrue(twin.fundingNonce(JOB, 100) != escrow.fundingNonce(JOB, 100));
    }
}

contract XorvEscrowSettleTest is XorvEscrowTestBase {
    function test_release_byAttesterPaysProviderAndRecordsReputation() public {
        _fund(JOB, PRICE);

        vm.expectEmit(address(escrow));
        emit XorvEscrow.JobReleased(JOB, provider, PRICE, 0, RESULT, attester);
        vm.prank(attester);
        escrow.release(JOB, RESULT);

        assertEq(usdc.balanceOf(provider), PRICE);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalEscrowed(address(usdc)), 0);
        assertEq(uint8(escrow.getJob(JOB).status), uint8(XorvEscrow.Status.Released));
        assertEq(registry.completed(provider), 1);
        assertEq(registry.failed(provider), 0);
    }

    function test_release_byBuyerAnytime() public {
        uint40 deadline = _fund(JOB, PRICE);
        vm.warp(deadline + 1 days);
        vm.prank(buyer);
        escrow.release(JOB, RESULT);
        assertEq(usdc.balanceOf(provider), PRICE);
    }

    function test_release_attesterCannotReleaseAfterDeadline() public {
        uint40 deadline = _fund(JOB, PRICE);
        vm.warp(deadline + 1);
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.DeadlinePassed.selector, JOB, deadline));
        escrow.release(JOB, RESULT);
    }

    function test_release_strangerCannotRelease() public {
        _fund(JOB, PRICE);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.NotAuthorized.selector, stranger));
        escrow.release(JOB, RESULT);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.NotAuthorized.selector, provider));
        escrow.release(JOB, RESULT);
    }

    function test_release_takesSnapshottedFee() public {
        vm.prank(owner);
        escrow.setFee(250, treasury); // 2.5%
        _fund(JOB, PRICE);
        // Raising the fee after funding must not touch this job.
        vm.prank(owner);
        escrow.setFee(500, treasury);

        vm.prank(attester);
        escrow.release(JOB, RESULT);
        uint256 fee = (PRICE * 250) / 10_000;
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(usdc.balanceOf(provider), PRICE - fee);
    }

    function test_settledJobCannotSettleAgain() public {
        _fund(JOB, PRICE);
        vm.prank(attester);
        escrow.release(JOB, RESULT);

        vm.prank(attester);
        vm.expectRevert(
            abi.encodeWithSelector(XorvEscrow.JobNotFunded.selector, JOB, XorvEscrow.Status.Released)
        );
        escrow.release(JOB, RESULT);

        vm.prank(attester);
        vm.expectRevert(
            abi.encodeWithSelector(XorvEscrow.JobNotFunded.selector, JOB, XorvEscrow.Status.Released)
        );
        escrow.refund(JOB);
    }

    function test_unknownJobCannotSettle() public {
        vm.prank(attester);
        vm.expectRevert(
            abi.encodeWithSelector(XorvEscrow.JobNotFunded.selector, JOB, XorvEscrow.Status.None)
        );
        escrow.release(JOB, RESULT);
    }

    function test_refund_byAttesterAnytimeCountsAgainstProvider() public {
        _fund(JOB, PRICE);
        vm.expectEmit(address(escrow));
        emit XorvEscrow.JobRefunded(JOB, buyer, PRICE, true);
        vm.prank(attester);
        escrow.refund(JOB);

        assertEq(usdc.balanceOf(buyer), 1_000e6);
        assertEq(escrow.totalEscrowed(address(usdc)), 0);
        assertEq(registry.failed(provider), 1);
    }

    function test_refund_anyoneAfterDeadlineWithoutBlame() public {
        uint40 deadline = _fund(JOB, PRICE);
        assertFalse(escrow.isRefundable(JOB));
        vm.warp(deadline + 1);
        assertTrue(escrow.isRefundable(JOB));

        vm.prank(stranger);
        escrow.refund(JOB);
        assertEq(usdc.balanceOf(buyer), 1_000e6);
        assertEq(usdc.balanceOf(stranger), 0);
        assertEq(registry.failed(provider), 0);
    }

    function test_refund_notBeforeDeadline() public {
        uint40 deadline = _fund(JOB, PRICE);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.DeadlineNotReached.selector, JOB, deadline));
        escrow.refund(JOB);
    }

    function test_cancel_refundsWithoutBlame() public {
        _fund(JOB, PRICE);
        vm.expectEmit(address(escrow));
        emit XorvEscrow.JobRefunded(JOB, buyer, PRICE, false);
        vm.prank(attester);
        escrow.cancel(JOB);
        assertEq(usdc.balanceOf(buyer), 1_000e6);
        assertEq(escrow.totalEscrowed(address(usdc)), 0);
        assertEq(uint8(escrow.getJob(JOB).status), uint8(XorvEscrow.Status.Refunded));
        // A buyer calling it off is not the provider failing.
        assertEq(registry.failed(provider), 0);
        assertEq(registry.outcomeCount(), 0);
    }

    function test_cancel_onlyAttester() public {
        _fund(JOB, PRICE);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.NotAttester.selector, buyer));
        escrow.cancel(JOB);
    }

    function test_cancel_notAfterSettlement() public {
        _fund(JOB, PRICE);
        vm.prank(attester);
        escrow.release(JOB, RESULT);
        vm.prank(attester);
        vm.expectRevert(
            abi.encodeWithSelector(XorvEscrow.JobNotFunded.selector, JOB, XorvEscrow.Status.Released)
        );
        escrow.cancel(JOB);
    }

    function test_refund_worksWhilePaused() public {
        uint40 deadline = _fund(JOB, PRICE);
        vm.prank(owner);
        escrow.pause();
        vm.warp(deadline + 1);
        escrow.refund(JOB);
        assertEq(usdc.balanceOf(buyer), 1_000e6);
    }

    function test_release_worksWhilePaused() public {
        _fund(JOB, PRICE);
        vm.prank(owner);
        escrow.pause();
        vm.prank(attester);
        escrow.release(JOB, RESULT);
        assertEq(usdc.balanceOf(provider), PRICE);
    }

    function test_reassign_movesPayeeAndBlamesPrevious() public {
        _fund(JOB, PRICE);
        vm.expectEmit(address(escrow));
        emit XorvEscrow.JobReassigned(JOB, provider, provider2);
        vm.prank(attester);
        escrow.reassign(JOB, provider2);

        assertEq(registry.failed(provider), 1);
        vm.prank(attester);
        escrow.release(JOB, RESULT);
        assertEq(usdc.balanceOf(provider2), PRICE);
        assertEq(usdc.balanceOf(provider), 0);
    }

    function test_reassign_guards() public {
        uint40 deadline = _fund(JOB, PRICE);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.NotAttester.selector, stranger));
        escrow.reassign(JOB, provider2);

        vm.startPrank(attester);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.InvalidParties.selector, buyer, buyer));
        escrow.reassign(JOB, buyer);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.InvalidParties.selector, buyer, provider));
        escrow.reassign(JOB, provider);
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.DeadlinePassed.selector, JOB, deadline));
        escrow.reassign(JOB, provider2);
        vm.stopPrank();
    }
}

contract XorvEscrowRegistryTest is XorvEscrowTestBase {
    function test_brokenRegistryNeverBlocksPayment() public {
        registry.setMode(MockRegistry.Mode.Revert);
        _fund(JOB, PRICE);
        vm.expectEmit(true, true, false, false, address(escrow));
        emit XorvEscrow.RegistryCallFailed(JOB, provider, "");
        vm.prank(attester);
        escrow.release(JOB, RESULT);
        assertEq(usdc.balanceOf(provider), PRICE);
    }

    function test_gasBurningRegistryNeverBlocksPayment() public {
        registry.setMode(MockRegistry.Mode.BurnGas);
        _fund(JOB, PRICE);
        vm.prank(attester);
        escrow.refund(JOB);
        assertEq(usdc.balanceOf(buyer), 1_000e6);
    }

    function test_starvingTheRegistryCallReverts() public {
        // Supplying just too little gas for the registry, hoping the payment
        // still completes without the reputation update, must not work.
        registry.setMode(MockRegistry.Mode.BurnGas);
        _fund(JOB, PRICE);
        vm.prank(attester);
        (bool ok,) = address(escrow).call{gas: 120_000}(
            abi.encodeCall(XorvEscrow.release, (JOB, RESULT))
        );
        assertFalse(ok);
        assertEq(uint8(escrow.getJob(JOB).status), uint8(XorvEscrow.Status.Funded));
    }

    /// Regression: found on a live dev node. A gas limit that covers the payment
    /// but not the registry used to succeed with the reputation update skipped.
    function test_underfundedGasNeverSkipsReputation() public {
        registry.setMode(MockRegistry.Mode.Expensive);
        _fund(JOB, PRICE);
        for (uint256 g = 60_000; g < 1_000_000; g += 10_000) {
            vm.prank(attester);
            (bool ok,) = address(escrow).call{gas: g}(
                abi.encodeCall(XorvEscrow.release, (JOB, RESULT))
            );
            if (ok) {
                // The first limit that succeeds must also have paid for the record.
                assertEq(registry.completed(provider), 1, "released without reputation");
                assertEq(usdc.balanceOf(provider), PRICE);
                return;
            }
            assertEq(registry.completed(provider), 0);
        }
        revert("release never succeeded");
    }

    function test_outcomeCarriesJobId() public {
        _fund(JOB, PRICE);
        vm.prank(attester);
        escrow.release(JOB, RESULT);
        (bytes32 jobId, address p, bool success, uint256 amount) = registry.outcomes(0);
        assertEq(jobId, JOB);
        assertEq(p, provider);
        assertTrue(success);
        assertEq(amount, PRICE);
    }

    function test_noRegistryIsFine() public {
        vm.prank(owner);
        escrow.setRegistry(address(0));
        _fund(JOB, PRICE);
        vm.prank(attester);
        escrow.release(JOB, RESULT);
        assertEq(usdc.balanceOf(provider), PRICE);
        assertEq(registry.outcomeCount(), 0);
    }
}

contract XorvEscrowAdminTest is XorvEscrowTestBase {
    function test_adminIsOwnerOnly() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setAttester(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setRegistry(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setTokenAllowed(stranger, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setFee(1, stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.sweep(address(usdc), stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setFunder(stranger, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setMaxJobAmount(1);
        vm.stopPrank();
    }

    function test_feeIsCapped() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.FeeTooHigh.selector, 501));
        escrow.setFee(501, treasury);
        vm.expectRevert(XorvEscrow.ZeroAddress.selector);
        escrow.setFee(100, address(0));
        escrow.setFee(0, address(0));
        vm.stopPrank();
    }

    function test_sweepReachesOnlyExcess() public {
        _fund(JOB, PRICE);
        usdc.mint(address(escrow), 7e6); // sent by mistake

        vm.prank(owner);
        escrow.sweep(address(usdc), treasury);
        assertEq(usdc.balanceOf(treasury), 7e6);
        assertEq(usdc.balanceOf(address(escrow)), PRICE);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.NothingToSweep.selector, address(usdc)));
        escrow.sweep(address(usdc), treasury);
    }

    function test_renounceIsDisabled() public {
        vm.prank(owner);
        vm.expectRevert(XorvEscrow.RenounceDisabled.selector);
        escrow.renounceOwnership();
    }

    function test_ownershipTransferIsTwoStep() public {
        vm.prank(owner);
        escrow.transferOwnership(stranger);
        assertEq(escrow.owner(), owner);
        vm.prank(stranger);
        escrow.acceptOwnership();
        assertEq(escrow.owner(), stranger);
    }

    function test_disallowingTokenStillLetsFundedJobsSettle() public {
        _fund(JOB, PRICE);
        vm.prank(owner);
        escrow.setTokenAllowed(address(usdc), false);
        vm.prank(attester);
        escrow.release(JOB, RESULT);
        assertEq(usdc.balanceOf(provider), PRICE);
    }

    function test_rotatingAttesterRevokesOldKey() public {
        _fund(JOB, PRICE);
        address next = makeAddr("next-attester");
        vm.prank(owner);
        escrow.setAttester(next);
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.NotAuthorized.selector, attester));
        escrow.release(JOB, RESULT);
        vm.prank(next);
        escrow.release(JOB, RESULT);
    }
}

contract XorvEscrowFuzzTest is XorvEscrowTestBase {
    function testFuzz_releaseSplitsExactly(uint96 amount, uint16 fee) public {
        amount = uint96(bound(amount, 1, 1_000e6));
        fee = uint16(bound(fee, 0, escrow.MAX_FEE_BPS()));
        vm.prank(owner);
        escrow.setFee(fee, treasury);

        _fund(JOB, amount);
        vm.prank(attester);
        escrow.release(JOB, RESULT);

        assertEq(usdc.balanceOf(provider) + usdc.balanceOf(treasury), amount);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function testFuzz_refundReturnsEverything(uint96 amount, uint32 lateBy) public {
        amount = uint96(bound(amount, 1, 1_000e6));
        uint40 deadline = _fund(JOB, amount);
        vm.warp(uint256(deadline) + 1 + lateBy);
        escrow.refund(JOB);
        assertEq(usdc.balanceOf(buyer), 1_000e6);
    }

    function testFuzz_foreignSignerCannotFund(uint256 attackerKey) public {
        attackerKey = bound(attackerKey, 1, type(uint128).max);
        vm.assume(attackerKey != buyerKey);
        uint40 deadline = _deadline();
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, deadline);
        f.signature = _sign(attackerKey, buyer, PRICE, JOB, deadline);
        vm.prank(attester);
        vm.expectRevert("FiatTokenV2: invalid signature");
        escrow.fund(f);
    }
}

contract XorvEscrowCapTest is XorvEscrowTestBase {
    function test_capIsSetAtDeployAndMustBeNonZero() public {
        assertEq(escrow.maxJobAmount(), CAP);
        address[] memory tokens = new address[](0);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.InvalidAmount.selector, 0));
        new XorvEscrow(owner, attester, address(0), tokens, 0);
    }

    function test_ownerCanMoveTheCap() public {
        vm.expectEmit(address(escrow));
        emit XorvEscrow.MaxJobAmountUpdated(CAP, 100e6);
        vm.prank(owner);
        escrow.setMaxJobAmount(100e6);
        assertEq(escrow.maxJobAmount(), 100e6);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.InvalidAmount.selector, 0));
        escrow.setMaxJobAmount(0);
    }

    function test_loweringTheCapLeavesFundedJobsAlone() public {
        _fund(JOB, 500e6);
        vm.prank(owner);
        escrow.setMaxJobAmount(100e6);
        vm.prank(attester);
        escrow.release(JOB, RESULT);
        assertEq(usdc.balanceOf(provider), 500e6);
    }

    function test_jobAtExactlyTheCapIsFine() public {
        vm.prank(owner);
        escrow.setMaxJobAmount(PRICE);
        _fund(JOB, PRICE);
        assertEq(escrow.totalEscrowed(address(usdc)), PRICE);
    }
}

/// A contract buyer (the CCIP receiver) funds jobs as itself.
contract XorvEscrowFundDirectTest is XorvEscrowTestBase {
    address internal funder = makeAddr("ccip-receiver");

    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        escrow.setFunder(funder, true);
        usdc.mint(funder, 100e6);
        vm.prank(funder);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _direct(bytes32 jobId, uint256 amount, uint40 deadline) internal {
        vm.prank(funder);
        escrow.fundDirect(jobId, provider, address(usdc), amount, deadline);
    }

    function test_fundDirect_funderIsBuyerOfRecord() public {
        uint40 deadline = _deadline();
        vm.expectEmit(address(escrow));
        emit XorvEscrow.JobFunded(JOB, funder, provider, address(usdc), PRICE, deadline);
        _direct(JOB, PRICE, deadline);

        XorvEscrow.Job memory job = escrow.getJob(JOB);
        assertEq(job.buyer, funder);
        assertEq(job.provider, provider);
        assertEq(job.amount, PRICE);
        assertEq(usdc.balanceOf(address(escrow)), PRICE);
        assertEq(escrow.totalEscrowed(address(usdc)), PRICE);
    }

    function test_fundDirect_settlesLikeAnyJob() public {
        _direct(JOB, PRICE, _deadline());
        // The funder is the buyer: it may release at any time.
        vm.prank(funder);
        escrow.release(JOB, RESULT);
        assertEq(usdc.balanceOf(provider), PRICE);
        assertEq(registry.completed(provider), 1);

        bytes32 job2 = keccak256("job-2");
        uint40 deadline = _deadline();
        _direct(job2, PRICE, deadline);
        vm.warp(deadline + 1);
        escrow.refund(job2);
        assertEq(usdc.balanceOf(funder), 100e6 - PRICE);
    }

    function test_fundDirect_onlyAllowlisted() public {
        usdc.mint(stranger, 10e6);
        vm.startPrank(stranger);
        usdc.approve(address(escrow), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.NotFunder.selector, stranger));
        escrow.fundDirect(JOB, provider, address(usdc), PRICE, _deadline());
        vm.stopPrank();

        vm.prank(owner);
        escrow.setFunder(funder, false);
        vm.prank(funder);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.NotFunder.selector, funder));
        escrow.fundDirect(JOB, provider, address(usdc), PRICE, _deadline());
    }

    function test_fundDirect_setFunderGuards() public {
        vm.expectEmit(address(escrow));
        emit XorvEscrow.FunderUpdated(stranger, true);
        vm.prank(owner);
        escrow.setFunder(stranger, true);
        assertTrue(escrow.funderAllowed(stranger));
        vm.prank(owner);
        vm.expectRevert(XorvEscrow.ZeroAddress.selector);
        escrow.setFunder(address(0), true);
    }

    function test_fundDirect_sameValidationsAsFund() public {
        uint40 deadline = _deadline();
        vm.startPrank(funder);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.InvalidAmount.selector, 0));
        escrow.fundDirect(JOB, provider, address(usdc), 0, deadline);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.AmountAboveCap.selector, CAP + 1, CAP));
        escrow.fundDirect(JOB, provider, address(usdc), CAP + 1, deadline);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.InvalidParties.selector, funder, funder));
        escrow.fundDirect(JOB, funder, address(usdc), PRICE, deadline);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.InvalidParties.selector, funder, address(0)));
        escrow.fundDirect(JOB, address(0), address(usdc), PRICE, deadline);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.TokenNotAllowed.selector, stranger));
        escrow.fundDirect(JOB, provider, stranger, PRICE, deadline);
        uint40 tooSoon = uint40(block.timestamp + 30);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.InvalidDeadline.selector, tooSoon));
        escrow.fundDirect(JOB, provider, address(usdc), PRICE, tooSoon);
        uint40 tooLate = uint40(block.timestamp + 8 days);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.InvalidDeadline.selector, tooLate));
        escrow.fundDirect(JOB, provider, address(usdc), PRICE, tooLate);
        escrow.fundDirect(JOB, provider, address(usdc), PRICE, deadline);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.JobExists.selector, JOB));
        escrow.fundDirect(JOB, provider, address(usdc), PRICE, deadline);
        vm.stopPrank();
    }

    function test_fundDirect_cannotSquatOnABrokerJob() public {
        // A broker job funded by signature first: a funder can't reuse its id, and vice versa.
        _fund(JOB, PRICE);
        vm.prank(funder);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.JobExists.selector, JOB));
        escrow.fundDirect(JOB, provider, address(usdc), PRICE, _deadline());
    }

    function test_fundDirect_blockedWhenPaused() public {
        vm.prank(owner);
        escrow.pause();
        vm.prank(funder);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.fundDirect(JOB, provider, address(usdc), PRICE, _deadline());
    }

    function test_fundDirect_rejectsFeeOnTransfer() public {
        usdc.setTransferFeeBps(100);
        vm.prank(funder);
        vm.expectRevert(
            abi.encodeWithSelector(XorvEscrow.AmountMismatch.selector, PRICE, PRICE - PRICE / 100)
        );
        escrow.fundDirect(JOB, provider, address(usdc), PRICE, _deadline());
    }

    function test_fundDirect_respectsIdentityGate() public {
        MockGate gate = new MockGate();
        vm.prank(owner);
        escrow.setIdentityGate(address(gate));
        gate.set(provider, true);
        vm.prank(funder);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.IdentityNotVerified.selector, funder));
        escrow.fundDirect(JOB, provider, address(usdc), PRICE, _deadline());
        gate.set(funder, true);
        _direct(JOB, PRICE, _deadline());
    }
}

contract MockGate {
    mapping(address => bool) public isVerified;

    function set(address a, bool v) external {
        isVerified[a] = v;
    }
}
