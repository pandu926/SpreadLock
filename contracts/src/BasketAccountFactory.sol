// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BasketAccount} from "./BasketAccount.sol";
import {MarketRegistry} from "./MarketRegistry.sol";

contract BasketAccountFactory {
    error InvalidConfiguration();
    address public immutable bank;
    address public immutable collateral;
    address public immutable permissionsRegistry;
    address public immutable marketRegistry;
    mapping(address => bool) public isAccount;
    event AccountCreated(address indexed owner, address indexed account, bytes32 indexed salt);

    constructor(address bank_, address token_, address permissions_, address markets_) {
        if (
            bank_.code.length == 0 || token_.code.length == 0 || permissions_.code.length == 0
                || markets_.code.length == 0 || MarketRegistry(markets_).bank() != bank_
                || MarketRegistry(markets_).collateral() != token_
        ) revert InvalidConfiguration();
        bank = bank_;
        collateral = token_;
        permissionsRegistry = permissions_;
        marketRegistry = markets_;
    }

    function createAccount(bytes32 salt) external returns (address account) {
        account = address(
            new BasketAccount{salt: keccak256(abi.encode(msg.sender, salt))}(
                msg.sender, bank, collateral, permissionsRegistry, marketRegistry
            )
        );
        isAccount[account] = true;
        emit AccountCreated(msg.sender, account, salt);
    }

    function predictAccount(address owner, bytes32 salt) external view returns (address) {
        bytes32 initHash = keccak256(
            abi.encodePacked(
                type(BasketAccount).creationCode,
                abi.encode(owner, bank, collateral, permissionsRegistry, marketRegistry)
            )
        );
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), address(this), keccak256(abi.encode(owner, salt)), initHash)
                    )
                )
            )
        );
    }
}
