// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * Stands in for both halves of Circle CCTP V2 in a one-chain Chainlink Local
 * test: `depositForBurn` takes the tokens (the burn on the source chain) and,
 * unless deferred, hands `amount - fee` to the mint recipient at once (the
 * mint on Arc). `fee` is a configurable fast-transfer fee, capped by the
 * caller's `maxFee` as CCTP does. Deferred, mints wait for `releaseAll`, so a
 * test can deliver the CCIP message before the dollars.
 */
contract MockTokenMessengerV2 {
    struct Mint {
        address to;
        uint256 amount;
    }

    IERC20 public immutable token;
    bool public deferred;
    uint256 public fee;
    Mint[] public pending;
    uint32 public lastDestinationDomain;
    uint32 public lastMinFinality;
    uint256 public lastMaxFee;
    bytes32 public lastDestinationCaller;
    bytes32 public lastMintRecipient;
    uint256 public lastAmount;

    constructor(IERC20 _token) {
        token = _token;
    }

    function setDeferred(bool d) external {
        deferred = d;
    }

    function setFee(uint256 f) external {
        fee = f;
    }

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external {
        require(burnToken == address(token), "wrong token");
        require(fee <= maxFee, "fee above maxFee");
        token.transferFrom(msg.sender, address(this), amount);
        lastAmount = amount;
        lastDestinationDomain = destinationDomain;
        lastMinFinality = minFinalityThreshold;
        lastMaxFee = maxFee;
        lastDestinationCaller = destinationCaller;
        lastMintRecipient = mintRecipient;
        address to = address(uint160(uint256(mintRecipient)));
        uint256 minted = amount - fee;
        if (deferred) pending.push(Mint(to, minted));
        else token.transfer(to, minted);
    }

    function releaseAll() external {
        for (uint256 i; i < pending.length; ++i) token.transfer(pending[i].to, pending[i].amount);
        delete pending;
    }
}
