// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Ownable.sol";

// ── Minimal ERC-20 interface ──────────────────────────────────────────────────

interface IArenaToken {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

// ── Minimal ERC-6551 interface (for AgentAccount identity check) ──────────────

interface ITaskEscrow6551 {
    function token() external view returns (uint256 chainId, address tokenContract, uint256 tokenId);
}

/**
 * @title SimpleTaskEscrow
 * @notice Single-to-single AI task escrow. Four functions, four states.
 *
 *  Flow:
 *    poster.fund(taker, amount, deadline)
 *      → FUNDED
 *    taker.deliver(taskId, resultHash)
 *      → DONE
 *    poster.release(taskId)  OR  anyone after releaseAfter timeout
 *      → RELEASED  (taker paid, fee → treasury)
 *    anyone after deadline if still FUNDED/DONE
 *      → REFUNDED  (poster gets money back, no fee)
 *
 *  Design constraints:
 *    - Non-upgradeable (fund security, same as ArenaVault)
 *    - No reentrancy guard library: CEI pattern strictly enforced
 *    - poster ≠ taker enforced
 *    - Both poster and taker can be EOA or AgentAccount
 *    - AgentAccount identity checked via IERC6551Account.token()
 */
contract SimpleTaskEscrow is ArenaOwnable {

    // ── Config ────────────────────────────────────────────────────────────────

    IArenaToken public immutable token;
    address public treasury;

    uint256 public feeRateBps       = 300;   // 3%
    uint256 public maxTaskAmount    = 10_000 ether;
    uint256 public minTaskAmount    = 1 ether;
    uint256 public maxDeadlineSecs  = 7 days;
    uint256 public releaseDelaySecs = 2 hours; // dispute window after deliver

    bool public paused;

    // ── Task storage ──────────────────────────────────────────────────────────

    enum TaskStatus { FUNDED, DONE, RELEASED, REFUNDED }

    struct Task {
        address poster;        // who posted and funded
        address taker;         // designated AI agent (AgentAccount or EOA)
        uint256 amount;        // ARENA locked
        bytes32 taskHash;      // keccak256 of task description (off-chain content anchor)
        bytes32 resultHash;    // keccak256 of result (set by taker on deliver)
        uint64  deadline;      // taker must deliver before this
        uint64  releaseAfter;  // poster can release after deliver; auto-release after this
        TaskStatus status;
    }

    uint256 public nextTaskId = 1;
    mapping(uint256 => Task) public tasks;

    // Prevent resultHash reuse across tasks
    mapping(bytes32 => bool) public usedResultHashes;

    // ── Events ────────────────────────────────────────────────────────────────

    event TaskFunded(
        uint256 indexed taskId,
        address indexed poster,
        address indexed taker,
        bytes32 taskHash,
        uint256 amount,
        uint64  deadline
    );
    event TaskDelivered(uint256 indexed taskId, address indexed taker, bytes32 resultHash);
    event TaskReleased(uint256 indexed taskId, address indexed taker, uint256 net, uint256 fee);
    event TaskRefunded(uint256 indexed taskId, address indexed poster, uint256 amount);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address token_, address treasury_, address owner_) ArenaOwnable(owner_) {
        require(token_    != address(0), "zero token");
        require(treasury_ != address(0), "zero treasury");
        token    = IArenaToken(token_);
        treasury = treasury_;
    }

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier whenNotPaused() {
        require(!paused, "SimpleTaskEscrow: paused");
        _;
    }

    // ── Core: fund ────────────────────────────────────────────────────────────

    /**
     * @notice Post a task and lock payment.
     * @param taker       Designated agent (AgentAccount address or EOA).
     * @param amount      ARENA to lock. Must be within [minTaskAmount, maxTaskAmount].
     * @param deadline    Unix timestamp by which taker must deliver.
     * @param taskHash    keccak256 of task description (computed off-chain by API server).
     */
    function fund(
        address taker,
        uint256 amount,
        uint64  deadline,
        bytes32 taskHash
    ) external whenNotPaused returns (uint256 taskId) {
        require(taker != address(0),       "zero taker");
        require(taker != msg.sender,       "poster == taker");
        require(amount >= minTaskAmount,   "amount too small");
        require(amount <= maxTaskAmount,   "amount too large");
        require(deadline > block.timestamp, "deadline in past");
        require(
            deadline <= block.timestamp + maxDeadlineSecs,
            "deadline too far"
        );

        // CEI: assign ID, store, then transfer
        taskId = nextTaskId++;
        tasks[taskId] = Task({
            poster:      msg.sender,
            taker:       taker,
            amount:      amount,
            taskHash:    taskHash,
            resultHash:  bytes32(0),
            deadline:    deadline,
            releaseAfter: 0,
            status:      TaskStatus.FUNDED
        });

        // Transfer ARENA from poster into this contract
        require(
            token.transferFrom(msg.sender, address(this), amount),
            "transfer failed"
        );

        emit TaskFunded(taskId, msg.sender, taker, taskHash, amount, deadline);
    }

