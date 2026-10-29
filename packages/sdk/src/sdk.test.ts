import { describe, expect, it } from 'vitest';
import { parseManifest, selectExecutionPrice } from './index.js';
describe('execution planning', () => {
  it('uses the worst price needed to fill the full quantity, without loosening owner bounds', () => {
    expect(selectExecutionPrice(6n, 12n, [{price:10n,quantity:3n},{price:11n,quantity:4n}])).toBe(11n);
  });
  it('rejects insufficient depth and prices outside owner limits', () => {
    expect(()=>selectExecutionPrice(8n,12n,[{price:10n,quantity:3n}])).toThrow();
    expect(()=>selectExecutionPrice(-4n,10n,[{price:9n,quantity:9n}])).toThrow();
  });
  it('rejects a manifest with an unsafe or unsupported chain/address', () => {
    expect(()=>parseManifest({chainId:-1,router:'http://attacker'})).toThrow();
  });
});
