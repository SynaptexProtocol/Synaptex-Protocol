// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/SynaptexToken.sol";
import "../src/ArenaVault.sol";
import "../src/SeasonSettler.sol";
import "../src/AgentNFA.sol";
import "../src/AgentAccount.sol";
import "../src/AgentAccountBeacon.sol";
import "../src/AgentAccountRegistry.sol";
import "../src/LearningRootOracle.sol";
import "../src/SimpleTaskEscrow.sol";

contract Deploy is Script {
    function run() external {
        address owner = vm.envAddress("OWNER");
        uint256 pk = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(pk);

        // ── Non-upgradeable: SynaptexToken + ArenaVault ─────────────────────────
        SynaptexToken token = new SynaptexToken(owner, 100_000_000 ether, 1_000_000_000 ether);
        ArenaVault vault = new ArenaVault(address(token), owner);

        // ── UUPS: SeasonSettler ───────────────────────────────────────────────
        SeasonSettler settlerImpl = new SeasonSettler();
        ERC1967Proxy settlerProxy = new ERC1967Proxy(
            address(settlerImpl),
            abi.encodeCall(SeasonSettler.initialize, (address(vault), owner))
        );
        SeasonSettler settler = SeasonSettler(address(settlerProxy));

        // ── UUPS: AgentNFA ────────────────────────────────────────────────────
        AgentNFA nfaImpl = new AgentNFA();
        ERC1967Proxy nfaProxy = new ERC1967Proxy(
            address(nfaImpl),
            abi.encodeCall(AgentNFA.initialize, (owner))
        );
        AgentNFA agentNfa = AgentNFA(address(nfaProxy));

        // ── Beacon Proxy: AgentAccount + Registry ─────────────────────────────
        AgentAccount accountImpl = new AgentAccount();
        AgentAccountBeacon beacon = new AgentAccountBeacon(address(accountImpl), owner);
        AgentAccountRegistry registry = new AgentAccountRegistry(address(beacon));

        // ── UUPS: LearningRootOracle ──────────────────────────────────────────
        LearningRootOracle oracleImpl = new LearningRootOracle();
        ERC1967Proxy oracleProxy = new ERC1967Proxy(
            address(oracleImpl),
            abi.encodeCall(LearningRootOracle.initialize, (owner))
        );

        // ── Wiring ────────────────────────────────────────────────────────────
        vault.setSettler(address(settler));
        settler.setAgentNFA(address(agentNfa));
        agentNfa.setAuthorizedSettler(address(settler), true);

        bool lockConfig = vm.envOr("LOCK_CONFIG", false);
        if (lockConfig) {
            vault.lockSettler();
            settler.lockVault();
        }

        // ── SimpleTaskEscrow ──────────────────────────────────────────────────
        // Treasury = owner address initially; replace with multisig before mainnet
        SimpleTaskEscrow taskEscrow = new SimpleTaskEscrow(address(token), owner, owner);

        vm.stopBroadcast();

        console.log("TOKEN=", address(token));
        console.log("VAULT=", address(vault));
        console.log("SETTLER_IMPL=", address(settlerImpl));
        console.log("SETTLER_PROXY=", address(settler));
        console.log("AGENT_NFA_IMPL=", address(nfaImpl));
        console.log("AGENT_NFA_PROXY=", address(agentNfa));
        console.log("AGENT_ACCOUNT_IMPL=", address(accountImpl));
        console.log("AGENT_ACCOUNT_BEACON=", address(beacon));
        console.log("AGENT_ACCOUNT_REGISTRY=", address(registry));
        console.log("LEARNING_ROOT_ORACLE_IMPL=", address(oracleImpl));
        console.log("LEARNING_ROOT_ORACLE_PROXY=", address(oracleProxy));
        console.log("TASK_ESCROW=", address(taskEscrow));
        console.log("LOCK_CONFIG=", lockConfig);
    }
}
