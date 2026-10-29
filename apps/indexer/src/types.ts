import type { Address, Hex } from 'viem';

export type Role = 'factory' | 'router' | 'account' | 'registry' | 'bank' | 'pool' | 'liquidation';
export interface Header { number: bigint; hash: Hex; parentHash: Hex; timestamp: bigint }
export interface ChainLog {
  address: Address; blockNumber: bigint; blockHash: Hex; transactionHash: Hex;
  logIndex: number; topics: readonly Hex[]; data: Hex;
}
export interface DecodedLog extends ChainLog {
  eventName: string | null; args: Record<string, unknown> | null;
  receipt?: Record<string, unknown>;
}
export interface WatchedAddress { address: Address; role: Role }
export interface Checkpoint { number: bigint; hash: Hex }
export interface ChainClient {
  chainId(): Promise<number>;
  head(): Promise<bigint>;
  block(number: bigint): Promise<Header>;
  logs(from: bigint, to: bigint, addresses: Address[]): Promise<ChainLog[]>;
  receipt(hash: Hex): Promise<Record<string, unknown>>;
  codeHash?(address: Address): Promise<Hex>;
}
export interface IndexerStore {
  checkpoint(chainId: number): Promise<Checkpoint | null>;
  block(chainId: number, number: bigint): Promise<Header | null>;
  initialize(chainId: number, anchor: Header): Promise<void>;
  watched(chainId: number): Promise<WatchedAddress[]>;
  append(chainId: number, block: Header, logs: DecodedLog[]): Promise<void>;
  rollback(chainId: number, ancestor: bigint): Promise<void>;
  confirm(chainId: number, through: bigint): Promise<void>;
  incident(chainId: number, kind: string, details: Record<string, unknown>): Promise<void>;
}
export interface IndexerConfig {
  chainId: number; startBlock: bigint; addresses: WatchedAddress[];
  confirmations?: number; chunkSize?: number; reorgDepth?: number; headerConcurrency?: number;
  expectedCodeHashes?: Partial<Record<Address, Hex>>;
}
export interface TickResult { head: bigint; indexed: bigint; blocks: number; logs: number; reorg: boolean }
