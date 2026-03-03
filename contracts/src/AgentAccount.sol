// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/utils/Initializable.sol";

interface IAgentToken {
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
}

// ── ERC-6551: Token Bound Account interfaces ──────────────────────────────────

/// @dev ERC-165 interfaceId: 0x6faff5f1
interface IERC6551Account {
    receive() external payable;
    function token() external view returns (uint256 chainId, address tokenContract, uint256 tokenId);
    function state() external view returns (uint256);
    function isValidSigner(address signer, bytes calldata context) external view returns (bytes4 magicValue);
}

/// @dev ERC-165 interfaceId: 0x51945447
interface IERC6551Executable {
    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external payable returns (bytes memory);
}

// ── ERC-1271: Standard Signature Validation ───────────────────────────────────

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4 magicValue);
}

/**
 * @title AgentAccount
 * @dev Per-agent execution wallet. Deployed via BeaconProxy through AgentAccountRegistry.
 *      All instances share the same implementation (the Beacon), so upgrading the
 *      Beacon implementation upgrades every agent account atomically.
 *
 *      Implements:
 *        - ERC-6551 IERC6551Account  (interfaceId: 0x6faff5f1)
 *        - ERC-6551 IERC6551Executable (interfaceId: 0x51945447)
 *        - ERC-1271 isValidSignature
 *        - ERC-165  supportsInterface
 *
 * Storage layout (DO NOT reorder — Beacon Proxy safety):
 *   slot 0 : tokenContract
 *   slot 1 : tokenId
 *   slot 2 : chainId
 *   slot 3 : authorizedCallers (legacy; deprecated, kept for storage compatibility)
 *   slot 4 : authorizedCallersByOwner
 *   slot 5 : guardianRegistry
 *   slot 6 : _state  (ERC-6551 nonce — appended, upgrade-safe)
 */
