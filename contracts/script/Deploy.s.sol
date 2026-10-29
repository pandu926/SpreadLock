// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MarketRegistry} from "../src/MarketRegistry.sol";
import {BasketAccountFactory} from "../src/BasketAccountFactory.sol";
import {BasketRouter} from "../src/BasketRouter.sol";
import {SpreadLockGovernor} from "../src/SpreadLockGovernor.sol";

interface DeployVm {
    function envAddress(string calldata name) external returns (address);
    function envUint(string calldata name) external returns (uint256);
    function envOr(string calldata name, bool fallbackValue) external returns (bool);
    function startBroadcast(address signer) external;
    function stopBroadcast() external;
}

/// @dev Uses Foundry's encrypted account selection, never a private-key argument.
///      Without --broadcast this only simulates. Mainnet remains an explicit gate.
contract Deploy {
    DeployVm private constant vm = DeployVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    error WrongChain();
    error ProductionGate();
    event DeploymentCreated(
        uint256 indexed chainId, address indexed registry, address indexed factory, address router, address governor
    );

    function run()
        external
        returns (MarketRegistry markets, BasketAccountFactory accounts, BasketRouter router, address governor)
    {
        if (block.chainid != vm.envUint("CHAIN_ID")) {
            revert WrongChain();
        }
        bool production = vm.envOr("PRODUCTION", false);
        if (
            production
                && (block.chainid == 50383 || block.chainid == 31337 || !vm.envOr("MAINNET_RELEASE_APPROVED", false))
        ) {
            revert ProductionGate();
        }
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        address bank = vm.envAddress("MARGIN_BANK");
        address token = vm.envAddress("COLLATERAL_TOKEN");
        address protocolFactory = vm.envAddress("PERP_POOL_FACTORY");
        address permissions = vm.envAddress("OPERATOR_REGISTRY");
        address guardian = vm.envAddress("GUARDIAN_ADDRESS");
        address multisig;
        if (production) multisig = vm.envAddress("GOVERNANCE_MULTISIG");
        vm.startBroadcast(deployer);
        governor = production ? address(new SpreadLockGovernor(multisig)) : deployer;
        markets = new MarketRegistry(bank, protocolFactory, token, governor, guardian);
        accounts = new BasketAccountFactory(bank, token, permissions, address(markets));
        router = new BasketRouter(address(accounts), address(markets));
        vm.stopBroadcast();
        emit DeploymentCreated(block.chainid, address(markets), address(accounts), address(router), governor);
    }
}
