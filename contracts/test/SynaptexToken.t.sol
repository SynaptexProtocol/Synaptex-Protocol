// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SynaptexToken.sol";

contract SynaptexTokenTest is Test {
    address owner = address(0x1);
    address alice = address(0x2);
    address bob = address(0x3);

    function test_CapEnforced_OnMint() public {
        SynaptexToken token = new SynaptexToken(owner, 1_000 ether, 1_100 ether);

        vm.prank(owner);
        token.mint(alice, 100 ether);
        assertEq(token.totalSupply(), 1_100 ether);

        vm.prank(owner);
        vm.expectRevert(bytes("ERC20: cap exceeded"));
        token.mint(alice, 1);
    }

    function test_Revert_InitialSupplyExceedsCap() public {
        vm.expectRevert(bytes("ERC20: initial supply exceeds cap"));
        new SynaptexToken(owner, 1_001 ether, 1_000 ether);
    }

    function test_Revert_ZeroCap() public {
        vm.expectRevert(bytes("ERC20: zero cap"));
        new SynaptexToken(owner, 1_000 ether, 0);
    }

    function test_TwoStepOwnershipTransfer() public {
        SynaptexToken token = new SynaptexToken(owner, 1_000 ether, 2_000 ether);

        vm.prank(owner);
        token.transferOwnership(alice);
        assertEq(token.owner(), owner);
        assertEq(token.pendingOwner(), alice);

        vm.prank(bob);
        vm.expectRevert(bytes("Ownable: not pending owner"));
        token.acceptOwnership();

        vm.prank(alice);
        token.acceptOwnership();
        assertEq(token.owner(), alice);
        assertEq(token.pendingOwner(), address(0));
    }
}
