// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IDreamBank, IDreamPool, IOperatorRegistry, IBasketRouterConfig} from "./interfaces/IDreamDex.sol";
import {MarketRegistry} from "./MarketRegistry.sol";

/// @notice One independently funded MarginBank account per basket, controlled by
///         its immutable owner. No shared-parent allowance or arbitrary calls.
contract BasketAccount is IERC1271, ReentrancyGuard {
    using SafeERC20 for IERC20;
    error Unauthorized();
    error InvalidArgument();
    error InvalidRouter();
    error InvalidMarket();
    error InvalidRevision();
    error InvalidClose();
    error NotFilled();
    address public immutable owner;
    address public immutable factory;
    address public immutable bank;
    address public immutable collateral;
    address public immutable permissionsRegistry;
    address public immutable marketRegistry;
    uint256 public epoch;
    uint256 public revision;
    mapping(address => bool) public routerAuthorized;
    event AuthorizationChanged(address indexed router, bool approved, uint256 epoch, uint256 revision);
    event EpochAdvanced(uint256 epoch, uint256 revision);
    event RevisionAdvanced(uint256 revision);
    event MarginDeposited(uint256 amount);
    event MarginWithdrawn(uint256 amount);
    event EmergencyClosed(address indexed pool, int128 delta, uint256 quantity, uint256 price);

    constructor(address owner_, address bank_, address token_, address permissions_, address markets_) {
        if (owner_ == address(0)) revert InvalidArgument();
        owner = owner_;
        factory = msg.sender;
        bank = bank_;
        collateral = token_;
        permissionsRegistry = permissions_;
        marketRegistry = markets_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return SignatureChecker.isValidSignatureNow(owner, hash, signature)
            ? IERC1271.isValidSignature.selector
            : bytes4(0xffffffff);
    }

    function depositMargin(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert InvalidArgument();
        IERC20 token = IERC20(collateral);
        token.forceApprove(bank, amount);
        IDreamBank(bank).deposit(amount);
        token.forceApprove(bank, 0);
        emit MarginDeposited(amount);
    }

    function withdrawMargin(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert InvalidArgument();
        _invalidate();
        IDreamBank(bank).withdraw(amount);
        IERC20(collateral).safeTransfer(owner, amount);
        emit MarginWithdrawn(amount);
    }

    function withdrawToken(address token, uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0 || token == address(0)) revert InvalidArgument();
        IERC20(token).safeTransfer(owner, amount);
    }

    function withdrawNative(uint256 amount) external onlyOwner nonReentrant {
        (bool ok,) = owner.call{value: amount}("");
        if (!ok) revert InvalidArgument();
    }

    function setRouterApproval(address router, address[] calldata pools, bool approved)
        external
        onlyOwner
        nonReentrant
    {
        if (
            router.code.length == 0 || IBasketRouterConfig(router).accountFactory() != factory
                || IBasketRouterConfig(router).marketRegistry() != marketRegistry
        ) revert InvalidRouter();
        if (pools.length == 0 || pools.length > 8) revert InvalidArgument();
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = IDreamPool.placeOrderFor.selector;
        for (uint256 i; i < pools.length; ++i) {
            if (!MarketRegistry(marketRegistry).isKnownPool(pools[i])) revert InvalidMarket();
            IOperatorRegistry(permissionsRegistry).setOperatorApprovalForPool(pools[i], router, selectors, approved);
        }
        routerAuthorized[router] = approved;
        _invalidate();
        emit AuthorizationChanged(router, approved, epoch, revision);
    }

    function invalidateIntents() external onlyOwner {
        _invalidate();
    }

    function recordExecution(uint256 expectedRevision) external {
        if (!routerAuthorized[msg.sender]) revert Unauthorized();
        if (revision != expectedRevision) revert InvalidRevision();
        ++revision;
        emit RevisionAdvanced(revision);
    }

    function cancelOrder(address pool, uint128 orderId) external onlyOwner nonReentrant {
        if (!MarketRegistry(marketRegistry).isKnownPool(pool)) revert InvalidMarket();
        _invalidate();
        IDreamPool(pool).cancelOrder(orderId);
    }

    function emergencyClose(address pool, uint256 quantity, uint256 limitPrice, uint64 expiryNs, bool immediateOrCancel)
        external
        onlyOwner
        nonReentrant
    {
        if (!MarketRegistry(marketRegistry).isKnownPool(pool)) revert InvalidMarket();
        int256 beforeSize = IDreamBank(bank).getPosition(address(this), pool).size;
        if (beforeSize == 0 || quantity == 0 || quantity > uint256(beforeSize > 0 ? beforeSize : -beforeSize)) {
            revert InvalidClose();
        }
        if (expiryNs <= block.timestamp * 1e9) revert InvalidArgument();
        _invalidate();
        (bool accepted,) = IDreamPool(pool)
            .placeOrder(beforeSize < 0, 0, limitPrice, quantity, expiryNs, immediateOrCancel ? 2 : 1, 0, address(0), 0);
        int256 afterSize = IDreamBank(bank).getPosition(address(this), pool).size;
        int256 delta = afterSize - beforeSize;
        if (
            !accepted || delta == 0 || (beforeSize > 0 && (delta > 0 || afterSize < 0))
                || (beforeSize < 0 && (delta < 0 || afterSize > 0))
        ) revert NotFilled();
        uint256 filled = uint256(delta > 0 ? delta : -delta);
        if (filled > quantity || (!immediateOrCancel && filled != quantity)) revert NotFilled();
        emit EmergencyClosed(pool, int128(delta), filled, limitPrice);
    }

    function _invalidate() private {
        ++epoch;
        ++revision;
        emit EpochAdvanced(epoch, revision);
    }
    receive() external payable {}
}
