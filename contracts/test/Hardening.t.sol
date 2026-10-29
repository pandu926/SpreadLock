// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Fixture} from "./Fixture.sol";
import {BasketAccount} from "../src/BasketAccount.sol";
import {BasketAccountFactory} from "../src/BasketAccountFactory.sol";
import {BasketRouter} from "../src/BasketRouter.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {IntentTypes} from "../src/IntentTypes.sol";
import {MockPool} from "./Mocks.sol";

contract RejectNativeOwner {
    receive() external payable {
        revert("reject native");
    }
}

contract HardeningTest is Fixture {
    function test_InvalidConstructorsAndRouterBindings() public {
        vm.expectRevert(BasketAccount.InvalidArgument.selector);
        new BasketAccount(address(0), address(bank), address(token), address(permissions), address(markets));
        vm.expectRevert(BasketRouter.InvalidAccount.selector);
        new BasketRouter(address(0), address(markets));
        MarketRegistry other = new MarketRegistry(address(bank), address(protocolFactory), address(token), owner, owner);
        vm.expectRevert(BasketRouter.InvalidAccount.selector);
        new BasketRouter(address(factory), address(other));
        BasketAccountFactory otherFactory =
            new BasketAccountFactory(address(bank), address(token), address(permissions), address(markets));
        BasketRouter otherRouter = new BasketRouter(address(otherFactory), address(markets));
        address[] memory allowed = new address[](1);
        allowed[0] = address(pools[0]);
        vm.expectRevert(BasketAccount.InvalidRouter.selector);
        vm.prank(owner);
        account.setRouterApproval(address(otherRouter), allowed, true);
    }

    function test_NativeFailurePreservesFundsAndAuthorizedRevisionRejectsStale() public {
        RejectNativeOwner rejecting = new RejectNativeOwner();
        vm.prank(address(rejecting));
        BasketAccount a = BasketAccount(payable(factory.createAccount(bytes32(uint256(92)))));
        vm.deal(address(a), 1 ether);
        vm.expectRevert(BasketAccount.InvalidArgument.selector);
        vm.prank(address(rejecting));
        a.withdrawNative(1 ether);
        require(address(a).balance == 1 ether, "funds preserved");
        uint256 staleRevision = account.revision() + 1;
        vm.expectRevert(BasketAccount.InvalidRevision.selector);
        vm.prank(address(router));
        account.recordExecution(staleRevision);
    }

    function test_InvalidAccountAndNonceAuthority() public {
        vm.expectRevert(BasketRouter.InvalidAccount.selector);
        router.invalidateNonces(owner, 0, 1);
        vm.expectRevert(BasketRouter.Unauthorized.selector);
        router.invalidateNonces(address(account), 0, 1);
        vm.prank(address(account));
        router.invalidateNonces(address(account), 0, 1 << 9);
        require(router.nonceUsed(address(account), account.epoch(), 9), "account cancels");
    }

    function testFuzz_NonceBitmapIsolation(uint256 nonce) public {
        uint256 epoch = account.epoch();
        vm.prank(owner);
        router.invalidateNonces(address(account), nonce >> 8, uint256(1) << uint8(nonce));
        require(router.nonceUsed(address(account), epoch, nonce), "selected bit");
        require(!router.nonceUsed(address(account), epoch, nonce ^ 1), "adjacent bit");
        vm.prank(owner);
        account.invalidateIntents();
        require(!router.nonceUsed(address(account), account.epoch(), nonce), "epoch independent");
    }

    function test_InvalidIntentShapes() public {
        IntentTypes.Intent memory intent = _intent(2);
        intent.operation = 3;
        _expect(intent, BasketRouter.InvalidIntent.selector);
        intent = _intent(0);
        _expect(intent, BasketRouter.InvalidIntent.selector);
        intent = _intent(1);
        _expect(intent, BasketRouter.InvalidIntent.selector);
        intent = _intent(2);
        intent.legs = new IntentTypes.Leg[](9);
        _expect(intent, BasketRouter.InvalidIntent.selector);
        intent = _intent(2);
        intent.triggerKind = 3;
        _expect(intent, BasketRouter.InvalidIntent.selector);
        intent = _intent(2);
        intent.executor = address(0);
        _expect(intent, BasketRouter.InvalidIntent.selector);
    }

    function test_ExecutablePriceLengthAndMalformedSignature() public {
        IntentTypes.Intent memory intent = _intent(2);
        bytes memory sig = _sign(intent);
        vm.expectRevert(BasketRouter.InvalidIntent.selector);
        vm.prank(executor);
        router.execute(intent, new uint256[](1), sig);
        uint256[] memory prices = _prices(intent);
        vm.expectRevert(BasketRouter.InvalidSignature.selector);
        vm.prank(executor);
        router.execute(intent, prices, hex"1234");
    }

    function test_OwnerMaySubmitIntentWithoutExecutor() public {
        IntentTypes.Intent memory intent = _intent(2);
        bytes memory sig = _sign(intent);
        uint256[] memory prices = _prices(intent);
        vm.prank(owner);
        router.execute(intent, prices, sig);
        require(account.revision() == intent.expectedRevision + 1, "owner submission");
    }

    function test_WindowDurationAndNanosecondOverflowRejected() public {
        IntentTypes.Intent memory intent = _intent(2);
        intent.validUntil = uint64(block.timestamp + 31 days);
        _expect(intent, BasketRouter.InvalidWindow.selector);
        intent.validUntil = type(uint64).max;
        _expect(intent, BasketRouter.InvalidWindow.selector);
        intent.validUntil = intent.validAfter;
        _expect(intent, BasketRouter.InvalidWindow.selector);
    }

    function test_StalePositionsAndOpenOnExistingBasketRejected() public {
        IntentTypes.Intent memory intent = _intent(2);
        intent.expectedPositionsHash = bytes32(uint256(1));
        _expect(intent, BasketRouter.StaleState.selector);
        _execute(_intent(2));
        intent = _intent(2);
        intent.nonce = 2;
        _expect(intent, BasketRouter.StaleState.selector);
    }

    function test_InvalidLegQuantityPriceAndOracleZero() public {
        IntentTypes.Intent memory intent = _intent(2);
        intent.legs[0].delta = 0;
        _expect(intent, BasketRouter.InvalidLeg.selector);
        intent.legs[0].delta = type(int128).min;
        _expect(intent, BasketRouter.InvalidLeg.selector);
        intent = _intent(2);
        intent.legs[0].limitPrice = 0;
        _expect(intent, BasketRouter.InvalidLeg.selector);
        intent = _intent(2);
        bytes memory sig = _sign(intent);
        uint256[] memory prices = _prices(intent);
        prices[0] = 0;
        vm.expectPartialRevert(BasketRouter.InvalidLeg.selector);
        vm.prank(executor);
        router.execute(intent, prices, sig);
        pools[0].setMark(0, true);
        _expect(intent, BasketRouter.OracleUnavailable.selector);
    }

    function test_MaliciousPoolMutatesEarlierLegAndFinalCheckRollsBackEverything() public {
        IntentTypes.Intent memory intent = _intent(2);
        bytes32 beforeHash = router.positionsHash(address(account), intent.legs);
        // Leg 1 succeeds, then leg 2 causes leg 1's pool to modify its position again.
        // Both immediate per-leg delta checks pass; only the final basket check catches it.
        pools[1].setCallback(address(pools[0]), abi.encodeCall(MockPool.corruptPosition, (address(account), int128(1))));
        _expect(intent, BasketRouter.DeltaMismatch.selector);
        require(router.positionsHash(address(account), intent.legs) == beforeHash, "all legs reverted");
        require(!router.nonceUsed(address(account), intent.epoch, intent.nonce), "nonce reverted");
        require(account.revision() == intent.expectedRevision, "revision reverted");
    }

    function test_MaliciousPoolCannotOpenUnsignedMarket() public {
        IntentTypes.Intent memory intent = _intent(2);
        uint256 revision = account.revision();
        pools[1].setCallback(address(pools[2]), abi.encodeCall(MockPool.corruptPosition, (address(account), int128(1))));
        _expect(intent, BasketRouter.InvalidMarket.selector);
        require(bank.getActivePerpPools(address(account)).length == 0, "unsigned market and signed legs reverted");
        require(!router.nonceUsed(address(account), intent.epoch, intent.nonce), "nonce reverted");
        require(account.revision() == revision, "revision reverted");
    }

    function test_ActiveMarketLimitsBeforeAndAfterExecution() public {
        for (uint256 i; i < 8; ++i) {
            pools[i].corruptPosition(address(account), 1);
        }
        IntentTypes.Intent memory intent = _intent(1);
        intent.operation = IntentTypes.ADJUST;
        intent.legs[0] = IntentTypes.Leg(address(pools[8]), 1, 100e18, 0);
        intent.expectedPositionsHash = router.positionsHash(address(account), intent.legs);
        address[] memory allowed = new address[](1);
        allowed[0] = address(pools[8]);
        vm.prank(owner);
        account.setRouterApproval(address(router), allowed, true);
        intent.epoch = account.epoch();
        intent.expectedRevision = account.revision();
        _expect(intent, BasketRouter.TooManyMarkets.selector);
        require(bank.getActivePerpPools(address(account)).length == 8, "ninth market reverted");
        pools[8].corruptPosition(address(account), 1);
        vm.expectRevert(BasketRouter.TooManyMarkets.selector);
        router.positionsHash(address(account), intent.legs);
    }

    function test_OversizedHashInputAndApprovalRejected() public {
        IntentTypes.Leg[] memory legs = new IntentTypes.Leg[](9);
        vm.expectRevert(BasketRouter.TooManyMarkets.selector);
        router.positionsHash(address(account), legs);
        address[] memory allowed = new address[](9);
        vm.expectRevert(BasketAccount.InvalidArgument.selector);
        vm.prank(owner);
        account.setRouterApproval(address(router), allowed, true);
        vm.expectRevert(BasketAccount.InvalidArgument.selector);
        vm.prank(owner);
        account.withdrawToken(address(0), 1);
    }

    function test_EmergencyShortExitAndRefusedOrderRollback() public {
        _execute(_intent(2));
        uint256 q = pools[1].base() / 10;
        uint64 expiry = uint64((block.timestamp + 60) * 1e9);
        pools[1].setRefuse(true);
        uint256 revision = account.revision();
        vm.expectRevert(BasketAccount.NotFilled.selector);
        vm.prank(owner);
        account.emergencyClose(address(pools[1]), q, 100e18, expiry, true);
        require(account.revision() == revision, "failed exit preserves revision");
        pools[1].setRefuse(false);
        vm.prank(owner);
        account.emergencyClose(address(pools[1]), q, 100e18, expiry, false);
        require(bank.getPosition(address(account), address(pools[1])).size == 0, "short closed");
        vm.expectRevert(BasketAccount.InvalidClose.selector);
        vm.prank(owner);
        account.emergencyClose(address(pools[1]), q, 100e18, expiry, false);
    }

    function test_SignedQuoteAndMarkCannotOverflowInt256() public {
        MockPool unitPool = new MockPool(bank, permissions, 1);
        protocolFactory.register(address(unitPool));
        bank.register(address(unitPool));
        markets.configurePool(address(unitPool), true);
        IntentTypes.Intent memory intent = _intent(2);
        intent.legs[0] = IntentTypes.Leg(address(unitPool), 1, uint256(1) << 255, 0);
        intent.expectedPositionsHash = router.positionsHash(address(account), intent.legs);
        _expect(intent, BasketRouter.InvalidLeg.selector);
        intent.legs[0].limitPrice = 100e18;
        unitPool.setMark(uint256(1) << 255, true);
        _expect(intent, BasketRouter.InvalidLeg.selector);
    }

    function test_UnauthorizedGuardianReplacementRejected() public {
        vm.expectRevert(MarketRegistry.Unauthorized.selector);
        vm.prank(owner);
        markets.setGuardian(owner);
    }
}
