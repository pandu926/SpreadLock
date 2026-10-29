// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IDreamBank, IDreamPool, IDreamFactory, IOperatorRegistry} from "../src/interfaces/IDreamDex.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Quote collateral", "USDso") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockPermissions is IOperatorRegistry {
    mapping(address => mapping(address => mapping(address => bool))) public approved;

    function setOperatorApprovalForPool(address pool, address operator, bytes4[] calldata, bool allow) external {
        approved[msg.sender][pool][operator] = allow;
    }
}

contract MockFactory is IDreamFactory {
    mapping(address => bool) public isDeployedByFactory;

    function register(address pool) external {
        isDeployedByFactory[pool] = true;
    }
}

contract MockBank is IDreamBank {
    MockToken public immutable token;
    address public immutable factory;
    mapping(address => mapping(address => Position)) private positions;
    mapping(address => address[]) private active;
    mapping(address => bool) public isPerpPoolRegistered;
    mapping(address => int256) public balance;
    bool public wired = true;
    error InsufficientMarginForOrder();

    constructor(MockToken token_, address factory_) {
        token = token_;
        factory = factory_;
    }

    function register(address pool) external {
        isPerpPoolRegistered[pool] = true;
    }

    function setWired(bool value) external {
        wired = value;
    }

    function getSystemConfig() external view returns (SystemConfig memory) {
        return SystemConfig(address(this), address(token), factory, address(1), address(2), address(3), 20, wired);
    }

    function getPosition(address who, address pool) external view returns (Position memory) {
        return positions[who][pool];
    }

    function getActivePerpPools(address who) external view returns (address[] memory) {
        return active[who];
    }

    function deposit(uint256 amount) external {
        token.transferFrom(msg.sender, address(this), amount);
        balance[msg.sender] += int256(amount);
    }

    function withdraw(uint256 amount) external {
        balance[msg.sender] -= int256(amount);
        (int256 eq, uint256 im,,) = getAccountHealth(msg.sender);
        if (eq < int256(im)) revert InsufficientMarginForOrder();
        token.transfer(msg.sender, amount);
    }

    function getAccountHealth(address who) public view returns (int256 equity, uint256 im, uint256 mm, uint256 cm) {
        equity = balance[who];
        for (uint256 i; i < active[who].length; ++i) {
            address pool = active[who][i];
            Position memory pos = positions[who][pool];
            (, uint256 mark) = IDreamPool(pool).tryGetMarkPrice();
            uint256 base = IDreamPool(pool).getOneBase();
            uint256 absSize = uint256(pos.size > 0 ? int256(pos.size) : -int256(pos.size));
            equity += (int256(mark) - int256(uint256(pos.avgEntryPrice))) * int256(pos.size) / int256(base);
            im += absSize * mark / base / 20;
            mm += absSize * mark / base / 40;
        }
        cm = mm / 2;
    }

    function settle(address who, int128 delta, uint256 price, uint256 fee) external {
        require(isPerpPoolRegistered[msg.sender], "unregistered pool");
        Position storage p = positions[who][msg.sender];
        int128 beforeSize = p.size;
        int256 next = int256(beforeSize) + int256(delta);
        require(next >= type(int128).min && next <= type(int128).max, "size overflow");
        uint256 beforeAbs = uint256(beforeSize > 0 ? int256(beforeSize) : -int256(beforeSize));
        uint256 deltaAbs = uint256(delta > 0 ? int256(delta) : -int256(delta));
        uint256 afterAbs = uint256(next >= 0 ? next : -next);
        uint256 base = IDreamPool(msg.sender).getOneBase();
        if (beforeSize == 0 || (beforeSize > 0) == (delta > 0)) {
            p.avgEntryPrice = uint128((uint256(p.avgEntryPrice) * beforeAbs + price * deltaAbs) / afterAbs);
        } else {
            uint256 closed = beforeAbs < deltaAbs ? beforeAbs : deltaAbs;
            balance[who] += (int256(price) - int256(uint256(p.avgEntryPrice))) * int256(closed)
                * (beforeSize > 0 ? int256(1) : int256(-1)) / int256(base);
            if (next == 0) p.avgEntryPrice = 0;
            else if ((next > 0) != (beforeSize > 0)) p.avgEntryPrice = uint128(price);
        }
        p.size = int128(next);
        balance[who] -= int256(fee);
        if (beforeSize == 0 && next != 0) active[who].push(msg.sender);
        if (beforeSize != 0 && next == 0) {
            for (uint256 i; i < active[who].length; ++i) {
                if (active[who][i] == msg.sender) {
                    active[who][i] = active[who][active[who].length - 1];
                    active[who].pop();
                    break;
                }
            }
        }
        if (afterAbs > beforeAbs) {
            (int256 equity, uint256 im,,) = getAccountHealth(who);
            if (equity < int256(im)) revert InsufficientMarginForOrder();
        }
    }
}

