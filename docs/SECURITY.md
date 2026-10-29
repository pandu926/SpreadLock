# Security model and remaining trust

A keeper can submit a permitted basket. It cannot withdraw the basket's collateral through SpreadLock. That distinction shapes the account, signature and operational design.

The public MVP demonstrated an owner-funded account, a separate execution wallet, atomic open and close, permission revocation and owner withdrawal. It does not constitute a security audit. The exact proof boundary appears in [Validation](VALIDATION.md).

## Authorization boundaries

| Actor | Authority | Boundary |
| --- | --- | --- |
| Owner | Fund and withdraw, authorize a router, sign intents, invalidate signatures and attempt emergency reduction. | Account ownership is immutable; owner-key compromise defeats these controls. |
| Keeper | Pay gas and submit a valid intent for its assigned account and executor. | Contract checks still apply even if the API or keeper process is dishonest. |
| API | Authenticate sessions, store signed requests, prepare transactions and serve eligible work. | It receives no owner or keeper private key and cannot manufacture an owner signature. |
| Governor and guardian | Activate supported markets and pause entry under their respective roles. | Production governance is a release requirement; testnet administration is not a production multisig deployment. |
| dreamDEX protocol | Maintain collateral, positions, order matching, marks, funding and liquidation. | SpreadLock depends on the correctness and availability of these external contracts. |

The governor checks multisig owner count and threshold at construction and starts with a 48-hour delay. Later signer configuration and timelock-delay changes remain governance decisions, so deployment review must cover those authorities as well.

Router approval is an explicit trust decision. The account checks that a router reports compatible factory and registry bindings. Clients must also verify the intended router's pinned code. Approving an arbitrary contract that imitates those bindings is unsafe.

## What a signature permits

An EIP-712 intent binds the chain, router, account, executor, epoch, nonce, expected revision and position hash, together with quantities, price and fee limits, time bounds, triggers and post-trade requirements. A stale or replayed instruction must fail.

The router accepts the designated executor or the account owner. Smart-wallet owners are supported through ERC-1271. Their signature-validation policy remains part of the trust boundary; a changing or reverting policy can invalidate an otherwise well-formed request.

API keeper certificates control feed access and account scope. They are separate from the trading signatures enforced by the router. Revoking a certificate or ending a session does not cancel a trading signature that has already been distributed. Cancellation requires canonical nonce or epoch invalidation.

## What atomic execution protects

Every leg must produce its exact signed position delta, and the final account state must match the complete expected market set. Failure reverts the transaction's state changes, including its nonce and revision changes. This prevents a successful transaction from leaving only the first intended leg filled.

Entry pause blocks OPEN and ADJUST. CLOSE remains available, subject to the router and protocol checks.

The protection ends at the transaction boundary. Prices can move after entry; funding can accrue; collateral can become insufficient; liquidation can occur. Two assets do not become economically neutral because their orders were committed together. A reverted transaction still consumes gas.

Registered protocol contracts are an external dependency. Tests exercise malicious callbacks that alter earlier positions, introduce unsigned markets or leave fees changed during execution. These tests motivated defensive checks. They do not demonstrate an exploit in official dreamDEX pools, and those checks cannot make a fully dishonest external bank, pool or oracle trustworthy.

## Failures outside the router

The keeper independently checks deployment identity and signed state, simulates, enforces gas policy and persists its signed transaction before broadcast. A crash resumes the same transaction family instead of silently allocating a fresh nonce. Replacement accounting tracks the original transaction as well, because it can still win.

The indexer validates canonical receipts and rolls back projections after reorgs. Entry readiness fails when the provider, checkpoint or implementation is unsuitable. The owner can prepare cancellation and withdrawal without a healthy entry oracle; actual protocol withdrawal and emergency-close rules still apply.

A narrow simulated FOK rejection can trigger one retry at the already signed limits. This does not authorize a larger quantity, looser limit or weaker combined quote bound.

## Release requirements

Independent contract audit, a stable seven-day soak, complete public service-path testing, verified mainnet compatibility, production governance and offsite recovery remain incomplete. A local restore and high test coverage do not satisfy those requirements.

Production signing must separate the owner from the central service and keeper trust domains. Encryption protects a stored key at rest; a compromised signing host can still act while that key is usable. Deployment fingerprints, TLS, scoped access, monitored gas policy and an exercised pause/exit procedure are required operational controls.

For technical review, start with [`BasketRouter`](../contracts/src/BasketRouter.sol), [`BasketAccount`](../contracts/src/BasketAccount.sol), the [keeper engine](../apps/keeper/src/engine.ts) and the [canonical indexer](../apps/indexer/src/engine.ts). Report an exploitable issue privately to the repository maintainer before sharing a working attack publicly; a dedicated disclosure channel has not been configured in this repository.
