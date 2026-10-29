import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import type { SignedIntent, WireIntent } from './types.js';

export const routerAbi = parseAbi([
  'function execute((address account,address executor,uint256 nonce,uint256 epoch,uint256 expectedRevision,bytes32 expectedPositionsHash,uint64 validAfter,uint64 validUntil,uint8 operation,(address pool,int128 delta,uint256 limitPrice,uint32 maxTakerFeeBpsTimes1k)[] legs,int256 minNetQuote,uint8 triggerKind,int256 triggerValue,uint256 minPostEquity,uint32 minPostHealthBps) intent,uint256[] prices,bytes signature)',
  'function nonceUsed(address account,uint256 epoch,uint256 nonce) view returns (bool)',
  'function positionsHash(address account,(address pool,int128 delta,uint256 limitPrice,uint32 maxTakerFeeBpsTimes1k)[] legs) view returns (bytes32)',
]);
export { intentTypes } from '../../../packages/domain/src/index.js';
import { parseIntent, hashIntent, getIntentTypedData } from '../../../packages/domain/src/index.js';
export const parseKeeperIntent = parseIntent;
export function keeperTypedData(intent: WireIntent, chainId: number, router: Address) {
  return getIntentTypedData(parseIntent(intent), chainId, router);
}
export function keeperIntentHash(intent: WireIntent, chainId: number, router: Address): Hex {
  return hashIntent(parseIntent(intent), chainId, router);
}
export function encodeExecution(envelope: SignedIntent, prices: readonly bigint[]): Hex {
  return encodeFunctionData({ abi: routerAbi, functionName: 'execute',
    args: [parseIntent(envelope.intent), prices, envelope.signature] });
}
