// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BasketAccountFactory} from "../src/BasketAccountFactory.sol";
import {Fixture} from "./Fixture.sol";

contract FactoryRedTest is Fixture {
    function test_CreateBasketAccountMustProduceOwnedAccount() public {
        address created = factory.createAccount(bytes32(uint256(999)));
        require(created.code.length > 0, "factory must deploy an account");
        (bool ok, bytes memory result) = created.staticcall(abi.encodeWithSignature("owner()"));
        require(ok && abi.decode(result, (address)) == address(this), "caller must own account");
    }
}
