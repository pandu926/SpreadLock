# Review the public MVP in three minutes

SpreadLock has completed an atomic BTC/ETH basket open and close on dreamDEX's Somnia testnet, chain **50383**. The demonstration uses the SDK and deployed contracts, with separate owner and executor wallets. It has no frontend or recorded video attached to this document.

## 0:00–0:45 — Inspect the opening transaction

Open the [public basket entry](https://explorer.testnet.somnia.network/tokyo/tx/0xd0d0b9d09f567754aaefb4b71d26c3907e68109f2861b44ba2ad852b7e8a81c1).

The transaction targets the deployed SpreadLock router:

```text
0x8584e07c36388cC76AfEFA001fC86F070645c487
```

The signed instruction requested two position changes:

| Pool | Direction | Quantity | Raw base units |
| --- | --- | --- | --- |
| BTC perpetual | Buy / long | 0.00013 BTC | 13,000 |
| ETH perpetual | Sell / short | 0.004 ETH | 4,000,000,000,000,000 |

These quantities were filled in one transaction. Look for the router's `IntentExecuted` and two `LegExecuted` events, then the underlying fill and MarginBank position events. The account after entry held both requested positions.

The basket account used for the demonstration is:

```text
0xB6B75ed9222319e3441CB877883F4ef4d5BAe1c7
```

## 0:45–1:30 — Inspect the closing transaction

Open the [public basket close](https://explorer.testnet.somnia.network/tokyo/tx/0x1f01e6f3821df8d74a26df9cb7602c8155bdeaf0bbae76be495033dc9cd05418).

The close requested the opposite delta for each existing position. Both deltas were filled, and the observed account returned to zero active positions. The close has a different intent hash and nonce from entry and binds the updated account revision.

Verification required at least **twelve canonical confirmations** for each transaction. It matched the exact router, account, executor, intent hash, nonce, epoch and resulting revision. A transaction hash by itself was not treated as proof of a completed basket.

## 1:30–2:15 — Check the money and owner control

The account was funded with **20 USDso** of margin for this run. The full open/close produced **−0.020312 USDso** in realized trading PnL. Trading fee and settled funding events in these two receipts were zero; that is an observation for this run, not a promise about future fees or funding.

After closing, the owner [revoked router approval](https://explorer.testnet.somnia.network/tokyo/tx/0xbe39fbc245046e2f98b99fe1cc2bf75de65028a32c887f8d68a0f544ad3e6e9d) and [withdrew the remaining margin](https://explorer.testnet.somnia.network/tokyo/tx/0x1ca9e65a31a56ad8b4ecece74eb1161dff57f673763f7e873455969a097361ec).

At the recorded final check on 29 October 2026, the basket had zero positions, zero locked collateral, zero unlocked margin and inactive router authorization. These are historical verified observations; inspect current chain state before relying on them as live status.

The opening and closing transactions together consumed **0.055652358 STT** at the observed gas price. Deployment, setup and earlier attempts are accounted for separately in [Validation](VALIDATION.md).

## 2:15–3:00 — Review the guarantee and its boundary

The [router implementation](../contracts/src/BasketRouter.sol) verifies exact position deltas and the final account state. If a leg or final check fails, the transaction reverts. Failed execution rollback is covered by local and real-protocol fork tests; the two public trades above demonstrate the successful path.

Public four- and eight-leg trading, a complete live API/keeper/indexer deployment, an independent audit and production readiness are not established by this demo. Historical log RPC timeouts blocked the broader indexed campaign. The demonstrated path confirms individual transactions through receipts and canonical block hashes; the production API readiness gate remains in place.

## Five-minute recording script

This is a proposed recording sequence, not a claim that a video has been produced.

| Time | Show | Explain |
| --- | --- | --- |
| 0:00–0:40 | The two-leg instruction and quantities | A user authorizes the complete basket and its limits. |
| 0:40–1:40 | Opening receipt and both resulting positions | Exact fills are checked before the basket commits. |
| 1:40–2:30 | A local rollback test and its assertions | A failed later leg cannot leave an earlier position or consume the intent nonce. Label the footage as a local test. |
| 2:30–3:30 | Closing receipt and zero positions | Closing is a new signed state transition. |
| 3:30–4:20 | Revocation and withdrawal receipts | The owner retains permission and withdrawal control. |
| 4:20–5:00 | Validation matrix and remaining release gates | Separate demonstrated behavior from work still required. |

For local reproduction, follow the [repository check commands](../README.md#run-the-local-checks) and [integration guide](INTEGRATION.md). Use a disposable database and local/fork tests first. Public execution requires an independently reviewed deployment manifest, funded testnet wallets, current market conditions and deliberate signing; private deployment journals and signing files are not part of the public repository.
