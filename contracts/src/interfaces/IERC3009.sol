// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * The slice of EIP-3009 ("Transfer With Authorization") that XorvEscrow uses.
 *
 * Circle's USDC implements it (FiatTokenV2_2; on Arc, the ERC-20 view of the
 * native gas balance at 0x3600…0000, EIP-712 domain "USDC" version "2"). The
 * `bytes signature` overloads are used rather than `(v, r, s)` because they
 * also accept ERC-1271 signatures, so a buyer paying from a smart-contract
 * wallet works with no extra code.
 */
interface IERC3009 {
    /**
     * Pull `value` from `from` into `to`, authorized by `from`'s signature over
     * an EIP-712 `ReceiveWithAuthorization` message.
     *
     * Unlike `transferWithAuthorization`, the token requires `msg.sender == to`.
     * That is the property escrow depends on: an authorization naming the
     * escrow as payee can only ever be executed *by* the escrow, so it cannot
     * be front-run into a bare transfer that lands funds without a job.
     */
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;

    /// True once `nonce` has been used or cancelled by `authorizer`.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}
