// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Ownable.sol";

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract ArenaVault is ArenaOwnable {
    uint256 public constant WAD = 1e18;
    uint256 public constant MAX_AGENTS_PER_SEASON = 256;
    bool public paused;
    bool private entered;

    IERC20 public immutable arenaToken;
    address public settler;
    bool public settlerLocked;

    mapping(bytes32 => mapping(bytes32 => uint256)) public totalStakeBySeasonAgent;
    mapping(bytes32 => mapping(bytes32 => mapping(address => uint256))) public userStakeBySeasonAgent;
    mapping(bytes32 => bytes32[]) private seasonAgents;
    mapping(bytes32 => mapping(bytes32 => bool)) private seasonAgentExists;
    mapping(bytes32 => uint256) public totalSeasonPool;

    mapping(bytes32 => bool) public seasonSettled;
    mapping(bytes32 => mapping(bytes32 => uint256)) public seasonWeightWad;
    mapping(bytes32 => mapping(address => bool)) public userClaimed;
    mapping(bytes32 => mapping(bytes32 => mapping(address => bool))) public userClaimedBySeasonAgent;

    event Staked(string indexed seasonId, string indexed agentId, address indexed user, uint256 amount);
    event SeasonSettled(string indexed seasonId);
    event Claimed(string indexed seasonId, address indexed user, uint256 amount);
    event ClaimedAgent(string indexed seasonId, string indexed agentId, address indexed user, uint256 amount);
    event SettlerUpdated(address indexed settler);
    event SettlerLocked(address indexed by);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    modifier onlySettler() {
        require(msg.sender == settler, "ArenaVault: not settler");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "ArenaVault: paused");
        _;
    }

    modifier nonReentrant() {
        require(!entered, "ArenaVault: reentrancy");
        entered = true;
        _;
        entered = false;
    }

    constructor(address token, address initialOwner) ArenaOwnable(initialOwner) {
        require(token != address(0), "ArenaVault: zero token");
        arenaToken = IERC20(token);
    }

    function setSettler(address newSettler) external onlyOwner {
        require(!settlerLocked, "ArenaVault: settler locked");
        require(newSettler != address(0), "ArenaVault: zero settler");
        settler = newSettler;
        emit SettlerUpdated(newSettler);
    }

    function lockSettler() external onlyOwner {
        settlerLocked = true;
        emit SettlerLocked(msg.sender);
    }

    function stake(string calldata seasonId, string calldata agentId, uint256 amount) external whenNotPaused nonReentrant {
        require(amount > 0, "ArenaVault: zero amount");
        bytes32 s = _seasonKey(seasonId);
        bytes32 a = _agentKey(agentId);
        require(!seasonSettled[s], "ArenaVault: season settled");

        bool ok = arenaToken.transferFrom(msg.sender, address(this), amount);
        require(ok, "ArenaVault: transferFrom failed");

        if (!seasonAgentExists[s][a]) {
            require(seasonAgents[s].length < MAX_AGENTS_PER_SEASON, "ArenaVault: too many agents");
            seasonAgentExists[s][a] = true;
            seasonAgents[s].push(a);
        }

        totalStakeBySeasonAgent[s][a] += amount;
        userStakeBySeasonAgent[s][a][msg.sender] += amount;
        totalSeasonPool[s] += amount;

        emit Staked(seasonId, agentId, msg.sender, amount);
    }

    function setSeasonWeights(
        string calldata seasonId,
        string[] calldata agentIds,
        uint256[] calldata weightsWad
    ) external onlySettler whenNotPaused {
        require(agentIds.length == weightsWad.length, "ArenaVault: length mismatch");
        bytes32 s = _seasonKey(seasonId);
        require(!seasonSettled[s], "ArenaVault: already settled");

        uint256 totalWeight;
        for (uint256 i = 0; i < agentIds.length; i++) {
            bytes32 a = _agentKey(agentIds[i]);
            if (!seasonAgentExists[s][a]) {
                require(seasonAgents[s].length < MAX_AGENTS_PER_SEASON, "ArenaVault: too many agents");
                seasonAgentExists[s][a] = true;
                seasonAgents[s].push(a);
            }
            seasonWeightWad[s][a] = weightsWad[i];
            totalWeight += weightsWad[i];
        }
        require(totalWeight == WAD, "ArenaVault: total weight must be 1e18");

        seasonSettled[s] = true;
        emit SeasonSettled(seasonId);
    }

    function claim(string calldata seasonId) external whenNotPaused nonReentrant {
        bytes32 s = _seasonKey(seasonId);
        require(seasonSettled[s], "ArenaVault: season not settled");
        require(!userClaimed[s][msg.sender], "ArenaVault: already claimed");

        uint256 payout;
        bytes32[] storage agents = seasonAgents[s];
        for (uint256 i = 0; i < agents.length; i++) {
            bytes32 a = agents[i];
            if (userClaimedBySeasonAgent[s][a][msg.sender]) continue;
            uint256 part = _payoutForAgent(s, a, msg.sender);
            if (part == 0) continue;
            userClaimedBySeasonAgent[s][a][msg.sender] = true;
            payout += part;
        }

        require(payout > 0, "ArenaVault: no payout");
        // CEI: mark state before external call
        userClaimed[s][msg.sender] = true;
        // (per-agent flags already set in loop above)
        bool ok = arenaToken.transfer(msg.sender, payout);
        require(ok, "ArenaVault: transfer failed");
        emit Claimed(seasonId, msg.sender, payout);
    }

    function claimAgent(string calldata seasonId, string calldata agentId) external whenNotPaused nonReentrant {
        bytes32 s = _seasonKey(seasonId);
        bytes32 a = _agentKey(agentId);
        require(seasonSettled[s], "ArenaVault: season not settled");
        require(!userClaimed[s][msg.sender], "ArenaVault: already claimed");
        require(!userClaimedBySeasonAgent[s][a][msg.sender], "ArenaVault: agent already claimed");

        uint256 payout = _payoutForAgent(s, a, msg.sender);
        require(payout > 0, "ArenaVault: no payout");
        // CEI: mark state before external call
        userClaimedBySeasonAgent[s][a][msg.sender] = true;
        bool ok = arenaToken.transfer(msg.sender, payout);
        require(ok, "ArenaVault: transfer failed");
        emit ClaimedAgent(seasonId, agentId, msg.sender, payout);
    }

    function claimAgents(string calldata seasonId, string[] calldata agentIds) external whenNotPaused nonReentrant {
        bytes32 s = _seasonKey(seasonId);
        require(seasonSettled[s], "ArenaVault: season not settled");
        require(!userClaimed[s][msg.sender], "ArenaVault: already claimed");
        require(agentIds.length > 0, "ArenaVault: empty agentIds");

        uint256 payout;
        for (uint256 i = 0; i < agentIds.length; i++) {
            bytes32 a = _agentKey(agentIds[i]);
            if (userClaimedBySeasonAgent[s][a][msg.sender]) continue;
            uint256 part = _payoutForAgent(s, a, msg.sender);
            if (part == 0) continue;
            userClaimedBySeasonAgent[s][a][msg.sender] = true;
            payout += part;
        }

        require(payout > 0, "ArenaVault: no payout");
        // CEI: mark state before external call
        bool ok = arenaToken.transfer(msg.sender, payout);
        require(ok, "ArenaVault: transfer failed");
        emit Claimed(seasonId, msg.sender, payout);
    }

    function getSeasonAgents(string calldata seasonId) external view returns (bytes32[] memory) {
        return seasonAgents[_seasonKey(seasonId)];
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function _seasonKey(string memory seasonId) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(seasonId));
    }

    function _agentKey(string memory agentId) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(agentId));
    }

    function _payoutForAgent(bytes32 seasonKey, bytes32 agentKey, address user) private view returns (uint256) {
        uint256 userStake = userStakeBySeasonAgent[seasonKey][agentKey][user];
        if (userStake == 0) return 0;

        uint256 totalStake = totalStakeBySeasonAgent[seasonKey][agentKey];
        if (totalStake == 0) return 0;

        uint256 weight = seasonWeightWad[seasonKey][agentKey];
        if (weight == 0) return 0;

        uint256 pool = totalSeasonPool[seasonKey];
        return (pool * weight * userStake) / (WAD * totalStake);
    }
}
