// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title LearningRootOracle
 * @dev Stores Merkle roots per cycle for off-chain signal verification.
 *      UUPS-upgradeable.
 *
 * Storage layout (DO NOT reorder):
 *   Own state vars must only be appended for upgrade safety.
 */
contract LearningRootOracle is Initializable, UUPSUpgradeable {
    // ── Ownership ─────────────────────────────────────────────────────────────
    address private _owner;

    modifier onlyOwner() {
        require(msg.sender == _owner, "Ownable: not owner");
        _;
    }

    function owner() public view returns (address) { return _owner; }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "LearningRootOracle: zero owner");
        emit OwnershipTransferred(_owner, newOwner);
        _owner = newOwner;
    }

    // ── State ─────────────────────────────────────────────────────────────────
    bool public paused;

    struct CycleRoot {
        bytes32 root;
        uint64 submittedAt;
        bool exists;
    }

    // seasonKey => cycleKey => root
    mapping(bytes32 => mapping(bytes32 => CycleRoot)) public cycleRoots;
    // seasonKey => latest cycle count submitted
    mapping(bytes32 => uint256) public seasonCycleCount;

    // ── Events ────────────────────────────────────────────────────────────────
    event CycleRootSubmitted(string indexed seasonId, string indexed cycleId, bytes32 indexed cycleRoot);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    modifier whenNotPaused() {
        require(!paused, "LearningRootOracle: paused");
        _;
    }

    // ── Proxy setup ───────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialOwner) public initializer {
        require(initialOwner != address(0), "LearningRootOracle: zero owner");
        emit OwnershipTransferred(address(0), initialOwner);
        _owner = initialOwner;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ── Functions ─────────────────────────────────────────────────────────────

    function submitCycleRoot(
        string calldata seasonId,
        string calldata cycleId,
        bytes32 cycleRoot
    ) external onlyOwner whenNotPaused {
        bytes32 seasonKey = keccak256(abi.encodePacked(seasonId));
        bytes32 cycleKey = keccak256(abi.encodePacked(cycleId));
        require(!cycleRoots[seasonKey][cycleKey].exists, "LearningRootOracle: cycle exists");

        cycleRoots[seasonKey][cycleKey] = CycleRoot({
            root: cycleRoot,
            submittedAt: uint64(block.timestamp),
            exists: true
        });
        seasonCycleCount[seasonKey] += 1;
        emit CycleRootSubmitted(seasonId, cycleId, cycleRoot);
    }

    function hasCycleRoot(
        string calldata seasonId,
        string calldata cycleId
    ) external view returns (bool) {
        bytes32 seasonKey = keccak256(abi.encodePacked(seasonId));
        bytes32 cycleKey = keccak256(abi.encodePacked(cycleId));
        return cycleRoots[seasonKey][cycleKey].exists;
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }
}
