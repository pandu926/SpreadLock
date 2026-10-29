// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BasketAccountFactory} from "../src/BasketAccountFactory.sol";
import {BasketAccount} from "../src/BasketAccount.sol";
import {BasketRouter} from "../src/BasketRouter.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {IntentTypes} from "../src/IntentTypes.sol";
import {IDreamBank, IDreamPool} from "../src/interfaces/IDreamDex.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ForkVm {
    function envOr(string calldata, bool) external returns (bool);
    function envOr(string calldata, uint256) external returns (uint256);
    function createSelectFork(string calldata, uint256) external returns (uint256);
    function skip(bool) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function expectRevert() external;
}

interface IDiscovery {
    function getPerpPools() external view returns (address[] memory);
}

interface IBook {
    struct Level {
        uint256 price;
        uint256 quantity;
    }
    function getBookLevels(bool, uint64) external view returns (Level[] memory);
}

/// @dev Opt-in, read-only public RPC + local fork writes. No public transactions.
contract DreamdexForkTest {
    ForkVm constant vm = ForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant BANK = 0x478769E1177C0773c43A593DCCc4Ad15F15F1394;
    address constant TOKEN = 0xed7993A74dAe1e6656B704A424DcD8711aAf4F72;
    address constant PROTOCOL_FACTORY = 0xE631fAEE547baeE07353E290f0562ea67d856560;
    address constant PERMISSIONS = 0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a;
    address constant DONOR = 0xd58596620Ee6951B2958a931949e4ff7ce6222be;
    uint256 constant KEY = 0x512345;
    address owner;
    BasketAccount account;
    BasketRouter router;
    MarketRegistry markets;
    BasketAccountFactory factory;
    address[] pools;
    event log_named_uint(string key, uint256 value);

    function setUp() public {
        if (!vm.envOr("DREAMDEX_FORK_TESTS", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("dreamdex", vm.envOr("DREAMDEX_FORK_BLOCK", uint256(34991667)));
        owner = vm.addr(KEY);
        markets = new MarketRegistry(BANK, PROTOCOL_FACTORY, TOKEN, address(this), address(this));
        factory = new BasketAccountFactory(BANK, TOKEN, PERMISSIONS, address(markets));
        router = new BasketRouter(address(factory), address(markets));
        address[] memory discovered = IDiscovery(PROTOCOL_FACTORY).getPerpPools();
        for (uint256 i; i < discovered.length && pools.length < 8; ++i) {
            if (!IDreamPool(discovered[i]).isRestricted() && IDreamBank(BANK).isPerpPoolRegistered(discovered[i])) {
                markets.configurePool(discovered[i], true);
                pools.push(discovered[i]);
            }
        }
        require(pools.length == 8, "need eight verified pools");
        vm.prank(owner);
        account = BasketAccount(payable(factory.createAccount(keccak256("fork basket"))));
        // Transfer real collateral from a funded external donor ONLY in this local
        // fork. No bank borrowing, minting, code overrides or artificial liquidity.
        vm.prank(DONOR);
        require(IERC20(TOKEN).transfer(address(account), 1000e18), "fork transfer");
        vm.prank(owner);
        account.depositMargin(1000e18);
        address[] memory allowed = pools;
        vm.prank(owner);
        account.setRouterApproval(address(router), allowed, true);
    }

    function _intent(uint256 count, bool closing) internal view returns (IntentTypes.Intent memory intent) {
        intent.account = address(account);
        intent.executor = address(this);
        intent.nonce = closing ? 2 : 1;
        intent.epoch = account.epoch();
        intent.expectedRevision = account.revision();
        intent.validAfter = uint64(block.timestamp);
        intent.validUntil = uint64(block.timestamp + 300);
        intent.operation = closing ? 2 : 0;
        intent.minNetQuote = type(int256).min;
        intent.minPostHealthBps = 20_000;
        intent.legs = new IntentTypes.Leg[](count);
        for (uint256 i; i < count; ++i) {
            IDreamPool.Grid memory grid = IDreamPool(pools[i]).getOrderBookParameters();
            bool buy = (i % 2 == 0) != closing;
            IBook.Level[] memory levels = IBook(pools[i]).getBookLevels(!buy, 1);
            require(levels.length > 0 && levels[0].quantity >= grid.minQuantity, "live depth below minimum");
            intent.legs[i] = IntentTypes.Leg(
                pools[i],
                buy ? int128(int256(grid.minQuantity)) : -int128(int256(grid.minQuantity)),
                levels[0].price,
                uint32(IDreamPool(pools[i]).getPerpPoolParameters().takerFeeBpsTimes1k)
            );
        }
        intent.expectedPositionsHash = router.positionsHash(address(account), intent.legs);
    }

    function _execute(IntentTypes.Intent memory intent) internal {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, router.hashIntent(intent));
        uint256[] memory prices = new uint256[](intent.legs.length);
        for (uint256 i; i < prices.length; ++i) {
            prices[i] = intent.legs[i].limitPrice;
        }
        router.execute(intent, prices, abi.encodePacked(r, s, v));
    }

    function testFork_EightLegSignedAccountLifecycleAndOwnerExit() public {
        uint256 start = gasleft();
        _execute(_intent(8, false));
        emit log_named_uint("eight-leg signed router open gas", start - gasleft());
        require(IDreamBank(BANK).getActivePerpPools(address(account)).length == 8, "eight actual positions");
        start = gasleft();
        _execute(_intent(8, true));
        emit log_named_uint("eight-leg signed router close gas", start - gasleft());
        require(IDreamBank(BANK).getActivePerpPools(address(account)).length == 0, "not flat");
        vm.prank(owner);
        account.invalidateIntents();
        vm.prank(owner);
        account.withdrawMargin(100e18);
        require(IERC20(TOKEN).balanceOf(owner) == 100e18, "owner withdraw");
    }

    function testFork_SecondLegFailureRollsBackPositionAndNonce() public {
        IntentTypes.Intent memory intent = _intent(2, false);
        // BTC second leg buys far below its ask, valid tick but no executable fill.
        address tempPool = intent.legs[0].pool;
        intent.legs[0].pool = intent.legs[1].pool;
        intent.legs[0].delta = -intent.legs[1].delta;
        IBook.Level[] memory asks = IBook(intent.legs[0].pool).getBookLevels(false, 1);
        intent.legs[0].limitPrice = asks[0].price;
        intent.legs[1].pool = tempPool;
        intent.legs[1].delta = int128(int256(IDreamPool(tempPool).getOrderBookParameters().minQuantity));
        intent.legs[1].limitPrice = IDreamPool(tempPool).getOrderBookParameters().tickSize;
        intent.expectedPositionsHash = router.positionsHash(address(account), intent.legs);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, router.hashIntent(intent));
        uint256[] memory prices = new uint256[](2);
        prices[0] = intent.legs[0].limitPrice;
        prices[1] = intent.legs[1].limitPrice;
        vm.expectRevert();
        router.execute(intent, prices, abi.encodePacked(r, s, v));
        require(IDreamBank(BANK).getActivePerpPools(address(account)).length == 0, "orphan");
        require(!router.nonceUsed(address(account), intent.epoch, intent.nonce), "nonce consumed on failure");
        // Control: executable two-leg account/router signature works after failure.
        _execute(_intent(2, false));
        require(IDreamBank(BANK).getActivePerpPools(address(account)).length == 2, "control fill");
    }
}
