# Operational verification campaigns

These tools produce measured evidence. A smoke run is **NOT_RUN** for the full capacity gate; an elapsed-time observer cannot pass seven days early. Missing remote recovery infrastructure is **BLOCKED**. No tool signs or broadcasts a blockchain transaction.

## Regression tests

```sh
node --test ops/testing/*.test.mjs
```

## Actual HTTP/PostgreSQL capacity

```sh
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:15483/spreadlock_test \
  node --import tsx ops/scripts/campaign-load.ts --output evidence/operations/load-smoke.json
```

This creates a random dedicated schema, applies real migrations, seeds 100 owners, 1,000 baskets, 10,000 historical intents, and 10 keeper sessions; it serves the actual Fastify application on a random loopback port. Real signed intent submissions create DB jobs and a real worker revalidates them. All chain operations use an explicit controlled gateway; no public RPC is used. Seeded historical signatures and certificates are fixtures, not claimed chain proofs. Test keys and bearer tokens remain ephemeral in memory and are never emitted.

The 13-second smoke sends 1,900 requests (10s at100rps,3s at300rps), approximately5% writes,5% quotes,10% keeper feed and80% other reads. Reported elapsed latency includes scheduler delay, signing, HTTP and response parsing to avoid coordinated omission. Writes are reconciled with actual persisted intent owners/nonces and corresponding jobs. Private ownership is checked on list results. Queue recovery excludes future standing-intent revalidations and counts overdue/leased jobs. Memory is sampled from the actual process; cgroup OOM kills are measured from this process's Linux cgroup. Missing OOM telemetry fails closed.

For the full one-hour baseline followed by five-minute burst:

```sh
TEST_DATABASE_URL=... node --import tsx ops/scripts/campaign-load.ts --full \
  --output evidence/operations/load-full.json
```

Full execution requires15GiB free disk. Full PASS additionally requires95th percentile read≤200ms,write≤500ms,quote≤2s;5xx<0.1%;no lost/dropped work,ownership/integrity errors,or OOM;≥99% of offered throughput; and queue recovery≤5min. The normal rate limiter is increased **only inside this isolated harness** because a shared loopback test source is not100 public IPs. Production rate limiting/auth abuse have separate API tests.

This is application capacity evidence, not blockchain throughput, persistent user traffic, or real external RPC performance. Full runs should use an isolated staging host rather than this shared VPS while disk is constrained. Re-run after the source freezes; source changes invalidate a full run.

## Persistent seven-day testnet observer

Copy `ops/testing/soak.example.json` to ignored runtime storage and fill in reviewed deployment manifest and dedicated API address. Start only after source freezes and deployment prerequisites pass:

```sh
node --import tsx ops/scripts/campaign-soak.ts runtime/soak/config.json --once
node --import tsx ops/scripts/campaign-soak.ts runtime/soak/config.json
```

The first command executes one actual probe and reconciliation; the second probes every60seconds until terminated, failed, or seven days pass. Use a service supervisor on the staging host; SIGTERM/SIGINT preserve state. State writes are fsync+atomic rename and restricted0600; an exclusive PID lock prevents duplicate observers. Restart reuses the initial timestamp and counts missing probes as outages. A source change requires a **new** state file and seven-day period.

The observer checks real API readiness, pinned chain50383/deployment fingerprints, canonical confirmed receipts, actual gas, token transfer commitment, exact signed close hashes/events and historical flat position state. It recomputes cycle days using actual block timestamps. Historical cycles before observer start do not count; reporting an old close today cannot satisfy today's cycle requirement. It performs a full reconciliation at least daily, verifying all campaign accounts are flat and owned by the expected owner. A probe failure records downtime; an irreversible budget breach fails immediately.

`campaignFiles` lists public root-campaign reports (`evidence/public-testnet/campaign.json` shape). Add separate source-identical reports for each newly completed daily campaign to this runtime list. The observer does **not** invent or schedule trades. The execution operator must supply at least two actual completed open/close cycles each day. Campaign hard caps remain100USDso peak collateral and10STT aggregate gas; no automatic top-up or budget escalation. Any pending active campaign is expected to fail flat reconciliation until complete.

Pass requires seven real days,≥99.5% observed availability,daily successful reconciliation,and at least two canonical round trips in each of the seven days. Missing interval evidence is counted, not hidden after restart. Additional anomaly review and the release report verifier are still required.

## Second-host disaster recovery proof

Capture actual host observations on **both** source and recovery hosts:

```sh
node ops/scripts/campaign-dr.mjs host-observation evidence/operations/dr-source-host.json
```

Host ID is SHA-256 of local machine-id; never change it to make the hosts appear distinct. Existing backup/restore scripts still require a dedicated database and reject a nonempty target. Configure encrypted offsite backup and continuous WAL archiving with your actual infrastructure. Restore on host2, replay WAL, reconcile chain/application state, and record incident/start/completion/latest recovered timestamps.

The evidence input uses `sourceSha256`, `reviewedBy`, `measurements` and `artifacts:[{path,sha256}]`. Required measurements: sourceHostId,restoreHostId,encrypted,offsite,walArchived,targetWasEmpty,restoreStartedAt,restoreCompletedAt,lastRecoverableAt,incidentAt,reconciled,backupSha256,restoreArtifactSha256. Timestamps are UTC epoch milliseconds. Artifact paths must be inside evidence/, hash match, and contain raw redacted host observations, backup/WAL verification and restore/reconciliation logs. Do not publish database dumps or credentials.

```sh
node ops/scripts/campaign-dr.mjs verify runtime/dr/proof.json evidence/operations/dr-verified.json
node ops/scripts/campaign-dr.mjs verify
```

The second command records BLOCKED when required infrastructure is absent. PASS needs distinct hosts, encrypted offsite WAL-backed recovery, previously empty target, successful reconciliation,RPO≤15min and RTO≤4h from incident. This is an evidence verifier, not an offsite provider or automated restore executor; no command in this harness deletes data or reconfigures existing services. An independent operator must review the raw recovery proof before production release.
