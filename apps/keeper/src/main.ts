import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ApiIntentFeed } from './api.js';
import { loadKeeperConfig } from './config.js';
import { KeeperEngine } from './engine.js';
import { ViemKeeperGateway } from './gateway.js';
import { acquireKeeperLock } from './lock.js';
import { loadKeeperSigner } from './signer.js';
import { KeeperStore } from './store.js';

export async function runKeeper(configPath: string): Promise<() => Promise<void>> {
  process.umask(0o077);
  const config = loadKeeperConfig(configPath);
  mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
  const unlock = acquireKeeperLock(`${config.databasePath}.lock`);
  const store = new KeeperStore(config.databasePath);
  try {
    const signer = await loadKeeperSigner(config.keystorePath, config.passwordFile, config.authorization.keeper);
    const gateway = new ViemKeeperGateway(config, signer.address);
    await gateway.assertDeployment();
    const feed = new ApiIntentFeed(config, signer);
    const engine = new KeeperEngine({ config: { ...config, chainId: config.manifest.chainId,
      router: config.manifest.router, accounts: config.authorization.accounts, confirmations: config.manifest.confirmations },
      store, gateway, signer, feed });
    const health = createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'running', lastHealthyAt: engine.lastHealthyAt,
          lastError: engine.lastError, pending: Boolean(store.pending()) }));
      } else if (request.url === '/metrics') {
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        response.end(Object.entries(engine.metrics).map(([key, value]) => `spreadlock_keeper_${key} ${value}`).join('\n') + '\n');
      } else { response.writeHead(404); response.end(); }
    });
    await new Promise<void>((resolve, reject) => { health.once('error', reject); health.listen(config.healthPort, '127.0.0.1', resolve); });
    let stopped = false;
    const tick = () => { if (!stopped) void engine.tick().catch(() => { engine.lastError = 'CHAIN_OR_STORAGE_UNAVAILABLE'; }); };
    const stopWatch = gateway.watch(tick);
    const poll = setInterval(tick, config.pollIntervalMs);
    const heartbeat = setInterval(() => { void feed.heartbeat().catch(() => {}); }, 15000);
    tick();
    const stop = async () => {
      if (stopped) return;
      stopped = true; clearInterval(poll); clearInterval(heartbeat); stopWatch();
      await new Promise<void>((resolve, reject) => health.close(error => error ? reject(error) : resolve()));
      // Pending ticks finish via bounded RPC timeouts before closing their durable store.
      while (engine.isRunning) await new Promise(resolve => setTimeout(resolve, 25));
      store.close(); unlock();
    };
    return stop;
  } catch (error) { store.close(); unlock(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const configPath = process.argv[2] ?? process.env.KEEPER_CONFIG;
  if (!configPath) { process.stderr.write('Usage: keeper <config.json> or KEEPER_CONFIG\n'); process.exitCode = 1; }
  else void runKeeper(configPath).then(stop => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void stop().catch(() => { process.exitCode = 1; }); });
  }).catch(() => { process.stderr.write('Keeper startup failed; verify local configuration, keystore permissions, deployment and RPC.\n'); process.exitCode = 1; });
}
