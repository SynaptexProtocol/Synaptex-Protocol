// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/LearningRootOracle.sol";

contract LearningRootOracleTest is Test {
    LearningRootOracle oracle;

    address owner = address(0x1);
    address nonOwner = address(0x2);

    bytes32 constant ROOT = bytes32(uint256(0x1234));

    function setUp() public {
        LearningRootOracle impl = new LearningRootOracle();
        bytes memory init = abi.encodeCall(LearningRootOracle.initialize, (owner));
        oracle = LearningRootOracle(address(new ERC1967Proxy(address(impl), init)));
    }

    function test_SubmitCycleRoot() public {
        vm.prank(owner);
        oracle.submitCycleRoot("season-1", "cycle-1", ROOT);

        bytes32 s = keccak256(abi.encodePacked("season-1"));
        bytes32 c = keccak256(abi.encodePacked("cycle-1"));
        (bytes32 root, uint64 ts, bool exists) = oracle.cycleRoots(s, c);
        assertEq(root, ROOT);
        assertTrue(ts > 0);
        assertTrue(exists);
        assertEq(oracle.seasonCycleCount(s), 1);
        assertTrue(oracle.hasCycleRoot("season-1", "cycle-1"));
    }

    function test_Revert_DuplicateCycle() public {
        vm.prank(owner);
        oracle.submitCycleRoot("season-1", "cycle-1", ROOT);

        vm.prank(owner);
        vm.expectRevert(bytes("LearningRootOracle: cycle exists"));
        oracle.submitCycleRoot("season-1", "cycle-1", ROOT);
    }

    function test_Revert_WhenPaused() public {
        vm.prank(owner);
        oracle.pause();

        vm.prank(owner);
        vm.expectRevert(bytes("LearningRootOracle: paused"));
        oracle.submitCycleRoot("season-1", "cycle-1", ROOT);
    }

    function test_Revert_NonOwnerSubmit() public {
        vm.prank(nonOwner);
        vm.expectRevert(bytes("Ownable: not owner"));
        oracle.submitCycleRoot("season-1", "cycle-1", ROOT);
    }
}
