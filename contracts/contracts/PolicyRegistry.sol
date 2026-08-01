// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title AEGIS PolicyRegistry
/// @notice Seals the hash of the active spending policy on-chain so that a
///         compromised server can never silently rewrite the limits: the truth
///         about what the agent was allowed to spend is on the chain.
contract PolicyRegistry {
    address public owner;

    bytes32 public latestHash;
    uint256 public sealedBlock;
    uint256 public sealedAt;
    string public latestUri;

    event PolicySealed(bytes32 indexed policyHash, string uri, uint256 blockNumber, uint256 timestamp);
    event OwnerChanged(address previous, address next);

    modifier onlyOwner() {
        require(msg.sender == owner, "PolicyRegistry: not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function sealPolicy(bytes32 policyHash, string calldata uri) external onlyOwner {
        require(policyHash != bytes32(0), "PolicyRegistry: empty hash");
        latestHash = policyHash;
        latestUri = uri;
        sealedBlock = block.number;
        sealedAt = block.timestamp;
        emit PolicySealed(policyHash, uri, block.number, block.timestamp);
    }

    function setOwner(address next) external onlyOwner {
        require(next != address(0), "PolicyRegistry: zero owner");
        emit OwnerChanged(owner, next);
        owner = next;
    }

    /// @dev (policyHash, sealedBlock, sealedAt, uri) of the newest sealed policy.
    function latest() external view returns (bytes32, uint256, uint256, string memory) {
        return (latestHash, sealedBlock, sealedAt, latestUri);
    }
}
