// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SynaptexToken.sol";
import "../src/ArenaVault.sol";

contract ArenaVaultTest is Test {
    SynaptexToken token;
    ArenaVault vault;

    address owner   = address(0x1);
    // settler is a dedicated address that has been granted settler role
    address settler = address(0x10);
    address alice   = address(0x2);
    address bob     = address(0x3);

    uint256 constant WAD = 1e18;
    uint256 constant STAKE = 1_000 ether;

    function setUp() public {
        vm.startPrank(owner);
        token = new SynaptexToken(owner, 10_000_000 ether, 100_000_000 ether);
        vault = new ArenaVault(address(token), owner);
        // Grant settler role
        vault.setSettler(settler);
        // Distribute tokens
        token.transfer(alice, 5_000 ether);
        token.transfer(bob,   5_000 ether);
        vm.stopPrank();

        // Approve vault from each user
        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        token.approve(address(vault), type(uint256).max);
    }

    // ── helpers ────────────────────────────────────────────────────────────────

    function _settle(string memory seasonId, string memory agentId, uint256 weightWad) internal {
        string[]  memory ids = new string[](1);
        uint256[] memory ws  = new uint256[](1);
        ids[0] = agentId;
        ws[0]  = weightWad;
        vm.prank(settler);
        vault.setSeasonWeights(seasonId, ids, ws);
    }

    function _settleTwo(
        string memory seasonId,
        string memory a1, uint256 w1,
        string memory a2, uint256 w2
    ) internal {
        string[]  memory ids = new string[](2);
        uint256[] memory ws  = new uint256[](2);
        ids[0] = a1; ws[0] = w1;
        ids[1] = a2; ws[1] = w2;
        vm.prank(settler);
        vault.setSeasonWeights(seasonId, ids, ws);
    }

    // ── Test 1: Normal settlement — single staker, single agent ───────────────
    function test_NormalSettle_SingleAgent() public {
        vm.prank(alice);
        vault.stake("s1", "agent-a", STAKE);

        _settle("s1", "agent-a", WAD); // 100% to agent-a

        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        vault.claim("s1");

        // Full pool returned (1000 ARENA)
        assertEq(token.balanceOf(alice) - before, STAKE);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    // ── Test 2: Normal settlement — two stakers, two agents ───────────────────
    function test_NormalSettle_TwoAgents_CrossPayout() public {
        // Alice stakes 1000 on agent-a; Bob stakes 1000 on agent-b
        vm.prank(alice);
        vault.stake("s2", "agent-a", STAKE);
        vm.prank(bob);
        vault.stake("s2", "agent-b", STAKE);

        // agent-a=60%, agent-b=40%
        _settleTwo("s2", "agent-a", 6e17, "agent-b", 4e17);

        uint256 aliceBefore = token.balanceOf(alice);
        uint256 bobBefore   = token.balanceOf(bob);

        vm.prank(alice);
        vault.claim("s2");
        vm.prank(bob);
        vault.claim("s2");

        // Alice backed the winning agent (60%) — gets 60% of 2000 pool = 1200
        assertEq(token.balanceOf(alice) - aliceBefore, 1_200 ether);
        // Bob backed the losing agent (40%) — gets 40% of 2000 pool = 800
        assertEq(token.balanceOf(bob)   - bobBefore,   800 ether);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    // ── Test 3: weight != 1e18 must revert ────────────────────────────────────
    function test_Revert_WeightNotOneWad() public {
        vm.prank(alice);
        vault.stake("s3", "agent-a", STAKE);

        string[]  memory ids = new string[](1);
        uint256[] memory ws  = new uint256[](1);
        ids[0] = "agent-a";
        ws[0]  = 5e17; // only 50%, not 100%

        vm.prank(settler);
        vm.expectRevert(bytes("ArenaVault: total weight must be 1e18"));
        vault.setSeasonWeights("s3", ids, ws);
    }

    // ── Test 4: double-settle must revert ─────────────────────────────────────
    function test_Revert_DoubleSettle() public {
        vm.prank(alice);
        vault.stake("s4", "agent-a", STAKE);

        _settle("s4", "agent-a", WAD);

        // Second settle must revert
        vm.prank(settler);
        vm.expectRevert(bytes("ArenaVault: already settled"));
        vault.setSeasonWeights(
            "s4",
            _oneStringArray("agent-a"),
            _oneUintArray(WAD)
        );
    }

    // ── Test 5: double-claim must revert ──────────────────────────────────────
    function test_Revert_DoubleClaim() public {
        vm.prank(alice);
        vault.stake("s5", "agent-a", STAKE);

        _settle("s5", "agent-a", WAD);

        vm.prank(alice);
        vault.claim("s5");

        vm.prank(alice);
        vm.expectRevert(bytes("ArenaVault: already claimed"));
        vault.claim("s5");
    }

    // ── Test 6: claim with zero user stake reverts (no payout) ────────────────
    function test_Revert_ZeroPayout_NoClaim() public {
        // Alice stakes on agent-a; season settled but Bob never staked
        vm.prank(alice);
        vault.stake("s6", "agent-a", STAKE);

        _settle("s6", "agent-a", WAD);

        // Bob never staked → payout = 0 → should revert
        vm.prank(bob);
        vm.expectRevert(bytes("ArenaVault: no payout"));
        vault.claim("s6");
    }

    // ── Test 7: cross-agent allocation precision ──────────────────────────────
    function test_CrossAgentPrecision() public {
        // Alice stakes on both agents equally (500 each)
        vm.prank(alice);
        vault.stake("s7", "agent-a", 500 ether);
        vm.prank(alice);
        vault.stake("s7", "agent-b", 500 ether);

        // 70/30 split
        _settleTwo("s7", "agent-a", 7e17, "agent-b", 3e17);

        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        vault.claim("s7");

        // payout = pool(1000) * 0.7 * 500 / 500  +  pool(1000) * 0.3 * 500 / 500
        //        = 700 + 300 = 1000 (full pool back since Alice is only staker)
        assertEq(token.balanceOf(alice) - before, 1_000 ether);
    }

    // ── helpers ────────────────────────────────────────────────────────────────
    function test_Revert_WhenPaused_Stake() public {
        vm.prank(owner);
        vault.pause();

        vm.prank(alice);
        vm.expectRevert(bytes("ArenaVault: paused"));
        vault.stake("s8", "agent-a", STAKE);
    }

    function test_Revert_SetSettler_AfterLock() public {
        vm.prank(owner);
        vault.lockSettler();

        vm.prank(owner);
        vm.expectRevert(bytes("ArenaVault: settler locked"));
        vault.setSettler(address(0x20));
    }

    function test_ClaimAgent_SinglePath() public {
        vm.prank(alice);
        vault.stake("s9", "agent-a", STAKE);

        _settle("s9", "agent-a", WAD);

        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        vault.claimAgent("s9", "agent-a");

        assertEq(token.balanceOf(alice) - before, STAKE);
    }

    function test_Revert_ClaimAgent_DoubleClaim() public {
        vm.prank(alice);
        vault.stake("s10", "agent-a", STAKE);

        _settle("s10", "agent-a", WAD);

        vm.prank(alice);
        vault.claimAgent("s10", "agent-a");

        vm.prank(alice);
        vm.expectRevert(bytes("ArenaVault: agent already claimed"));
        vault.claimAgent("s10", "agent-a");
    }

    function test_ClaimAgents_BatchPath() public {
        vm.prank(alice);
        vault.stake("s11", "agent-a", 600 ether);
        vm.prank(alice);
        vault.stake("s11", "agent-b", 400 ether);

        _settleTwo("s11", "agent-a", 6e17, "agent-b", 4e17);

        string[] memory ids = new string[](2);
        ids[0] = "agent-a";
        ids[1] = "agent-b";

        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        vault.claimAgents("s11", ids);

        assertEq(token.balanceOf(alice) - before, 1_000 ether);
    }

    function test_Revert_ClaimAgents_Empty() public {
        vm.prank(alice);
        vault.stake("s12", "agent-a", STAKE);
        _settle("s12", "agent-a", WAD);

        string[] memory ids = new string[](0);
        vm.prank(alice);
        vm.expectRevert(bytes("ArenaVault: empty agentIds"));
        vault.claimAgents("s12", ids);
    }

    function test_MixedClaimAgentThenClaim_RemainingPayoutOnly() public {
        vm.prank(alice);
        vault.stake("s13", "agent-a", 600 ether);
        vm.prank(alice);
        vault.stake("s13", "agent-b", 400 ether);
        _settleTwo("s13", "agent-a", 6e17, "agent-b", 4e17);

        uint256 before = token.balanceOf(alice);

        // First claim only agent-a (expects 600)
        vm.prank(alice);
        vault.claimAgent("s13", "agent-a");
        assertEq(token.balanceOf(alice) - before, 600 ether);

        // Then claim() should only pay remaining agent-b share (400)
        vm.prank(alice);
        vault.claim("s13");
        assertEq(token.balanceOf(alice) - before, 1_000 ether);

        // Fully claimed user cannot claim agent path again
        vm.prank(alice);
        vm.expectRevert(bytes("ArenaVault: already claimed"));
        vault.claimAgent("s13", "agent-b");
    }

    function test_MixedClaimAgentsSubsetThenClaim_CompletesSeason() public {
        vm.prank(alice);
        vault.stake("s14", "agent-a", 500 ether);
        vm.prank(alice);
        vault.stake("s14", "agent-b", 500 ether);
        _settleTwo("s14", "agent-a", 7e17, "agent-b", 3e17);

        string[] memory subset = new string[](1);
        subset[0] = "agent-a";

        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        vault.claimAgents("s14", subset); // gets 700
        assertEq(token.balanceOf(alice) - before, 700 ether);

        vm.prank(alice);
        vault.claim("s14"); // gets remaining 300
        assertEq(token.balanceOf(alice) - before, 1_000 ether);
    }

    function test_Revert_ClaimAgents_UnknownOnly_NoPayout() public {
        vm.prank(alice);
        vault.stake("s15", "agent-a", STAKE);
        _settle("s15", "agent-a", WAD);

        string[] memory ids = new string[](1);
        ids[0] = "agent-unknown";
        vm.prank(alice);
        vm.expectRevert(bytes("ArenaVault: no payout"));
        vault.claimAgents("s15", ids);
    }

    function test_Revert_TooManyAgentsPerSeason_OnStake() public {
        for (uint256 i = 0; i < 256; i++) {
            vm.prank(alice);
            vault.stake("s16", string(abi.encodePacked("agent-", vm.toString(i))), 1);
        }

        vm.prank(alice);
        vm.expectRevert(bytes("ArenaVault: too many agents"));
        vault.stake("s16", "agent-overflow", 1);
    }

    function test_Revert_TooManyAgentsPerSeason_OnSetSeasonWeights() public {
        string[] memory ids = new string[](257);
        uint256[] memory ws = new uint256[](257);

        ids[0] = "agent-0";
        ws[0] = WAD;
        for (uint256 i = 1; i < 257; i++) {
            ids[i] = string(abi.encodePacked("agent-", vm.toString(i)));
            ws[i] = 0;
        }

        vm.prank(settler);
        vm.expectRevert(bytes("ArenaVault: too many agents"));
        vault.setSeasonWeights("s17", ids, ws);
    }

    function _oneStringArray(string memory s) internal pure returns (string[] memory a) {
        a = new string[](1);
        a[0] = s;
    }

    function _oneUintArray(uint256 v) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = v;
    }
}
