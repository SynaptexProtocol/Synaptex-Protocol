// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/SynaptexToken.sol";
import "../src/ArenaVault.sol";
import "../src/SeasonSettler.sol";
import "../src/AgentNFA.sol";
import "../src/AgentAccount.sol";
import "../src/AgentAccountRegistry.sol";
import "../src/AgentAccountBeacon.sol";

// =============================================================================
// 对抗性测试套件
// 验证 4 个核心安全假设:
//   1. SeasonSettler CEI 重入防护
//   2. ArenaVault 代币守恒性
//   3. AgentAccount 所有权转移后授权完全失效
//   4. 升级存储布局不破坏已有状态
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// 测试 1: 重入攻击 — 恶意 Vault 在 setSeasonWeights 回调中试图再次结算
// ─────────────────────────────────────────────────────────────────────────────

/// @dev 恶意 Vault: 在 setSeasonWeights 被调用时，立刻回调 settler.submitSeasonResult
contract MaliciousVaultReentrant {
    SeasonSettler public settler;
    bool public attackFired;
    bool public attackSucceeded;
    string public attackSeasonId;

    function setSettler(address s) external { settler = SeasonSettler(s); }

    // 恶意 vault 接受 setSeasonWeights 调用后立刻重入
    function setSeasonWeights(
        string calldata seasonId,
        string[] calldata agentIds,
        uint256[] calldata weightsWad
    ) external {
        if (!attackFired) {
            attackFired = true;
            // 试图重入：相同 seasonId 再次提交
            string[] memory ids2 = new string[](1);
            uint256[] memory ws2 = new uint256[](1);
            uint256[] memory reps = new uint256[](0);
            ids2[0] = agentIds[0];
            ws2[0] = 1e18;
            try settler.submitSeasonResult(seasonId, bytes32(0), bytes32(0), ids2, ws2, reps) {
                attackSucceeded = true;
            } catch {
                attackSucceeded = false;
            }
        }
    }

    // 让 settler 可以调用 setVault 切换到恶意 vault
    function setSeasonWeightsSimple(string calldata, string[] calldata, uint256[] calldata) external {}
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试 2: 代币守恒 — 恶意 ERC20 在 transfer 回调中试图重入 claim
// ─────────────────────────────────────────────────────────────────────────────

/// @dev 恶意 ERC20: 在 transfer 时尝试回调 vault.claim
contract MaliciousToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public vault;
    bool public attackFired;
    bool public attackSucceeded;
    string public reentrantSeasonId;

    function setVault(address v) external { vault = v; }
    function setReentrantSeason(string calldata s) external { reentrantSeasonId = s; }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    // 在 transfer 被调用时（vault 发钱给用户）尝试重入 claim
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        // 尝试重入
        if (!attackFired && msg.sender == vault) {
            attackFired = true;
            try ArenaVault(vault).claim(reentrantSeasonId) {
                attackSucceeded = true;
            } catch {
                attackSucceeded = false;
            }
        }
        return true;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试 3: 升级后的 AgentAccount impl (存储布局兼容性验证)
// ─────────────────────────────────────────────────────────────────────────────

/// @dev 升级版 AgentAccount: 在原有存储末尾追加新字段
contract AgentAccountV2 is AgentAccount {
    // 追加新字段 (slot 6) — 不改动 slot 0-5
    uint256 public newFeatureFlag;

    function setNewFeatureFlag(uint256 v) external {
        address currentOwner = owner();
        require(msg.sender == currentOwner, "AgentAccount: not token owner");
        newFeatureFlag = v;
    }
}

// =============================================================================
// 主测试合约
// =============================================================================

contract AdversarialTest is Test {
    SynaptexToken  token;
    ArenaVault  vault;
    SeasonSettler settler;
    AgentNFA    nfa;

    address owner   = address(0x1);
    address alice   = address(0x2);
    address bob     = address(0x3);
    address carol   = address(0x4);
    address dave    = address(0x5);

    uint256 constant WAD   = 1e18;
    uint256 constant STAKE = 1_000 ether;

    // ── Setup ─────────────────────────────────────────────────────────────────

    function setUp() public {
        vm.startPrank(owner);

        token = new SynaptexToken(owner, 10_000_000 ether, 100_000_000 ether);
        vault = new ArenaVault(address(token), owner);

        SeasonSettler settlerImpl = new SeasonSettler();
        bytes memory init = abi.encodeCall(
            SeasonSettler.initialize, (address(vault), owner)
        );
        settler = SeasonSettler(address(new ERC1967Proxy(address(settlerImpl), init)));

        AgentNFA nfaImpl = new AgentNFA();
        bytes memory nfaInit = abi.encodeCall(AgentNFA.initialize, (owner));
        nfa = AgentNFA(address(new ERC1967Proxy(address(nfaImpl), nfaInit)));

        vault.setSettler(address(settler));
        settler.setAgentNFA(address(nfa));
        nfa.setAuthorizedSettler(address(settler), true);

        token.transfer(alice, 5_000 ether);
        token.transfer(bob,   5_000 ether);
        token.transfer(carol, 5_000 ether);

        vm.stopPrank();

        vm.prank(alice); token.approve(address(vault), type(uint256).max);
        vm.prank(bob);   token.approve(address(vault), type(uint256).max);
        vm.prank(carol); token.approve(address(vault), type(uint256).max);
    }

    // =========================================================================
    // 测试集 1: 重入攻击防护 (SeasonSettler CEI)
    // =========================================================================

    /// @notice 验证：恶意 vault 在 setSeasonWeights 回调中试图重入 submitSeasonResult
    ///         CEI 修复应保证第一次写入 resultsBySeason[s].exists=true 后，
    ///         重入调用被 "season already submitted" 拦截
    function test_Adversarial_Reentrancy_SubmitSeasonResult_Blocked() public {
        // 部署恶意 vault
        MaliciousVaultReentrant malVault = new MaliciousVaultReentrant();
        malVault.setSettler(address(settler));

        // owner 将 settler 的 vault 切换为恶意 vault
        vm.prank(owner);
        settler.setVault(address(malVault));

        // 触发结算 — 恶意 vault 的 setSeasonWeights 会尝试重入
        string[] memory ids  = new string[](1);
        uint256[] memory ws  = new uint256[](1);
        uint256[] memory reps = new uint256[](0);
        ids[0] = "agent-a"; ws[0] = WAD;

        vm.prank(owner);
        settler.submitSeasonResult("s_attack", bytes32(uint256(1)), bytes32(uint256(2)), ids, ws, reps);

        // 验证：攻击被触发了（确认测试真的在测攻击路径）
        assertTrue(malVault.attackFired(), "Attack should have been attempted");
        // 验证：攻击没有成功（CEI 防护有效）
        assertFalse(malVault.attackSucceeded(), "CEI protection FAILED: reentrancy succeeded");

        // 验证：原始结算确实完成了，链上状态正确
        bytes32 key = keccak256(abi.encodePacked("s_attack"));
        (, , , bool exists) = settler.resultsBySeason(key);
        assertTrue(exists, "Original settlement should exist");
    }

    /// @notice 验证：同一赛季二次结算直接调用也被拒绝（幂等性保护）
    function test_Adversarial_DirectDoubleSubmit_Blocked() public {
        string[] memory ids  = new string[](1);
        uint256[] memory ws  = new uint256[](1);
        uint256[] memory reps = new uint256[](0);
        ids[0] = "agent-a"; ws[0] = WAD;

        vm.prank(owner);
        settler.submitSeasonResult("s_double", bytes32(uint256(1)), bytes32(uint256(2)), ids, ws, reps);

        vm.prank(owner);
        vm.expectRevert(bytes("SeasonSettler: season already submitted"));
        settler.submitSeasonResult("s_double", bytes32(uint256(3)), bytes32(uint256(4)), ids, ws, reps);
    }

    // =========================================================================
    // 测试集 2: ArenaVault 代币守恒性
    // =========================================================================

    /// @notice 验证：所有人 claim 之后，vault 余额精确为 0（代币既不多也不少）
    function test_Adversarial_TokenConservation_MultiStaker_MultiAgent() public {
        // 3 个用户，2 个 agent，不同质押量
        vm.prank(alice); vault.stake("s_conserve", "agent-a", 600 ether);
        vm.prank(alice); vault.stake("s_conserve", "agent-b", 400 ether);
        vm.prank(bob);   vault.stake("s_conserve", "agent-a", 300 ether);
        vm.prank(carol); vault.stake("s_conserve", "agent-b", 700 ether);

        // 总池 = 2000 ARENA; agent-a 总质押 = 900, agent-b 总质押 = 1100
        uint256 totalPool = 2_000 ether;
        assertEq(token.balanceOf(address(vault)), totalPool, "Vault should hold all staked tokens");

        // 结算: agent-a=55%, agent-b=45%
        string[]  memory ids = new string[](2);
        uint256[] memory ws  = new uint256[](2);
        uint256[] memory reps = new uint256[](0);
        ids[0] = "agent-a"; ws[0] = 55e16;
        ids[1] = "agent-b"; ws[1] = 45e16;
        vm.prank(owner);
        settler.submitSeasonResult("s_conserve", bytes32(uint256(1)), bytes32(uint256(2)), ids, ws, reps);

        uint256 aliceBefore = token.balanceOf(alice);
        uint256 bobBefore   = token.balanceOf(bob);
        uint256 carolBefore = token.balanceOf(carol);

        vm.prank(alice); vault.claim("s_conserve");
        vm.prank(bob);   vault.claim("s_conserve");
        vm.prank(carol); vault.claim("s_conserve");

        uint256 aliceGot = token.balanceOf(alice) - aliceBefore;
        uint256 bobGot   = token.balanceOf(bob)   - bobBefore;
        uint256 carolGot = token.balanceOf(carol) - carolBefore;

        uint256 totalPaidOut = aliceGot + bobGot + carolGot;

        // 核心守恒断言: 支出总量不超过输入总量（允许精度误差 ≤ 3 wei）
        assertApproxEqAbs(totalPaidOut, totalPool, 3, "Token conservation violated");

        // 验证：vault 余额接近 0（剩余仅来自整除精度损耗）
        uint256 vaultRemainder = token.balanceOf(address(vault));
        assertLe(vaultRemainder, 3, "Vault should be empty after all claims");

        // 验证：没有人凭空得到超出自己应得份额的钱
        // Alice: agent-a 600/900 * 2000 * 0.55 + agent-b 400/1100 * 2000 * 0.45
        // = 733.33 + 327.27 ≈ 1060.6
        uint256 aliceExpected = (2000 ether * 55e16 * 600 ether) / (WAD * 900 ether)
                              + (2000 ether * 45e16 * 400 ether) / (WAD * 1100 ether);
        assertApproxEqAbs(aliceGot, aliceExpected, 2, "Alice payout incorrect");
    }

    /// @notice 验证：恶意 token 在 transfer 时尝试重入 claim，被 nonReentrant 拦截
    function test_Adversarial_Reentrancy_Claim_BlockedByNonReentrant() public {
        // 用恶意 token 部署一个新 vault
        MaliciousToken malToken = new MaliciousToken();
        ArenaVault malVault = new ArenaVault(address(malToken), owner);

        vm.prank(owner);
        malVault.setSettler(owner);

        // alice 质押 (malToken 直接 mint)
        malToken.mint(alice, 1_000 ether);
        vm.prank(alice);
        malToken.approve(address(malVault), type(uint256).max);
        vm.prank(alice);
        malVault.stake("s_reentrant", "agent-a", STAKE);

        // 配置恶意 token 的重入目标
        malToken.setVault(address(malVault));
        malToken.setReentrantSeason("s_reentrant");

        // 结算
        string[]  memory ids = new string[](1);
        uint256[] memory ws  = new uint256[](1);
        ids[0] = "agent-a"; ws[0] = WAD;
        vm.prank(owner);
        malVault.setSeasonWeights("s_reentrant", ids, ws);

        // alice 发起 claim — 恶意 token 的 transfer 会尝试重入 claim
        vm.prank(alice);
        malVault.claim("s_reentrant");

        // 验证：重入攻击被 nonReentrant 拦截
        assertTrue(malToken.attackFired(), "Reentrancy should have been attempted");
        assertFalse(malToken.attackSucceeded(), "nonReentrant FAILED: reentrancy in claim succeeded");
    }

    /// @notice 验证：已 claim 的用户不能通过 claimAgent 再次领取
    function test_Adversarial_ClaimThenClaimAgent_Blocked() public {
        vm.prank(alice); vault.stake("s_double_claim", "agent-a", STAKE);

        string[]  memory ids = new string[](1);
        uint256[] memory ws  = new uint256[](1);
        uint256[] memory reps = new uint256[](0);
        ids[0] = "agent-a"; ws[0] = WAD;
        vm.prank(owner);
        settler.submitSeasonResult("s_double_claim", bytes32(uint256(1)), bytes32(uint256(2)), ids, ws, reps);

        vm.prank(alice); vault.claim("s_double_claim");

        // 尝试再次通过 claimAgent 领取
        vm.prank(alice);
        vm.expectRevert(bytes("ArenaVault: already claimed"));
        vault.claimAgent("s_double_claim", "agent-a");
    }

    // =========================================================================
    // 测试集 3: AgentAccount 所有权转移后授权完全失效
    // =========================================================================

    function _deployAgentAccount() internal returns (AgentAccount account, uint256 tokenId) {
        // 创建 AgentAccount registry + beacon
        AgentAccount accountImpl = new AgentAccount();
        AgentAccountBeacon beacon = new AgentAccountBeacon(address(accountImpl), owner);
        AgentAccountRegistry registry = new AgentAccountRegistry(address(beacon));

        // mint NFA token to alice
        vm.prank(owner);
        tokenId = nfa.mintAgent(alice, "test-agent", "ipfs://test");

        // deploy TBA
        registry.createAccount(address(nfa), tokenId, block.chainid, 0);
        address accountAddr = registry.accountAddress(address(nfa), tokenId, block.chainid, 0);
        account = AgentAccount(payable(accountAddr));
    }

    /// @notice 核心安全验证：
    ///         alice 授权 bob 可以执行 → alice 转移 NFT 给 carol
    ///         → bob 试图执行 → 必须被拒绝（旧 owner 的授权随所有权转移而失效）
    function test_Adversarial_AuthInvalidatedAfterOwnerTransfer() public {
        (AgentAccount account, uint256 tokenId) = _deployAgentAccount();

        // alice 授权 bob
        vm.prank(alice);
        account.setAuthorizedCaller(bob, true);

        // bob 可以执行（授权有效）
        vm.prank(bob);
        account.executeCall(address(0x9999), 0, "");

        // alice 把 NFT 转给 carol
        vm.prank(alice);
        nfa.transferFrom(alice, carol, tokenId);

        // bob 再次尝试执行 — 必须被拒绝
        vm.prank(bob);
        vm.expectRevert(bytes("AgentAccount: not authorized"));
        account.executeCall(address(0x9999), 0, "");

        // carol（新 owner）可以执行
        vm.prank(carol);
        account.executeCall(address(0x9999), 0, "");

        // carol 授权 dave
        vm.prank(carol);
        account.setAuthorizedCaller(dave, true);

        // dave 可以执行（carol 的授权有效）
        vm.prank(dave);
        account.executeCall(address(0x9999), 0, "");

        // bob 仍然不能执行（bob 只被 alice 授权过，alice 不再是 owner）
        vm.prank(bob);
        vm.expectRevert(bytes("AgentAccount: not authorized"));
        account.executeCall(address(0x9999), 0, "");
    }

    /// @notice 验证：前任 owner 的授权记录仍在存储里，但因 owner() 已变，无法被利用
    function test_Adversarial_StaleAuthInStorage_CannotBeExploited() public {
        (AgentAccount account, uint256 tokenId) = _deployAgentAccount();

        // alice 授权 bob（写入 authorizedCallersByOwner[alice][bob] = true）
        vm.prank(alice);
        account.setAuthorizedCaller(bob, true);

        // 确认旧记录仍在
        assertTrue(account.authorizedCallersByOwner(alice, bob), "Stale record should exist in storage");

        // alice 把 NFT 转给 carol
        vm.prank(alice);
        nfa.transferFrom(alice, carol, tokenId);

        // owner() 现在返回 carol
        assertEq(account.owner(), carol, "Owner should be carol");

        // onlyAuthorized 检查的是 authorizedCallersByOwner[carol][bob]，这是 false
        assertFalse(account.authorizedCallersByOwner(carol, bob), "Bob should not be authorized under carol");

        // bob 不能执行（即使 alice 的记录里 bob=true）
        vm.prank(bob);
        vm.expectRevert(bytes("AgentAccount: not authorized"));
        account.executeCall(address(0x9999), 0, "");
    }

    /// @notice 验证：旧 owner 自己也不能再执行（NFT 不在手了）
    function test_Adversarial_PreviousOwner_CannotExecuteAfterTransfer() public {
        (AgentAccount account, uint256 tokenId) = _deployAgentAccount();

        // alice 是 owner，可以执行
        vm.prank(alice);
        account.executeCall(address(0x9999), 0, "");

        // alice 转移 NFT
        vm.prank(alice);
        nfa.transferFrom(alice, carol, tokenId);

        // alice 不再是 owner，不能执行
        vm.prank(alice);
        vm.expectRevert(bytes("AgentAccount: not authorized"));
        account.executeCall(address(0x9999), 0, "");
    }

    // =========================================================================
    // 测试集 4: 升级存储布局兼容性
    // =========================================================================

    /// @notice 验证：AgentAccount Beacon 升级到 V2 后，原有存储状态完全保留
    function test_Adversarial_BeaconUpgrade_StoragePreserved() public {
        AgentAccount accountImpl = new AgentAccount();
        AgentAccountBeacon beacon = new AgentAccountBeacon(address(accountImpl), owner);
        AgentAccountRegistry registry = new AgentAccountRegistry(address(beacon));

        vm.prank(owner);
        uint256 tokenId = nfa.mintAgent(alice, "upgrade-agent", "ipfs://upgrade");

        registry.createAccount(address(nfa), tokenId, block.chainid, 0);
        address accountAddr = registry.accountAddress(address(nfa), tokenId, block.chainid, 0);
        AgentAccount account = AgentAccount(payable(accountAddr));

        // 升级前：验证存储值
        assertEq(account.tokenContract(), address(nfa), "Pre-upgrade: tokenContract mismatch");
        assertEq(account.tokenId(), tokenId, "Pre-upgrade: tokenId mismatch");
        assertEq(account.chainId(), block.chainid, "Pre-upgrade: chainId mismatch");
        assertEq(account.guardianRegistry(), address(registry), "Pre-upgrade: guardianRegistry mismatch");

        // alice 授权 bob（写入 slot 4）
        vm.prank(alice);
        account.setAuthorizedCaller(bob, true);
        assertTrue(account.authorizedCallersByOwner(alice, bob), "Pre-upgrade: auth not set");

        // 升级到 V2
        AgentAccountV2 newImpl = new AgentAccountV2();
        vm.prank(owner);
        beacon.upgradeTo(address(newImpl));

        // 通过 V2 接口访问升级后的账户
        AgentAccountV2 accountV2 = AgentAccountV2(payable(accountAddr));

        // 升级后：所有原有存储状态必须完全保留
        assertEq(accountV2.tokenContract(), address(nfa), "Post-upgrade: tokenContract corrupted");
        assertEq(accountV2.tokenId(), tokenId, "Post-upgrade: tokenId corrupted");
        assertEq(accountV2.chainId(), block.chainid, "Post-upgrade: chainId corrupted");
        assertEq(accountV2.guardianRegistry(), address(registry), "Post-upgrade: guardianRegistry corrupted");
        assertTrue(accountV2.authorizedCallersByOwner(alice, bob), "Post-upgrade: auth state corrupted");

        // 升级后：新字段初始值为 0
        assertEq(accountV2.newFeatureFlag(), 0, "New field should initialize to 0");

        // 升级后：alice 能操作新字段（新功能正常）
        vm.prank(alice);
        accountV2.setNewFeatureFlag(42);
        assertEq(accountV2.newFeatureFlag(), 42, "New feature flag not set");

        // 升级后：alice 的授权仍然有效（功能没有被破坏）
        vm.prank(bob);
        accountV2.executeCall(address(0x9999), 0, "");

        // 升级后：beacon 指向新 impl
        assertEq(beacon.implementation(), address(newImpl), "Beacon should point to new impl");
    }

    /// @notice 验证：UUPS 合约（SeasonSettler）升级后状态保留
    function test_Adversarial_UUPSUpgrade_SeasonSettler_StatePreserved() public {
        // 先提交一个赛季结算
        string[]  memory ids  = new string[](1);
        uint256[] memory ws   = new uint256[](1);
        uint256[] memory reps = new uint256[](0);
        ids[0] = "agent-a"; ws[0] = WAD;

        vm.prank(owner);
        settler.submitSeasonResult("s_upgrade", bytes32(uint256(0xABCD)), bytes32(uint256(0x1234)), ids, ws, reps);

        // 验证结算已存储
        bytes32 key = keccak256(abi.encodePacked("s_upgrade"));
        (bytes32 lb1, bytes32 mr1, uint64 ts1, bool exists1) = settler.resultsBySeason(key);
        assertTrue(exists1, "Season result should exist before upgrade");

        // 升级到新 impl（同一合约代码，模拟 bug fix 部署）
        SeasonSettler newSettlerImpl = new SeasonSettler();
        vm.prank(owner);
        settler.upgradeToAndCall(address(newSettlerImpl), "");

        // 升级后：同一 proxy 地址，状态完全保留
        (bytes32 lb2, bytes32 mr2, uint64 ts2, bool exists2) = settler.resultsBySeason(key);
        assertTrue(exists2, "Season result should survive upgrade");
        assertEq(lb2, lb1, "leaderboardHash corrupted by upgrade");
        assertEq(mr2, mr1, "merkleRoot corrupted by upgrade");
        assertEq(ts2, ts1, "settledAt corrupted by upgrade");

        // 升级后：vault 和 owner 配置未变
        assertEq(settler.owner(), owner, "Owner corrupted by upgrade");
        assertEq(address(settler.vault()), address(vault), "Vault corrupted by upgrade");

        // 升级后：已结算的赛季不能再次提交（业务保护保留）
        vm.prank(owner);
        vm.expectRevert(bytes("SeasonSettler: season already submitted"));
        settler.submitSeasonResult("s_upgrade", bytes32(uint256(1)), bytes32(uint256(2)), ids, ws, reps);
    }

    /// @notice 验证：非 owner 不能升级 UUPS 合约
    function test_Adversarial_UUPS_UnauthorizedUpgrade_Blocked() public {
        SeasonSettler newImpl = new SeasonSettler();

        vm.prank(alice); // alice 不是 owner
        vm.expectRevert(bytes("Ownable: not owner"));
        settler.upgradeToAndCall(address(newImpl), "");
    }
}
