// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Ownable.sol";

contract SynaptexToken is ArenaOwnable {
    string public constant name = "Synaptex Token";
    string public constant symbol = "SYNPTX";
    uint8 public constant decimals = 18;
    uint256 public immutable cap;

    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    constructor(address initialOwner, uint256 initialSupply, uint256 maxSupply) ArenaOwnable(initialOwner) {
        require(maxSupply > 0, "ERC20: zero cap");
        require(initialSupply <= maxSupply, "ERC20: initial supply exceeds cap");
        cap = maxSupply;
        _mint(initialOwner, initialSupply);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "ERC20: insufficient allowance");
        allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        require(to != address(0), "ERC20: zero to");
        require(totalSupply + amount <= cap, "ERC20: cap exceeded");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "ERC20: zero to");
        uint256 bal = balanceOf[from];
        require(bal >= amount, "ERC20: insufficient balance");
        balanceOf[from] = bal - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
