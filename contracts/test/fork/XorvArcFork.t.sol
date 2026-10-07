// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {XorvEscrow} from "../../src/XorvEscrow.sol";
import {XorvReputation} from "../../src/XorvReputation.sol";
import {IIdentityRegistry8004} from "../../src/interfaces/IIdentityRegistry8004.sol";
import {IReputationRegistry8004} from "../../src/interfaces/IReputationRegistry8004.sol";
import {ArcForkBase} from "./ArcForkBase.sol";

interface IUsdcMeta {
    function name() external view returns (string memory);
    function version() external view returns (string memory);
    function decimals() external view returns (uint8);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/**
 * The escrow and XorvReputation against Arc testnet's real contracts: Circle's
 * USDC (EIP-3009 signed exactly as a wallet signs it) and the real ERC-8004
 * Identity and Reputation Registries. Nothing here is mocked.
 */
contract XorvArcForkTest is ArcForkBase {
    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    uint256 internal constant BUYER_KEY = 0xB0B5;
    uint256 internal constant PRICE = 1_500_000; // 1.50 USDC

    IIdentityRegistry8004 internal identity = IIdentityRegistry8004(IDENTITY);
    IReputationRegistry8004 internal reputation = IReputationRegistry8004(REPUTATION);
    XorvReputation internal rep;
    XorvEscrow internal escrow;
    address internal attester = makeAddr("xorv-broker");
    address internal provider = makeAddr("xorv-provider");
    address internal buyer;
    uint256 internal agentId;

    function setUp() public override {
        super.setUp();
        buyer = vm.addr(BUYER_KEY);
        rep = new XorvReputation(IDENTITY, REPUTATION, address(this));
        address[] memory tokens = new address[](1);
        tokens[0] = USDC;
        escrow = new XorvEscrow(address(this), attester, address(rep), tokens, 100e6);
        rep.setEscrow(address(escrow));

        // The provider registers a real ERC-8004 agent; its verified wallet defaults to the registrant.
        vm.prank(provider);
        agentId = identity.register("https://xorv.example/agents/fork-provider.json");
        assertEq(identity.getAgentWallet(agentId), provider);
        rep.bind(agentId);

        _giveUsdc(buyer, 10e6);
    }

    function test_fork_usdcDomainIsUsdcV2() public view {
        IUsdcMeta u = IUsdcMeta(USDC);
        assertEq(u.name(), "USDC");
        assertEq(u.version(), "2");
        assertEq(u.decimals(), 6);
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("USDC"),
                keccak256("2"),
                uint256(5042002),
                USDC
            )
        );
        assertEq(u.DOMAIN_SEPARATOR(), expected);
        assertEq(expected, 0x361191522483d32a83e70ae7183b4b9629442c13a78bc9921d6f707911c8c6b0);
    }

    function test_fork_nativeBalanceIsTheErc20Balance() public {
        address a = makeAddr("anyone");
        vm.deal(a, 3e18); // 3 USDC as the 18-decimal native balance
        assertEq(IERC20(USDC).balanceOf(a), 3e6);
        vm.prank(a);
        IERC20(USDC).transfer(provider, 1e6);
        assertEq(a.balance, 2e18);
        assertEq(IERC20(USDC).balanceOf(provider), 1e6);
    }

    function _signedFunding(bytes32 jobId) internal view returns (XorvEscrow.Funding memory f) {
        f.jobId = jobId;
        f.buyer = buyer;
        f.provider = provider;
        f.token = USDC;
        f.amount = PRICE;
        f.deadline = uint40(block.timestamp + 30 minutes);
        f.validBefore = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_TYPEHASH, buyer, address(escrow), PRICE, 0, f.validBefore, escrow.fundingNonce(jobId, f.deadline)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IUsdcMeta(USDC).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_KEY, digest);
        f.signature = abi.encodePacked(r, s, v);
    }

    function _fund(bytes32 jobId) internal {
        XorvEscrow.Funding memory f = _signedFunding(jobId);
        vm.prank(attester);
        escrow.fund(f);
    }

    function test_fork_releaseWritesRealErc8004Feedback() public {
        bytes32 jobId = keccak256("arc-fork-job-1");
        _fund(jobId);
        assertEq(IERC20(USDC).balanceOf(address(escrow)), PRICE, "escrowed");
        assertEq(IERC20(USDC).balanceOf(buyer), 10e6 - PRICE, "buyer debited");

        vm.prank(attester);
        escrow.release(jobId, keccak256("the result"));
        assertEq(IERC20(USDC).balanceOf(provider), PRICE, "provider paid");

        // Read it back from the real Reputation Registry: client = XorvReputation.
        assertEq(reputation.getLastIndex(agentId, address(rep)), 1);
        (int128 value, uint8 decimals, string memory tag1, string memory tag2, bool revoked) =
            reputation.readFeedback(agentId, address(rep), 1);
        assertEq(value, 100);
        assertEq(decimals, 0);
        assertEq(tag1, "successRate");
        assertEq(tag2, "xorv-escrow");
        assertFalse(revoked);
        address[] memory clients = reputation.getClients(agentId);
        assertEq(clients.length, 1);
        assertEq(clients[0], address(rep));
        address[] memory only = new address[](1);
        only[0] = address(rep);
        (uint64 count, int128 summary,) = reputation.getSummary(agentId, only, "successRate", "xorv-escrow");
        assertEq(count, 1);
        assertEq(summary, 100);

        (uint64 completed,, uint256 earned,) = rep.stats(provider);
        assertEq(completed, 1);
        assertEq(earned, PRICE);
    }

    function test_fork_attesterRefundWritesZero() public {
        bytes32 jobId = keccak256("arc-fork-job-2");
        _fund(jobId);
        vm.prank(attester);
        escrow.refund(jobId);
        assertEq(IERC20(USDC).balanceOf(buyer), 10e6, "buyer refunded in full");
        (int128 value,, string memory tag1,,) = reputation.readFeedback(agentId, address(rep), 1);
        assertEq(value, 0);
        assertEq(tag1, "successRate");
        assertEq(rep.score(provider), 3333);
    }

    /// The worst case for the escrow's REGISTRY_GAS_LIMIT: a provider's first outcome and this
    /// client's first feedback for the agent on the real registry.
    function test_fork_measureFirstFeedbackGas() public {
        vm.prank(address(escrow));
        uint256 g = gasleft();
        rep.recordOutcome(keccak256("gas-probe"), provider, true, PRICE);
        uint256 first = g - gasleft();

        vm.prank(address(escrow));
        g = gasleft();
        rep.recordOutcome(keccak256("gas-probe-2"), provider, false, 0);
        uint256 second = g - gasleft();

        emit log_named_uint("recordOutcome gas, first feedback (real ERC-8004)", first);
        emit log_named_uint("recordOutcome gas, later feedback (real ERC-8004)", second);
        assertEq(reputation.getLastIndex(agentId, address(rep)), 2, "both written");
        assertLt(first, escrow.REGISTRY_GAS_LIMIT(), "budget too small");
    }

    /// End to end with the gas an estimator would pick: the release must never succeed without
    /// the feedback write.
    function test_fork_releaseNeverSkipsFeedbackAtAnyGasLimit() public {
        bytes32 jobId = keccak256("arc-fork-job-3");
        _fund(jobId);
        for (uint256 gl = 100_000; gl < 1_200_000; gl += 20_000) {
            vm.prank(attester);
            (bool ok,) = address(escrow).call{gas: gl}(abi.encodeCall(XorvEscrow.release, (jobId, bytes32(0))));
            if (ok) {
                emit log_named_uint("smallest successful release gas", gl);
                assertEq(reputation.getLastIndex(agentId, address(rep)), 1, "released without feedback");
                return;
            }
        }
        revert("release never succeeded");
    }
}
