// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/SynaptexToken.sol";
import "../src/ArenaVault.sol";
import "../src/SeasonSettler.sol";

contract SeasonSettlerTest is Test {
    SynaptexToken   token;
    ArenaVault   vault;
    SeasonSettler settler;

    address owner     = address(0x1);
    address nonOwner  = address(0x9);

    uint256 constant WAD = 1e18;

    bytes32 constant LB_HASH    = bytes32(uint256(0xABCD));
    bytes32 constant MERKLE_ROOT = bytes32(uint256(0x1234));

    function setUp() public {
        vm.startPrank(owner);
        token   = new SynaptexToken(owner, 1_000_000 ether, 10_000_000 ether);
        vault   = new ArenaVault(address(token), owner);
        SeasonSettler settlerImpl = new SeasonSettler();
        bytes memory init = abi.encodeCall(SeasonSettler.initialize, (address(vault), owner));
        settler = SeasonSettler(address(new ERC1967Proxy(address(settlerImpl), init)));
        vault.setSettler(address(settler));
        vm.stopPrank();
    }

    // ── helpers ────────────────────────────────────────────────────────────────

    function _submit(string memory seasonId) internal {
        string[]  memory ids  = new string[](2);
        uint256[] memory ws   = new uint256[](2);
        uint256[] memory reps = new uint256[](0); // empty = skip reputation updates
        ids[0] = "agent-a"; ws[0] = 6e17;
        ids[1] = "agent-b"; ws[1] = 4e17;
        vm.prank(owner);
        settler.submitSeasonResult(seasonId, LB_HASH, MERKLE_ROOT, ids, ws, reps);
    }

    // ── Test 1: Normal submit — stores result and sets vault weights ───────────
    function test_NormalSubmit_StoresResult() public {
        _submit("s1");

        bytes32 key = keccak256(abi.encodePacked("s1"));
        (bytes32 lb, bytes32 mr, uint64 ts, bool exists) = settler.resultsBySeason(key);

        assertEq(lb, LB_HASH);
        assertEq(mr, MERKLE_ROOT);
        assertTrue(ts > 0);
        assertTrue(exists);
    }

    // ── Test 2: Normal submit — vault is marked settled ───────────────────────
    function test_NormalSubmit_VaultSettled() public {
        _submit("s2");
        bytes32 key = keccak256(abi.encodePacked("s2"));
        assertTrue(vault.seasonSettled(key));
    }

    // ── Test 3: Non-owner cannot submit ───────────────────────────────────────
    function test_Revert_OnlyOwner() public {
        string[]  memory ids  = new string[](1);
        uint256[] memory ws   = new uint256[](1);
        uint256[] memory reps = new uint256[](0);
        ids[0] = "agent-a"; ws[0] = WAD;

        vm.prank(nonOwner);
        vm.expectRevert(bytes("Ownable: not owner"));
        settler.submitSeasonResult("s3", LB_HASH, MERKLE_ROOT, ids, ws, reps);
    }

    // ── Test 4: Duplicate season submit must revert ────────────────────────────
    function test_Revert_DuplicateSubmit() public {
        _submit("s4");

        string[]  memory ids  = new string[](2);
        uint256[] memory ws   = new uint256[](2);
        uint256[] memory reps = new uint256[](0);
        ids[0] = "agent-a"; ws[0] = 6e17;
        ids[1] = "agent-b"; ws[1] = 4e17;

        vm.prank(owner);
        vm.expectRevert(bytes("SeasonSettler: season already submitted"));
        settler.submitSeasonResult("s4", LB_HASH, MERKLE_ROOT, ids, ws, reps);
    }

    // ── Test 5: Array length mismatch must revert ─────────────────────────────
    function test_Revert_LengthMismatch() public {
        string[]  memory ids  = new string[](2);
        uint256[] memory ws   = new uint256[](1); // mismatch
        uint256[] memory reps = new uint256[](0);
        ids[0] = "agent-a"; ids[1] = "agent-b";
        ws[0]  = WAD;

        vm.prank(owner);
        vm.expectRevert(bytes("SeasonSettler: length mismatch"));
        settler.submitSeasonResult("s5", LB_HASH, MERKLE_ROOT, ids, ws, reps);
    }

    // ── Test 6: SeasonResultSubmitted event is emitted with correct args ───────
    function test_Event_SeasonResultSubmitted() public {
        string[]  memory ids  = new string[](2);
        uint256[] memory ws   = new uint256[](2);
        uint256[] memory reps = new uint256[](0);
        ids[0] = "agent-a"; ws[0] = 6e17;
        ids[1] = "agent-b"; ws[1] = 4e17;

        vm.prank(owner);
        vm.expectEmit(true, true, true, true, address(settler));
        emit SeasonResultSubmitted("s6", LB_HASH, MERKLE_ROOT);
        settler.submitSeasonResult("s6", LB_HASH, MERKLE_ROOT, ids, ws, reps);
    }

    // ── Test 7: setVault permission check ────────────────────────────────────
    function test_Revert_SetVault_NotOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert(bytes("Ownable: not owner"));
        settler.setVault(address(0x999));
    }

    function test_Revert_WhenPaused_Submit() public {
        vm.prank(owner);
        settler.pause();

        string[] memory ids  = new string[](1);
        uint256[] memory ws  = new uint256[](1);
        uint256[] memory reps = new uint256[](0);
        ids[0] = "agent-a";
        ws[0] = WAD;

        vm.prank(owner);
        vm.expectRevert(bytes("SeasonSettler: paused"));
        settler.submitSeasonResult("s7", LB_HASH, MERKLE_ROOT, ids, ws, reps);
    }

    function test_Revert_SetVault_AfterLock() public {
        vm.prank(owner);
        settler.lockVault();

        vm.prank(owner);
        vm.expectRevert(bytes("SeasonSettler: vault locked"));
        settler.setVault(address(0x999));
    }

    event SeasonResultSubmitted(
        string indexed seasonId,
        bytes32 indexed leaderboardHash,
        bytes32 indexed merkleRoot
    );
}
