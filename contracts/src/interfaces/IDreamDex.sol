// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IDreamBank {
    struct Position {
        int128 size;
        uint128 avgEntryPrice;
        int256 entryFundingIndex;
        uint64 lastUpdatedTimestampNs;
    }

    struct SystemConfig {
        address marginBank;
        address collateralToken;
        address perpPoolFactory;
        address liquidationEngine;
        address insuranceFund;
        address feeRecipient;
        uint16 maxLeverageLimit;
        bool fullyWired;
    }
    function getSystemConfig() external view returns (SystemConfig memory);
    function getPosition(address account, address pool) external view returns (Position memory);
    function getActivePerpPools(address account) external view returns (address[] memory);
    function getAccountHealth(address account) external view returns (int256, uint256, uint256, uint256);
    function isPerpPoolRegistered(address pool) external view returns (bool);
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external;
}

interface IDreamPool {
    struct Grid {
        uint256 tickSize;
        uint256 minQuantity;
        uint256 lotSize;
    }

    struct Risk {
        uint256 initialMarginBps;
        uint256 maintenanceMarginBps;
        uint256 closeOutMarginBps;
        uint256 maxOpenInterest;
        uint256 maxPositionSize;
        uint256 takerFeeBpsTimes1k;
        int256 makerFeeBpsTimes1k;
        uint256 insuranceFundShareBps;
    }
    function marginBank() external view returns (address);
    function getOneBase() external view returns (uint256);
    function getOrderBookParameters() external view returns (Grid memory);
    function getPerpPoolParameters() external view returns (Risk memory);
    function isRestricted() external view returns (bool);
    function tryGetMarkPrice() external view returns (bool, uint256);
    function placeOrderFor(address, bool, uint64, uint256, uint256, uint64, uint8, uint8, address, uint96)
        external
        payable
        returns (bool, uint128);
    function placeOrder(bool, uint64, uint256, uint256, uint64, uint8, uint8, address, uint96)
        external
        payable
        returns (bool, uint128);
    function cancelOrder(uint128 orderId) external;
}

interface IDreamFactory {
    function isDeployedByFactory(address pool) external view returns (bool);
}

interface IOperatorRegistry {
    function setOperatorApprovalForPool(address pool, address operator, bytes4[] calldata selectors, bool approved)
        external;
}

interface IBasketRouterConfig {
    function accountFactory() external view returns (address);
    function marketRegistry() external view returns (address);
}
