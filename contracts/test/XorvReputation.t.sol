// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {XorvEscrow} from "../src/XorvEscrow.sol";
import {XorvReputation} from "../src/XorvReputation.sol";
import {MockERC3009} from "./mocks/MockERC3009.sol";
import {MockIdentityRegistry, MockReputationRegistry} from "./mocks/MockERC8004.sol";

/// XorvReputation wired to a real XorvEscrow, against mock ERC-8004 registries.
/// (test/fork/XorvArcFork.t.sol runs the same flow against Arc testnet's real registries.)
contract XorvReputationTest is Test {
    MockIdentityRegistry internal identity;
    MockReputationRegistry internal reputation;
    XorvReputation internal rep;
    XorvEscrow internal escrow;
    MockERC3009 internal usdc;

    address internal owner = makeAddr("owner");
    address internal attester = makeAddr("attester");
    address internal funder = makeAddr("funder");
    address internal provider = makeAddr("provider");
    address internal stranger = makeAddr("stranger");
    uint256 internal agentId;

    uint256 internal constant PRICE = 2e6;
    uint256 internal nonce;

    function setUp() public {
        vm.warp(1_800_000_000);
        identity = new MockIdentityRegistry();
        reputation = new MockReputationRegistry(identity);
        rep = new XorvReputation(address(identity), address(reputation), owner);
        usdc = new MockERC3009("USDC", "2");
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        escrow = new XorvEscrow(owner, attester, address(rep), tokens, 100e6);
        vm.startPrank(owner);
        rep.setEscrow(address(escrow));
        escrow.setFunder(funder, true);
        vm.stopPrank();

        usdc.mint(funder, 1_000e6);
        vm.prank(funder);
        usdc.approve(address(escrow), type(uint256).max);

        vm.prank(provider);
        agentId = identity.register("ipfs://agent");
        // Push the id past 0 so "agentId 0" bugs can't hide.
        if (agentId == 0) {
            vm.prank(provider);
            agentId = identity.register("ipfs://agent-2");
        }
    }

    function _job() internal returns (bytes32 jobId) {
        jobId = keccak256(abi.encode("job", nonce++));
        vm.prank(funder);
        escrow.fundDirect(jobId, provider, address(usdc), PRICE, uint40(block.timestamp + 1 hours));
    }

    function _release() internal returns (bytes32 jobId) {
        jobId = _job();
        vm.prank(attester);
        escrow.release(jobId, keccak256("result"));
    }

    function _fail() internal returns (bytes32 jobId) {
        jobId = _job();
        vm.prank(attester);
        escrow.refund(jobId);
    }

    // -----------------------------------------------------------------
    // bind
    // -----------------------------------------------------------------

    function test_bind_mapsTheAgentWallet() public {
        (bool bound,) = rep.agentOf(provider);
        assertFalse(bound);
        vm.expectEmit(address(rep));
        emit XorvReputation.AgentBound(provider, agentId);
        vm.prank(stranger); // permissionless
        rep.bind(agentId);
        uint256 id;
        (bound, id) = rep.agentOf(provider);
        assertTrue(bound);
        assertEq(id, agentId);
        assertTrue(rep.isLive(provider));
    }

    function test_bind_agentIdZeroWorks() public {
        // agentId 0 is a real ERC-8004 id: the +1 encoding must keep it distinct from "unbound".
        MockIdentityRegistry id2 = new MockIdentityRegistry();
        XorvReputation r2 = new XorvReputation(address(id2), address(new MockReputationRegistry(id2)), owner);
        vm.prank(provider);
        assertEq(id2.register(""), 0);
        r2.bind(0);
        (bool bound, uint256 a) = r2.agentOf(provider);
        assertTrue(bound);
        assertEq(a, 0);
    }

    function test_bind_rejectsUnknownOrClearedAgent() public {
        vm.expectRevert(abi.encodeWithSelector(XorvReputation.NoAgentWallet.selector, 999));
        rep.bind(999);
        vm.prank(provider);
        identity.transfer(agentId, stranger); // ERC-8004 clears the wallet on transfer
        vm.expectRevert(abi.encodeWithSelector(XorvReputation.NoAgentWallet.selector, agentId));
        rep.bind(agentId);
    }

    function test_bind_refusesAnAgentItOperates() public {
        vm.prank(provider);
        identity.approveOperator(agentId, address(rep));
        vm.expectRevert(abi.encodeWithSelector(XorvReputation.SelfAuthorized.selector, agentId));
        rep.bind(agentId);
    }

    function test_bind_onlyTheWalletMovesALiveBinding() public {
        rep.bind(agentId);
        vm.prank(provider);
        uint256 other = identity.register("ipfs://second");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(XorvReputation.AlreadyBound.selector, provider, agentId));
        rep.bind(other);
        vm.prank(provider);
        rep.bind(other);
        (, uint256 id) = rep.agentOf(provider);
        assertEq(id, other);
    }

    function test_bind_anyoneMayRebindAStaleBinding() public {
        rep.bind(agentId);
        vm.prank(provider);
        uint256 other = identity.register("ipfs://second");
        vm.prank(provider);
        identity.setAgentWallet(agentId, stranger); // the old agent now pays someone else
        vm.prank(stranger);
        rep.bind(other);
        (, uint256 id) = rep.agentOf(provider);
        assertEq(id, other);
    }

    // -----------------------------------------------------------------
    // recordOutcome
    // -----------------------------------------------------------------

    function test_release_writesSuccessFeedback() public {
        rep.bind(agentId);
        bytes32 jobId = _job();
        vm.expectEmit(address(rep));
        emit XorvReputation.OutcomeRecorded(jobId, provider, agentId, true, PRICE, true);
        vm.prank(attester);
        escrow.release(jobId, keccak256("result"));

        assertEq(reputation.getLastIndex(agentId, address(rep)), 1);
        (int128 value, uint8 dec, string memory tag1, string memory tag2,) = reputation.readFeedback(agentId, address(rep), 1);
        assertEq(value, 100);
        assertEq(dec, 0);
        assertEq(tag1, "successRate");
        assertEq(tag2, "xorv-escrow");
        assertEq(reputation.hashOf(agentId, address(rep), 1), jobId);
    }

    function test_attesterRefund_writesZero() public {
        rep.bind(agentId);
        bytes32 jobId = _fail();
        (int128 value,,,,) = reputation.readFeedback(agentId, address(rep), 1);
        assertEq(value, 0);
        assertEq(reputation.hashOf(agentId, address(rep), 1), jobId);
        (uint64 completed, uint64 failed,,) = rep.stats(provider);
        assertEq(completed, 0);
        assertEq(failed, 1);
    }

    function test_reassign_writesZeroForThePreviousProvider() public {
        rep.bind(agentId);
        bytes32 jobId = _job();
        vm.prank(attester);
        escrow.reassign(jobId, makeAddr("provider2"));
        (int128 value,,,,) = reputation.readFeedback(agentId, address(rep), 1);
        assertEq(value, 0);
    }

    function test_timeoutRefundAndCancel_writeNothing() public {
        rep.bind(agentId);
        bytes32 a = _job();
        vm.prank(attester);
        escrow.cancel(a);
        bytes32 b = _job();
        vm.warp(block.timestamp + 2 hours);
        escrow.refund(b);
        assertEq(reputation.getLastIndex(agentId, address(rep)), 0);
        (uint64 completed, uint64 failed,,) = rep.stats(provider);
        assertEq(completed + failed, 0);
    }

    function test_unboundProvider_countsButWritesNoFeedback() public {
        bytes32 jobId = _job();
        vm.expectEmit(address(rep));
        emit XorvReputation.OutcomeRecorded(jobId, provider, 0, true, PRICE, false);
        vm.prank(attester);
        escrow.release(jobId, keccak256("result"));
        (uint64 completed,, uint256 earned, uint40 lastJobAt) = rep.stats(provider);
        assertEq(completed, 1);
        assertEq(earned, PRICE);
        assertEq(lastJobAt, block.timestamp);
        assertEq(reputation.getLastIndex(agentId, address(rep)), 0);
    }

    function test_soldAgent_stopsCollectingFeedback() public {
        rep.bind(agentId);
        _release();
        vm.prank(provider);
        identity.transfer(agentId, stranger);
        assertFalse(rep.isLive(provider));
        _release();
        assertEq(reputation.getLastIndex(agentId, address(rep)), 1);
        (uint64 completed,,,) = rep.stats(provider);
        assertEq(completed, 2);
    }

    function test_brokenRegistry_neverBlocksPayment() public {
        rep.bind(agentId);
        reputation.setBroken(true);
        bytes32 jobId = _job();
        vm.expectEmit(address(rep));
        emit XorvReputation.OutcomeRecorded(jobId, provider, agentId, true, PRICE, false);
        vm.prank(attester);
        escrow.release(jobId, keccak256("result"));
        assertEq(usdc.balanceOf(provider), PRICE);
        (uint64 completed,,,) = rep.stats(provider);
        assertEq(completed, 1);
    }

    function test_operatorApprovedLater_feedbackFailsGracefully() public {
        rep.bind(agentId);
        vm.prank(provider);
        identity.approveOperator(agentId, address(rep));
        _release();
        assertEq(usdc.balanceOf(provider), PRICE);
        assertEq(reputation.getLastIndex(agentId, address(rep)), 0);
    }

    function test_onlyEscrowReports() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(XorvReputation.NotEscrow.selector, stranger));
        rep.recordOutcome(bytes32(0), provider, true, 1);
    }

    function test_score_isLaplaceSmoothed() public {
        assertEq(rep.score(provider), 5000);
        _release();
        _release();
        _release();
        _fail();
        // (3+1)*10000/(3+1+2)
        assertEq(rep.score(provider), 6666);
    }

    // -----------------------------------------------------------------
    // Gas: the escrow's budget must cover the worst case
    // -----------------------------------------------------------------

    function test_firstFeedbackFitsTheEscrowBudget() public {
        rep.bind(agentId);
        bytes32 jobId = _job();
        vm.prank(address(escrow));
        uint256 g = gasleft();
        rep.recordOutcome(jobId, provider, true, PRICE);
        uint256 used = g - gasleft();
        emit log_named_uint("recordOutcome (mock registry), first feedback", used);
        assertLt(used, escrow.REGISTRY_GAS_LIMIT());
    }

    // -----------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------

    function test_admin() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        rep.setEscrow(stranger);
        vm.prank(owner);
        vm.expectRevert(XorvReputation.RenounceDisabled.selector);
        rep.renounceOwnership();
        vm.expectRevert(XorvReputation.ZeroAddress.selector);
        new XorvReputation(address(0), address(reputation), owner);
    }
}
