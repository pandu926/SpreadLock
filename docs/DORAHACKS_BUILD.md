# SpreadLock

## Short description

Atomic basket execution for dreamDEX perpetuals. Sign one trading decision across multiple markets; every leg must satisfy the signed constraints or the transaction reverts.

## Build details

### One strategy. One execution outcome.

On 29 October 2026, SpreadLock opened a BTC long and an ETH short together on dreamDEX's Somnia Tokyo testnet. A second transaction closed both positions. The owner then revoked the router's permission and withdrew the remaining collateral.

That lifecycle demonstrates the product's purpose: a strategy that depends on several positions should have an explicit condition for completing all of them.

### The problem

Consider a strategy that needs a BTC long and an ETH short. If an application submits separate orders, the first can fill while the second fails. The trader is left with an exposure they did not intend to hold alone. Recovering requires another trade, another price decision, and more execution risk.

An individual fill-or-kill order protects one leg. The application still needs to enforce the outcome across the complete basket.

### What SpreadLock does

SpreadLock turns the basket into an owner-signed instruction. It specifies the markets, quantities, price and fee limits, authorized executor, expiry, expected account state, and required health after execution.

The router submits the legs through dreamDEX and verifies their exact position changes and the final position set. If a leg cannot fill as required, or a final check fails, the transaction reverts, including earlier position changes and intent nonce consumption. Reverted transactions still consume gas.

Each basket has its own funded account, with cross margin inside that account. The router holds no collateral. Owners retain direct withdrawal, intent invalidation, and emergency exit paths.

### Who it is for

SpreadLock is built for developers of relative-value strategies, trading bots, wallet integrations, and portfolio tools that need coordinated execution across markets.

An application can reuse the same integration for entry, adjustment, and exit. Strategy developers choose the exposures; SpreadLock enforces the signed execution conditions. Atomic execution does not remove market, funding, liquidation, or underlying protocol risk.

### Working MVP and public proof

The public demonstration used **20 paper USDso** of margin on **Somnia Tokyo testnet, chain 50383**:

- [Atomic open](https://explorer.testnet.somnia.network/tokyo/tx/0xd0d0b9d09f567754aaefb4b71d26c3907e68109f2861b44ba2ad852b7e8a81c1): long **0.00013 BTC** and short **0.004 ETH**.
- [Atomic close](https://explorer.testnet.somnia.network/tokyo/tx/0x1f01e6f3821df8d74a26df9cb7602c8155bdeaf0bbae76be495033dc9cd05418): both positions closed.
- [Permission revocation](https://explorer.testnet.somnia.network/tokyo/tx/0xbe39fbc245046e2f98b99fe1cc2bf75de65028a32c887f8d68a0f544ad3e6e9d) and [withdrawal](https://explorer.testnet.somnia.network/tokyo/tx/0x1ca9e65a31a56ad8b4ecece74eb1161dff57f673763f7e873455969a097361ec): owner control after execution.

Both trades were verified after at least twelve canonical confirmations, with checks of intent identity, exact position deltas, account revision, and collateral accounting. At the recorded final check, the basket had zero positions and zero margin. The round trip realized **−0.020312 USDso**; this demonstrates execution and reconciliation, not strategy profitability.

### Engineering and validation

The repository contains Solidity contracts tested with Foundry, a TypeScript SDK and CLI, an authenticated API, a keeper with durable transaction recovery, and a PostgreSQL-backed canonical indexer.

Recorded validation includes **465 unit tests**, **80 integration tests on PostgreSQL 14 and 17**, and **68 contract tests repeated under three stress seeds**, alongside fuzzing, stateful invariants, and four targeted security mutation checks.

The contract supports **2–8 entry legs** and **1–8 adjustment or close legs**. Eight-leg execution and rollback have local and real-protocol fork coverage. Public transaction evidence currently covers two legs.

### Current scope and next steps

The demonstrated MVP uses the SDK, CLI, and deployed contracts. It has no hosted frontend. Historical log RPC timeouts prevented completion of the full public API/keeper/indexer campaign; local service E2E tests use a mocked external trading protocol.

Next steps are sustained public service validation, broader native-chain basket testing, independent contract review, and production recovery and governance work before mainnet deployment. No production readiness or independent audit is claimed.

### Review the build

- [Source code and local setup](https://github.com/pandu926/SpreadLock)
- [Demo walkthrough](https://github.com/pandu926/SpreadLock/blob/main/docs/DEMO.md)
- [Architecture](https://github.com/pandu926/SpreadLock/blob/main/docs/ARCHITECTURE.md)
- [Validation and evidence boundaries](https://github.com/pandu926/SpreadLock/blob/main/docs/VALIDATION.md)
- [Security model](https://github.com/pandu926/SpreadLock/blob/main/docs/SECURITY.md)
