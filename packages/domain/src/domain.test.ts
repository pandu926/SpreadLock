import { describe, it, expect } from 'vitest';
import { conservativeQuote, parseIntent, canonicalPositionsHash } from './index.js';
describe('safe basket arithmetic', () => {
  it('bounds sell credit conservatively across fragmented fills and fee rounding', () => {
    expect(conservativeQuote([{ delta: -6n, price: 7n, lotSize: 2n, oneBase: 10n, feeRate: 0n }])).toBe(3n);
  });
  it('rounds buy cost upward per lot including fees', () => {
    expect(conservativeQuote([{ delta: 6n, price: 7n, lotSize: 2n, oneBase: 10n, feeRate: 1n }])).toBe(-9n);
  });
  it('rejects non-integer wire quantities', () => {
    expect(() => parseIntent({ legs: [{ delta: '0.4' }] })).toThrow();
  });
  it('hashes positions independently of input order', () => {
    const a = '0x0000000000000000000000000000000000000001';
    const b = '0x0000000000000000000000000000000000000002';
    expect(canonicalPositionsHash([{pool:a,size:1n},{pool:b,size:-2n}]))
      .toBe(canonicalPositionsHash([{pool:b,size:-2n},{pool:a,size:1n}]));
  });
});