contract AgentAccount is Initializable, IERC6551Account, IERC6551Executable, IERC1271 {

    // ── ERC-6551 operation types ───────────────────────────────────────────────
    uint8 public constant CALL         = 0;
    uint8 public constant DELEGATECALL = 1;
    uint8 public constant CREATE       = 2;
    uint8 public constant CREATE2      = 3;

    // ── ERC-165 interfaceIds ───────────────────────────────────────────────────
    bytes4 private constant _ERC165_ID          = 0x01ffc9a7;
    bytes4 private constant _ERC6551_ACCOUNT_ID = 0x6faff5f1;
    bytes4 private constant _ERC6551_EXEC_ID    = 0x51945447;
    bytes4 private constant _ERC1271_ID         = 0x1626ba7e;

    // ── ERC-1271 magic values ─────────────────────────────────────────────────
    bytes4 private constant _ERC1271_SUCCESS = 0x1626ba7e;
    bytes4 private constant _ERC1271_FAIL    = 0xffffffff;

    // ── Storage slots 0-5 (DO NOT reorder) ────────────────────────────────────
    address public tokenContract;
    uint256 public tokenId;
    uint256 public chainId;

    /// @notice Legacy authorization map. Deprecated; kept for storage compatibility.
    mapping(address => bool) public authorizedCallers;
    /// @notice Owner-scoped authorization map.
    mapping(address => mapping(address => bool)) public authorizedCallersByOwner;
    /// @notice Registry address that created this account. Used for emergency rescue.
    address public guardianRegistry;

    /// @notice ERC-6551 state counter. Incremented on every successful execute().
    uint256 private _state;

    // ── Events ────────────────────────────────────────────────────────────────
    event Executed(address indexed to, uint256 value, bytes data, bytes result);
    event CallerAuthorized(address indexed caller, bool authorized);
    event RescueNative(address indexed to, uint256 amount);
    event RescueERC20(address indexed token, address indexed to, uint256 amount);

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyAuthorized() {
        address currentOwner = owner();
        require(
            msg.sender == currentOwner || authorizedCallersByOwner[currentOwner][msg.sender],
            "AgentAccount: not authorized"
        );
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Called once per proxy instance during createAccount().
    function initialize(
        address _tokenContract,
        uint256 _tokenId,
        uint256 _chainId
    ) public initializer {
        tokenContract = _tokenContract;
        tokenId       = _tokenId;
        chainId       = _chainId;
        guardianRegistry = msg.sender;
    }

    // ── ERC-6551: IERC6551Account ─────────────────────────────────────────────

    receive() external payable override {}

    /// @inheritdoc IERC6551Account
    function token() external view override returns (uint256, address, uint256) {
        return (chainId, tokenContract, tokenId);
    }

    /// @inheritdoc IERC6551Account
    function state() external view override returns (uint256) {
        return _state;
    }

    /// @inheritdoc IERC6551Account
    function isValidSigner(address signer, bytes calldata) external view override returns (bytes4) {
        if (_isValidSigner(signer)) return IERC6551Account.isValidSigner.selector;
        return bytes4(0);
    }

    // ── ERC-6551: IERC6551Executable ──────────────────────────────────────────

    /// @inheritdoc IERC6551Executable
    /// @dev operation 0 = CALL, 1 = DELEGATECALL, 2 = CREATE, 3 = CREATE2.
    ///      Only CALL is supported; others revert.
    function execute(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation
    ) external payable override onlyAuthorized returns (bytes memory result) {
        require(operation == CALL, "AgentAccount: only CALL supported");
        _state += 1;
        bool ok;
        (ok, result) = to.call{value: value}(data);
        require(ok, "AgentAccount: call failed");
        emit Executed(to, value, data, result);
    }

    // ── ERC-1271: Signature Validation ────────────────────────────────────────

    /// @inheritdoc IERC1271
    /// @dev Validates that the signature was produced by the current token owner.
    ///      Supports ECDSA (65-byte) signatures only.
    function isValidSignature(bytes32 hash, bytes calldata signature)
        external view override returns (bytes4)
    {
        address recovered = _recoverSigner(hash, signature);
        if (recovered != address(0) && _isValidSigner(recovered)) {
            return _ERC1271_SUCCESS;
        }
        return _ERC1271_FAIL;
    }

    // ── ERC-165 ───────────────────────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == _ERC165_ID          ||
            interfaceId == _ERC6551_ACCOUNT_ID ||
            interfaceId == _ERC6551_EXEC_ID    ||
            interfaceId == _ERC1271_ID;
    }

    // ── Legacy executeCall (kept for backward compatibility) ──────────────────

    /// @notice Original execution function. Still works; use execute() for ERC-6551 compliance.
    function executeCall(
        address to,
        uint256 value,
        bytes calldata data
    ) external onlyAuthorized returns (bytes memory result) {
        _state += 1;
        bool ok;
        (ok, result) = to.call{value: value}(data);
        require(ok, "AgentAccount: call failed");
        emit Executed(to, value, data, result);
    }

    // ── Owner & authorization ─────────────────────────────────────────────────

    function owner() public view returns (address) {
        if (block.chainid != chainId) return address(0);
        return IAgentToken(tokenContract).ownerOf(tokenId);
    }

    function setAuthorizedCaller(address caller, bool authorized) external {
        address currentOwner = owner();
        require(msg.sender == currentOwner, "AgentAccount: not token owner");
        require(caller != address(0), "AgentAccount: zero caller");
        authorizedCallersByOwner[currentOwner][caller] = authorized;
        emit CallerAuthorized(caller, authorized);
    }

    // ── Rescue ────────────────────────────────────────────────────────────────

    function rescueNative(address payable to, uint256 amount) external {
        require(msg.sender == guardianRegistry, "AgentAccount: not guardian");
        require(owner() == address(0), "AgentAccount: owner active");
        require(to != address(0), "AgentAccount: zero to");
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "AgentAccount: native rescue failed");
        emit RescueNative(to, amount);
    }

    function rescueERC20(address token_, address to, uint256 amount) external {
        require(msg.sender == guardianRegistry, "AgentAccount: not guardian");
        require(owner() == address(0), "AgentAccount: owner active");
        require(token_ != address(0), "AgentAccount: zero token");
        require(to != address(0), "AgentAccount: zero to");
        bool ok = IERC20Like(token_).transfer(to, amount);
        require(ok, "AgentAccount: token rescue failed");
        emit RescueERC20(token_, to, amount);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _isValidSigner(address signer) internal view returns (bool) {
        address currentOwner = owner();
        return currentOwner != address(0) && (
            signer == currentOwner ||
            authorizedCallersByOwner[currentOwner][signer]
        );
    }

    /// @dev Minimal ECDSA recover; returns address(0) on invalid signature.
    function _recoverSigner(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(hash, v, r, s);
    }
}
