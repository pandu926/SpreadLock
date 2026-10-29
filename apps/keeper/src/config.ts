import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { getAddress, type Address, type Hex } from 'viem';
import type { DeploymentManifest } from '../../../packages/domain/src/index.js';
import { parseManifest } from '../../../packages/sdk/src/manifest.js';

export interface KeeperAuthorization {
  owner: Address; keeper: Address; accounts: Address[]; chainId: number;
  validUntil: string; nonce: string; signature: Hex;
}
export interface KeeperRuntimeConfig {
  manifest: DeploymentManifest;
  rpcHttpUrl: string; rpcWsUrl?: string; routerCodeHash: Hex;
  databasePath: string; keystorePath: string; passwordFile: string;
  authorization: KeeperAuthorization; apiBaseUrl: string;
  maxGas: bigint; maxFeePerGas: bigint; maxDailyWei: bigint;
  pollIntervalMs: number; healthPort: number; allowLocalDevelopment: boolean;
}
function positive(value: unknown, name: string): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || value.length > 78) throw new Error(`${name} must be a positive decimal string`);
  return BigInt(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a configuration object');
  return value as Record<string, unknown>;
}
function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Missing ${name}`);
  return value;
}
function endpoint(value: unknown, name: string, local: boolean, ws = false): string {
  const url = new URL(string(value, name));
  const secure = ws ? 'wss:' : 'https:';
  const insecure = ws ? 'ws:' : 'http:';
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== secure && !(local && loopback && url.protocol === insecure))) throw new Error(`Unsafe ${name}`);
  return url.toString().replace(/\/$/, '');
}
export function readPrivateFile(path: string): string {
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Secret files must be regular files accessible only to their owner');
  return readFileSync(path, 'utf8');
}
export function loadKeeperConfig(path: string): KeeperRuntimeConfig {
  const base = dirname(resolve(path));
  const raw = object(JSON.parse(readFileSync(path, 'utf8')));
  const file = (key: string) => {
    const name = string(raw[key], key);
    return isAbsolute(name) ? name : resolve(base, name);
  };
  const manifest = parseManifest(JSON.parse(readFileSync(file('manifestFile'), 'utf8')));
  const auth = object(JSON.parse(readPrivateFile(file('authorizationFile')))) as unknown as KeeperAuthorization;
  getAddress(auth.owner); getAddress(auth.keeper);
  if (auth.chainId !== manifest.chainId || !Array.isArray(auth.accounts) || !auth.accounts.length || auth.accounts.length > 100) throw new Error('Invalid keeper account scope');
  auth.accounts.forEach(getAddress);
  positive(auth.validUntil, 'authorization.validUntil');
  if (!/^(0|[1-9][0-9]*)$/.test(auth.nonce) || !/^0x[0-9a-fA-F]+$/.test(auth.signature)) throw new Error('Invalid keeper certificate');
  const local = raw.allowLocalDevelopment === true;
  if (!local) {
    const pinned = Object.keys(manifest.fingerprints ?? {}).map(value => value.toLowerCase());
    const required = [manifest.router, manifest.factory, manifest.marketRegistry, manifest.marginBank,
      manifest.collateral, manifest.permissionsRegistry, manifest.protocolFactory, ...manifest.markets];
    if (required.some(address => !pinned.includes(address.toLowerCase()))) throw new Error('Production requires pinned bytecode/proxy fingerprints for every deployment contract and market');
  }
  const codeHash = string(raw.routerCodeHash, 'routerCodeHash');
  if (!/^0x[0-9a-fA-F]{64}$/.test(codeHash)) throw new Error('Invalid pinned router code hash');
  const maxGas = raw.maxGas === undefined ? 40_000_000n : positive(raw.maxGas, 'maxGas');
  if (maxGas > 40_000_000n) throw new Error('Gas cap exceeds the verified 40M policy');
  const poll = raw.pollIntervalMs ?? 1000;
  const port = raw.healthPort ?? 19191;
  if (!Number.isSafeInteger(poll) || (poll as number) < 250 || (poll as number) > 30000) throw new Error('Invalid polling interval');
  if (!Number.isSafeInteger(port) || (port as number) < 0 || (port as number) > 65535) throw new Error('Invalid health port');
  return { manifest, authorization: auth, routerCodeHash: codeHash as Hex,
    rpcHttpUrl: endpoint(raw.rpcHttpUrl, 'rpcHttpUrl', local),
    ...(raw.rpcWsUrl ? { rpcWsUrl: endpoint(raw.rpcWsUrl, 'rpcWsUrl', local, true) } : {}),
    apiBaseUrl: endpoint(raw.apiBaseUrl, 'apiBaseUrl', local),
    databasePath: file('databasePath'), keystorePath: file('keystorePath'), passwordFile: file('passwordFile'),
    maxGas, maxFeePerGas: positive(raw.maxFeePerGas, 'maxFeePerGas'),
    maxDailyWei: positive(raw.maxDailyWei, 'maxDailyWei'), pollIntervalMs: poll as number,
    healthPort: port as number, allowLocalDevelopment: local };
}