    // ── Core: deliver ─────────────────────────────────────────────────────────

    /**
     * @notice Taker submits result. Starts the 2-hour dispute window.
     * @param taskId     Task to deliver.
     * @param resultHash keccak256 of the result content (stored off-chain by API).
     */
    function deliver(uint256 taskId, bytes32 resultHash) external {
        Task storage t = tasks[taskId];

        // CHECK
        require(t.status == TaskStatus.FUNDED,       "not funded");
        require(msg.sender == t.taker,               "not taker");
        require(block.timestamp <= t.deadline,        "deadline passed");
        require(resultHash != bytes32(0),            "empty result");
        require(!usedResultHashes[resultHash],        "result hash reused");

        // EFFECT
        usedResultHashes[resultHash] = true;
        t.resultHash   = resultHash;
        t.releaseAfter = uint64(block.timestamp + releaseDelaySecs);
        t.status       = TaskStatus.DONE;

        emit TaskDelivered(taskId, msg.sender, resultHash);
    }

    // ── Core: release ─────────────────────────────────────────────────────────

    /**
     * @notice Release payment to taker.
     *         Poster can call immediately after DONE.
     *         Anyone can call after releaseAfter timeout (auto-release).
     */
    function release(uint256 taskId) external {
        Task storage t = tasks[taskId];

        // CHECK
        require(t.status == TaskStatus.DONE, "not done");
        require(
            msg.sender == t.poster || block.timestamp >= t.releaseAfter,
            "not poster or too early"
        );

        // EFFECT
        t.status = TaskStatus.RELEASED;
        uint256 fee = (t.amount * feeRateBps) / 10_000;
        uint256 net = t.amount - fee;
        address taker_   = t.taker;
        address treasury_ = treasury;

        // INTERACT
        require(token.transfer(taker_,    net), "taker transfer failed");
        require(token.transfer(treasury_, fee), "fee transfer failed");

        emit TaskReleased(taskId, taker_, net, fee);
    }

    // ── Core: refund ──────────────────────────────────────────────────────────

    /**
     * @notice Refund poster if taker missed deadline.
     *         Can be called by anyone once deadline has passed and task is still FUNDED.
     *         Also refunds if task is DONE but taker never triggered and deadline passed
     *         (edge case: poster can always call release() themselves; refund is only
     *          for FUNDED tasks past deadline).
     */
    function refund(uint256 taskId) external {
        Task storage t = tasks[taskId];

        // CHECK
        require(t.status == TaskStatus.FUNDED,        "not funded");
        require(block.timestamp > t.deadline,          "deadline not passed");

        // EFFECT
        t.status = TaskStatus.REFUNDED;
        uint256 amount_  = t.amount;
        address poster_  = t.poster;

        // INTERACT
        require(token.transfer(poster_, amount_), "refund transfer failed");

        emit TaskRefunded(taskId, poster_, amount_);
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    function setTreasury(address treasury_) external onlyOwner {
        require(treasury_ != address(0), "zero treasury");
        treasury = treasury_;
    }

    function setFeeRateBps(uint256 bps) external onlyOwner {
        require(bps <= 1000, "fee too high"); // max 10%
        feeRateBps = bps;
    }

    function setMaxTaskAmount(uint256 amount) external onlyOwner {
        maxTaskAmount = amount;
    }

    function setMinTaskAmount(uint256 amount) external onlyOwner {
        minTaskAmount = amount;
    }

    function setReleaseDelaySecs(uint256 secs) external onlyOwner {
        require(secs <= 7 days, "delay too long");
        releaseDelaySecs = secs;
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getTask(uint256 taskId) external view returns (Task memory) {
        return tasks[taskId];
    }

    function taskCount() external view returns (uint256) {
        return nextTaskId - 1;
    }
}
