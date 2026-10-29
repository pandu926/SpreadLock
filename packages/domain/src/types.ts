import type { Address, Hex } from 'viem';
export type Operation = 0 | 1 | 2;
export type TriggerKind = 0 | 1 | 2;
export interface Leg { pool: Address; delta: bigint; limitPrice: bigint; maxTakerFeeBpsTimes1k: number }
export interface Intent {
  account: Address; executor: Address; nonce: bigint; epoch: bigint; expectedRevision: bigint;
  expectedPositionsHash: Hex; validAfter: bigint; validUntil: bigint; operation: Operation; legs: Leg[];
  minNetQuote: bigint; triggerKind: TriggerKind; triggerValue: bigint; minPostEquity: bigint; minPostHealthBps: number;
}
export interface WireLeg { pool: Address; delta: string; limitPrice: string; maxTakerFeeBpsTimes1k: number }
export interface WireIntent {
  account: Address; executor: Address; nonce: string; epoch: string; expectedRevision: string;
  expectedPositionsHash: Hex; validAfter: string; validUntil: string; operation: Operation; legs: WireLeg[];
  minNetQuote: string; triggerKind: TriggerKind; triggerValue: string; minPostEquity: string; minPostHealthBps: number;
}
export interface MarketMetadata {
  pool: Address; oneBase: bigint; tickSize: bigint; lotSize: bigint; minQuantity: bigint; takerFeeBpsTimes1k: number;
}
export interface Position { pool: Address; size: bigint }
export interface SignedIntent { hash: Hex; intent: WireIntent; signature: Hex }
export interface DeploymentManifest {
  version: 1; chainId: number; router: Address; factory: Address; marketRegistry: Address;
  marginBank: Address; collateral: Address; permissionsRegistry: Address; protocolFactory: Address;
  deploymentBlock: string; rpcHttpUrl?: string; rpcWsUrl?: string; confirmations: number; markets: Address[];
  fingerprints?: Record<Address, {codeHash:Hex;implementation?:Address;implementationCodeHash?:Hex;beacon?:Address}>;
}
export class DomainError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'DomainError'; }
}
