// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/AgentNFA.sol";
import "../src/AgentAccount.sol";
import "../src/AgentAccountBeacon.sol";
import "../src/AgentAccountRegistry.sol";
import "../src/SynaptexToken.sol";

// ── Helpers ───────────────────────────────────────────────────────────────────

contract ERC721ReceiverGood is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract ERC721ReceiverBad {
    // intentionally missing IERC721Receiver
}

contract PingTarget {
    uint256 public count;
    function ping() external { count += 1; }
}

// ══════════════════════════════════════════════════════════════════════════════
// AgentNFA tests — ERC-721 + ERC-7662 + ERC-7231 + ERC-165
// ══════════════════════════════════════════════════════════════════════════════

contract AgentNFATest is Test {
    AgentNFA nfa;

    address owner = address(0x1);
    address alice = address(0x2);
    address bob   = address(0x3);

    uint256 tokenId;

    function setUp() public {
        AgentNFA impl = new AgentNFA();
        bytes memory init = abi.encodeCall(AgentNFA.initialize, (owner));
        nfa = AgentNFA(address(new ERC1967Proxy(address(impl), init)));

        vm.prank(owner);
        tokenId = nfa.mintAgent(alice, "thunder", "ipfs://agent/thunder");
    }

    // ── ERC-721 ───────────────────────────────────────────────────────────────

    function test_MintAgent() public view {
        assertEq(tokenId, 1);
        assertEq(nfa.ownerOf(tokenId), alice);
        assertEq(nfa.balanceOf(alice), 1);
    }

    function test_Revert_NonOwnerMint() public {
        vm.prank(alice);
        vm.expectRevert(bytes("AgentNFA: not owner"));
        nfa.mintAgent(alice, "frost", "ipfs://agent/frost");
    }

    function test_TransferByOwner() public {
        vm.prank(alice);
        nfa.transferFrom(alice, bob, tokenId);
        assertEq(nfa.ownerOf(tokenId), bob);
    }

    function test_TransferByApproved() public {
        vm.prank(alice);
        nfa.approve(bob, tokenId);

        vm.prank(bob);
        nfa.transferFrom(alice, bob, tokenId);
        assertEq(nfa.ownerOf(tokenId), bob);
    }

    function test_SafeTransferToReceiverContract() public {
        ERC721ReceiverGood receiver = new ERC721ReceiverGood();
        vm.prank(alice);
        nfa.safeTransferFrom(alice, address(receiver), tokenId);
        assertEq(nfa.ownerOf(tokenId), address(receiver));
    }

    function test_Revert_SafeTransferToNonReceiverContract() public {
        ERC721ReceiverBad receiver = new ERC721ReceiverBad();
        vm.prank(alice);
        vm.expectRevert();
        nfa.safeTransferFrom(alice, address(receiver), tokenId);
    }

    // ── ERC-165 ───────────────────────────────────────────────────────────────

    function test_SupportsInterface_ERC165() public view {
        assertTrue(nfa.supportsInterface(0x01ffc9a7), "ERC-165");
    }

    function test_SupportsInterface_ERC721() public view {
        assertTrue(nfa.supportsInterface(0x80ac58cd), "ERC-721");
    }

    function test_SupportsInterface_ERC7662() public view {
        bytes4 id = type(IERC7662).interfaceId;
        assertTrue(nfa.supportsInterface(id), "ERC-7662");
    }

    function test_SupportsInterface_ERC7231() public view {
        bytes4 id = type(IERC7231).interfaceId;
        assertTrue(nfa.supportsInterface(id), "ERC-7231");
    }

    function test_SupportsInterface_Unknown_ReturnsFalse() public view {
        assertFalse(nfa.supportsInterface(0xdeadbeef));
    }

    // ── ERC-7662: AI Agent metadata ───────────────────────────────────────────

    function test_SetAndGetAgentData() public {
        vm.prank(alice);
        nfa.setAgentData(
            tokenId,
            "Thunder",
            "Aggressive breakout hunter",
            "claude-sonnet-4-6",
            "ipfs://prompts/thunder-user",
            "ipfs://prompts/thunder-system",
            false
        );

        (
            string memory agentName,
            string memory description,
            string memory model,
            string memory userPromptURI,
            string memory systemPromptURI,
            bool promptsEncrypted
        ) = nfa.getAgentData(tokenId);

        assertEq(agentName,       "Thunder");
        assertEq(description,     "Aggressive breakout hunter");
        assertEq(model,           "claude-sonnet-4-6");
        assertEq(userPromptURI,   "ipfs://prompts/thunder-user");
        assertEq(systemPromptURI, "ipfs://prompts/thunder-system");
        assertFalse(promptsEncrypted);
    }

    function test_SetAgentData_EmitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit IERC7662.AgentUpdated(tokenId);

        vm.prank(alice);
        nfa.setAgentData(tokenId, "Thunder", "desc", "model", "u", "s", false);
    }

    function test_GetAgentData_DefaultsEmpty() public view {
        // token exists but no metadata set yet — should return empty strings
        (string memory agentName,,,,, ) = nfa.getAgentData(tokenId);
        assertEq(agentName, "");
    }

    function test_Revert_SetAgentData_NotTokenOwner() public {
        vm.prank(bob);
        vm.expectRevert(bytes("AgentNFA: not token owner"));
        nfa.setAgentData(tokenId, "X", "", "", "", "", false);
    }

    function test_Revert_GetAgentData_TokenNotMinted() public {
        vm.expectRevert(bytes("AgentNFA: token not minted"));
        nfa.getAgentData(999);
    }

    function test_SetAgentData_AfterTransfer_NewOwnerCanUpdate() public {
        vm.prank(alice);
        nfa.transferFrom(alice, bob, tokenId);

        vm.prank(bob);
        nfa.setAgentData(tokenId, "Thunder-v2", "Updated", "gpt-4o", "u2", "s2", true);

        (string memory agentName,,,,, bool enc) = nfa.getAgentData(tokenId);
        assertEq(agentName, "Thunder-v2");
        assertTrue(enc);
    }

    function test_Revert_SetAgentData_OldOwnerBlockedAfterTransfer() public {
        vm.prank(alice);
        nfa.transferFrom(alice, bob, tokenId);

        vm.prank(alice);
        vm.expectRevert(bytes("AgentNFA: not token owner"));
        nfa.setAgentData(tokenId, "X", "", "", "", "", false);
    }

    // ── ERC-7231: Identity root ───────────────────────────────────────────────

    function test_SetAndGetIdentitiesRoot() public {
        bytes32 root = keccak256("discord:alice#0001,twitter:alice_eth");

        vm.prank(alice);
        nfa.setIdentitiesRoot(tokenId, root);

        assertEq(nfa.getIdentitiesRoot(tokenId), root);
    }

    function test_SetIdentitiesRoot_EmitsEvent() public {
        bytes32 root = keccak256("discord:alice#0001");

        vm.expectEmit(true, false, false, true);
        emit IERC7231.SetIdentitiesRoot(tokenId, root);

        vm.prank(alice);
        nfa.setIdentitiesRoot(tokenId, root);
    }

    function test_Revert_SetIdentitiesRoot_NotTokenOwner() public {
        vm.prank(bob);
        vm.expectRevert(bytes("AgentNFA: not token owner"));
        nfa.setIdentitiesRoot(tokenId, keccak256("x"));
    }

    function test_GetIdentitiesRoot_DefaultZero() public view {
        assertEq(nfa.getIdentitiesRoot(tokenId), bytes32(0));
    }

    function test_VerifyIdentitiesBinding_ValidSignature() public {
        // Build identity root over one userID
        string[] memory ids = new string[](1);
        ids[0] = "discord:alice#0001";
        bytes32 root = keccak256(abi.encodePacked(ids[0]));

        vm.prank(alice);
        nfa.setIdentitiesRoot(tokenId, root);

        // Build the payload and sign it with alice's key (vm.addr(aliceKey) == alice)
        uint256 aliceKey = 0xA11CE;
        address aliceAddr = vm.addr(aliceKey);

        // Re-mint to aliceAddr so ownerOf matches the signer
        vm.prank(owner);
        uint256 tid2 = nfa.mintAgent(aliceAddr, "frost", "ipfs://frost");

        vm.prank(aliceAddr);
        nfa.setIdentitiesRoot(tid2, root);

        bytes32 payload = keccak256(abi.encode(tid2, aliceAddr, ids, root));
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payload));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, ethHash);
        bytes memory sig = abi.encodePacked(r, s, v);

        assertTrue(nfa.verifyIdentitiesBinding(tid2, aliceAddr, ids, root, sig));
    }

    function test_VerifyIdentitiesBinding_WrongRoot_ReturnsFalse() public {
        bytes32 root = keccak256("root1");
        vm.prank(alice);
        nfa.setIdentitiesRoot(tokenId, root);

        string[] memory ids = new string[](0);
        bytes32 wrongRoot = keccak256("root2");
        assertFalse(nfa.verifyIdentitiesBinding(tokenId, alice, ids, wrongRoot, ""));
    }

    function test_VerifyIdentitiesBinding_WrongOwner_ReturnsFalse() public {
        bytes32 root = keccak256("root");
        vm.prank(alice);
        nfa.setIdentitiesRoot(tokenId, root);

        string[] memory ids = new string[](0);
        assertFalse(nfa.verifyIdentitiesBinding(tokenId, bob, ids, root, ""));
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// AgentAccount tests — ERC-6551 + ERC-1271 + ERC-165
// ══════════════════════════════════════════════════════════════════════════════

contract AgentAccountStandardsTest is Test {
    AgentNFA nfa;
    AgentAccountRegistry registry;
    PingTarget target;
    SynaptexToken token;

    address owner = address(0x1);
    address alice = address(0x2);
    address bob   = address(0x3);

    uint256 aliceKey = 0xA11CE;

    uint256 tokenId;
    AgentAccount account;

    function setUp() public {
        // Deploy NFA
        AgentNFA nfaImpl = new AgentNFA();
        nfa = AgentNFA(address(new ERC1967Proxy(
            address(nfaImpl),
            abi.encodeCall(AgentNFA.initialize, (owner))
        )));

        // Mint to vm.addr(aliceKey) so we can sign
        address aliceAddr = vm.addr(aliceKey);
        vm.prank(owner);
        tokenId = nfa.mintAgent(aliceAddr, "thunder", "ipfs://thunder");

        // Deploy registry
        AgentAccount accountImpl = new AgentAccount();
        AgentAccountBeacon beacon = new AgentAccountBeacon(address(accountImpl), owner);
        registry = new AgentAccountRegistry(address(beacon));

        // Create account
        address accountAddr = registry.createAccount(address(nfa), tokenId, block.chainid, 0);
        account = AgentAccount(payable(accountAddr));

        target = new PingTarget();
        token  = new SynaptexToken(owner, 1_000_000 ether, 2_000_000 ether);
    }

    // ── ERC-165 ───────────────────────────────────────────────────────────────

    function test_SupportsInterface_ERC165() public view {
        assertTrue(account.supportsInterface(0x01ffc9a7));
    }

    function test_SupportsInterface_ERC6551Account() public view {
        assertTrue(account.supportsInterface(0x6faff5f1));
    }

    function test_SupportsInterface_ERC6551Executable() public view {
        assertTrue(account.supportsInterface(0x51945447));
    }

    function test_SupportsInterface_ERC1271() public view {
        assertTrue(account.supportsInterface(0x1626ba7e));
    }

    function test_SupportsInterface_Unknown_ReturnsFalse() public view {
        assertFalse(account.supportsInterface(0xdeadbeef));
    }

    // ── ERC-6551: token() ─────────────────────────────────────────────────────

    function test_Token_ReturnsCorrectValues() public view {
        (uint256 cid, address tc, uint256 tid) = account.token();
        assertEq(cid, block.chainid);
        assertEq(tc,  address(nfa));
        assertEq(tid, tokenId);
    }

    // ── ERC-6551: state() ─────────────────────────────────────────────────────

    function test_State_StartsAtZero() public view {
        assertEq(account.state(), 0);
    }

    function test_State_IncrementsOnExecute() public {
        vm.prank(vm.addr(aliceKey));
        account.execute(address(target), 0, abi.encodeWithSignature("ping()"), 0);
        assertEq(account.state(), 1);

        vm.prank(vm.addr(aliceKey));
        account.execute(address(target), 0, abi.encodeWithSignature("ping()"), 0);
        assertEq(account.state(), 2);
    }

    function test_State_IncrementsOnExecuteCall() public {
        vm.prank(vm.addr(aliceKey));
        account.executeCall(address(target), 0, abi.encodeWithSignature("ping()"));
        assertEq(account.state(), 1);
    }

    // ── ERC-6551: isValidSigner() ─────────────────────────────────────────────

    function test_IsValidSigner_OwnerReturnsSelector() public view {
        bytes4 result = account.isValidSigner(vm.addr(aliceKey), "");
        assertEq(result, IERC6551Account.isValidSigner.selector);
    }

    function test_IsValidSigner_StrangerReturnsZero() public view {
        bytes4 result = account.isValidSigner(bob, "");
        assertEq(result, bytes4(0));
    }

    // ── ERC-6551: execute() ───────────────────────────────────────────────────

    function test_Execute_CALLWorks() public {
        vm.prank(vm.addr(aliceKey));
        account.execute(address(target), 0, abi.encodeWithSignature("ping()"), 0);
        assertEq(target.count(), 1);
    }

    function test_Revert_Execute_NonCALL() public {
        vm.prank(vm.addr(aliceKey));
        vm.expectRevert(bytes("AgentAccount: only CALL supported"));
        account.execute(address(target), 0, "", 1); // DELEGATECALL
    }

    function test_Revert_Execute_NotAuthorized() public {
        vm.prank(bob);
        vm.expectRevert(bytes("AgentAccount: not authorized"));
        account.execute(address(target), 0, abi.encodeWithSignature("ping()"), 0);
    }

    // ── ERC-1271: isValidSignature() ─────────────────────────────────────────

    function test_IsValidSignature_OwnerSignature() public view {
        bytes32 hash = keccak256("test message");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, hash);
        bytes memory sig = abi.encodePacked(r, s, v);

        bytes4 result = account.isValidSignature(hash, sig);
        assertEq(result, bytes4(0x1626ba7e));
    }

    function test_IsValidSignature_WrongSigner_ReturnsFail() public view {
        bytes32 hash = keccak256("test message");
        uint256 bobKey = 0xB0B;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(bobKey, hash);
        bytes memory sig = abi.encodePacked(r, s, v);

        bytes4 result = account.isValidSignature(hash, sig);
        assertEq(result, bytes4(0xffffffff));
    }

    function test_IsValidSignature_InvalidLength_ReturnsFail() public view {
        bytes32 hash = keccak256("x");
        bytes4 result = account.isValidSignature(hash, "");
        assertEq(result, bytes4(0xffffffff));
    }

    // ── ERC-6551 Registry: IERC6551Registry interface ─────────────────────────

    function test_Registry_CreateAccount_ERC6551Signature() public {
        // Use the ERC-6551-compliant signature: (implementation, bytes32 salt, chainId, tokenContract, tokenId)
        address expected = registry.account(
            registry.beacon(), bytes32(uint256(0)), block.chainid, address(nfa), tokenId
        );
        address actual = registry.createAccount(
            registry.beacon(), bytes32(uint256(0)), block.chainid, address(nfa), tokenId
        );
        assertEq(actual, expected);
    }

    function test_Registry_CreateAccount_Idempotent() public {
        address first  = registry.createAccount(registry.beacon(), bytes32(0), block.chainid, address(nfa), tokenId);
        address second = registry.createAccount(registry.beacon(), bytes32(0), block.chainid, address(nfa), tokenId);
        assertEq(first, second);
    }

    function test_Registry_Account_MatchesAccountAddress() public view {
        address via6551   = registry.account(registry.beacon(), bytes32(0), block.chainid, address(nfa), tokenId);
        address viaHelper = registry.accountAddress(address(nfa), tokenId, block.chainid, 0);
        assertEq(via6551, viaHelper);
    }

    function test_Registry_EmitsERC6551AccountCreated() public {
        vm.prank(owner);
        uint256 tid2 = nfa.mintAgent(vm.addr(aliceKey), "frost", "ipfs://frost");

        address expectedAddr = registry.account(registry.beacon(), bytes32(uint256(1)), block.chainid, address(nfa), tid2);

        vm.expectEmit(false, true, true, false);
        emit IERC6551Registry.ERC6551AccountCreated(
            expectedAddr,
            registry.beacon(),
            bytes32(uint256(1)),
            block.chainid,
            address(nfa),
            tid2
        );
        registry.createAccount(registry.beacon(), bytes32(uint256(1)), block.chainid, address(nfa), tid2);
    }

    // ── Existing tests (preserved) ────────────────────────────────────────────

    function test_CreateAccount_DeterministicAddress() public {
        address expected = registry.accountAddress(address(nfa), tokenId, block.chainid, 0);
        address actual   = registry.createAccount(address(nfa), tokenId, block.chainid, 0);
        assertEq(actual, expected);

        address again = registry.createAccount(address(nfa), tokenId, block.chainid, 0);
        assertEq(again, expected);
    }

    function test_AccountOwner_FollowsNFAOwner() public {
        address aliceAddr = vm.addr(aliceKey);
        assertEq(account.owner(), aliceAddr);

        vm.prank(aliceAddr);
        nfa.transferFrom(aliceAddr, bob, tokenId);
        assertEq(account.owner(), bob);
    }

    function test_ExecuteCall_OnlyTokenOwner() public {
        vm.prank(bob);
        vm.expectRevert(bytes("AgentAccount: not authorized"));
        account.executeCall(address(target), 0, abi.encodeWithSignature("ping()"));

        vm.prank(vm.addr(aliceKey));
        account.executeCall(address(target), 0, abi.encodeWithSignature("ping()"));
        assertEq(target.count(), 1);
    }

    function test_Authorization_DoesNotPersistAcrossOwnerTransfer() public {
        address aliceAddr = vm.addr(aliceKey);

        vm.prank(aliceAddr);
        account.setAuthorizedCaller(bob, true);
        assertTrue(account.authorizedCallersByOwner(aliceAddr, bob));

        vm.prank(bob);
        account.executeCall(address(target), 0, abi.encodeWithSignature("ping()"));
        assertEq(target.count(), 1);

        vm.prank(aliceAddr);
        nfa.transferFrom(aliceAddr, bob, tokenId);

        vm.prank(aliceAddr);
        vm.expectRevert(bytes("AgentAccount: not authorized"));
        account.executeCall(address(target), 0, abi.encodeWithSignature("ping()"));
    }

    function test_Rescue_WhenOwnerUnavailable() public {
        address aliceAddr = vm.addr(aliceKey);
        address accountAddr = registry.createAccount(address(nfa), tokenId, block.chainid + 1, 0);
        AgentAccount acc = AgentAccount(payable(accountAddr));
        assertEq(acc.owner(), address(0));

        vm.prank(owner);
        token.transfer(accountAddr, 100 ether);
        vm.deal(accountAddr, 1 ether);

        uint256 bobEthBefore   = bob.balance;
        uint256 bobTokenBefore = token.balanceOf(bob);

        vm.prank(owner);
        registry.rescueAccountNative(accountAddr, payable(bob), 0.25 ether);
        vm.prank(owner);
        registry.rescueAccountERC20(accountAddr, address(token), bob, 40 ether);

        assertEq(bob.balance - bobEthBefore,           0.25 ether);
        assertEq(token.balanceOf(bob) - bobTokenBefore, 40 ether);
    }

    function test_Revert_Rescue_NotBeaconOwner() public {
        address accountAddr = registry.createAccount(address(nfa), tokenId, block.chainid + 1, 1);

        vm.prank(alice);
        vm.expectRevert(bytes("AgentAccountRegistry: not beacon owner"));
        registry.rescueAccountNative(accountAddr, payable(alice), 1);
    }
}
