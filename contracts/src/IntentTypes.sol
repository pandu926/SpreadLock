// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

library IntentTypes {
    uint8 internal constant OPEN = 0;
    uint8 internal constant ADJUST = 1;
    uint8 internal constant CLOSE = 2;

    struct Leg {
        address pool;
        int128 delta;
        uint256 limitPrice;
        uint32 maxTakerFeeBpsTimes1k;
    }

    struct Intent {
        address account;
        address executor;
        uint256 nonce;
        uint256 epoch;
        uint256 expectedRevision;
        bytes32 expectedPositionsHash;
        uint64 validAfter;
        uint64 validUntil;
        uint8 operation;
        Leg[] legs;
        int256 minNetQuote;
        uint8 triggerKind;
        int256 triggerValue;
        uint256 minPostEquity;
        uint32 minPostHealthBps;
    }
}
