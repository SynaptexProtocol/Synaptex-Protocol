// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

interface IArenaVault {
    function setSeasonWeights(
        string calldata seasonId,
        string[] calldata agentIds,
        uint256[] calldata weightsWad
    ) external;
}

interface IAgentNFA {
    function tokenByAgentKey(bytes32 key) external view returns (uint256);
    function updateReputation(uint256 tokenId, uint256 scoreDelta) external;
}

/**
 * @title SeasonSettler
 * @dev Settlement coordinator: pushes vault weights and updates agent reputations.
 *      UUPS-upgradeable.
 *
 * Storage layout (DO NOT reorder):
 *   Own state vars must only be appended for upgrade safety.
 */
contract SeasonSettler is Initializable, UUPSUpgradeable {
    // ── Ownership ─────────────────────────────────────────────────────────────
    address private _owner;

    modifier onlyOwner() {
        require(msg.sender == _owner, "Ownable: not owner");
        _;
    }

    function owner() public view returns (address) { return _owner; }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "SeasonSettler: zero owner");
        emit OwnershipTransferred(_owner, newOwner);
        _owner = newOwner;
    }

    // ── State ─────────────────────────────────────────────────────────────────
    bool public paused;
    bool public vaultLocked;

    struct SeasonResult {
        bytes32 leaderboardHash;
        bytes32 merkleRoot;
        uint64 settledAt;
        bool exists;
    }

    IArenaVault public vault;
    IAgentNFA public agentNFA;
    mapping(bytes32 => SeasonResult) public resultsBySeason;

    // ── Events ────────────────────────────────────────────────────────────────
    event SeasonResultSubmitted(
        string indexed seasonId,
        bytes32 indexed leaderboardHash,
        bytes32 indexed merkleRoot
    );
    event VaultUpdated(address indexed vault);
    event AgentNFAUpdated(address indexed agentNFA);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event VaultLocked(address indexed by);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    modifier whenNotPaused() {
        require(!paused, "SeasonSettler: paused");
        _;
    }

    // ── Proxy setup ───────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address vaultAddress, address initialOwner) public initializer {
        require(vaultAddress != address(0), "SeasonSettler: zero vault");
        require(initialOwner != address(0), "SeasonSettler: zero owner");
        emit OwnershipTransferred(address(0), initialOwner);
        _owner = initialOwner;
        vault = IArenaVault(vaultAddress);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ── Admin ─────────────────────────────────────────────────────────────────

    function setVault(address vaultAddress) external onlyOwner {
        require(!vaultLocked, "SeasonSettler: vault locked");
        require(vaultAddress != address(0), "SeasonSettler: zero vault");
        vault = IArenaVault(vaultAddress);
        emit VaultUpdated(vaultAddress);
    }

    function setAgentNFA(address nfaAddress) external onlyOwner {
        agentNFA = IAgentNFA(nfaAddress);
        emit AgentNFAUpdated(nfaAddress);
    }

    function lockVault() external onlyOwner {
        vaultLocked = true;
        emit VaultLocked(msg.sender);
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ── Settlement ────────────────────────────────────────────────────────────

    /**
     * @notice Submit season result, push vault weights, and update agent reputations.
     * @param agentIds         Agent ID strings (must match NFA minted agentId keys).
     * @param weightsWad       Softmax settlement weights (WAD, same length as agentIds).
     * @param reputationDeltas Reputation score deltas per agent (WAD, same length).
     *                         Pass empty array to skip reputation updates.
     */
    function submitSeasonResult(
        string calldata seasonId,
        bytes32 leaderboardHash,
        bytes32 merkleRoot,
        string[] calldata agentIds,
        uint256[] calldata weightsWad,
        uint256[] calldata reputationDeltas
    ) external onlyOwner whenNotPaused {
        require(agentIds.length == weightsWad.length, "SeasonSettler: length mismatch");
        require(
            reputationDeltas.length == 0 || reputationDeltas.length == agentIds.length,
            "SeasonSettler: reputation length mismatch"
        );
        bytes32 s = _seasonKey(seasonId);
        require(!resultsBySeason[s].exists, "SeasonSettler: season already submitted");

        // CEI: write state before any external calls
        resultsBySeason[s] = SeasonResult({
            leaderboardHash: leaderboardHash,
            merkleRoot: merkleRoot,
            settledAt: uint64(block.timestamp),
            exists: true
        });

        vault.setSeasonWeights(seasonId, agentIds, weightsWad);

        // Update on-chain reputation if NFA contract is configured
        if (address(agentNFA) != address(0) && reputationDeltas.length == agentIds.length) {
            for (uint256 i = 0; i < agentIds.length; i++) {
                bytes32 key = keccak256(abi.encodePacked(agentIds[i]));
                uint256 tokenId = agentNFA.tokenByAgentKey(key);
                if (tokenId != 0) {
                    agentNFA.updateReputation(tokenId, reputationDeltas[i]);
                }
            }
        }

        emit SeasonResultSubmitted(seasonId, leaderboardHash, merkleRoot);
    }

    function _seasonKey(string memory seasonId) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(seasonId));
    }
}
