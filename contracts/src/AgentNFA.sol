// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

interface IERC721Receiver {
    function onERC721Received(
        address operator,
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external returns (bytes4);
}

// ── ERC-7662: AI Agent NFT interface ─────────────────────────────────────────

interface IERC7662 {
    function getAgentData(uint256 tokenId) external view returns (
        string memory agentName,
        string memory description,
        string memory model,
        string memory userPromptURI,
        string memory systemPromptURI,
        bool promptsEncrypted
    );

    event AgentUpdated(uint256 indexed tokenId);
}

// ── ERC-7231: Identity-aggregated NFT interface ───────────────────────────────

interface IERC7231 {
    function setIdentitiesRoot(uint256 id, bytes32 identitiesRoot) external;
    function getIdentitiesRoot(uint256 id) external view returns (bytes32);
    function verifyIdentitiesBinding(
        uint256 id,
        address nftOwnerAddress,
        string[] memory userIDs,
        bytes32 identitiesRoot,
        bytes calldata signature
    ) external view returns (bool);

    event SetIdentitiesRoot(uint256 indexed id, bytes32 identitiesRoot);
}

/**
 * @title AgentNFA
 * @dev Non-fungible agent tokens with on-chain reputation tracking.
 *      UUPS-upgradeable: owner can call upgradeToAndCall() to push a new implementation.
 *
 *      Implements:
 *        - ERC-721  (full: transfer, approve, safeTransfer, events)
 *        - ERC-7662 IERC7662  — structured AI agent metadata
 *        - ERC-7231 IERC7231  — identity root binding per token
 *        - ERC-165  supportsInterface
 *
 * Storage layout (DO NOT reorder — proxy safety):
 *   Slots are append-only for upgrade safety.
 */
contract AgentNFA is Initializable, UUPSUpgradeable, IERC7662, IERC7231 {

    // ── ERC-165 interfaceIds ───────────────────────────────────────────────────
    bytes4 private constant _ERC165_ID  = 0x01ffc9a7;
    bytes4 private constant _ERC721_ID  = 0x80ac58cd;
    bytes4 private constant _ERC7662_ID = type(IERC7662).interfaceId;
    bytes4 private constant _ERC7231_ID = type(IERC7231).interfaceId;

    // ── Ownership (inline — avoids constructor-bearing OZ Ownable) ──────────
    address private _owner;

    modifier onlyOwner() {
        require(msg.sender == _owner, "AgentNFA: not owner");
        _;
    }

    function owner() public view returns (address) { return _owner; }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "AgentNFA: zero owner");
        emit OwnershipTransferred(_owner, newOwner);
        _owner = newOwner;
    }

    // ── ERC-721 token state ───────────────────────────────────────────────────
    string public name;
    string public symbol;

    uint256 public nextTokenId;

    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    mapping(uint256 => string) public tokenURI;
    mapping(uint256 => bytes32) public agentKeyByToken;
    mapping(bytes32 => uint256) public tokenByAgentKey;

    // ── Reputation (Synaptex Protocol) ───────────────────────────────────────────
    /// @notice Cumulative reputation score (WAD-scaled, updated by authorized settlers)
    mapping(uint256 => uint256) public reputation;
    /// @notice Season count a token has participated in
    mapping(uint256 => uint256) public seasonCount;
    /// @notice Addresses allowed to call updateReputation (e.g. SeasonSettler)
    mapping(address => bool) public authorizedSettlers;

    // ── ERC-7662: AI Agent metadata ───────────────────────────────────────────

    struct AgentData {
        string agentName;
        string description;
        string model;
        string userPromptURI;
        string systemPromptURI;
        bool promptsEncrypted;
    }

    mapping(uint256 => AgentData) private _agentData;

    // ── ERC-7231: Identity roots ───────────────────────────────────────────────

    mapping(uint256 => bytes32) private _identitiesRoot;

    // ── Events ────────────────────────────────────────────────────────────────
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed spender, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event AgentRegistered(uint256 indexed tokenId, bytes32 indexed agentKey, string agentId);
    event ReputationUpdated(uint256 indexed tokenId, uint256 newReputation, uint256 seasonCount);
    event SettlerAuthorized(address indexed settler, bool authorized);
    // IERC7662 AgentUpdated — declared in interface, emitted on metadata update
    // IERC7231 SetIdentitiesRoot — declared in interface, emitted on root update

    // ── Proxy setup ───────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialOwner) public initializer {
        require(initialOwner != address(0), "AgentNFA: zero owner");
        _owner = initialOwner;
        name = "Arena Agent";
        symbol = "AGENT";
        nextTokenId = 1;
    }

    /// @dev Only owner can authorize an upgrade (UUPS requirement).
    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ── ERC-165 ───────────────────────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == _ERC165_ID  ||
            interfaceId == _ERC721_ID  ||
            interfaceId == _ERC7662_ID ||
            interfaceId == _ERC7231_ID;
    }

    // ── ERC-7662: AI Agent metadata ───────────────────────────────────────────

    /// @inheritdoc IERC7662
    function getAgentData(uint256 tokenId) external view override returns (
        string memory agentName,
        string memory description,
        string memory model,
        string memory userPromptURI,
        string memory systemPromptURI,
        bool promptsEncrypted
    ) {
        require(ownerOf[tokenId] != address(0), "AgentNFA: token not minted");
        AgentData storage d = _agentData[tokenId];
        return (d.agentName, d.description, d.model, d.userPromptURI, d.systemPromptURI, d.promptsEncrypted);
    }

    /// @notice Set or update ERC-7662 agent metadata. Only the token owner can update.
    function setAgentData(
        uint256 tokenId,
        string calldata agentName,
        string calldata description,
        string calldata model,
        string calldata userPromptURI,
        string calldata systemPromptURI,
        bool promptsEncrypted
    ) external {
        require(ownerOf[tokenId] == msg.sender, "AgentNFA: not token owner");
        _agentData[tokenId] = AgentData(agentName, description, model, userPromptURI, systemPromptURI, promptsEncrypted);
        emit AgentUpdated(tokenId);
    }

    // ── ERC-7231: Identity root ───────────────────────────────────────────────

    /// @inheritdoc IERC7231
    function setIdentitiesRoot(uint256 id, bytes32 identitiesRoot) external override {
        require(ownerOf[id] == msg.sender, "AgentNFA: not token owner");
        _identitiesRoot[id] = identitiesRoot;
        emit SetIdentitiesRoot(id, identitiesRoot);
    }

    /// @inheritdoc IERC7231
    function getIdentitiesRoot(uint256 id) external view override returns (bytes32) {
        return _identitiesRoot[id];
    }

    /// @inheritdoc IERC7231
    /// @dev Verifies that `identitiesRoot` matches the stored root, then checks
    ///      that the provided ECDSA signature over keccak256(abi.encode(id, nftOwnerAddress, userIDs))
    ///      was produced by `nftOwnerAddress`. This lets off-chain systems prove that an
    ///      NFT owner consented to the identity binding.
    function verifyIdentitiesBinding(
        uint256 id,
        address nftOwnerAddress,
        string[] memory userIDs,
        bytes32 identitiesRoot,
        bytes calldata signature
    ) external view override returns (bool) {
        // 1. Root must match stored value
        if (_identitiesRoot[id] != identitiesRoot) return false;
        // 2. Claimed owner must currently own the token
        if (ownerOf[id] != nftOwnerAddress) return false;
        // 3. Signature must be from nftOwnerAddress over the binding payload
        bytes32 payload = keccak256(abi.encode(id, nftOwnerAddress, userIDs, identitiesRoot));
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payload));
        address recovered = _recoverSigner(ethHash, signature);
        return recovered == nftOwnerAddress;
    }

    // ── Settler authorization ─────────────────────────────────────────────────

    function setAuthorizedSettler(address settler, bool authorized) external onlyOwner {
        require(settler != address(0), "AgentNFA: zero settler");
        authorizedSettlers[settler] = authorized;
        emit SettlerAuthorized(settler, authorized);
    }

    // ── Reputation (Synaptex Protocol) ───────────────────────────────────────────

    function updateReputation(uint256 tokenId, uint256 scoreDelta) external {
        require(authorizedSettlers[msg.sender], "AgentNFA: not authorized settler");
        require(ownerOf[tokenId] != address(0), "AgentNFA: token not minted");
        reputation[tokenId] += scoreDelta;
        seasonCount[tokenId] += 1;
        emit ReputationUpdated(tokenId, reputation[tokenId], seasonCount[tokenId]);
    }

    // ── Minting ───────────────────────────────────────────────────────────────

    function mintAgent(
        address to,
        string calldata agentId,
        string calldata uri
    ) external onlyOwner returns (uint256 tokenId) {
        require(to != address(0), "AgentNFA: zero to");
        bytes32 key = keccak256(abi.encodePacked(agentId));
        require(tokenByAgentKey[key] == 0, "AgentNFA: agent exists");

        tokenId = nextTokenId++;
        ownerOf[tokenId] = to;
        balanceOf[to] += 1;
        tokenURI[tokenId] = uri;
        agentKeyByToken[tokenId] = key;
        tokenByAgentKey[key] = tokenId;

        emit Transfer(address(0), to, tokenId);
        emit AgentRegistered(tokenId, key, agentId);
    }

    // ── ERC-721 approval & transfer ───────────────────────────────────────────

    function approve(address spender, uint256 tokenId) external {
        address tokenOwner = ownerOf[tokenId];
        require(tokenOwner != address(0), "AgentNFA: not minted");
        require(
            msg.sender == tokenOwner || isApprovedForAll[tokenOwner][msg.sender],
            "AgentNFA: not approved owner"
        );
        getApproved[tokenId] = spender;
        emit Approval(tokenOwner, spender, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        require(to != address(0), "AgentNFA: zero to");
        require(ownerOf[tokenId] == from, "AgentNFA: wrong from");
        require(_isApprovedOrOwner(msg.sender, tokenId), "AgentNFA: not approved");

        getApproved[tokenId] = address(0);
        ownerOf[tokenId] = to;
        balanceOf[from] -= 1;
        balanceOf[to] += 1;

        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length > 0) {
            bytes4 retval = IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data);
            require(retval == IERC721Receiver.onERC721Received.selector, "AgentNFA: unsafe receiver");
        }
    }

    function _isApprovedOrOwner(address spender, uint256 tokenId) internal view returns (bool) {
        address tokenOwner = ownerOf[tokenId];
        return (
            spender == tokenOwner
            || getApproved[tokenId] == spender
            || isApprovedForAll[tokenOwner][spender]
        );
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

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
