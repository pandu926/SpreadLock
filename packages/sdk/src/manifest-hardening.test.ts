import { describe, expect, it } from 'vitest';
import { parseManifest } from './manifest.js';
const a = '0x1111111111111111111111111111111111111111';
const b = '0x2222222222222222222222222222222222222222';
const hash = `0x${'1'.repeat(64)}`;
const fixture = () => ({ version: 1, chainId: 50383, router: a, factory: b, marketRegistry: a, marginBank: b,
  collateral: a, permissionsRegistry: b, protocolFactory: a, deploymentBlock: '0', confirmations: 12, markets: [a, b] });

describe('deployment manifest strict trust boundaries', () => {
  it.each([null, [], 1, 'manifest'])('rejects malformed manifest %j', value => expect(() => parseManifest(value)).toThrow());
  it.each([{ version: 2 }, { chainId: 0 }, { chainId: 1.5 }, { deploymentBlock: 1 }, { deploymentBlock: '01' },
    { confirmations: 0 }, { confirmations: 257 }, { confirmations: 1.5 }, { markets: [] }, { markets: null },
    { markets: Array(1001).fill(a) }, { markets: [a, a] }, { router: 1 }, { router: '0x12' }, { router: `0x${'0'.repeat(40)}` }])
    ('rejects malformed trusted field %j', changes => expect(() => parseManifest({ ...fixture(), ...changes })).toThrow());
  it.each([{ rpcHttpUrl: 1 }, { rpcWsUrl: 1 }, { rpcHttpUrl: 'ftp://rpc.example' },
    { rpcHttpUrl: 'https://user@rpc.example' }, { rpcHttpUrl: 'https://:password@rpc.example' },
    { fingerprints: [] }, { fingerprints: null }, { fingerprints: { [a]: null } }, { fingerprints: { [a]: 1 } },
    { fingerprints: { [a]: { codeHash: 1 } } }, { fingerprints: { [a]: { codeHash: hash, implementationCodeHash: 1 } } },
    { fingerprints: { [a]: { codeHash: hash, implementationCodeHash: '0x12' } } },
    { fingerprints: { [a]: { codeHash: hash, implementation: '0x12' } } },
    { fingerprints: { [a]: { codeHash: hash, beacon: '0x12' } } }])
    ('rejects unsafe RPC or fingerprint field %j', changes => expect(() => parseManifest({ ...fixture(), ...changes })).toThrow());
  it('preserves explicit implementation/beacon hashes and normalizes supported URLs', () => {
    const value = { ...fixture(), rpcHttpUrl: 'https://rpc.example', rpcWsUrl: 'wss://rpc.example/ws',
      fingerprints: { [a]: { codeHash: hash, implementation: b, implementationCodeHash: hash, beacon: a } } };
    const before = JSON.stringify(value), parsed = parseManifest(value);
    expect(parsed.fingerprints?.[a]).toEqual(value.fingerprints[a]);
    expect(parsed.rpcHttpUrl).toBe('https://rpc.example/'); expect(parsed.rpcWsUrl).toBe('wss://rpc.example/ws');
    expect(JSON.stringify(value)).toBe(before);
    expect(parseManifest(fixture()).fingerprints).toBeUndefined();
  });
});
