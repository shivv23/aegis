// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title AEGIS Guardian
/// @notice On-chain mirror of the wallet-layer Policy Guard. The API proposes,
///         the chain enforces: per-tx cap, allowlist, daily limit, velocity and
///         a one-way kill switch that no compromised agent can remove.
contract Guardian {
    address public immutable owner;

    bool public paused;
    uint256 public perTxCap;
    uint256 public dailyLimit;
    uint256 public velocityWindow;
    uint256 public velocityMax;

    /// @dev keccak256 of the active policy document (mirrored from PolicyRegistry).
    bytes32 public policyHash;

    uint256 public allowlistSize;
    mapping(address => bool) public allowlisted;

    /// @dev daily spent per payee, bucketed by calendar day (UTC).
    mapping(uint256 => mapping(address => uint256)) public dailySpent;

    /// @dev per-payee settlement timestamps for the rolling velocity check.
    mapping(address => uint256[]) private transferTimes;

    event TransferApproved(address indexed to, uint256 amount, string purpose, uint256 timestamp);
    event TransferBlocked(address indexed to, uint256 amount, string reason);
    event LimitsChanged(uint256 perTxCap, uint256 dailyLimit, uint256 velocityWindow, uint256 velocityMax);
    event AllowlistChanged(address indexed payee, bool allowed);
    event PolicySealed(bytes32 policyHash);
    event Revoked(address by);

    modifier onlyOwner() {
        require(msg.sender == owner, "Guardian: not owner");
        _;
    }

    constructor(uint256 _perTxCap, uint256 _dailyLimit, uint256 _velocityWindow, uint256 _velocityMax) {
        owner = msg.sender;
        perTxCap = _perTxCap;
        dailyLimit = _dailyLimit;
        velocityWindow = _velocityWindow;
        velocityMax = _velocityMax;
    }

    /// @dev Enforce every guard rule against a proposed transfer and record it.
    function execute(address to, uint256 amount, string calldata purpose) external {
        require(!paused, "Guardian: paused");
        require(to != address(0) && to != address(this), "Guardian: bad recipient");
        require(amount > 0, "Guardian: zero amount");
        require(amount <= perTxCap, "Guardian: over per-tx cap");
        require(allowlistSize == 0 || allowlisted[to], "Guardian: payee not allowlisted");

        uint256 day = block.timestamp / 86400;
        require(dailySpent[day][to] + amount <= dailyLimit, "Guardian: daily limit exceeded");

        _prune(to);
        require(transferTimes[to].length < velocityMax, "Guardian: velocity limit exceeded");

        dailySpent[day][to] += amount;
        transferTimes[to].push(block.timestamp);

        emit TransferApproved(to, amount, purpose, block.timestamp);
    }

    /// @dev One-way kill switch. Once revoked the guard never approves again.
    function revoke() external onlyOwner {
        paused = true;
        emit Revoked(msg.sender);
    }

    function setLimits(uint256 _perTxCap, uint256 _dailyLimit, uint256 _velocityWindow, uint256 _velocityMax) external onlyOwner {
        perTxCap = _perTxCap;
        dailyLimit = _dailyLimit;
        velocityWindow = _velocityWindow;
        velocityMax = _velocityMax;
        emit LimitsChanged(_perTxCap, _dailyLimit, _velocityWindow, _velocityMax);
    }

    function addAllowlist(address payee) external onlyOwner {
        if (!allowlisted[payee]) allowlistSize += 1;
        allowlisted[payee] = true;
        emit AllowlistChanged(payee, true);
    }

    function removeAllowlist(address payee) external onlyOwner {
        if (allowlisted[payee]) allowlistSize -= 1;
        allowlisted[payee] = false;
        emit AllowlistChanged(payee, false);
    }

    function setPolicyHash(bytes32 _policyHash) external onlyOwner {
        policyHash = _policyHash;
        emit PolicySealed(_policyHash);
    }

    /// @dev How many settled transfers each payee made inside the rolling window.
    function velocityCount(address to) external view returns (uint256) {
        uint256 cutoff = block.timestamp - velocityWindow;
        uint256[] storage times = transferTimes[to];
        uint256 count;
        for (uint256 i = 0; i < times.length; i++) {
            if (times[i] >= cutoff) count += 1;
        }
        return count;
    }

    function _prune(address to) private {
        uint256[] storage times = transferTimes[to];
        uint256 cutoff = block.timestamp - velocityWindow;
        uint256 keep = 0;
        for (uint256 i = 0; i < times.length; i++) {
            if (times[i] >= cutoff) times[keep++] = times[i];
        }
        while (times.length > keep) times.pop();
    }
}
