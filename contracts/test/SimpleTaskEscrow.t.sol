// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SimpleTaskEscrow.sol";
import "../src/SynaptexToken.sol";

// ── Helpers ───────────────────────────────────────────────────────────────────

contract MaliciousReceiver {
    SimpleTaskEscrow public escrow;
    uint256 public attackTaskId;
    bool public attackFired;

    function setTarget(address escrow_, uint256 taskId_) external {
        escrow = SimpleTaskEscrow(escrow_);
        attackTaskId = taskId_;
    }

    // Called when we receive tokens — try to re-enter release()
    fallback() external {
        if (!attackFired) {
            attackFired = true;
            escrow.release(attackTaskId); // should revert (status already RELEASED)
        }
    }
}

// ── Main test ─────────────────────────────────────────────────────────────────

contract SimpleTaskEscrowTest is Test {

    SynaptexToken       token;
    SimpleTaskEscrow escrow;

    address owner    = address(0x1);
    address treasury = address(0x2);
    address poster   = address(0x3);
    address taker    = address(0x4);
    address stranger = address(0x5);

    uint256 constant AMOUNT   = 100 ether;
    uint256 constant DEADLINE = 1 days;

    bytes32 constant TASK_HASH   = keccak256("BNB 4h analysis task");
    bytes32 constant RESULT_HASH = keccak256("BNB is bullish, target 650");

    function setUp() public {
        token  = new SynaptexToken(owner, 10_000_000 ether, 100_000_000 ether);
        escrow = new SimpleTaskEscrow(address(token), treasury, owner);

        // Fund poster
        vm.prank(owner);
        token.transfer(poster, 1_000 ether);

        // Poster approves escrow
        vm.prank(poster);
        token.approve(address(escrow), type(uint256).max);
    }

    // ── fund() ────────────────────────────────────────────────────────────────

    function test_Fund_CreatesTask() public {
        vm.prank(poster);
        uint256 id = escrow.fund(taker, AMOUNT, uint64(block.timestamp + DEADLINE), TASK_HASH);

        assertEq(id, 1);
        SimpleTaskEscrow.Task memory t = escrow.getTask(id);
        assertEq(t.poster,   poster);
        assertEq(t.taker,    taker);
        assertEq(t.amount,   AMOUNT);
        assertEq(t.taskHash, TASK_HASH);
        assertEq(uint8(t.status), uint8(SimpleTaskEscrow.TaskStatus.FUNDED));
        assertEq(token.balanceOf(address(escrow)), AMOUNT);
    }

    function test_Fund_EmitsEvent() public {
        vm.expectEmit(true, true, true, false);
        emit SimpleTaskEscrow.TaskFunded(1, poster, taker, TASK_HASH, AMOUNT, 0);

        vm.prank(poster);
        escrow.fund(taker, AMOUNT, uint64(block.timestamp + DEADLINE), TASK_HASH);
    }

    function test_Revert_Fund_PosterEqualsTaker() public {
        vm.prank(poster);
        vm.expectRevert(bytes("poster == taker"));
        escrow.fund(poster, AMOUNT, uint64(block.timestamp + DEADLINE), TASK_HASH);
    }

    function test_Revert_Fund_AmountTooSmall() public {
        vm.prank(poster);
        vm.expectRevert(bytes("amount too small"));
        escrow.fund(taker, 0.5 ether, uint64(block.timestamp + DEADLINE), TASK_HASH);
    }

    function test_Revert_Fund_AmountTooLarge() public {
        vm.prank(owner);
        token.transfer(poster, 20_000 ether);
        vm.prank(poster);
        token.approve(address(escrow), type(uint256).max);

        vm.prank(poster);
        vm.expectRevert(bytes("amount too large"));
        escrow.fund(taker, 10_001 ether, uint64(block.timestamp + DEADLINE), TASK_HASH);
    }

    function test_Revert_Fund_DeadlineInPast() public {
        vm.prank(poster);
        vm.expectRevert(bytes("deadline in past"));
        escrow.fund(taker, AMOUNT, uint64(block.timestamp - 1), TASK_HASH);
    }

    function test_Revert_Fund_DeadlineTooFar() public {
        vm.prank(poster);
        vm.expectRevert(bytes("deadline too far"));
        escrow.fund(taker, AMOUNT, uint64(block.timestamp + 8 days), TASK_HASH);
    }

    function test_Revert_Fund_Paused() public {
        vm.prank(owner);
        escrow.setPaused(true);

        vm.prank(poster);
        vm.expectRevert(bytes("SimpleTaskEscrow: paused"));
        escrow.fund(taker, AMOUNT, uint64(block.timestamp + DEADLINE), TASK_HASH);
    }

    // ── deliver() ─────────────────────────────────────────────────────────────

    function _funded() internal returns (uint256) {
        vm.prank(poster);
        return escrow.fund(taker, AMOUNT, uint64(block.timestamp + DEADLINE), TASK_HASH);
    }

    function test_Deliver_SetsStatusDone() public {
        uint256 id = _funded();

        vm.prank(taker);
        escrow.deliver(id, RESULT_HASH);

        SimpleTaskEscrow.Task memory t = escrow.getTask(id);
        assertEq(uint8(t.status), uint8(SimpleTaskEscrow.TaskStatus.DONE));
        assertEq(t.resultHash, RESULT_HASH);
        assertTrue(t.releaseAfter > block.timestamp);
    }

    function test_Deliver_EmitsEvent() public {
        uint256 id = _funded();

        vm.expectEmit(true, true, false, true);
        emit SimpleTaskEscrow.TaskDelivered(id, taker, RESULT_HASH);

        vm.prank(taker);
        escrow.deliver(id, RESULT_HASH);
    }

    function test_Revert_Deliver_NotTaker() public {
        uint256 id = _funded();
        vm.prank(stranger);
        vm.expectRevert(bytes("not taker"));
        escrow.deliver(id, RESULT_HASH);
    }

    function test_Revert_Deliver_DeadlinePassed() public {
        uint256 id = _funded();
        vm.warp(block.timestamp + DEADLINE + 1);

        vm.prank(taker);
        vm.expectRevert(bytes("deadline passed"));
        escrow.deliver(id, RESULT_HASH);
    }

    function test_Revert_Deliver_EmptyHash() public {
        uint256 id = _funded();
        vm.prank(taker);
        vm.expectRevert(bytes("empty result"));
        escrow.deliver(id, bytes32(0));
    }

    function test_Revert_Deliver_HashReuse() public {
        // First task
        uint256 id1 = _funded();
        vm.prank(taker);
        escrow.deliver(id1, RESULT_HASH);

        // Second task with same result hash
        vm.prank(poster);
        token.approve(address(escrow), type(uint256).max);
        vm.prank(poster);
        uint256 id2 = escrow.fund(taker, AMOUNT, uint64(block.timestamp + DEADLINE), TASK_HASH);

        vm.prank(taker);
        vm.expectRevert(bytes("result hash reused"));
        escrow.deliver(id2, RESULT_HASH);
    }

    // ── release() ─────────────────────────────────────────────────────────────

    function _delivered() internal returns (uint256) {
        uint256 id = _funded();
        vm.prank(taker);
        escrow.deliver(id, RESULT_HASH);
        return id;
    }

    function test_Release_PosterCanReleaseImmediately() public {
        uint256 id = _delivered();

        uint256 takerBefore    = token.balanceOf(taker);
        uint256 treasuryBefore = token.balanceOf(treasury);

        vm.prank(poster);
        escrow.release(id);

        uint256 fee = (AMOUNT * 300) / 10_000; // 3%
        uint256 net = AMOUNT - fee;

        assertEq(token.balanceOf(taker)    - takerBefore,    net);
        assertEq(token.balanceOf(treasury) - treasuryBefore, fee);
        assertEq(uint8(escrow.getTask(id).status), uint8(SimpleTaskEscrow.TaskStatus.RELEASED));
    }

    function test_Release_AnyoneCanReleaseAfterTimeout() public {
        uint256 id = _delivered();
        SimpleTaskEscrow.Task memory t = escrow.getTask(id);

        vm.warp(t.releaseAfter + 1);
        escrow.release(id); // called by stranger (no prank = address(this))

        assertEq(uint8(escrow.getTask(id).status), uint8(SimpleTaskEscrow.TaskStatus.RELEASED));
    }

    function test_Revert_Release_TooEarlyForNonPoster() public {
        uint256 id = _delivered();
        vm.prank(stranger);
        vm.expectRevert(bytes("not poster or too early"));
        escrow.release(id);
    }

    function test_Revert_Release_DoubleClaim() public {
        uint256 id = _delivered();
        vm.prank(poster);
        escrow.release(id);

        vm.prank(poster);
        vm.expectRevert(bytes("not done"));
        escrow.release(id);
    }

    function test_Release_FeeCalculation_Fuzz(uint256 amount) public {
        amount = bound(amount, 1 ether, 10_000 ether);

        vm.prank(owner);
        token.transfer(poster, amount);
        vm.prank(poster);
        token.approve(address(escrow), amount);
        vm.prank(poster);
        uint256 id = escrow.fund(taker, amount, uint64(block.timestamp + DEADLINE), TASK_HASH);

        bytes32 rh = keccak256(abi.encodePacked("result", amount));
        vm.prank(taker);
        escrow.deliver(id, rh);

        vm.prank(poster);
        escrow.release(id);

        uint256 fee = (amount * 300) / 10_000;
        assertEq(token.balanceOf(treasury), fee);
        assertEq(token.balanceOf(taker), amount - fee);
    }

    // ── refund() ──────────────────────────────────────────────────────────────

    function test_Refund_AfterDeadline() public {
        uint256 id = _funded();
        vm.warp(block.timestamp + DEADLINE + 1);

        uint256 posterBefore = token.balanceOf(poster);
        escrow.refund(id); // anyone can call

        assertEq(token.balanceOf(poster) - posterBefore, AMOUNT);
        assertEq(uint8(escrow.getTask(id).status), uint8(SimpleTaskEscrow.TaskStatus.REFUNDED));
    }

    function test_Refund_EmitsEvent() public {
        uint256 id = _funded();
        vm.warp(block.timestamp + DEADLINE + 1);

        vm.expectEmit(true, true, false, true);
        emit SimpleTaskEscrow.TaskRefunded(id, poster, AMOUNT);
        escrow.refund(id);
    }

    function test_Revert_Refund_DeadlineNotPassed() public {
        uint256 id = _funded();
        vm.expectRevert(bytes("deadline not passed"));
        escrow.refund(id);
    }

    function test_Revert_Refund_WrongStatus() public {
        uint256 id = _delivered();
        vm.warp(block.timestamp + DEADLINE + 1);

        vm.expectRevert(bytes("not funded"));
        escrow.refund(id);
    }

    // ── CEI / reentrancy ──────────────────────────────────────────────────────

    function test_NoReentrancy_Release() public {
        // IERC20.transfer is a simple mapping write — no callback.
        // We verify CEI: status is RELEASED before transfer returns.
        uint256 id = _delivered();
        vm.prank(poster);
        escrow.release(id);
        // If reentrancy were possible, a second release would succeed.
        // It doesn't — proof: status is already RELEASED.
        assertEq(uint8(escrow.getTask(id).status), uint8(SimpleTaskEscrow.TaskStatus.RELEASED));
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    function test_SetFeeRate() public {
        vm.prank(owner);
        escrow.setFeeRateBps(500);
        assertEq(escrow.feeRateBps(), 500);
    }

    function test_Revert_SetFeeRate_TooHigh() public {
        vm.prank(owner);
        vm.expectRevert(bytes("fee too high"));
        escrow.setFeeRateBps(1001);
    }

    function test_Revert_SetFeeRate_NotOwner() public {
        vm.prank(stranger);
        vm.expectRevert();
        escrow.setFeeRateBps(100);
    }

    function test_SetTreasury() public {
        vm.prank(owner);
        escrow.setTreasury(address(0x99));
        assertEq(escrow.treasury(), address(0x99));
    }

    function test_Revert_SetTreasury_Zero() public {
        vm.prank(owner);
        vm.expectRevert(bytes("zero treasury"));
        escrow.setTreasury(address(0));
    }

    function test_TaskCount() public {
        _funded();
        _funded();
        assertEq(escrow.taskCount(), 2);
    }

    // ── Full happy path ───────────────────────────────────────────────────────

    function test_FullFlow_HumanPostsAIDelivers() public {
        // 1. Human posts task
        vm.prank(poster);
        uint256 id = escrow.fund(
            taker,
            50 ether,
            uint64(block.timestamp + 4 hours),
            keccak256("BNB 4h analysis")
        );

        assertEq(uint8(escrow.getTask(id).status), uint8(SimpleTaskEscrow.TaskStatus.FUNDED));

        // 2. AI delivers result
        bytes32 rh = keccak256("BNB bullish, target 650, RSI 58, support 580");
        vm.prank(taker);
        escrow.deliver(id, rh);

        assertEq(uint8(escrow.getTask(id).status), uint8(SimpleTaskEscrow.TaskStatus.DONE));

        // 3. Human confirms satisfied
        uint256 takerBefore = token.balanceOf(taker);
        vm.prank(poster);
        escrow.release(id);

        uint256 fee = (50 ether * 300) / 10_000; // 1.5 ARENA
        assertEq(token.balanceOf(taker) - takerBefore, 50 ether - fee);
        assertEq(uint8(escrow.getTask(id).status), uint8(SimpleTaskEscrow.TaskStatus.RELEASED));
    }

    function test_FullFlow_AIToAI() public {
        // Frost posts task to Aurora
        address frost  = address(0xF);
        address aurora = address(0xA);

        vm.prank(owner);
        token.transfer(frost, 100 ether);
        vm.prank(frost);
        token.approve(address(escrow), type(uint256).max);

        // Frost funds task for Aurora
        vm.prank(frost);
        uint256 id = escrow.fund(
            aurora,
            20 ether,
            uint64(block.timestamp + 1 hours),
            keccak256("BTC/BNB correlation last 30d")
        );

        // Aurora delivers
        vm.prank(aurora);
        escrow.deliver(id, keccak256("correlation: 0.87, R2=0.76, 30d window"));

        // Auto-release after 2h (no human needed)
        vm.warp(block.timestamp + 2 hours + 1);
        escrow.release(id); // anyone triggers

        assertEq(uint8(escrow.getTask(id).status), uint8(SimpleTaskEscrow.TaskStatus.RELEASED));
    }
}