contract MockPool is IDreamPool {
    MockBank public immutable bank;
    MockPermissions public immutable permissions;
    uint256 public immutable base;
    uint256 public mark = 100e18;
    uint256 public fee;
    bool public restricted;
    bool public live = true;
    bool public reject;
    bool public refuse;
    bool public partialFill;
    bool public attack;
    address public callbackTarget;
    bytes public callbackData;
    error FillOrKillNotFillable();

    constructor(MockBank bank_, MockPermissions perms_, uint256 base_) {
        bank = bank_;
        permissions = perms_;
        base = base_;
    }

    /// @dev Adversarial registered-pool behavior, used only to test router final-state checks.
    function corruptPosition(address who, int128 delta) external {
        bank.settle(who, delta, mark, 0);
    }

    function setFee(uint256 value) external {
        fee = value;
    }

    function setMark(uint256 value, bool live_) external {
        mark = value;
        live = live_;
    }

    function setRestricted(bool value) external {
        restricted = value;
    }

    function setReject(bool value) external {
        reject = value;
    }

    function setRefuse(bool value) external {
        refuse = value;
    }

    function setPartial(bool value) external {
        partialFill = value;
    }

    function setCallback(address target, bytes calldata data) external {
        callbackTarget = target;
        callbackData = data;
        attack = true;
    }

    function marginBank() external view returns (address) {
        return address(bank);
    }

    struct BookLevel {
        uint256 price;
        uint256 quantity;
    }

    function getBookLevels(bool, uint64) external view returns (BookLevel[] memory levels) {
        levels = new BookLevel[](1);
        levels[0] = BookLevel(mark, base * 1000);
    }

    function getOneBase() external view returns (uint256) {
        return base;
    }

    function getOrderBookParameters() external view returns (Grid memory) {
        return Grid(1, 1, 1);
    }

    function getPerpPoolParameters() external view returns (Risk memory) {
        return Risk(500, 250, 125, type(uint128).max, type(uint128).max, fee, 0, 0);
    }

    function isRestricted() external view returns (bool) {
        return restricted;
    }

    function tryGetMarkPrice() external view returns (bool, uint256) {
        return (live, mark);
    }

    function placeOrderFor(
        address who,
        bool isBid,
        uint64,
        uint256 price,
        uint256 q,
        uint64,
        uint8,
        uint8,
        address,
        uint96
    ) external payable returns (bool, uint128) {
        require(permissions.approved(who, address(this), msg.sender), "no operator grant");
        return _place(who, isBid, price, q);
    }

    function placeOrder(bool isBid, uint64, uint256 price, uint256 q, uint64, uint8, uint8, address, uint96)
        external
        payable
        returns (bool, uint128)
    {
        return _place(msg.sender, isBid, price, q);
    }
    function cancelOrder(uint128) external {}

    function _place(address who, bool isBid, uint256 price, uint256 q) private returns (bool, uint128) {
        if (reject) revert FillOrKillNotFillable();
        if (refuse) return (false, 0);
        require(live && (isBid ? price >= mark : price <= mark), "limit not executable");
        uint256 actual = partialFill ? q / 2 : q;
        uint256 notional = actual * mark / base;
        uint256 charge = (notional * fee + 9_999_999) / 10_000_000;
        bank.settle(who, isBid ? int128(int256(actual)) : -int128(int256(actual)), mark, charge);
        if (attack) {
            (bool ok,) = callbackTarget.call(callbackData);
            require(ok, "callback rejected");
        }
        return (true, 1);
    }
}
