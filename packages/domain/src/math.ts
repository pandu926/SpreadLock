import { encodeAbiParameters, getAddress, keccak256 } from 'viem';
import { DomainError, type Position } from './types.js';
export const FEE_DENOMINATOR = 10_000_000n;
export const abs = (n: bigint): bigint => n < 0n ? -n : n;
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (a < 0n || b <= 0n) throw new DomainError('INVALID_ARITHMETIC', 'Expected nonnegative numerator and positive denominator');
  return a / b + (a % b === 0n ? 0n : 1n);
}
export interface BoundLeg { delta: bigint; price: bigint; lotSize: bigint; oneBase: bigint; feeRate: bigint }
/** Synthetic sell-minus-buy notional. Not collateral cashflow or locked profit. */
export function conservativeQuote(legs: readonly BoundLeg[]): bigint {
  return legs.reduce((net, l) => {
    const q = abs(l.delta);
    if (!q || l.price <= 0n || l.lotSize <= 0n || l.oneBase <= 0n || q % l.lotSize || l.feeRate < 0n || l.feeRate >= FEE_DENOMINATOR)
      throw new DomainError('INVALID_QUOTE', 'Invalid size, lot, price, or taker fee');
    const lots = q / l.lotSize;
    const raw = l.lotSize * l.price;
    const n = l.delta > 0n ? ceilDiv(raw, l.oneBase) : raw / l.oneBase;
    const fee = ceilDiv(n * l.feeRate, FEE_DENOMINATOR);
    const result = net + lots * (l.delta > 0n ? -(n + fee) : n - fee);
    if (result < -(1n << 255n) || result >= 1n << 255n) throw new DomainError('OVERFLOW', 'Quote exceeds int256');
    return result;
  }, 0n);
}
export function canonicalPositionsHash(positions: readonly Position[]): `0x${string}` {
  const sorted = positions.map(p => ({pool:getAddress(p.pool),size:p.size}))
    .sort((a,b) => BigInt(a.pool) < BigInt(b.pool) ? -1 : BigInt(a.pool) > BigInt(b.pool) ? 1 : 0);
  if (sorted.length > 16 || new Set(sorted.map(p=>p.pool.toLowerCase())).size !== sorted.length)
    throw new DomainError('INVALID_POSITIONS', 'Positions must be unique, maximum 16');
  for (const {size} of sorted) if (size < -(1n<<127n) || size >= 1n<<127n) throw new DomainError('INVALID_POSITIONS','Position exceeds int128');
  return keccak256(encodeAbiParameters([{type:'address[]'},{type:'int128[]'}],[sorted.map(p=>p.pool),sorted.map(p=>p.size)]));
}
