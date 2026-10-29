// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IntentTypes} from "./IntentTypes.sol";
import {BasketAccount} from "./BasketAccount.sol";
import {BasketAccountFactory} from "./BasketAccountFactory.sol";
import {MarketRegistry} from "./MarketRegistry.sol";
import {IDreamBank, IDreamPool} from "./interfaces/IDreamDex.sol";

/// @notice Signed, one-shot, full-fill basket execution. No user funds are held
///         here, no arbitrary calls are accepted, and the executor pays native gas.
contract BasketRouter is EIP712, ReentrancyGuard {
    uint256 private constant FEE_DENOMINATOR = 10_000_000;
    bytes32 public constant LEG_TYPEHASH =
        keccak256("Leg(address pool,int128 delta,uint256 limitPrice,uint32 maxTakerFeeBpsTimes1k)");
    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "Intent(address account,address executor,uint256 nonce,uint256 epoch,uint256 expectedRevision,bytes32 expectedPositionsHash,uint64 validAfter,uint64 validUntil,uint8 operation,Leg[] legs,int256 minNetQuote,uint8 triggerKind,int256 triggerValue,uint256 minPostEquity,uint32 minPostHealthBps)Leg(address pool,int128 delta,uint256 limitPrice,uint32 maxTakerFeeBpsTimes1k)"
    );
    address public immutable accountFactory;
    address public immutable marketRegistry;
    IDreamBank public immutable bank;
    mapping(address => mapping(uint256 => mapping(uint256 => uint256))) private nonceWords;

    error InvalidAccount();
    error InvalidExecutor();
    error InvalidSignature();
    error InvalidWindow();
    error InvalidIntent();
    error StaleState();
    error NonceUnavailable();
    error EntryPaused();
    error InvalidMarket(address pool);
    error InvalidLeg(uint256 index);
    error PriceOutsideLimit(uint256 index);
    error FeeOutsideLimit(uint256 index);
    error QuoteTooLow();
    error TriggerNotMet();
    error OracleUnavailable();
    error NotFilled(uint256 index);
    error DeltaMismatch(uint256 index);
    error InvalidClose(uint256 index);
    error InsufficientPostTradeHealth();
    error TooManyMarkets();
    error Unauthorized();
    event IntentExecuted(
        bytes32 indexed intentHash,
        address indexed account,
        address indexed executor,
        uint256 nonce,
        uint256 epoch,
        uint256 revision,
        int256 guaranteedNetQuote
    );
    event LegExecuted(bytes32 indexed intentHash, address indexed pool, int128 delta, uint256 limitPrice);
    event NoncesInvalidated(address indexed account, uint256 indexed epoch, uint256 indexed word, uint256 mask);

    constructor(address factory_, address markets_) EIP712("SpreadLock", "1") {
        if (
            factory_.code.length == 0 || markets_.code.length == 0
                || BasketAccountFactory(factory_).marketRegistry() != markets_
        ) revert InvalidAccount();
        accountFactory = factory_;
        marketRegistry = markets_;
        bank = IDreamBank(MarketRegistry(markets_).bank());
    }

    function hashIntent(IntentTypes.Intent calldata intent) public view returns (bytes32) {
        bytes32[] memory legHashes = new bytes32[](intent.legs.length);
        for (uint256 i; i < intent.legs.length; ++i) {
            IntentTypes.Leg calldata leg = intent.legs[i];
            legHashes[i] =
                keccak256(abi.encode(LEG_TYPEHASH, leg.pool, leg.delta, leg.limitPrice, leg.maxTakerFeeBpsTimes1k));
        }
        // All EIP-712 fields are one ABI word; fixed-array encoding is identical
        // to the static field sequence and avoids compiler stack pressure.
        bytes32[16] memory words;
        words[0] = INTENT_TYPEHASH;
        words[1] = bytes32(uint256(uint160(intent.account)));
        words[2] = bytes32(uint256(uint160(intent.executor)));
        words[3] = bytes32(intent.nonce);
        words[4] = bytes32(intent.epoch);
        words[5] = bytes32(intent.expectedRevision);
        words[6] = intent.expectedPositionsHash;
        words[7] = bytes32(uint256(intent.validAfter));
        words[8] = bytes32(uint256(intent.validUntil));
        words[9] = bytes32(uint256(intent.operation));
        words[10] = keccak256(abi.encodePacked(legHashes));
        words[11] = bytes32(uint256(intent.minNetQuote));
        words[12] = bytes32(uint256(intent.triggerKind));
        words[13] = bytes32(uint256(intent.triggerValue));
        words[14] = bytes32(intent.minPostEquity);
        words[15] = bytes32(uint256(intent.minPostHealthBps));
        return _hashTypedDataV4(keccak256(abi.encode(words)));
    }

    function nonceUsed(address account, uint256 epoch, uint256 nonce) public view returns (bool) {
        return nonceWords[account][epoch][nonce >> 8] & (uint256(1) << uint8(nonce)) != 0;
    }

    function invalidateNonces(address account, uint256 word, uint256 mask) external {
        BasketAccount a = _account(account);
        if (msg.sender != a.owner() && msg.sender != account) revert Unauthorized();
        uint256 currentEpoch = a.epoch();
        nonceWords[account][currentEpoch][word] |= mask;
        emit NoncesInvalidated(account, currentEpoch, word, mask);
    }

    /// @dev Hash includes all currently active pools and requested pools, sorted
    ///      by address. New pools have zero size. Avg entry/funding are NOT prices.
    function positionsHash(address account, IntentTypes.Leg[] calldata legs) public view returns (bytes32) {
        address[] memory pools = _poolUnion(account, legs);
        int128[] memory sizes = new int128[](pools.length);
        for (uint256 i; i < pools.length; ++i) {
            sizes[i] = bank.getPosition(account, pools[i]).size;
        }
        return keccak256(abi.encode(pools, sizes));
    }

    function execute(IntentTypes.Intent calldata intent, uint256[] calldata executablePrices, bytes calldata signature)
        external
        nonReentrant
    {
        BasketAccount account = _account(intent.account);
        _authorize(account, intent, signature);
        if (executablePrices.length != intent.legs.length) revert InvalidIntent();
        address[] memory allPools = _poolUnion(intent.account, intent.legs);
        int128[] memory beforeSizes = new int128[](allPools.length);
        for (uint256 i; i < allPools.length; ++i) {
            beforeSizes[i] = bank.getPosition(intent.account, allPools[i]).size;
        }
        if (keccak256(abi.encode(allPools, beforeSizes)) != intent.expectedPositionsHash) revert StaleState();
        if (intent.operation == IntentTypes.OPEN && bank.getActivePerpPools(intent.account).length != 0) {
            revert StaleState();
        }
        if (intent.operation != IntentTypes.CLOSE && MarketRegistry(marketRegistry).entryPaused()) {
            revert EntryPaused();
        }
        int256 guaranteedNetQuote;
        int256 markQuote;
        uint256[] memory observedFees = new uint256[](intent.legs.length);
        for (uint256 i; i < intent.legs.length; ++i) {
            (int256 bound, int256 mark, uint256 observedFee) = _validateLeg(intent, i, executablePrices[i]);
            observedFees[i] = observedFee;
            guaranteedNetQuote += bound;
            markQuote += mark;
        }
        if (guaranteedNetQuote < intent.minNetQuote) revert QuoteTooLow();
        if (
            (intent.triggerKind == 1 && markQuote < intent.triggerValue)
                || (intent.triggerKind == 2 && markQuote > intent.triggerValue)
        ) revert TriggerNotMet();
        nonceWords[intent.account][intent.epoch][intent.nonce >> 8] |= uint256(1) << uint8(intent.nonce);
        bytes32 intentHash = hashIntent(intent);
        uint64 poolExpiry = uint64(uint256(intent.validUntil) * 1e9);
        for (uint256 i; i < intent.legs.length; ++i) {
            IntentTypes.Leg calldata leg = intent.legs[i];
            int256 beforeSize = bank.getPosition(intent.account, leg.pool).size;
            (bool accepted,) = IDreamPool(leg.pool)
                .placeOrderFor(
                    intent.account,
                    leg.delta > 0,
                    0,
                    executablePrices[i],
                    _quantity(leg.delta),
                    poolExpiry,
                    1,
                    0,
                    address(0),
                    0
                );
            if (!accepted) revert NotFilled(i);
            if (int256(bank.getPosition(intent.account, leg.pool).size) - beforeSize != int256(leg.delta)) {
                revert DeltaMismatch(i);
            }
            emit LegExecuted(intentHash, leg.pool, leg.delta, executablePrices[i]);
        }
        _checkFinalPositions(intent, allPools, beforeSizes);
        // Quote bounds use the fees observed before execution. Registered pool
        // callbacks must not leave those parameters changed during this basket.
        for (uint256 i; i < intent.legs.length; ++i) {
            if (IDreamPool(intent.legs[i].pool).getPerpPoolParameters().takerFeeBpsTimes1k != observedFees[i]) {
                revert FeeOutsideLimit(i);
            }
        }
        (int256 equity,, uint256 maintenance,) = bank.getAccountHealth(intent.account);
        if (
            equity < 0 || uint256(equity) < intent.minPostEquity
                || uint256(equity) < Math.mulDiv(maintenance, intent.minPostHealthBps, 10_000, Math.Rounding.Ceil)
        ) {
            revert InsufficientPostTradeHealth();
        }
        account.recordExecution(intent.expectedRevision);
        emit IntentExecuted(
            intentHash, intent.account, msg.sender, intent.nonce, intent.epoch, account.revision(), guaranteedNetQuote
        );
    }

    function _authorize(BasketAccount account, IntentTypes.Intent calldata intent, bytes calldata signature)
        private
        view
    {
        uint256 count = intent.legs.length;
        if (
            intent.operation > IntentTypes.CLOSE || count == 0 || count > 8
                || (intent.operation == IntentTypes.OPEN && count < 2) || intent.triggerKind > 2
                || intent.executor == address(0)
        ) {
            revert InvalidIntent();
        }
        if (msg.sender != intent.executor && msg.sender != account.owner()) revert InvalidExecutor();
        if (!account.routerAuthorized(address(this))) revert Unauthorized();
        if (
            intent.validAfter > block.timestamp || intent.validUntil <= block.timestamp
                || intent.validUntil <= intent.validAfter || uint256(intent.validUntil) * 1e9 > type(uint64).max
                || uint256(intent.validUntil) - intent.validAfter > 30 days
        ) revert InvalidWindow();
        if (account.epoch() != intent.epoch || account.revision() != intent.expectedRevision) revert StaleState();
        if (nonceUsed(intent.account, intent.epoch, intent.nonce)) revert NonceUnavailable();
        if (!SignatureChecker.isValidSignatureNow(intent.account, hashIntent(intent), signature)) {
            revert InvalidSignature();
        }
    }

    function _validateLeg(IntentTypes.Intent calldata intent, uint256 index, uint256 price)
        private
        view
        returns (int256 bound, int256 markValue, uint256 observedFee)
    {
        IntentTypes.Leg calldata leg = intent.legs[index];
        MarketRegistry markets = MarketRegistry(marketRegistry);
        if (!markets.isKnownPool(leg.pool)) revert InvalidMarket(leg.pool);
        if (leg.delta == 0 || leg.delta == type(int128).min || leg.limitPrice == 0) revert InvalidLeg(index);
        for (uint256 j; j < index; ++j) {
            if (intent.legs[j].pool == leg.pool) revert InvalidLeg(index);
        }
        uint256 quantity = _quantity(leg.delta);
        (uint256 oneBase, uint256 tick, uint256 minimum, uint256 lot, uint256 fee) = markets.marketMetadata(leg.pool);
        if (price == 0 || price % tick != 0 || quantity < minimum || quantity % lot != 0) revert InvalidLeg(index);
        if ((leg.delta > 0 && price > leg.limitPrice) || (leg.delta < 0 && price < leg.limitPrice)) {
            revert PriceOutsideLimit(index);
        }
        if (fee > leg.maxTakerFeeBpsTimes1k) revert FeeOutsideLimit(index);
        observedFee = fee;
        int256 beforeSize = bank.getPosition(intent.account, leg.pool).size;
        bool reducing = beforeSize > 0
            ? leg.delta < 0 && quantity <= uint256(beforeSize)
            : beforeSize < 0 && leg.delta > 0 && quantity <= uint256(-beforeSize);
        if (intent.operation == IntentTypes.CLOSE && !reducing) revert InvalidClose(index);
        if (
            intent.operation != IntentTypes.CLOSE && !reducing
                && (!markets.entryEnabled(leg.pool) || IDreamPool(leg.pool).isRestricted())
        ) revert InvalidMarket(leg.pool);
        // Per-lot bounds remain conservative even if every lot fills separately
        // and the protocol rounds fees/quote on each fragment.
        uint256 grossPerLot = Math.mulDiv(lot, price, oneBase, leg.delta > 0 ? Math.Rounding.Ceil : Math.Rounding.Floor);
        uint256 feePerLot = Math.mulDiv(grossPerLot, fee, FEE_DENOMINATOR, Math.Rounding.Ceil);
        uint256 amount = quantity / lot * (leg.delta > 0 ? grossPerLot + feePerLot : grossPerLot - feePerLot);
        if (amount > uint256(type(int256).max)) revert InvalidLeg(index);
        bound = leg.delta > 0 ? -int256(amount) : int256(amount);
        (bool live, uint256 mark) = IDreamPool(leg.pool).tryGetMarkPrice();
        if (!live || mark == 0) revert OracleUnavailable();
        uint256 rawMark = Math.mulDiv(quantity, mark, oneBase);
        if (rawMark > uint256(type(int256).max)) revert InvalidLeg(index);
        markValue = leg.delta > 0 ? -int256(rawMark) : int256(rawMark);
    }

    function _checkFinalPositions(
        IntentTypes.Intent calldata intent,
        address[] memory pools,
        int128[] memory beforeSizes
    ) private view {
        uint256 active;
        for (uint256 i; i < pools.length; ++i) {
            int256 expected = beforeSizes[i];
            for (uint256 j; j < intent.legs.length; ++j) {
                if (intent.legs[j].pool == pools[i]) expected += intent.legs[j].delta;
            }
            int256 actual = bank.getPosition(intent.account, pools[i]).size;
            if (actual != expected) revert DeltaMismatch(i);
            if (actual != 0) ++active;
        }
        address[] memory finalPools = bank.getActivePerpPools(intent.account);
        if (active > 8 || finalPools.length > 8) revert TooManyMarkets();
        // A pool callback must not create exposure outside the signed/snapshotted
        // union, even when the resulting account stays below the market limit.
        for (uint256 i; i < finalPools.length; ++i) {
            bool included;
            for (uint256 j; j < pools.length; ++j) {
                if (finalPools[i] == pools[j]) {
                    included = true;
                    break;
                }
            }
            if (!included) revert InvalidMarket(finalPools[i]);
        }
    }

    function _poolUnion(address account, IntentTypes.Leg[] calldata legs)
        private
        view
        returns (address[] memory pools)
    {
        address[] memory active = bank.getActivePerpPools(account);
        if (active.length > 8 || legs.length > 8) revert TooManyMarkets();
        address[] memory union = new address[](active.length + legs.length);
        uint256 count;
        for (uint256 i; i < active.length + legs.length; ++i) {
            address candidate = i < active.length ? active[i] : legs[i - active.length].pool;
            bool found;
            for (uint256 j; j < count; ++j) {
                if (union[j] == candidate) {
                    found = true;
                    break;
                }
            }
            if (!found) union[count++] = candidate;
        }
        for (uint256 i = 1; i < count; ++i) {
            address value = union[i];
            uint256 j = i;
            while (j > 0 && uint160(union[j - 1]) > uint160(value)) {
                union[j] = union[j - 1];
                --j;
            }
            union[j] = value;
        }
        pools = new address[](count);
        for (uint256 i; i < count; ++i) {
            pools[i] = union[i];
        }
    }

    function _account(address account) private view returns (BasketAccount a) {
        if (!BasketAccountFactory(accountFactory).isAccount(account)) revert InvalidAccount();
        a = BasketAccount(payable(account));
    }

    function _quantity(int128 delta) private pure returns (uint256) {
        return uint256(delta > 0 ? int256(delta) : -int256(delta));
    }
}
