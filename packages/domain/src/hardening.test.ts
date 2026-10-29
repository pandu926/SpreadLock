import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256 } from 'viem';
import { canonicalPositionsHash, ceilDiv, conservativeQuote, parseIntent, serializeIntent } from './index.js';
import type { WireIntent } from './index.js';

const a = '0x0000000000000000000000000000000000000001' as const;
const b = '0x0000000000000000000000000000000000000002' as const;
const fixture = (): WireIntent => ({ account: a, executor: b, nonce: '0', epoch: '0', expectedRevision: '0',
  expectedPositionsHash: `0x${'0'.repeat(64)}`, validAfter: '100', validUntil: '200', operation: 0,
  legs: [{ pool: a, delta: '1', limitPrice: '1', maxTakerFeeBpsTimes1k: 0 },
    { pool: b, delta: '-1', limitPrice: '1', maxTakerFeeBpsTimes1k: 0 }],
  minNetQuote: '0', triggerKind: 0, triggerValue: '0', minPostEquity: '0', minPostHealthBps: 0 });

describe('strict intent arithmetic and independent accounting reference', () => {
  it.each([null, [], 1, 'intent'])('rejects non-object intent %j', input => expect(() => parseIntent(input)).toThrow());
  it.each([undefined, {}, [], [fixture().legs[0]], Array(9).fill(fixture().legs[0])])('rejects invalid open legs %j', legs => {
    expect(() => parseIntent({ ...fixture(), legs })).toThrow();
  });
  it.each([undefined, 1, '01', '-0', '1e3', '9'.repeat(80)])('rejects noncanonical integer %j', nonce => {
    expect(() => parseIntent({ ...fixture(), nonce })).toThrow();
  });
  it.each([undefined, 0.5, NaN, -1, 3, '0'])('rejects invalid operation %j', operation => {
    expect(() => parseIntent({ ...fixture(), operation })).toThrow();
  });
  it.each([null, {}, [], { ...fixture().legs[0], unknown: true }])('rejects malformed leg %j', leg => {
    expect(() => parseIntent({ ...fixture(), legs: [leg, fixture().legs[1]] })).toThrow();
  });
  it.each(['0', (-(1n << 127n)).toString(), (1n << 127n).toString()])('rejects invalid signed quantity %s', delta => {
    expect(() => parseIntent({ ...fixture(), legs: [{ ...fixture().legs[0], delta }, fixture().legs[1]] })).toThrow();
  });
  it('accepts a single-leg close and extreme valid fields without precision loss', () => {
    const wire = { ...fixture(), operation: 2 as const, legs: [fixture().legs[0]!],
      nonce: ((1n << 256n) - 1n).toString(), minNetQuote: (-(1n << 255n)).toString(),
      triggerValue: ((1n << 255n) - 1n).toString(), minPostHealthBps: 0xffffffff, triggerKind: 2 as const };
    expect(serializeIntent(parseIntent(wire))).toEqual(wire);
  });
  it('rejects zero prices, invalid hash types, fees and oversized health fields', () => {
    const w = fixture();
    for (const changes of [{ expectedPositionsHash: null }, { minPostHealthBps: 0x100000000 },
      { legs: [{ ...w.legs[0], limitPrice: '0' }, w.legs[1]] },
      { legs: [{ ...w.legs[0], maxTakerFeeBpsTimes1k: 10_000_000 }, w.legs[1]] }]) {
      expect(() => parseIntent({ ...w, ...changes })).toThrow();
    }
  });
  it('rejects malformed and incorrectly checksummed owner addresses', () => {
    expect(() => parseIntent({ ...fixture(), account: 7 })).toThrow();
    expect(() => parseIntent({ ...fixture(), account: '0x52908400098527886E0F7030069857D2e4169EE7' })).toThrow('checksum');
    const owner='0x52908400098527886E0F7030069857D2E4169EE7';
    expect(parseIntent({...fixture(),account:owner}).account).toBe(owner);
    expect(parseIntent({...fixture(),account:owner.toLowerCase()}).account).toBe(owner);
  });
  it('guards signed limits and nanosecond expiry overflow', () => {
    expect(() => parseIntent({ ...fixture(), triggerValue: (1n << 255n).toString() })).toThrow('int256');
    expect(() => parseIntent({ ...fixture(), triggerValue: (-(1n << 255n) - 1n).toString() })).toThrow('int256');
    expect(() => parseIntent({ ...fixture(), validAfter: '18446744073', validUntil: '18446744074' })).toThrow('window');
  });
  it('matches an independent per-lot reference over deterministic decimal, fee and direction combinations', () => {
    // This oracle intentionally imports no production division/rounding helper.
    const up = (n: bigint, d: bigint) => (n + d - 1n) / d;
    for (const oneBase of [1n, 10n, 10n ** 8n, 10n ** 18n]) {
      for (const feeRate of [0n, 1n, 12_345n, 9_999_999n]) {
        for (let seed = 1n; seed <= 25n; seed++) {
          const lot = seed * 3n, price = seed * 137n + oneBase, lots = seed % 7n + 1n;
          for (const direction of [-1n, 1n]) {
            const n = direction > 0n ? up(lot * price, oneBase) : lot * price / oneBase;
            const fee = up(n * feeRate, 10_000_000n);
            const expected = lots * (direction > 0n ? -n - fee : n - fee);
            expect(conservativeQuote([{ delta: direction * lot * lots, price, lotSize: lot, oneBase, feeRate }])).toBe(expected);
          }
        }
      }
    }
    expect(ceilDiv(10n, 5n)).toBe(2n); expect(ceilDiv(11n, 5n)).toBe(3n);
    expect(conservativeQuote([])).toBe(0n);
  });
  it('rejects every invalid quote dimension and both int256 overflow directions', () => {
    const leg = { delta: 1n, price: 1n, lotSize: 1n, oneBase: 1n, feeRate: 0n };
    for (const change of [{ delta: 0n }, { price: 0n }, { lotSize: 0n }, { oneBase: 0n },
      { feeRate: -1n }, { feeRate: 10_000_000n }]) expect(() => conservativeQuote([{ ...leg, ...change }])).toThrow();
    expect(() => conservativeQuote([{ ...leg, delta: -1n, price: 1n << 255n }])).toThrow('int256');
    expect(() => conservativeQuote([{ ...leg, price: (1n << 255n) + 1n }])).toThrow('int256');
  });
  it('matches direct ABI reference hashing and enforces all position snapshot boundaries', () => {
    const expected = keccak256(encodeAbiParameters([{ type: 'address[]' }, { type: 'int128[]' }], [[a, b], [2n, -3n]]));
    expect(canonicalPositionsHash([{ pool: b, size: -3n }, { pool: a, size: 2n }])).toBe(expected);
    expect(() => canonicalPositionsHash([{ pool: a, size: 0n }, { pool: a, size: 1n }])).toThrow();
    expect(() => canonicalPositionsHash(Array.from({ length: 17 }, (_, n) => ({ pool: `0x${(n + 1).toString(16).padStart(40, '0')}` as `0x${string}`, size: 0n })))).toThrow();
    expect(() => canonicalPositionsHash([{ pool: a, size: 1n << 127n }])).toThrow();
    expect(() => canonicalPositionsHash([{ pool: a, size: -(1n << 127n) - 1n }])).toThrow();
    expect(canonicalPositionsHash([{ pool: a, size: -(1n << 127n) }])).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
