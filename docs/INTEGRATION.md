# Integrating a strategy with SpreadLock

A strategy supplies the desired position changes. SpreadLock supplies the account, signed execution constraints, and transaction boundary. The [public two-leg demonstration](VALIDATION.md) used this direct contract path; no hosted API is required for that path.

The SDK is currently source code in this repository. The root package is private; this guide does not assume a published npm package or an available public API endpoint.

## 1. Inspect the deployment before signing

Install the root dependencies and use Node 24. Prepare a local deployment manifest using the schema in [`parseManifest`](../packages/sdk/src/manifest.ts). It includes:

- Version, chain ID, deployment block, and confirmation count.
- SpreadLock router, factory, and market registry addresses.
- MarginBank, collateral, permissions registry, and protocol factory addresses.
- An explicit market list and reviewed code/proxy fingerprints.

The demonstrated deployment is on **Somnia testnet, chain 50383**; its public addresses are in [Validation](VALIDATION.md). The [official dreamDEX integration guide](https://app.testnet.dreamdex.io/docs/developers/perps-testnet) identifies protocol configuration. Read each pool's actual grid and base scale; the SDK rejects unsupported sizes rather than assuming all assets have the same precision.

Keep runtime manifests out of Git. Fingerprint capture is available as a local tool:

```sh
node --import tsx ops/scripts/fingerprint-manifest.ts runtime/candidate.json runtime/reviewed.json
```

Review the captured addresses and implementations before trusting the output. Capturing a hash does not establish that the contract is trustworthy. `verifyDeployment()` checks chain, deployment bindings, code existence, and any supplied fingerprints; production configuration requires complete reviewed pins.

A read-only example is included:

```sh
SPREADLOCK_MANIFEST=runtime/reviewed.json \
BASKET_ACCOUNT=0xYOUR_BASKET_ACCOUNT \
node --import tsx examples/inspect-basket.ts
```

It verifies the supplied deployment and prints public account state. It does not sign or send a transaction.

## 2. Create and fund a basket account

The factory exposes `predictAccount(owner, salt)` and `createAccount(salt)`. An account is bound to its owner and to one MarginBank, collateral token, permissions registry, and market registry.

The funding sequence is explicit:

1. Create the basket account.
2. Transfer collateral to that account.
3. Call `depositMargin(amount)` on the account.
4. Authorize the router for the selected registered pools.

`setRouterApproval` advances the account's epoch and revision. Build the intent **after** the grant; signing against the previous revision creates a stale request. Each basket funds its own margin. Creating another basket does not grant access to a parent wallet's collateral.

The SDK exposes `createAccountCall`, `fundAccountCall`, `depositCall`, and `grantCall` for transaction preparation. The CLI exposes the same workflow. For example, this command prepares the collateral-transfer call:

```sh
npm run cli -- account-fund \
  --manifest "$SPREADLOCK_MANIFEST" \
  --account "$BASKET_ACCOUNT" \
  --amount 20000000000000000000 \
  --keystore "$OWNER_KEYSTORE" \
  --password-file "$OWNER_PASSPHRASE_FILE"
```

On the demonstrated USDso deployment, that raw amount is 20 USDso. General integrations must check token precision. The CLI requires local encrypted-wallet files for this workflow. Transaction commands prepare calls by default; `--send` intentionally broadcasts after simulation. Obtain native RPC gas estimates before sending.

## 3. Construct and sign the intended state transition

Use the [canonical intent schema](../contracts/src/IntentTypes.sol) and the [domain parser](../packages/domain/src/intent.ts). Important inputs are:

| Input | Integration responsibility |
| --- | --- |
| Account and executor | Select the owned basket and the executor allowed by the signature |
| Epoch and revision | Read the current account state; account actions can invalidate it |
| Expected positions hash | Use `positionsHash` over the active/requested pool union |
| Legs | Supply signed raw base quantities, tick-aligned limits, and fee caps |
| Validity and nonce | Choose an unused nonce and an intentional execution window |
| Combined quote and health | Supply the strategy's execution bound and required post-trade health |

The wire format uses decimal strings for large integers and integer numbers for small enum/uint32 fields. Parse it with `parseIntent` before using `getIntentTypedData(intent, chainId, router)`. Never convert raw amounts through JavaScript floating-point numbers.

The owner signs the typed data locally. `intent-sign` produces a signed envelope from a local intent file. A keeper must receive the envelope and its scope, never the owner's signing key. Give the router the account's pool permission; do not give a keeper an independent direct-pool grant that bypasses the intended execution policy.

## 4. Prepare and execute

`SpreadLockClient.prepareExecution(intent, signature)` verifies the basket signature, obtains executable prices, checks the combined quote, simulates execution, estimates native gas, and returns calldata. A narrowly recognized FOK rejection permits one retry at the **existing signed limits**; those limits and the signature are unchanged, and the fallback is simulated again.

The assigned executor can use the CLI:

```sh
npm run cli -- intent-execute \
  --manifest "$SPREADLOCK_MANIFEST" \
  --file runtime/signed-intent.json \
  --keystore "$KEEPER_KEYSTORE" \
  --password-file "$KEEPER_PASSPHRASE_FILE"
```

Inspect the prepared result before choosing to add `--send`. The account owner can also execute at contract level. This particular CLI command requires the local signer to equal the assigned executor.

For a hosted application, `SpreadLockApiClient` supports owner authentication, account preparation, quotes, intent preparation/submission, and execution queries. The API does not take custody of signing keys. Its full public indexer-backed execution path remains a separate validation milestone; do not assume the direct SDK demonstration proves that service deployment.

## 5. Verify settlement and preserve recovery paths

A transaction hash is a pending identifier. Confirm the successful receipt, its canonical block hash, the expected router event and intent hash, account/executor, nonce/epoch/revision, and actual position changes. The demonstration required at least 12 canonical confirmations. Reconcile fills, fees, funding settlements, and collateral separately from the synthetic quote bound.

Owner invalidation, withdrawal, and emergency close are available directly through the contracts and CLI. HTTP cancellation records a request; effective cancellation requires canonical on-chain invalidation. See [Security](SECURITY.md) before automating these operations.
