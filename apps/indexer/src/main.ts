import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import { createPublicClient, http, webSocket, parseAbi, type Address } from 'viem';
import { parseManifest, SpreadLockClient } from '../../../packages/sdk/src/index.js';
import { CanonicalIndexer } from './engine.js';
import { fingerprint, fingerprintMatches, type Fingerprint } from './fingerprints.js';
import { PgIndexerStore } from './pg-store.js';
import { createChainClient } from './rpc.js';
import type { WatchedAddress } from './types.js';

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
const rawManifest: unknown = JSON.parse(await readFile(required('SPREADLOCK_MANIFEST'), 'utf8'));
const manifest = parseManifest(rawManifest);
const rpcUrl = process.env.RPC_HTTP_URL ?? manifest.rpcHttpUrl;
if (!rpcUrl) throw new Error('RPC_HTTP_URL is required');
const headerConcurrency = process.env.INDEXER_HEADER_CONCURRENCY === undefined ? 16 : Number(process.env.INDEXER_HEADER_CONCURRENCY);
if (!Number.isInteger(headerConcurrency) || headerConcurrency < 1 || headerConcurrency > 64)
  throw new Error('INDEXER_HEADER_CONCURRENCY must be an integer from 1 through 64');
const pool = new Pool({ connectionString: required('DATABASE_URL'), max: 4 });
const store = new PgIndexerStore(pool); await store.migrate();
await new SpreadLockClient(manifest, rpcUrl).verifyDeployment();
const watched: WatchedAddress[] = [
  { address: manifest.factory, role: 'factory' }, { address: manifest.router, role: 'router' },
  { address: manifest.marketRegistry, role: 'registry' }, { address: manifest.marginBank, role: 'bank' },
  ...manifest.markets.map(address => ({ address, role: 'pool' as const })),
];
const systemClient=createPublicClient({transport:http(rpcUrl,{timeout:20000})});
const system=await systemClient.readContract({address:manifest.marginBank,abi:parseAbi(['function getSystemConfig() view returns((address marginBank,address collateralToken,address perpPoolFactory,address liquidationEngine,address insuranceFund,address feeRecipient,uint16 maxLeverageLimit,bool fullyWired))']),functionName:'getSystemConfig'});
if(system.liquidationEngine !== '0x0000000000000000000000000000000000000000')watched.push({address:system.liquidationEngine,role:'liquidation'});
const fingerprints = ((rawManifest as Record<string, unknown>).fingerprints ?? {}) as Record<Address, Fingerprint>;
const publicClient = createPublicClient({ transport: http(rpcUrl, { timeout: 20000 }) });
const pinnedAddresses = [manifest.router, manifest.factory, manifest.marketRegistry, manifest.marginBank, manifest.collateral, manifest.permissionsRegistry, manifest.protocolFactory, ...manifest.markets];
if (process.env.NODE_ENV === 'production' && pinnedAddresses.some(address => !Object.keys(fingerprints).some(key => key.toLowerCase() === address.toLowerCase()))) throw new Error('Production requires pinned code/proxy fingerprints for every manifest contract');
const engine = new CanonicalIndexer({ chainId: manifest.chainId, startBlock: BigInt(manifest.deploymentBlock), addresses: watched, confirmations: manifest.confirmations, headerConcurrency }, createChainClient(rpcUrl), store);
let stopping = false; let running: Promise<void> | undefined; let lastSuccess = 0; let lastError: string | null = null;
let lastFingerprintCheck = 0; let fingerprintsHealthy = true; let ticks = 0; let errors = 0; let wakeAgain = false;

async function checkFingerprints(): Promise<void> {
  if (Date.now() - lastFingerprintCheck < 60000) return;
  lastFingerprintCheck = Date.now();
  for (const [address, expected] of Object.entries(fingerprints)) {
    const actual = await fingerprint(publicClient, address as Address);
    if (!fingerprintMatches(expected, actual)) {
      if (fingerprintsHealthy) await store.incident(manifest.chainId, 'IMPLEMENTATION_CHANGED', { address, expected, actual });
      fingerprintsHealthy = false;
    }
  }
}

async function tick(): Promise<void> {
  try {
    await checkFingerprints();
    // Continue indexing exits and canonical history even when entry is suspended.
    const result = await engine.tick(); ticks++; lastSuccess = Date.now(); lastError = null;
    if (result.indexed < result.head) wakeAgain = true;
  } catch (error) {
    errors++; lastError = error instanceof Error ? error.message : 'Indexer error';
    console.error(JSON.stringify({ service: 'indexer', error: lastError }));
  }
}
function wake(): void {
  if (stopping) return;
  if (running) { wakeAgain = true; return; }
  running = (async () => { do { wakeAgain = false; await tick(); } while (wakeAgain && !stopping && !lastError); })().finally(() => { running = undefined; });
}
const timer = setInterval(wake, 2000);
let unwatch: (() => void) | undefined;
const wsUrl = process.env.RPC_WS_URL ?? manifest.rpcWsUrl;
if (wsUrl) {
  const ws = createPublicClient({ transport: webSocket(wsUrl, { reconnect: true }) });
  unwatch = ws.watchBlockNumber({ onBlockNumber: wake, onError: () => { /* HTTP backfill remains authoritative. */ } });
}
const port = Number(process.env.INDEXER_HEALTH_PORT ?? '18181');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid INDEXER_HEALTH_PORT');
const health = createServer((req, res) => {
  if (req.url === '/metrics') { res.setHeader('content-type', 'text/plain; version=0.0.4'); res.end(`spreadlock_indexer_ticks_total ${ticks}\nspreadlock_indexer_errors_total ${errors}\nspreadlock_indexer_last_success_timestamp_seconds ${lastSuccess / 1000}\n`); return; }
  const ready = Date.now() - lastSuccess < 30000 && lastError === null && fingerprintsHealthy;
  res.statusCode = ready ? 200 : 503; res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ready, fingerprintsHealthy, lastSuccess, lastError }));
});
health.listen(port, process.env.INDEXER_HEALTH_HOST ?? '127.0.0.1');
async function shutdown(): Promise<void> {
  if (stopping) return; stopping = true; clearInterval(timer); unwatch?.();
  await running; await new Promise<void>(resolve => health.close(() => resolve())); await pool.end();
}
process.once('SIGTERM', () => { void shutdown(); }); process.once('SIGINT', () => { void shutdown(); });
wake();
