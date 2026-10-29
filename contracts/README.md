# SpreadLock contracts

Solidity 0.8.30, EVM Cancun, Foundry/Forge 1.5.1. Contracts are immutable; a new
router version requires explicit owner authorization. Each `BasketAccount` is a
separate MarginBank account and stays CROSS internally for multi-market baskets.
No linked-parent funding or pooled user collateral is used.

## Contracts and trust boundaries

- `MarketRegistry(bank, protocolFactory, collateral, governor, guardian)` verifies
  official factory origin, MarginBank registration, common collateral/system
  wiring and supported market metadata. Governor changes activation; guardian
  can pause entry. Disabled entry markets remain known for exits.
- `BasketAccountFactory(bank, collateral, permissionsRegistry, marketRegistry)`
  uses owner-scoped CREATE2 salts. `createAccount(bytes32 salt)` creates an
  immutable-owner account. `predictAccount(owner,salt)` gives the address before
  funding. Factory account membership is checked by the router.
- `BasketAccount` supports predeposit, withdrawal to owner, per-market router
  authorization, nonce epoch invalidation and independent owner emergency exits.
  The account implements ERC-1271 via its owner, supporting EOA and deployed
  smart-wallet owners. No counterfactual signature/account abstraction service.
- `BasketRouter(accountFactory,marketRegistry)` executes exact signed quantities
  via FOK. It checks all starting positions, exact resulting deltas, shared-bank
  health, bounded fees, nonce/epoch/revision and full rollback on any failure.
- `SpreadLockGovernor(multisig)` starts with a 48-hour timelock delay and checks
  an existing multisig as 2-of-3 at construction. It assigns proposer/executor
  roles to that address, with no external bootstrap admin. Later configuration
  changes remain part of the governance trust boundary.

The router never holds collateral. A keeper only pays gas and is bound into the
owner's signature. It must NOT receive account ownership or direct pool grants.
Underlying dreamDEX pools may be upgraded independently: these immutable
contracts do not eliminate protocol/oracle/governance trust.

## Interface

`IntentTypes.sol` is the canonical tuple schema. EIP-712 domain is
`name=SpreadLock`, `version=1`, current `chainId`, and router `verifyingContract`.
Operations: OPEN=0, ADJUST=1, CLOSE=2. OPEN requires 2–8 unique pools; adjust/close
accept 1–8. No more than eight active markets may remain in the account.

`execute(Intent intent,uint256[] executablePrices,bytes signature)` only permits
the signed executor or the account owner. The array retains the signed leg
order. Buy prices may be tightened down and sell prices up, never loosened.
Intent timestamps are seconds; pool expiry is checked/converted to uint64
nanoseconds. Maximum intent window is 30 days.

`positionsHash(account,legs)` = `keccak256(abi.encode(address[] sortedUnion,
int128[] sizes))`. The union covers all active account pools and requested pools,
deduplicated and sorted numerically by address. It includes flat/new pools with
size zero. It does not infer executed price from average entry price.

`minNetQuote` is a conservative bound on **synthetic signed execution notional**:
sell notional minus buy notional minus trading fee. It is NOT an actual cash
transfer, profitability guarantee or funding-inclusive PnL. Bounds are computed
per lot with conservative rounding, then multiplied by lot count. Fee denominator
is 10,000,000; builder fee is zero. Fee/fragment rounding must remain compatible
with the registered dreamDEX implementation. Receipt fills provide actual prices.

Trigger kinds: 0 NONE, 1 MARK_NET_QUOTE_GTE, 2 MARK_NET_QUOTE_LTE. Mark quote sums
the signed intent order notionals at live marks, excluding fees/funding/gas.

## Owner actions

- Transfer existing collateral to the account, then `depositMargin(amount)`.
- `setRouterApproval(router,pools,approved)` grants placement only; every change
  advances epoch/revision and invalidates earlier signed intents. Revoking any
  subset also disables the router at account level until explicitly re-enabled.
- `withdrawMargin(amount)` withdraws allowed collateral to the owner and advances
  epoch/revision. Token allowance to the bank is reset after each deposit.
- `invalidateIntents()` advances account epoch/revision without API dependency.
- `router.invalidateNonces(account,word,mask)` cancels selected nonces in the
  current epoch; only the owner/account can call it. HTTP cancellation alone
  does not cancel an already distributed signature.
- `emergencyClose(pool,quantity,limitPrice,expiryNs,immediateOrCancel)` is owner-only,
  independently available during router pause. IOC accepts genuinely partial
  reduction; FOK requires the full quantity. Neither may flip the position.
- `cancelOrder(pool,orderId)` and token/native recovery remain owner-only.

Pool/oracle/liquidity failures can still prevent exits. No application pause can
make the underlying protocol execute a trade it refuses.

## Tests

```bash
forge test --root contracts -vv
FOUNDRY_PROFILE=ci forge test --root contracts
forge coverage --ir-minimum --exclude-tests --report lcov --report-file /tmp/spreadlock-contracts.lcov
python3 contracts/script/tools/check_critical_coverage.py /tmp/spreadlock-contracts.lcov
DREAMDEX_FORK_TESTS=true forge test --root contracts --match-contract DreamdexForkTest -vvv
```

Fork writes remain local. Default pinned fork block is 34991667 on chain 50383;
override with `DREAMDEX_FORK_BLOCK`. Funding impersonates a funded external donor
on the local fork and transfers existing collateral, then deposits normally.
No public signing, state-changing calls, artificial liquidity, or oracle mocks
are used for fork tests. Unit/adversarial tests explicitly use mock contracts.

## Deployment

Install the root npm dependencies before building, which supply OpenZeppelin.
Set `CHAIN_ID`, `DEPLOYER_ADDRESS`, `MARGIN_BANK`, `COLLATERAL_TOKEN`,
`PERP_POOL_FACTORY`, `OPERATOR_REGISTRY`, and `GUARDIAN_ADDRESS`.

```bash
forge script --root contracts script/Deploy.s.sol:Deploy --rpc-url "$RPC_URL" --account deployer
```

This simulates. Public deployment additionally requires intentional `--broadcast`
and the encrypted Foundry keystore. Never pass plaintext private keys as CLI
arguments. Verify and pin the deployment bytecode/artifacts before activation.
Production also requires `PRODUCTION=true`, `MAINNET_RELEASE_APPROVED=true`,
`GOVERNANCE_MULTISIG`, a compatible live protocol deployment and all release
gates. This source does not declare mainnet ready or fabricate mainnet addresses.

Pools start inactive. The testnet governor activates verified pools using
`configurePool(pool,true)`. Production activation must be scheduled/executed
through the timelock. No token can be withdrawn by the registry/governor/router.
