// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";

import {XorvEscrow} from "../../src/XorvEscrow.sol";
import {XorvReputation} from "../../src/XorvReputation.sol";
import {XorvCcipReceiver} from "../../src/ccip/XorvCcipReceiver.sol";
import {XorvCcipIntent} from "../../src/ccip/XorvCcipIntent.sol";
import {ITokenMessengerV2} from "../../src/interfaces/ITokenMessengerV2.sol";
import {ArcForkBase} from "./ArcForkBase.sol";

/**
 * Chainlink CCIP and Circle CCTP V2 on Arc testnet, for real:
 *  - Chainlink's Arc testnet router serves the Base Sepolia and Ethereum Sepolia lanes,
 *    and quotes Arc -> Base Sepolia fees in native USDC;
 *  - XorvCcipReceiver accepts a delivery only from that router, then funds a real
 *    escrow job in Arc's real USDC;
 *  - a provider withdraws earnings off Arc with the real TokenMessengerV2.
 */
contract XorvCcipArcForkTest is ArcForkBase {
    function test_fork_routerServesXorvLanes() public view {
        IRouterClient router = IRouterClient(CCIP_ROUTER);
        assertTrue(router.isChainSupported(BASE_SEPOLIA), "Base Sepolia lane");
        assertTrue(router.isChainSupported(ETHEREUM_SEPOLIA), "Ethereum Sepolia lane");
    }

    function test_fork_feeQuoteInNativeUsdc() public {
        Client.EVM2AnyMessage memory m = Client.EVM2AnyMessage({
            receiver: abi.encode(address(0xBEEF)),
            data: XorvCcipIntent.release(keccak256("job"), address(this), keccak256("result")),
            tokenAmounts: new Client.EVMTokenAmount[](0),
            extraArgs: Client._argsToBytes(Client.GenericExtraArgsV2({gasLimit: 700_000, allowOutOfOrderExecution: true})),
            feeToken: address(0)
        });
        uint256 toBase = IRouterClient(CCIP_ROUTER).getFee(BASE_SEPOLIA, m);
        uint256 toEth = IRouterClient(CCIP_ROUTER).getFee(ETHEREUM_SEPOLIA, m);
        emit log_named_decimal_uint("Arc -> Base Sepolia CCIP fee (native USDC, 18 dec)", toBase, 18);
        emit log_named_decimal_uint("Arc -> Ethereum Sepolia CCIP fee (native USDC, 18 dec)", toEth, 18);
        assertGt(toBase, 0);
        assertLt(toBase, 5e18, "a few dollars at most");
        assertGt(toEth, 0);
    }

    function test_fork_receiverOnlyAcceptsTheRealRouter_andFundsARealJob() public {
        XorvReputation rep = new XorvReputation(IDENTITY, REPUTATION, address(this));
        address[] memory tokens = new address[](1);
        tokens[0] = USDC;
        XorvEscrow escrow = new XorvEscrow(address(this), makeAddr("broker"), address(rep), tokens, 100e6);
        rep.setEscrow(address(escrow));
        XorvCcipReceiver receiver = new XorvCcipReceiver(CCIP_ROUTER, address(escrow), USDC, address(this));
        escrow.setFunder(address(receiver), true);
        address senderOnBase = makeAddr("XorvCcipSender on Base Sepolia");
        receiver.allowSender(BASE_SEPOLIA, senderOnBase, true);
        assertEq(receiver.getRouter(), CCIP_ROUTER);

        address requester = makeAddr("buyer agent");
        address provider = makeAddr("provider");
        bytes32 jobId = keccak256("fork-ccip-job");
        Client.Any2EVMMessage memory m = Client.Any2EVMMessage({
            messageId: keccak256("ccip-message"),
            sourceChainSelector: BASE_SEPOLIA,
            sender: abi.encode(senderOnBase),
            data: XorvCcipIntent.postJob(jobId, requester, provider, 2e6, uint40(block.timestamp + 1 hours)),
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });

        vm.expectRevert();
        receiver.ccipReceive(m); // not the router

        // The CCTP mint lands first (simulated by the Arc way of crediting USDC), then the router delivers.
        _giveUsdc(address(receiver), 2e6);
        vm.prank(CCIP_ROUTER);
        receiver.ccipReceive(m);
        assertEq(uint8(receiver.getIntent(jobId).status), uint8(XorvCcipReceiver.Status.Funded));
        assertEq(IERC20(USDC).balanceOf(address(escrow)), 2e6);
        assertEq(escrow.getJob(jobId).buyer, address(receiver));
    }

    /// "Providers withdraw earnings to any chain": a provider burns USDC on Arc with Circle's
    /// real TokenMessengerV2, minted to them on Base Sepolia (CCTP domain 6).
    function test_fork_providerWithdrawsToBaseSepoliaWithCctpV2() public {
        address provider = makeAddr("provider withdrawing");
        _giveUsdc(provider, 10e6);
        uint256 amount = 4e6;
        ITokenMessengerV2 tm = ITokenMessengerV2(TOKEN_MESSENGER_V2);

        vm.startPrank(provider);
        IERC20(USDC).approve(TOKEN_MESSENGER_V2, amount);
        vm.recordLogs();
        tm.depositForBurn(
            amount, BASE_SEPOLIA_CCTP_DOMAIN, bytes32(uint256(uint160(provider))), USDC, bytes32(0), 0, 2000
        );
        vm.stopPrank();

        assertEq(IERC20(USDC).balanceOf(provider), 6e6, "debited on Arc");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == TOKEN_MESSENGER_V2 && logs[i].topics[0] == ITokenMessengerV2.DepositForBurn.selector) {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), USDC, "burnToken");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), provider, "depositor");
                (uint256 amt, bytes32 mintRecipient, uint32 domain,,,,) =
                    abi.decode(logs[i].data, (uint256, bytes32, uint32, bytes32, bytes32, uint256, bytes));
                assertEq(amt, amount);
                assertEq(mintRecipient, bytes32(uint256(uint160(provider))));
                assertEq(domain, BASE_SEPOLIA_CCTP_DOMAIN);
                found = true;
            }
        }
        assertTrue(found, "DepositForBurn emitted");
    }
}
