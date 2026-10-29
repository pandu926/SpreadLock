// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

interface IMultisigConfiguration {
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
}

/// @notice Production configuration changes are proposed and executed by a
///         verified 2-of-3 multisig, after at least 48 hours. No bootstrap admin.
contract SpreadLockGovernor is TimelockController {
    error InvalidMultisig();

    constructor(address multisig) TimelockController(48 hours, _singleton(multisig), _singleton(multisig), address(0)) {
        if (
            multisig.code.length == 0 || IMultisigConfiguration(multisig).getThreshold() != 2
                || IMultisigConfiguration(multisig).getOwners().length != 3
        ) revert InvalidMultisig();
    }

    function _singleton(address who) private pure returns (address[] memory list) {
        list = new address[](1);
        list[0] = who;
    }
}
