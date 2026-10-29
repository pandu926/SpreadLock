# Read SpreadLock in the order you need

Start with the public transactions, then inspect the execution guarantee behind them.

| Reader | Start here | What it answers |
| --- | --- | --- |
| Judge reviewing the build | [Submission brief](SUBMISSION.md) | What was built, why it matters, and what is already proven |
| Trader or product reviewer | [Problem and impact](PROBLEM_AND_IMPACT.md) | Where incomplete execution hurts and which outcomes we intend to improve |
| Judge checking the demonstration | [Demo walkthrough](DEMO.md) | How to inspect the real two-leg open and close |
| Engineer reviewing the design | [Architecture](ARCHITECTURE.md) | Contracts, signed intents, permissions, services, and settlement |
| Developer integrating a strategy | [Integration guide](INTEGRATION.md) | Read-only inspection, transaction preparation, signing, and execution |
| Reviewer checking claims | [Validation record](VALIDATION.md) | Public transactions, local tests, fork tests, and the limits of each |
| Security reviewer | [Security model](SECURITY.md) | Authority, trust assumptions, failure modes, and release requirements |

The [repository README](../README.md) is the shortest overview. The [contract guide](../contracts/README.md) documents the Solidity interfaces in more detail.

These documents describe a testnet candidate. Each claim about a completed demonstration should be traceable to a transaction or a named test scope. Proposed impact and future milestones are identified as such.
