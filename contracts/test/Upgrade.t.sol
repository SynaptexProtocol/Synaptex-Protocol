// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/AgentNFA.sol";
import "../src/SeasonSettler.sol";
import "../src/LearningRootOracle.sol";
import "../src/AgentAccount.sol";
import "../src/AgentAccountBeacon.sol";
import "../src/AgentAccountRegistry.sol";
import "../src/SynaptexToken.sol";
import "../src/ArenaVault.sol";

// ── Minimal V2 implementations for upgrade testing ───────────────────────────

contract AgentNFAV2 is AgentNFA {
    function version() external pure returns (string memory) { return "v2"; }
}

contract SeasonSettlerV2 is SeasonSettler {
    function version() external pure returns (string memory) { return "v2"; }
}

contract LearningRootOracleV2 is LearningRootOracle {
    function version() external pure returns (string memory) { return "v2"; }
}

contract AgentAccountV2 is AgentAccount {
    function version() external pure returns (string memory) { return "v2"; }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

contract UpgradeTest is Test {
    address owner = address(0x1);
    address alice = address(0x2);
    address nonOwner = address(0x9);

    // ── AgentNFA UUPS upgrade ─────────────────────────────────────────────────

    function test_AgentNFA_UpgradeToV2_StoragePreserved() public {
        // Deploy proxy
        AgentNFA impl = new AgentNFA();
        AgentNFA nfa = AgentNFA(address(
            new ERC1967Proxy(address(impl), abi.encodeCall(AgentNFA.initialize, (owner)))
        ));

        // Mint a token before upgrade
        vm.prank(owner);
        uint256 tokenId = nfa.mintAgent(alice, "thunder", "ipfs://thunder");
        assertEq(nfa.ownerOf(tokenId), alice);

        // Upgrade to V2
        AgentNFAV2 implV2 = new AgentNFAV2();
        vm.prank(owner);
        nfa.upgradeToAndCall(address(implV2), "");

        // Storage unchanged after upgrade
        assertEq(nfa.ownerOf(tokenId), alice);
        assertEq(nfa.balanceOf(alice), 1);
        assertEq(nfa.owner(), owner);

        // New function available
        assertEq(AgentNFAV2(address(nfa)).version(), "v2");
    }

    function test_AgentNFA_Revert_NonOwner_Upgrade() public {
        AgentNFA impl = new AgentNFA();
        AgentNFA nfa = AgentNFA(address(
            new ERC1967Proxy(address(impl), abi.encodeCall(AgentNFA.initialize, (owner)))
        ));

        AgentNFAV2 implV2 = new AgentNFAV2();
        vm.prank(nonOwner);
        vm.expectRevert(bytes("AgentNFA: not owner"));
        nfa.upgradeToAndCall(address(implV2), "");
    }

    function test_AgentNFA_Revert_DoubleInitialize() public {
        AgentNFA impl = new AgentNFA();
        AgentNFA nfa = AgentNFA(address(
            new ERC1967Proxy(address(impl), abi.encodeCall(AgentNFA.initialize, (owner)))
        ));

        vm.expectRevert();
        nfa.initialize(owner);
    }

    // ── SeasonSettler UUPS upgrade ────────────────────────────────────────────

    function test_SeasonSettler_UpgradeToV2_StoragePreserved() public {
        SynaptexToken token = new SynaptexToken(owner, 1_000_000 ether, 10_000_000 ether);
        ArenaVault vault = new ArenaVault(address(token), owner);

        SeasonSettler impl = new SeasonSettler();
        SeasonSettler settler = SeasonSettler(address(
            new ERC1967Proxy(
                address(impl),
                abi.encodeCall(SeasonSettler.initialize, (address(vault), owner))
            )
        ));

        vm.prank(owner);
        vault.setSettler(address(settler));

        // Submit a season to verify storage persists after upgrade
        string[] memory ids = new string[](1);
        uint256[] memory ws = new uint256[](1);
        uint256[] memory reps = new uint256[](0);
        ids[0] = "agent-a"; ws[0] = 1e18;

        vm.prank(owner);
        settler.submitSeasonResult("s1", bytes32(uint256(0xAB)), bytes32(uint256(0xCD)), ids, ws, reps);

        // Upgrade to V2
        SeasonSettlerV2 implV2 = new SeasonSettlerV2();
        vm.prank(owner);
        settler.upgradeToAndCall(address(implV2), "");

        // Storage preserved
        bytes32 key = keccak256(abi.encodePacked("s1"));
        (, , , bool exists) = settler.resultsBySeason(key);
        assertTrue(exists);
        assertEq(settler.owner(), owner);

        // New function available
        assertEq(SeasonSettlerV2(address(settler)).version(), "v2");
    }

    function test_SeasonSettler_Revert_NonOwner_Upgrade() public {
        SynaptexToken token = new SynaptexToken(owner, 1_000_000 ether, 10_000_000 ether);
        ArenaVault vault = new ArenaVault(address(token), owner);

        SeasonSettler impl = new SeasonSettler();
        SeasonSettler settler = SeasonSettler(address(
            new ERC1967Proxy(
                address(impl),
                abi.encodeCall(SeasonSettler.initialize, (address(vault), owner))
            )
        ));

        SeasonSettlerV2 implV2 = new SeasonSettlerV2();
        vm.prank(nonOwner);
        vm.expectRevert(bytes("Ownable: not owner"));
        settler.upgradeToAndCall(address(implV2), "");
    }

    // ── LearningRootOracle UUPS upgrade ───────────────────────────────────────

    function test_LearningRootOracle_UpgradeToV2_StoragePreserved() public {
        LearningRootOracle impl = new LearningRootOracle();
        LearningRootOracle oracle = LearningRootOracle(address(
            new ERC1967Proxy(address(impl), abi.encodeCall(LearningRootOracle.initialize, (owner)))
        ));

        bytes32 root = bytes32(uint256(0x1234));
        vm.prank(owner);
        oracle.submitCycleRoot("season-1", "cycle-1", root);

        // Upgrade to V2
        LearningRootOracleV2 implV2 = new LearningRootOracleV2();
        vm.prank(owner);
        oracle.upgradeToAndCall(address(implV2), "");

        // Storage preserved
        assertTrue(oracle.hasCycleRoot("season-1", "cycle-1"));
        bytes32 s = keccak256(abi.encodePacked("season-1"));
        assertEq(oracle.seasonCycleCount(s), 1);

        // New function available
        assertEq(LearningRootOracleV2(address(oracle)).version(), "v2");
    }

    function test_LearningRootOracle_Revert_DoubleInitialize() public {
        LearningRootOracle impl = new LearningRootOracle();
        LearningRootOracle oracle = LearningRootOracle(address(
            new ERC1967Proxy(address(impl), abi.encodeCall(LearningRootOracle.initialize, (owner)))
        ));

        vm.expectRevert();
        oracle.initialize(owner);
    }

    // ── AgentAccount Beacon upgrade ───────────────────────────────────────────

    function test_AgentAccount_BeaconUpgrade_AllProxiesUpdated() public {
        // Deploy NFA proxy
        AgentNFA nfaImpl = new AgentNFA();
        AgentNFA nfa = AgentNFA(address(
            new ERC1967Proxy(address(nfaImpl), abi.encodeCall(AgentNFA.initialize, (owner)))
        ));

        vm.prank(owner);
        uint256 tokenId = nfa.mintAgent(alice, "thunder", "ipfs://thunder");

        // Deploy beacon + registry
        AgentAccount accountImpl = new AgentAccount();
        AgentAccountBeacon beacon = new AgentAccountBeacon(address(accountImpl), owner);
        AgentAccountRegistry registry = new AgentAccountRegistry(address(beacon));

        // Create two separate accounts
        address payable acc1 = payable(registry.createAccount(address(nfa), tokenId, block.chainid, 0));
        address payable acc2 = payable(registry.createAccount(address(nfa), tokenId, block.chainid, 1));

        // Verify they are v1 (no version() function yet)
        vm.expectRevert();
        AgentAccountV2(acc1).version();

        // Upgrade beacon → all accounts upgrade atomically
        AgentAccountV2 implV2 = new AgentAccountV2();
        vm.prank(owner);
        beacon.upgradeTo(address(implV2));

        // Both accounts now expose version()
        assertEq(AgentAccountV2(acc1).version(), "v2");
        assertEq(AgentAccountV2(acc2).version(), "v2");

        // Storage preserved on acc1
        assertEq(AgentAccount(payable(acc1)).tokenContract(), address(nfa));
        assertEq(AgentAccount(payable(acc1)).tokenId(), tokenId);
        assertEq(AgentAccount(payable(acc1)).owner(), alice);
    }

    function test_AgentAccount_Revert_NonOwner_BeaconUpgrade() public {
        AgentAccount accountImpl = new AgentAccount();
        AgentAccountBeacon beacon = new AgentAccountBeacon(address(accountImpl), owner);

        AgentAccountV2 implV2 = new AgentAccountV2();
        vm.prank(nonOwner);
        vm.expectRevert();
        beacon.upgradeTo(address(implV2));
    }

    function test_AgentAccount_Revert_DoubleInitialize() public {
        AgentNFA nfaImpl = new AgentNFA();
        AgentNFA nfa = AgentNFA(address(
            new ERC1967Proxy(address(nfaImpl), abi.encodeCall(AgentNFA.initialize, (owner)))
        ));
        vm.prank(owner);
        uint256 tokenId = nfa.mintAgent(alice, "aurora", "ipfs://aurora");

        AgentAccount accountImpl = new AgentAccount();
        AgentAccountBeacon beacon = new AgentAccountBeacon(address(accountImpl), owner);
        AgentAccountRegistry registry = new AgentAccountRegistry(address(beacon));

        address acc = registry.createAccount(address(nfa), tokenId, block.chainid, 0);

        vm.expectRevert();
        AgentAccount(payable(acc)).initialize(address(nfa), tokenId, block.chainid);
    }
}
