// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Fixture} from "./Fixture.sol";
import {MockPool} from "./Mocks.sol";
import {IntentTypes} from "../src/IntentTypes.sol";
import {BasketAccount} from "../src/BasketAccount.sol";
import {BasketRouter} from "../src/BasketRouter.sol";

interface VerificationVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

/// @dev Models a wallet whose signature policy can change independently of basket state.
contract MutableSignatureOwner {
    uint256 public mode;

    function setMode(uint256 next) external {
        mode = next;
    }

    fallback() external {
        uint256 selected = mode;
        if (selected == 1) revert("signature service unavailable");
        if (selected == 2) {
            assembly { return(0, 0) }
        }
        bytes4 result = selected == 0 ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
        assembly {
            mstore(0, result)
            return(0, 32)
        }
    }
}

contract ProductionVerificationTest is Fixture {
    VerificationVm private constant verificationVm = VerificationVm(address(vm));
    bytes32 private constant EXECUTED =
        keccak256("IntentExecuted(bytes32,address,address,uint256,uint256,uint256,int256)");

    // Deliberately does not import production Math/domain helpers. The reference
    // splits into single-unit fills and rounds using quotient/remainder only.
    function _ceilReference(uint256 numerator, uint256 denominator) private pure returns (uint256) {
        uint256 result = numerator / denominator;
        return result + (numerator % denominator == 0 ? 0 : 1);
    }

    function _fillReference(uint256 units, uint256 price, uint256 base, uint256 fee, bool buy)
        private
        pure
        returns (int256 bound)
    {
        for (uint256 j; j < units; ++j) {
            uint256 gross = buy ? _ceilReference(price, base) : price / base;
            uint256 charge = _ceilReference(gross * fee, 10_000_000);
            bound += buy ? -int256(gross + charge) : int256(gross - charge);
        }
    }

    function _installReferencePool(uint256 base, uint256 mark, uint256 fee) private returns (MockPool pool) {
        pool = new MockPool(bank, permissions, base);
        pool.setMark(mark, true);
        pool.setFee(fee);
        protocolFactory.register(address(pool));
        bank.register(address(pool));
        markets.configurePool(address(pool), true);
    }

    function testFuzz_IndependentFragmentedQuoteMarkAndFeeAccounting(
        uint32 priceSeed,
        uint16 baseSeed,
        uint16 feeSeed,
        uint8 quantitySeed,
        bool reverse
    ) public {
        uint256 base0 = 3 + uint256(baseSeed) % 97;
        uint256 base1 = 7 + uint256(baseSeed) % 89;
        uint256 price0 = 100e18 + uint256(priceSeed);
        uint256 price1 = 101e18 + uint256(priceSeed) * 3;
        uint256 fee0 = uint256(feeSeed) % 50_001;
        uint256 fee1 = uint256(feeSeed) % 17_003;
        uint256 q0 = 1 + uint256(quantitySeed) % 7;
        uint256 q1 = 1 + uint256(quantitySeed) % 5;
        MockPool first = _installReferencePool(base0, price0, fee0);
        MockPool second = _installReferencePool(base1, price1, fee1);
        address[] memory allowed = new address[](2);
        allowed[0] = address(first);
        allowed[1] = address(second);
        vm.prank(owner);
        account.setRouterApproval(address(router), allowed, true);
        IntentTypes.Intent memory intent = _intent(2);
        intent.legs[0] =
            IntentTypes.Leg(address(first), reverse ? -int128(int256(q0)) : int128(int256(q0)), price0, uint32(fee0));
        intent.legs[1] =
            IntentTypes.Leg(address(second), reverse ? int128(int256(q1)) : -int128(int256(q1)), price1, uint32(fee1));
        intent.expectedPositionsHash = router.positionsHash(address(account), intent.legs);
        int256 quote =
            _fillReference(q0, price0, base0, fee0, !reverse) + _fillReference(q1, price1, base1, fee1, reverse);
        int256 firstMark = int256(q0 * price0 / base0);
        int256 secondMark = int256(q1 * price1 / base1);
        int256 markQuote = reverse ? firstMark - secondMark : secondMark - firstMark;
        intent.minNetQuote = quote + 1;
        _expect(intent, BasketRouter.QuoteTooLow.selector);
        intent.minNetQuote = quote;
        intent.triggerKind = 1;
        intent.triggerValue = markQuote + 1;
        _expect(intent, BasketRouter.TriggerNotMet.selector);
        intent.triggerKind = 2;
        intent.triggerValue = markQuote - 1;
        _expect(intent, BasketRouter.TriggerNotMet.selector);
        intent.triggerKind = reverse ? 2 : 1;
        intent.triggerValue = markQuote;
        verificationVm.recordLogs();
        _execute(intent);
        VerificationVm.Log[] memory logs = verificationVm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(router) && logs[i].topics[0] == EXECUTED) {
                (,,, int256 actualQuote) = abi.decode(logs[i].data, (uint256, uint256, uint256, int256));
                require(actualQuote == quote, "independent fragmented quote");
                found = true;
            }
        }
        require(found, "execution event required");
        uint256 actualFee0 = _ceilReference((q0 * price0 / base0) * fee0, 10_000_000);
        uint256 actualFee1 = _ceilReference((q1 * price1 / base1) * fee1, 10_000_000);
        require(bank.balance(address(account)) == int256(1000e18 - actualFee0 - actualFee1), "fee conservation");
        require(bank.getPosition(address(account), address(first)).size == intent.legs[0].delta, "first size");
        require(bank.getPosition(address(account), address(second)).size == intent.legs[1].delta, "second size");
    }

    function test_IntraTransactionFeeIncreaseCannotExceedSignedCap() public {
        IntentTypes.Intent memory intent = _intent(2);
        pools[0].setCallback(address(pools[1]), abi.encodeCall(MockPool.setFee, (100_000)));
        _expect(intent, BasketRouter.FeeOutsideLimit.selector);
        require(bank.balance(address(account)) == 1000e18, "fee attack rolled back");
        require(bank.getActivePerpPools(address(account)).length == 0, "fee attack positions rolled back");
        require(!router.nonceUsed(address(account), intent.epoch, intent.nonce), "fee attack nonce rolled back");
    }

    function test_IndependentGoldenRealizedPnlAndFeeConservation() public {
        pools[0].setFee(10_000);
        pools[1].setFee(10_000);
        IntentTypes.Intent memory opening = _intent(2);
        opening.legs[0].maxTakerFeeBpsTimes1k = 10_000;
        opening.legs[1].maxTakerFeeBpsTimes1k = 10_000;
        _execute(opening);
        require(bank.balance(address(account)) == 99998e16, "opening fees: 0.02 collateral");
        pools[0].setMark(110e18, true);
        pools[1].setMark(90e18, true);
        (int256 equity,,,) = bank.getAccountHealth(address(account));
        require(equity == 100198e16, "unrealized PnL: +1 long, +1 short");
        IntentTypes.Intent memory closing = _intent(2);
        closing.operation = IntentTypes.CLOSE;
        closing.nonce = 2;
        for (uint256 j; j < 2; ++j) {
            closing.legs[j].delta = -closing.legs[j].delta;
            closing.legs[j].limitPrice = j == 0 ? 110e18 : 90e18;
            closing.legs[j].maxTakerFeeBpsTimes1k = 10_000;
        }
        _execute(closing);
        require(bank.balance(address(account)) == 100196e16, "realized +2 less 0.04 total fees");
        require(bank.getActivePerpPools(address(account)).length == 0, "golden roundtrip flat");
    }

    function test_AllOpenSizesNormalDirectionLifecycle() public {
        _allOpenSizesLifecycle(0);
    }

    function test_AllOpenSizesInverseDirectionLifecycle() public {
        _allOpenSizesLifecycle(1);
    }

    function _allOpenSizesLifecycle(uint256 inverted) private {
        for (uint256 count = 2; count <= 8; ++count) {
            account = _newAccount(bytes32(100 + count * 2 + inverted), 1000e18);
            IntentTypes.Intent memory intent = _intent(count);
            if (inverted == 1) {
                for (uint256 j; j < count; ++j) {
                    intent.legs[j].delta = -intent.legs[j].delta;
                }
            }
            _execute(intent);
            require(bank.getActivePerpPools(address(account)).length == count, "open count");
            intent = _intent(count);
            intent.operation = IntentTypes.ADJUST;
            intent.nonce = 2;
            for (uint256 j; j < count; ++j) {
                intent.legs[j].delta = bank.getPosition(address(account), address(pools[j])).size;
            }
            _execute(intent);
            intent = _intent(count);
            intent.operation = IntentTypes.CLOSE;
            intent.nonce = 3;
            for (uint256 j; j < count; ++j) {
                intent.legs[j].delta = -bank.getPosition(address(account), address(pools[j])).size / 2;
            }
            _execute(intent);
            intent = _intent(count);
            intent.operation = IntentTypes.CLOSE;
            intent.nonce = 4;
            for (uint256 j; j < count; ++j) {
                intent.legs[j].delta = -bank.getPosition(address(account), address(pools[j])).size;
            }
            _execute(intent);
            require(bank.getActivePerpPools(address(account)).length == 0, "full close flat");
            require(bank.balance(address(account)) == 1000e18, "zero fee roundtrip conservation");
        }
    }

    function test_AllOneToEightLegAdjustAndCloseSubsets() public {
        for (uint256 count = 1; count <= 8; ++count) {
            account = _newAccount(bytes32(300 + count), 1000e18);
            _execute(_intent(8));
            IntentTypes.Intent memory adjust = _intent(count);
            adjust.operation = IntentTypes.ADJUST;
            adjust.nonce = 2;
            _execute(adjust);
            IntentTypes.Intent memory close = _intent(count);
            close.operation = IntentTypes.CLOSE;
            close.nonce = 3;
            for (uint256 j; j < count; ++j) {
                close.legs[j].delta = -bank.getPosition(address(account), address(pools[j])).size;
            }
            _execute(close);
            require(bank.getActivePerpPools(address(account)).length == 8 - count, "subset close count");
            for (uint256 j = count; j < 8; ++j) {
                int128 expected =
                    j % 2 == 0 ? int128(int256(pools[j].base() / 10)) : -int128(int256(pools[j].base() / 10));
                require(
                    bank.getPosition(address(account), address(pools[j])).size == expected,
                    "unsigned existing position unchanged"
                );
            }
        }
    }

    function test_ERC1271PolicyRevertMalformedAndRevocation() public {
        MutableSignatureOwner smart = new MutableSignatureOwner();
        vm.prank(address(smart));
        account = BasketAccount(payable(factory.createAccount(keccak256("mutable signature owner"))));
        token.mint(address(account), 1000e18);
        vm.prank(address(smart));
        account.depositMargin(1000e18);
        address[] memory allowed = new address[](2);
        allowed[0] = address(pools[0]);
        allowed[1] = address(pools[1]);
        vm.prank(address(smart));
        account.setRouterApproval(address(router), allowed, true);
        IntentTypes.Intent memory intent = _intent(2);
        for (uint256 mode = 1; mode <= 3; ++mode) {
            smart.setMode(mode);
            _expect(intent, BasketRouter.InvalidSignature.selector);
            require(
                !router.nonceUsed(address(account), intent.epoch, intent.nonce), "invalid signature nonce unchanged"
            );
        }
        smart.setMode(0);
        _execute(intent);
        IntentTypes.Intent memory close = _intent(2);
        close.operation = IntentTypes.CLOSE;
        close.nonce = 2;
        for (uint256 j; j < 2; ++j) {
            close.legs[j].delta = -close.legs[j].delta;
        }
        smart.setMode(3);
        _expect(close, BasketRouter.InvalidSignature.selector);
        smart.setMode(0);
        _execute(close);
        require(bank.getActivePerpPools(address(account)).length == 0, "restored signature policy permits close");
    }

    function test_ExternalPositionReductionInvalidatesIntentAndOwnerCanStillExit() public {
        _execute(_intent(2));
        IntentTypes.Intent memory stale = _intent(2);
        stale.operation = IntentTypes.CLOSE;
        stale.nonce = 2;
        for (uint256 j; j < 2; ++j) {
            stale.legs[j].delta = -stale.legs[j].delta;
        }
        int128 initial = bank.getPosition(address(account), address(pools[0])).size;
        // Models the position effect of an external partial liquidation; it does
        // not claim to reproduce the real engine's fees/funding mechanics.
        pools[0].corruptPosition(address(account), -initial / 2);
        _expect(stale, BasketRouter.StaleState.selector);
        require(!router.nonceUsed(address(account), stale.epoch, stale.nonce), "stale liquidation nonce unused");
        markets.pauseEntry();
        vm.prank(owner);
        account.emergencyClose(
            address(pools[0]), uint256(int256(initial / 2)), 100e18, uint64((block.timestamp + 60) * 1e9), false
        );
        require(bank.getPosition(address(account), address(pools[0])).size == 0, "remaining exposure exited");
        require(bank.getActivePerpPools(address(account)).length == 1, "unrelated position preserved");
    }
}
