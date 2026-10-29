# Validation: the claims and the evidence

On **29 October 2026**, SpreadLock opened two real perpetual positions on dreamDEX testnet in one transaction and closed them in another. Both receipts were checked against canonical block hashes after at least 12 confirmations. The final account had no positions, no margin and no active router authorization.

This is a public SDK/CLI execution proof. It is the strongest completed MVP result; the wider service stack has a different validation boundary below.

## Public two-leg execution

Network: Somnia Hideki/Tokyo testnet, chain ID **50383**. Collateral: testnet USDso. Gas: STT. Network and protocol conventions are documented in the [official developer guide](https://app.testnet.dreamdex.io/docs/developers/perps-testnet).

| Action | Public transaction | Block |
| --- | --- | --- |
| Atomic open | [Open receipt](https://explorer.testnet.somnia.network/tokyo/tx/0xd0d0b9d09f567754aaefb4b71d26c3907e68109f2861b44ba2ad852b7e8a81c1) | 36,295,299 |
| Atomic close | [Close receipt](https://explorer.testnet.somnia.network/tokyo/tx/0x1f01e6f3821df8d74a26df9cb7602c8155bdeaf0bbae76be495033dc9cd05418) | 36,295,482 |
| Revoke router | [Revocation receipt](https://explorer.testnet.somnia.network/tokyo/tx/0xbe39fbc245046e2f98b99fe1cc2bf75de65028a32c887f8d68a0f544ad3e6e9d) | Inspect receipt |
| Withdraw remaining margin | [Withdrawal receipt](https://explorer.testnet.somnia.network/tokyo/tx/0x1ca9e65a31a56ad8b4ecece74eb1161dff57f673763f7e873455969a097361ec) | Inspect receipt |

The account was funded with **20 USDso**. The owner and execution wallet were separate.

| Market | Open delta | Close delta | Open fill price | Close fill price |
| --- | --- | --- | --- | --- |
| BTC perpetual | +0.00013 BTC | −0.00013 BTC | 80,475.3 | 80,340.9 |
| ETH perpetual | −0.004 ETH | +0.004 ETH | 2,323.92 | 2,324.63 |

Prices are quoted in the protocol's collateral units per base asset. The exact position deltas and fills were read from protocol state and receipt events. The proof also checked intent hash, executor, nonce, epoch and account revision; reconstructed realized PnL from fills; and reconciled collateral against PnL, fees and settled funding.

The round trip realized **−0.020312 USDso**. Trading fees and settled funding were zero in these receipts. The account returned **19.979688 USDso**, leaving the owner's total collateral balance at **99.979688 USDso**. Those figures demonstrate accounting and control; they are not a return forecast.

Observed execution gas was 6,510,192 for the open and 2,765,201 for the close, at 6 gwei. Their combined charge was **0.055652358 STT**. The **0.75345969 STT** reported for the entire development campaign also includes deployment, setup, earlier attempts and recovery. It must not be quoted as the cost of this single round trip. Native RPC estimates should be used for future transactions; local EVM measurements do not predict native-chain billing reliably.

Public contracts used for this result:

| Contract | Address |
| --- | --- |
| BasketRouter | `0x8584e07c36388cC76AfEFA001fC86F070645c487` |
| BasketAccountFactory | `0xBFDE34B4f48EF47e7308b734eE3A22aBCcf6B3E5` |
| MarketRegistry | `0x7e9Cca9f773d268Afb6a6B750b48bD19C5B1794A` |
| Demonstration basket | `0xB6B75ed9222319e3441CB877883F4ef4d5BAe1c7` |

## What has been tested

| Layer | Completed evidence | Boundary |
| --- | --- | --- |
| Public protocol | Atomic two-leg open/close, exact fills, receipt identity, canonical confirmation, reconciliation, revoke and withdrawal. | Direct SDK/contract path. No public four- or eight-leg claim. |
| Real-protocol fork | Two lifecycle/rollback tests, including eight-leg execution and failed-leg rollback. | Public RPC reads with local fork writes. No public funding or transaction claim. |
| Local service E2E | Owner sign-in, keeper authorization, signed intent submission, keeper broadcast, canonical confirmation and eight-leg close. | Real application components and PostgreSQL; external trading protocol mocked. |
| TypeScript | 465 unit tests; 80 integration tests on PostgreSQL 14 and again on 17. | Test counts describe the recorded execution build, not cumulative repetitions. |
| Solidity | 68 tests repeated under three deterministic CI-profile seeds; 10,000 fuzz runs per property and 256 × 128 stateful invariant campaigns. | Includes mock-based adversarial cases; optional public-RPC fork suite is separate. |
| Mutation checks | Four targeted mutations killed: nonce, signature, final-position and health guards. | Selected checks, rather than exhaustive mutation or formal verification. |
| Operational smoke | 1,900 HTTP requests and 95 writes; zero dropped requests, server errors, authorization/accounting failures, lost jobs or OOM events. | Controlled chain adapter and short duration. Not a one-hour capacity result. |

Backend coverage measured **87.64% lines, 83.94% branches and 86.93% functions**. The configured critical files passed their individual gates. Five critical contracts achieved **100% instrumented branch and function coverage**, with line coverage ranging from 93.24% to 100%. Instrumented branch locations do not enumerate every compound condition or economic scenario. None of these measurements replaces an audit.

## What remains open

The full public API/keeper/indexer campaign encountered log-range RPC timeouts. The successful MVP therefore verifies individual receipts and their block hashes; it does not establish sustained historical indexing or full public service readiness. Existing entry-readiness checks were not disabled to obtain the demo.

Independent audit, seven stable days of soak testing, full capacity testing, second-host recovery, production governance and mainnet compatibility are still release requirements. Larger baskets also need native-chain gas policy validation. No production approval is claimed.

## Reproduce the local boundary

Install the versions listed in the [project README](../README.md), then run:

```bash
npm run typecheck
npm test
TEST_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:PORT/spreadlock_test npm run test:integration
forge test --root contracts
DREAMDEX_FORK_TESTS=true forge test --root contracts --match-contract DreamdexForkTest -vv
npm run build
TEST_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:PORT/spreadlock_test npm run test:e2e
```

Use a disposable database. The full `npm run verify:release` command also checks coverage, stress seeds, mutation results and release prerequisites. It retains unmet gates as failures or blocked requirements, rather than promoting a passing demo into a production release.
