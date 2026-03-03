// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import "./AgentAccount.sol";

interface IBeaconOwnable {
    function owner() external view returns (address);
}

interface IAgentAccountRescue {
    function rescueNative(address payable to, uint256 amount) external;
    function rescueERC20(address token, address to, uint256 amount) external;
}

// ── ERC-6551: Registry interface ─────────────────────────────────────────────

interface IERC6551Registry {
    event ERC6551AccountCreated(
        address account,
        address indexed implementation,
        bytes32 salt,
        uint256 chainId,
        address indexed tokenContract,
        uint256 indexed tokenId
    );

    error AccountCreationFailed();

    function createAccount(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external returns (address account);

    function account(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external view returns (address account);
}

/**
 * @title AgentAccountRegistry
 * @dev Factory that deploys deterministic BeaconProxy instances for each agent token.
 *      Each proxy delegates to the implementation stored in the AgentAccountBeacon.
 *      Upgrading the beacon implementation upgrades all accounts simultaneously.
 *
 *      Implements IERC6551Registry interface.
 *      Note: uses BeaconProxy (not ERC1967Proxy), so `implementation` param in the
 *      ERC-6551 interface refers to the beacon address for this registry.
 */
contract AgentAccountRegistry is IERC6551Registry {
    /// @notice The beacon contract holding the current AgentAccount implementation.
    address public immutable beacon;

    // ── Legacy event (kept for backward compatibility) ────────────────────────
    event AccountCreated(
        address indexed account,
        address indexed tokenContract,
        uint256 indexed tokenId,
        uint256 chainId,
        uint256 salt
    );
    event AccountRescuedNative(address indexed account, address indexed to, uint256 amount);
    event AccountRescuedERC20(address indexed account, address indexed token, address indexed to, uint256 amount);

    constructor(address _beacon) {
        require(_beacon != address(0), "AgentAccountRegistry: zero beacon");
        beacon = _beacon;
    }

    // ── IERC6551Registry ──────────────────────────────────────────────────────

    /**
     * @notice Deploy (or return existing) BeaconProxy for a given agent token.
     * @dev    ERC-6551 compliant signature. The `implementation` param is the beacon
     *         address; pass `beacon` to use this registry's default implementation.
     *         `salt` is a bytes32 user-supplied value for deterministic addressing.
     */
    function createAccount(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external override returns (address accountAddr) {
        accountAddr = _accountAddress(implementation, salt, chainId, tokenContract, tokenId);
        if (accountAddr.code.length > 0) return accountAddr;

        bytes memory initData = abi.encodeCall(
            AgentAccount.initialize,
            (tokenContract, tokenId, chainId)
        );
        bytes32 deploySalt = _deploySalt(implementation, salt, chainId, tokenContract, tokenId);
        accountAddr = address(new BeaconProxy{salt: deploySalt}(implementation, initData));

        emit ERC6551AccountCreated(accountAddr, implementation, salt, chainId, tokenContract, tokenId);
        // Also emit legacy event for backward compatibility
        emit AccountCreated(accountAddr, tokenContract, tokenId, chainId, uint256(salt));
    }

    /**
     * @notice Compute the deterministic address for a BeaconProxy before deployment.
     * @dev    ERC-6551 compliant signature.
     */
    function account(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external view override returns (address) {
        return _accountAddress(implementation, salt, chainId, tokenContract, tokenId);
    }

    // ── Convenience helpers (uint256 salt variants) ───────────────────────────

    /**
     * @notice Deploy using the registry's default beacon and a uint256 salt.
     *         Convenience wrapper around the ERC-6551 createAccount().
     */
    function createAccount(
        address tokenContract,
        uint256 tokenId,
        uint256 chainId,
        uint256 salt
    ) external returns (address) {
        return this.createAccount(beacon, bytes32(salt), chainId, tokenContract, tokenId);
    }

    /**
     * @notice Compute deterministic address using the registry's default beacon.
     */
    function accountAddress(
        address tokenContract,
        uint256 tokenId,
        uint256 chainId,
        uint256 salt
    ) public view returns (address) {
        return _accountAddress(beacon, bytes32(salt), chainId, tokenContract, tokenId);
    }

    // ── Rescue ────────────────────────────────────────────────────────────────

    function rescueAccountNative(address accountAddr, address payable to, uint256 amount) external {
        require(msg.sender == IBeaconOwnable(beacon).owner(), "AgentAccountRegistry: not beacon owner");
        IAgentAccountRescue(accountAddr).rescueNative(to, amount);
        emit AccountRescuedNative(accountAddr, to, amount);
    }

    function rescueAccountERC20(address accountAddr, address token, address to, uint256 amount) external {
        require(msg.sender == IBeaconOwnable(beacon).owner(), "AgentAccountRegistry: not beacon owner");
        IAgentAccountRescue(accountAddr).rescueERC20(token, to, amount);
        emit AccountRescuedERC20(accountAddr, token, to, amount);
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _deploySalt(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) private pure returns (bytes32) {
        return keccak256(abi.encode(implementation, salt, chainId, tokenContract, tokenId));
    }

    function _accountAddress(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) private view returns (address) {
        bytes32 deploySalt = _deploySalt(implementation, salt, chainId, tokenContract, tokenId);
        bytes memory initData = abi.encodeCall(
            AgentAccount.initialize,
            (tokenContract, tokenId, chainId)
        );
        bytes memory proxyCode = abi.encodePacked(
            type(BeaconProxy).creationCode,
            abi.encode(implementation, initData)
        );
        bytes32 hash = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), deploySalt, keccak256(proxyCode))
        );
        return address(uint160(uint256(hash)));
    }
}
