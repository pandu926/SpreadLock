# One strategy should not leave half an entry behind

A user signs off on two positions: long BTC and short ETH. The BTC order fills. The ETH order fails because available depth moved. The account now holds a directional position that was never the complete trading decision.

That is the failure SpreadLock addresses. The example is hypothetical; the [public testnet demonstration](VALIDATION.md) proves the execution path with a real BTC/ETH basket.

## The problem sits between orders

A multi-market strategy is expressed as one decision, but an application can still execute it as several independent orders. Sending those orders close together does not give them a shared outcome. Retrying the missing side adds more decisions: which price is still acceptable, whether the first position should be unwound, and who is allowed to do either action.

Fill-or-kill protects an individual order. The dreamDEX integration guide describes `placeOrdersFor` batches which can report a per-item rejection as `successes[i] = false` while accepted items remain committed. Basket execution therefore needs a transaction-level rule across every leg. [Official integration guide](https://app.testnet.dreamdex.io/docs/developers/perps-testnet).

This matters to strategy developers, wallet integrations and portfolio tools that need an exact basket entry or adjustment. We have not measured demand, retention or adoption among these intended users.

## The solution: make the basket the unit of execution

SpreadLock accepts an owner-signed intent describing the account, markets, quantities, price limits, fee limits, validity window and expected account state. An assigned executor pays gas and submits that instruction to the router.

The [router](../contracts/src/BasketRouter.sol) verifies the instruction, places each leg through the registered dreamDEX pools, and checks the resulting positions. Every requested delta must match. The final account must satisfy the signed health and equity requirements. A failed leg or failed final check reverts the transaction, including its position changes and intent nonce consumption.

A reverted transaction can still consume gas. Atomic execution also cannot create missing liquidity: requiring every leg to fill may reject a basket that separate orders could have filled only in part.

The supported contract interface opens baskets across two to eight pools and adjusts or closes one to eight legs. The public MVP has demonstrated a two-leg open and close. Larger basket coverage currently comes from local tests and real-protocol fork tests; it is not a claim of public eight-leg validation.

## Why this belongs in the dreamDEX ecosystem

SpreadLock calls existing dreamDEX perpetual pools and settles through their MarginBank. Its contribution is an execution contract that other applications can target through a shared intent schema and SDK.

The intended result is less duplicated basket orchestration in individual bots and wallet applications. A strategy builder can express the desired state transition, obtain the owner's signature, and delegate execution without granting a keeper withdrawal authority. Each basket has its own funded account, while positions within that account share cross margin.

Those boundaries are useful beyond one trading strategy. A relative-value tool, a portfolio rebalance service or a wallet basket interface could use the same execution primitive. These are integration opportunities, not existing partnerships or customers.

## What has been demonstrated

On 29 October 2026, the public MVP opened and fully closed:

- A long position of **0.00013 BTC**.
- A short position of **0.004 ETH**.

Both legs of the opening transaction filled, and both were closed in the closing transaction. The verification checked the exact router event, intent identity, nonce, account revision and canonical block, with at least twelve confirmations. Position changes and collateral accounting were reconciled. Router approval was then revoked and remaining margin withdrawn. The observed final basket had no positions or deposited margin. Public transaction links and the scope of the evidence are in [Validation](VALIDATION.md).

The trade realized a loss of **0.020312 USDso**. That result belongs in the demonstration: the execution guarantee concerns the requested state transition, not whether the trade earns money. The quantities were not presented as a beta-neutral or profitable hedge.

## Impact we can reasonably pursue

The immediate benefit is a narrower failure outcome: a rejected basket transaction does not leave its earlier leg committed. The next stage should test whether external builders can use that property repeatedly and with acceptable cost.

| Question | Measurement for a pilot |
| --- | --- |
| Do rejected basket entries leave unintended positions? | Compare canonical pre/post positions for every rejected execution. |
| How often can a complete basket fill? | Confirmed executions divided by attempted baskets, with rejection reasons. |
| What does the guarantee cost? | Native gas across successful and reverted attempts, by basket size. |
| Can an owner recover control? | Cancellation, permission revocation and withdrawal outcomes, including failures. |
| Is the primitive useful to other builders? | Completed external integrations and repeated use, rather than submission counts alone. |

No volume, savings or user-growth estimate is attached to this MVP. Production adoption also depends on protocol compatibility, liquidity, oracle availability, operational reliability and independent security review. [Architecture](ARCHITECTURE.md) explains the implementation; [Security](SECURITY.md) defines the remaining trust and release boundaries.
