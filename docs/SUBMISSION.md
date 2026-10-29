# SpreadLock — one signed decision for a perpetual basket

## Short description

SpreadLock is an execution layer for dreamDEX perpetual strategies. A trader signs the intended basket, quantities, price limits, and account state. The router executes the legs in one transaction and rejects the transaction unless the complete basket satisfies those constraints.

The public MVP opened a BTC long and an ETH short together on Somnia testnet, then closed both together. Both transactions have been checked against canonical receipts. The account finished flat, its trading authorization was revoked, and the remaining margin was withdrawn.

## The problem

A strategy may depend on two exposures, while its order submission code handles two separate requests. The first request can fill before the second fails. That leaves the trader with an exposure the strategy never intended to hold alone. An unwind adds another order, another execution price, and another opportunity for failure.

Sending requests together does not, by itself, establish a basket-level commit condition. The application needs a way to make the completed position change the unit of success.

## What we built

SpreadLock introduces a reusable contract interface for that decision. Each basket has an independently funded account. The owner authorizes a router and signs an EIP-712 intent containing the executor, account state, nonce, expiry, leg quantities, price and fee caps, a combined execution quote bound, and post-trade health requirements.

The router validates that state, requests fill-or-kill execution, checks the exact position deltas, and verifies the final position set. A failure reverts the transaction's state changes, including nonce consumption. A reverted transaction still costs gas.

The repository also contains a TypeScript SDK, CLI, authenticated API, canonical indexer, and a keeper with a durable transaction outbox. The direct SDK/contract path is the public MVP demonstrated so far. The full service path has separate local integration coverage.

## Evidence of building

On **29 October 2026**, a real basket on Somnia testnet, chain **50383**, used **20 paper USDso** of margin:

- **Open:** long **0.00013 BTC** and short **0.004 ETH** in [one transaction](https://explorer.testnet.somnia.network/tokyo/tx/0xd0d0b9d09f567754aaefb4b71d26c3907e68109f2861b44ba2ad852b7e8a81c1).
- **Close:** both positions fully closed in [one transaction](https://explorer.testnet.somnia.network/tokyo/tx/0x1f01e6f3821df8d74a26df9cb7602c8155bdeaf0bbae76be495033dc9cd05418).
- Both executions passed checks for at least 12 canonical confirmations, the signed intent event, nonce and revision progression, exact position changes, and collateral accounting.

The test concluded with **zero positions and zero remaining basket margin**. Its trading result was **−0.020312 USDso**. This is execution evidence; it is not a profitable-strategy claim.

The contract implementation supports 2–8 entry legs and 1–8 adjustment or close legs. Eight-leg behavior has local and real-protocol fork coverage. Public execution evidence currently covers two legs.

## Why this is useful to the ecosystem

A strategy developer can concentrate on deciding which exposures to request and when to request them. SpreadLock gives that developer a shared execution contract with explicit failure semantics, account permissions, cancellation, and owner exits.

That creates a repeat-use path: the same integration can submit a new state-bound intent for each entry, adjustment, or close. Several strategy applications could use the same primitive without sharing collateral or adopting a common signal model.

We intend to measure incomplete-basket incidents, execution completion, rollback causes, gas costs, and successful owner withdrawals. User adoption and improvements to those operational metrics have not yet been measured.

## What remains

The current build is a backend and smart-contract MVP, without a hosted frontend. Historical log RPC timeouts prevented the full public API/indexer campaign; the successful demonstration used independently verified transaction receipts. That limitation remains visible in the validation record.

Independent audit, sustained public service testing, recovery on a second host, production governance, and mainnet compatibility verification remain release requirements. There is no mainnet approval.

For review, follow the [demo](DEMO.md), [architecture](ARCHITECTURE.md), and [validation record](VALIDATION.md). The [problem and impact](PROBLEM_AND_IMPACT.md) document expands the product case.
