// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {Fixture} from "./Fixture.sol";
import {IntentTypes} from "../src/IntentTypes.sol";
import {BasketRouter} from "../src/BasketRouter.sol";
import {BasketAccount} from "../src/BasketAccount.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {MockPool} from "./Mocks.sol";

contract BasketRouterTest is Fixture {
    function test_OpensEightLegBasket() public {
        IntentTypes.Intent memory intent = _intent(8);
        _execute(intent);
        require(bank.getActivePerpPools(address(account)).length == 8, "eight markets");
        for (uint256 i; i < 8; ++i) {
            require(bank.getPosition(address(account), address(pools[i])).size == intent.legs[i].delta, "exact delta");
        }
        require(account.revision() == intent.expectedRevision + 1, "revision");
        require(router.nonceUsed(address(account), intent.epoch, intent.nonce), "nonce");
    }

    function test_ClosesFullBasket() public {
        _execute(_intent(8));
        IntentTypes.Intent memory close = _intent(8);
        close.operation = 2;
        close.nonce = 2;
        for (uint256 i; i < 8; ++i) {
            close.legs[i].delta = -close.legs[i].delta;
        }
        _execute(close);
        require(bank.getActivePerpPools(address(account)).length == 0, "flat");
    }

    function test_PartialCloseAndResize() public {
        _execute(_intent(2));
        IntentTypes.Intent memory close = _intent(2);
        close.operation = 2;
        close.nonce = 2;
        for (uint256 i; i < 2; ++i) {
            close.legs[i].delta = -close.legs[i].delta / 2;
        }
        _execute(close);
        IntentTypes.Intent memory resize = _intent(2);
        resize.operation = 1;
        resize.nonce = 3;
        _execute(resize);
        require(
            bank.getPosition(address(account), address(pools[0])).size == int128(int256(pools[0].base() * 15 / 100)),
            "resized"
        );
    }

    function test_FailureAtEveryIndexRollsBackAllLegs() public {
        for (uint256 failing; failing < 8; ++failing) {
            pools[failing].setReject(true);
            IntentTypes.Intent memory intent = _intent(8);
            bytes memory sig = _sign(intent);
            uint256[] memory prices = _prices(intent);
            vm.expectRevert(MockPool.FillOrKillNotFillable.selector);
            vm.prank(executor);
            router.execute(intent, prices, sig);
            require(bank.getActivePerpPools(address(account)).length == 0, "orphan");
            require(!router.nonceUsed(address(account), intent.epoch, intent.nonce), "failed nonce consumed");
            require(bank.balance(address(account)) == 1000e18, "collateral changed");
            pools[failing].setReject(false);
        }
    }

    function test_FalseAndPartialFillAreRejected() public {
        IntentTypes.Intent memory intent = _intent(2);
        pools[1].setRefuse(true);
        _expect(intent, BasketRouter.NotFilled.selector);
        pools[1].setRefuse(false);
        pools[1].setPartial(true);
        _expect(intent, BasketRouter.DeltaMismatch.selector);
        require(bank.getActivePerpPools(address(account)).length == 0, "partial orphan");
    }

    function test_ReplayCannotExecuteAgain() public {
        IntentTypes.Intent memory intent = _intent(2);
        _execute(intent);
        _expect(intent, BasketRouter.StaleState.selector);
    }

    function test_IndividualCancellation() public {
        IntentTypes.Intent memory intent = _intent(2);
        vm.prank(owner);
        router.invalidateNonces(address(account), 0, 2);
        _expect(intent, BasketRouter.NonceUnavailable.selector);
    }

    function test_EpochCancellation() public {
        IntentTypes.Intent memory intent = _intent(2);
        vm.prank(owner);
        account.invalidateIntents();
        _expect(intent, BasketRouter.StaleState.selector);
    }

    function test_CancelledNonceInOtherWord() public {
        IntentTypes.Intent memory intent = _intent(2);
        intent.nonce = 257;
        vm.prank(owner);
        router.invalidateNonces(address(account), 1, 2);
        _expect(intent, BasketRouter.NonceUnavailable.selector);
    }

    function test_WrongSignatureAndExecutorAreRejected() public {
        IntentTypes.Intent memory intent = _intent(2);
        bytes memory sig = _sign(intent);
        uint256[] memory prices = _prices(intent);
        vm.expectRevert(BasketRouter.InvalidExecutor.selector);
        router.execute(intent, prices, sig);
        vm.expectRevert(BasketRouter.InvalidSignature.selector);
        vm.prank(executor);
        router.execute(intent, prices, new bytes(65));
    }

    function test_ExpiredAndFutureIntentRejected() public {
        IntentTypes.Intent memory intent = _intent(2);
        intent.validUntil = uint64(block.timestamp);
        _expect(intent, BasketRouter.InvalidWindow.selector);
        intent.validUntil = uint64(block.timestamp + 2 days);
        intent.validAfter = uint64(block.timestamp + 1 days);
        _expect(intent, BasketRouter.InvalidWindow.selector);
    }

    function test_SignatureCannotCrossRouterOrChain() public {
        IntentTypes.Intent memory intent = _intent(2);
        bytes32 digest = router.hashIntent(intent);
        BasketRouter second = new BasketRouter(address(factory), address(markets));
        require(second.hashIntent(intent) != digest, "router domain");
        vm.chainId(block.chainid + 1);
        require(router.hashIntent(intent) != digest, "chain domain");
    }

    function test_DuplicateAndUnknownMarketsRejected() public {
        IntentTypes.Intent memory intent = _intent(2);
        intent.legs[1].pool = intent.legs[0].pool;
        intent.expectedPositionsHash = router.positionsHash(address(account), intent.legs);
        _expect(intent, BasketRouter.InvalidLeg.selector);
        intent.legs[1].pool = address(0x1234);
        intent.expectedPositionsHash = router.positionsHash(address(account), intent.legs);
        _expect(intent, BasketRouter.InvalidMarket.selector);
    }

    function test_PriceCanOnlyTightenSignedCaps() public {
        IntentTypes.Intent memory intent = _intent(2);
        bytes memory sig = _sign(intent);
        uint256[] memory prices = _prices(intent);
        prices[0] += 1;
        vm.expectPartialRevert(BasketRouter.PriceOutsideLimit.selector);
        vm.prank(executor);
        router.execute(intent, prices, sig);
        prices[0] -= 1;
        prices[1] -= 1;
        vm.expectPartialRevert(BasketRouter.PriceOutsideLimit.selector);
        vm.prank(executor);
        router.execute(intent, prices, sig);
    }

    function test_FeeLimitAndConservativeQuote() public {
        pools[0].setFee(10000);
        IntentTypes.Intent memory intent = _intent(2);
        _expect(intent, BasketRouter.FeeOutsideLimit.selector);
        intent.legs[0].maxTakerFeeBpsTimes1k = 10000;
        intent.minNetQuote = 1;
        _expect(intent, BasketRouter.QuoteTooLow.selector);
        intent.minNetQuote = type(int256).min;
        _execute(intent);
        require(bank.balance(address(account)) < 1000e18, "fee charged");
    }

    function test_MarkTriggersAndStaleOracle() public {
        IntentTypes.Intent memory intent = _intent(2);
        intent.triggerKind = 1;
        intent.triggerValue = 1;
        _expect(intent, BasketRouter.TriggerNotMet.selector);
        intent.triggerKind = 2;
        intent.triggerValue = -1;
        _expect(intent, BasketRouter.TriggerNotMet.selector);
        intent.triggerKind = 0;
        pools[0].setMark(100e18, false);
        _expect(intent, BasketRouter.OracleUnavailable.selector);
    }

    function test_PauseAndDisableAllowExit() public {
        IntentTypes.Intent memory intent = _intent(2);
        markets.pauseEntry();
        _expect(intent, BasketRouter.EntryPaused.selector);
        markets.resumeEntry();
        _execute(intent);
        markets.pauseEntry();
        markets.configurePool(address(pools[0]), false);
        IntentTypes.Intent memory close = _intent(2);
        close.nonce = 2;
        close.operation = 2;
        for (uint256 i; i < 2; ++i) {
            close.legs[i].delta = -close.legs[i].delta;
        }
        _execute(close);
        require(bank.getActivePerpPools(address(account)).length == 0, "exit must work");
    }

    function test_DisabledAndRestrictedEntryRejected() public {
        IntentTypes.Intent memory intent = _intent(2);
        markets.configurePool(address(pools[0]), false);
        _expect(intent, BasketRouter.InvalidMarket.selector);
        markets.configurePool(address(pools[0]), true);
        pools[0].setRestricted(true);
        _expect(intent, BasketRouter.InvalidMarket.selector);
    }

    function test_PostTradeEquityAndHealthGuard() public {
        IntentTypes.Intent memory intent = _intent(2);
        intent.minPostEquity = 1001e18;
        _expect(intent, BasketRouter.InsufficientPostTradeHealth.selector);
        intent.minPostEquity = 0;
        intent.minPostHealthBps = type(uint32).max;
        _expect(intent, BasketRouter.InsufficientPostTradeHealth.selector);
        require(bank.getActivePerpPools(address(account)).length == 0, "health orphan");
    }

    function test_CloseCannotOpenOrFlip() public {
        IntentTypes.Intent memory intent = _intent(2);
        intent.operation = 2;
        _expect(intent, BasketRouter.InvalidClose.selector);
        intent.operation = 0;
        _execute(intent);
        IntentTypes.Intent memory close = _intent(2);
        close.nonce = 2;
        close.operation = 2;
        for (uint256 i; i < 2; ++i) {
            close.legs[i].delta = -close.legs[i].delta * 2;
        }
        _expect(close, BasketRouter.InvalidClose.selector);
    }

    function test_ReentryIsRejectedAndRollsBack() public {
        IntentTypes.Intent memory intent = _intent(2);
        bytes memory sig = _sign(intent);
        uint256[] memory prices = _prices(intent);
        pools[0].setCallback(address(router), abi.encodeCall(router.execute, (intent, prices, sig)));
        vm.expectRevert();
        vm.prank(executor);
        router.execute(intent, prices, sig);
        require(bank.getActivePerpPools(address(account)).length == 0, "reentry orphan");
    }

    function test_IsolatedAccountsDoNotShareMargin() public {
        _execute(_intent(2));
        BasketAccount first = account;
        account = _newAccount(bytes32(uint256(2)), 1e15);
        IntentTypes.Intent memory intent = _intent(2);
        bytes memory sig = _sign(intent);
        uint256[] memory prices = _prices(intent);
        vm.expectRevert();
        vm.prank(executor);
        router.execute(intent, prices, sig);
        require(bank.balance(address(first)) == 1000e18, "other basket collateral");
        require(bank.getActivePerpPools(address(first)).length == 2, "other basket positions");
    }

    function testFuzz_BasketCountAndDirections(uint8 countSeed, bool invert) public {
        uint256 count = uint256(countSeed) % 7 + 2;
        IntentTypes.Intent memory intent = _intent(count);
        if (invert) {
            for (uint256 i; i < count; ++i) {
                intent.legs[i].delta = -intent.legs[i].delta;
            }
        }
        _execute(intent);
        for (uint256 i; i < count; ++i) {
            require(bank.getPosition(address(account), intent.legs[i].pool).size == intent.legs[i].delta, "fuzz delta");
        }
    }
}
