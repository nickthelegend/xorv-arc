// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IXorvOutcomeSink} from "../../src/interfaces/IXorvOutcomeSink.sol";

/// Records what the escrow reports, and can be told to misbehave.
contract MockRegistry is IXorvOutcomeSink {
    enum Mode {
        Ok,
        Revert,
        BurnGas,
        /// Burns 250k gas before its storage writes: well above a plain record, still inside the
        /// escrow's 400k budget (the size of XorvReputation's first ERC-8004 feedback write).
        Expensive
    }

    Mode public mode;
    address public escrow;

    struct Outcome {
        bytes32 jobId;
        address provider;
        bool success;
        uint256 amount;
    }

    Outcome[] public outcomes;
    mapping(address => uint64) public completed;
    mapping(address => uint64) public failed;

    function setMode(Mode m) external {
        mode = m;
    }

    function setEscrow(address e) external {
        escrow = e;
    }

    function outcomeCount() external view returns (uint256) {
        return outcomes.length;
    }

    function recordOutcome(bytes32 jobId, address provider, bool success, uint256 amount) external {
        if (mode == Mode.Revert) revert("registry down");
        if (mode == Mode.BurnGas) {
            while (true) {}
        }
        if (mode == Mode.Expensive) {
            uint256 target = gasleft() - 250_000;
            while (gasleft() > target) {}
        }
        require(escrow == address(0) || msg.sender == escrow, "not escrow");
        outcomes.push(Outcome(jobId, provider, success, amount));
        if (success) completed[provider]++;
        else failed[provider]++;
    }
}

/// A smart-contract wallet that approves any hash its owner signed (ERC-1271).
contract MockSmartWallet {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        (uint8 v, bytes32 r, bytes32 s) = abi.decode(signature, (uint8, bytes32, bytes32));
        return ecrecover(hash, v, r, s) == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
