// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

/**
 * @title AgentAccountBeacon
 * @dev Beacon contract that stores the current AgentAccount implementation address.
 *      All BeaconProxy instances created by AgentAccountRegistry delegate to this beacon.
 *      Calling upgradeTo(newImpl) updates every agent account simultaneously.
 */
contract AgentAccountBeacon is UpgradeableBeacon {
    constructor(address implementation, address initialOwner)
        UpgradeableBeacon(implementation, initialOwner)
    {}
}
