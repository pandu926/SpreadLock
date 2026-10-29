// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IDreamBank, IDreamPool, IDreamFactory} from "./interfaces/IDreamDex.sol";

/// @notice Activation registry. Its governor should be a timelock on production.
/// @dev A disabled entry market remains known for owner exits; underlying protocol
///      upgrades are an external trust dependency, not prevented by this registry.
contract MarketRegistry {
    error Unauthorized();
    error InvalidConfiguration();
    error InvalidMarket(address pool);
    address public immutable bank;
    address public immutable protocolFactory;
    address public immutable collateral;
    address public immutable governor;
    address public guardian;
    bool public entryPaused;
    mapping(address => bool) public isKnownPool;
    mapping(address => bool) public entryEnabled;
    address[] private pools;
    event PoolConfigured(address indexed pool, bool entryEnabled);
    event EntryPauseChanged(bool paused);
    event GuardianChanged(address indexed guardian);

    constructor(address bank_, address factory_, address collateral_, address governor_, address guardian_) {
        if (
            bank_.code.length == 0 || factory_.code.length == 0 || collateral_.code.length == 0
                || governor_ == address(0) || guardian_ == address(0)
        ) revert InvalidConfiguration();
        IDreamBank.SystemConfig memory c = IDreamBank(bank_).getSystemConfig();
        if (c.marginBank != bank_ || c.perpPoolFactory != factory_ || c.collateralToken != collateral_ || !c.fullyWired)
        {
            revert InvalidConfiguration();
        }
        bank = bank_;
        protocolFactory = factory_;
        collateral = collateral_;
        governor = governor_;
        guardian = guardian_;
    }

    function configurePool(address pool, bool enabled) external {
        if (msg.sender != governor) revert Unauthorized();
        _validate(pool);
        if (!isKnownPool[pool]) pools.push(pool);
        isKnownPool[pool] = true;
        entryEnabled[pool] = enabled;
        emit PoolConfigured(pool, enabled);
    }

    function pauseEntry() external {
        if (msg.sender != governor && msg.sender != guardian) revert Unauthorized();
        entryPaused = true;
        emit EntryPauseChanged(true);
    }

    function resumeEntry() external {
        if (msg.sender != governor) revert Unauthorized();
        entryPaused = false;
        emit EntryPauseChanged(false);
    }

    function setGuardian(address next) external {
        if (msg.sender != governor) revert Unauthorized();
        if (next == address(0)) revert InvalidConfiguration();
        guardian = next;
        emit GuardianChanged(next);
    }

    function verifiedPools() external view returns (address[] memory) {
        return pools;
    }

    function marketMetadata(address pool)
        external
        view
        returns (uint256 oneBase, uint256 tickSize, uint256 minQuantity, uint256 lotSize, uint256 takerFeeBpsTimes1k)
    {
        if (!isKnownPool[pool]) revert InvalidMarket(pool);
        _validate(pool);
        IDreamPool.Grid memory grid = IDreamPool(pool).getOrderBookParameters();
        IDreamPool.Risk memory risk = IDreamPool(pool).getPerpPoolParameters();
        return (IDreamPool(pool).getOneBase(), grid.tickSize, grid.minQuantity, grid.lotSize, risk.takerFeeBpsTimes1k);
    }

    function _validate(address pool) private view {
        if (
            pool.code.length == 0 || !IDreamFactory(protocolFactory).isDeployedByFactory(pool)
                || !IDreamBank(bank).isPerpPoolRegistered(pool) || IDreamPool(pool).marginBank() != bank
        ) {
            revert InvalidMarket(pool);
        }
        IDreamPool.Grid memory grid = IDreamPool(pool).getOrderBookParameters();
        if (
            grid.tickSize == 0 || grid.lotSize == 0 || grid.minQuantity == 0 || grid.minQuantity % grid.lotSize != 0
                || IDreamPool(pool).getOneBase() == 0
                || IDreamPool(pool).getPerpPoolParameters().takerFeeBpsTimes1k >= 10_000_000
        ) {
            revert InvalidMarket(pool);
        }
    }
}
