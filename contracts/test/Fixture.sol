// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {MockToken, MockPermissions, MockFactory, MockBank, MockPool} from "./Mocks.sol";
import {BasketAccountFactory} from "../src/BasketAccountFactory.sol";
import {BasketAccount} from "../src/BasketAccount.sol";
import {BasketRouter} from "../src/BasketRouter.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {IntentTypes} from "../src/IntentTypes.sol";

interface Vm {
    function addr(uint256 key) external returns (address);
    function sign(uint256 key, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function prank(address who) external;
    function startPrank(address who) external;
    function stopPrank() external;
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
    function expectPartialRevert(bytes4 selector) external;
    function warp(uint256 timestamp) external;
    function deal(address who, uint256 balance) external;
    function chainId(uint256 value) external;
}

contract Fixture {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant OWNER_KEY = 0x5151;
    address internal owner;
    address internal executor = address(0xEEEE);
    MockToken internal token;
    MockPermissions internal permissions;
    MockFactory internal protocolFactory;
    MockBank internal bank;
    MarketRegistry internal markets;
    BasketAccountFactory internal factory;
    BasketRouter internal router;
    BasketAccount internal account;
    MockPool[] internal pools;

    function setUp() public virtual {
        vm.warp(1_790_000_000);
        owner = vm.addr(OWNER_KEY);
        token = new MockToken();
        permissions = new MockPermissions();
        protocolFactory = new MockFactory();
        bank = new MockBank(token, address(protocolFactory));
        markets =
            new MarketRegistry(address(bank), address(protocolFactory), address(token), address(this), address(this));
        factory = new BasketAccountFactory(address(bank), address(token), address(permissions), address(markets));
        router = new BasketRouter(address(factory), address(markets));
        for (uint256 i; i < 9; ++i) {
            MockPool pool = new MockPool(bank, permissions, 10 ** (i == 0 ? 8 : i == 1 ? 24 : 18));
            pools.push(pool);
            protocolFactory.register(address(pool));
            bank.register(address(pool));
            markets.configurePool(address(pool), true);
        }
        account = _newAccount(bytes32(uint256(1)), 1000e18);
    }

    function _newAccount(bytes32 salt, uint256 amount) internal returns (BasketAccount a) {
        vm.prank(owner);
        a = BasketAccount(payable(factory.createAccount(salt)));
        token.mint(address(a), amount);
        if (amount > 0) vm.prank(owner);
        a.depositMargin(amount);
        address[] memory allowed = new address[](8);
        for (uint256 i; i < 8; ++i) {
            allowed[i] = address(pools[i]);
        }
        vm.prank(owner);
        a.setRouterApproval(address(router), allowed, true);
    }

    function _intent(uint256 count) internal view returns (IntentTypes.Intent memory intent) {
        intent.account = address(account);
        intent.executor = executor;
        intent.nonce = 1;
        intent.epoch = account.epoch();
        intent.expectedRevision = account.revision();
        intent.validAfter = uint64(block.timestamp);
        intent.validUntil = uint64(block.timestamp + 1 days);
        intent.operation = 0;
        intent.minNetQuote = type(int256).min;
        intent.minPostHealthBps = 20_000;
        intent.legs = new IntentTypes.Leg[](count);
        for (uint256 i; i < count; ++i) {
            uint256 quantity = pools[i].base() / 10;
            intent.legs[i] = IntentTypes.Leg(
                address(pools[i]), i % 2 == 0 ? int128(int256(quantity)) : -int128(int256(quantity)), 100e18, 0
            );
        }
        intent.expectedPositionsHash = router.positionsHash(address(account), intent.legs);
    }

    function _prices(IntentTypes.Intent memory intent) internal pure returns (uint256[] memory prices) {
        prices = new uint256[](intent.legs.length);
        for (uint256 i; i < prices.length; ++i) {
            prices[i] = intent.legs[i].limitPrice;
        }
    }

    function _sign(IntentTypes.Intent memory intent) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, router.hashIntent(intent));
        return abi.encodePacked(r, s, v);
    }

    function _execute(IntentTypes.Intent memory intent) internal {
        bytes memory sig = _sign(intent);
        uint256[] memory prices = _prices(intent);
        vm.prank(executor);
        router.execute(intent, prices, sig);
    }

    function _expect(IntentTypes.Intent memory intent, bytes4 selector) internal {
        bytes memory sig = _sign(intent);
        uint256[] memory prices = _prices(intent);
        vm.expectPartialRevert(selector);
        vm.prank(executor);
        router.execute(intent, prices, sig);
    }
}
