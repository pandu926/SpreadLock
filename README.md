# SpreadLock

<img src="assets/spreadlock-logo.png" alt="SpreadLock logo" width="160" height="160" />

**A signed basket of dreamDEX perpetual orders, committed as one transaction.**

On 29 October 2026, SpreadLock opened a **0.00013 BTC long** and a **0.004 ETH short** together on Somnia testnet. A second transaction closed both. The basket finished flat, its router permission was revoked, and its remaining margin was withdrawn.

[Inspect the open](https://explorer.testnet.somnia.network/tokyo/tx/0xd0d0b9d09f567754aaefb4b71d26c3907e68109f2861b44ba2ad852b7e8a81c1) · [Inspect the close](https://explorer.testnet.somnia.network/tokyo/tx/0x1f01e6f3821df8d74a26df9cb7602c8155bdeaf0bbae76be495033dc9cd05418) · [Read the submission brief](docs/SUBMISSION.md)

## The execution problem

A trader wants two exposures. The BTC order fills; the ETH order is rejected. The strategy now holds a position it never intended to hold on its own, and closing it requires another trade.

SpreadLock makes the requested basket the unit of success. The owner signs quantities, worst acceptable prices, fee caps, a combined quote bound, account state, expiry, and post-trade health requirements. The router executes every leg through dreamDEX, checks exact position changes and the final position set, and reverts the transaction if a required condition fails. Gas remains payable when a transaction reverts.

This is a primitive for developers building relative-value, basket, and automated execution tools. Position sizing and trade selection remain with the strategy. Market risk, funding, liquidation, and underlying protocol risk remain after execution.

## What is in the repository

| Component | Responsibility |
| --- | --- |
| [Contracts](contracts/README.md) | Independently funded basket accounts, atomic router, market registry, and production timelock implementation |
| [Domain and SDK](packages/sdk/src/index.ts) | Integer quantities, EIP-712 intents, state inspection, quotes, simulation, and calldata |
| [API](apps/api/src/app.ts) | Owner authentication, scoped keeper sessions, intent validation, and transaction preparation |
| [Keeper](apps/keeper/src/engine.ts) | Independent execution checks, gas limits, durable signed-transaction recovery, and fee replacement |
| [Indexer](apps/indexer/src/engine.ts) | Canonical history, confirmations, reorg rollback, and execution projections |
| [CLI](apps/cli/src/main.ts) | Account actions, signing, submission, execution, cancellation, and emergency close |

Each basket is a separate MarginBank account, with cross margin inside that basket. The router holds no collateral. The central API receives neither owner nor keeper private keys. Owners retain direct withdrawal, invalidation, and emergency exit paths.

## What has been demonstrated

| Scope | Evidence |
| --- | --- |
| Public testnet | Two-leg atomic open and close through the direct SDK/contract path; at least 12 canonical confirmations; position, nonce, revision, fee, funding, and collateral checks |
| Real-protocol fork | Eight-leg lifecycle and failed-leg rollback against deployed dreamDEX contracts, with local fork writes |
| Local service E2E | API → keeper → contracts → indexer using real PostgreSQL and Anvil with an explicitly mocked external protocol |
| Local verification | 465 unit tests; 80 integration tests on PostgreSQL 14 and 17; 68 contract tests per each of three stress seeds; four targeted security mutations detected |

These are distinct evidence sets. Public evidence currently covers **two legs**. The full public API/indexer campaign, seven-day soak, independent audit, and production recovery requirements remain incomplete. See the [validation record](docs/VALIDATION.md).

## Read the project

- [Submission brief](docs/SUBMISSION.md): the product case and demonstrated result.
- [Problem and impact](docs/PROBLEM_AND_IMPACT.md): intended users, failure cases, and measurable outcomes.
- [Demo](docs/DEMO.md): a short review path through the public transactions.
- [Architecture](docs/ARCHITECTURE.md), [integration](docs/INTEGRATION.md), and [security](docs/SECURITY.md): how the system works and where its guarantees end.

## Run the local checks

Use Node 24, npm, Foundry/Forge 1.5.1, and a dedicated PostgreSQL database. Production configuration targets PostgreSQL 17. Install the root dependencies before building contracts; they provide OpenZeppelin.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
forge build --root contracts
forge test --root contracts
npm run build
```

For database and service tests, set `TEST_DATABASE_URL` to a **disposable** database, then run:

```sh
npm run test:integration
npm run test:e2e
```

The E2E script starts Anvil and uses local test funds. Optional protocol fork tests use public RPC reads and local writes:

```sh
DREAMDEX_FORK_TESTS=true forge test --root contracts --match-contract DreamdexForkTest -vv
```

`npm run verify:release` runs the broader release checks and writes local reports. Operational or external gates can remain blocked even when functional tests pass. `node dist/cli.mjs help` lists the CLI commands. The [integration guide](docs/INTEGRATION.md) covers a caller's account, signing, and execution flow.

## Integration and release status

SpreadLock integrates directly with dreamDEX contracts on Somnia testnet, chain 50383. The [official developer guide](https://app.testnet.dreamdex.io/docs/developers/perps-testnet) supplies network and protocol configuration. This project is an independent integration; it does not claim inclusion in the official dreamDEX interface or endorsement by its team.

The build is a **testnet candidate, without an independent contract audit or mainnet approval**. The combined quote bound is synthetic sell-minus-buy execution notional less trading fees; it excludes funding and gas and is not a profit guarantee.

## Before publishing changes

```sh
node --test scripts/publication.test.mjs
node scripts/publication/check.mjs
```

The publication guard checks candidate files and exact staged Git blobs without printing matched credential values. Wallets, signing state, raw reports, research, agent configuration, and host-specific operator material remain local through `.gitignore` and `.dockerignore`. The public documentation exposes selected on-chain proof, not private journals or server configuration. Ignore rules do not erase previously published history.

## X posts

Project post links have not been supplied yet. The bounty submission requires two or three published project posts tagging `@DreamDEXSomnia`; verified links should be added here before submission. Drafts and unpublished posts are not presented as completed evidence.
