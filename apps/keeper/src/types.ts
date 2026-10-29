import type { Address, Hex } from 'viem';

import type { SignedIntent } from '../../../packages/domain/src/index.js';
export type { WireLeg, WireIntent, SignedIntent } from '../../../packages/domain/src/index.js';
export interface PreparedExecution {
  to: Address;
  data: Hex;
  value: bigint;
  chainId: number;
  prices: bigint[];
  gasEstimate: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}
export interface SignableExecution extends PreparedExecution { nonce: number; gas: bigint }
export interface KeeperSigner {
  address: Address;
  signTransaction(transaction: SignableExecution): Promise<Hex>;
  signMessage(message: string): Promise<Hex>;
}
export interface ExecutionReceipt {
  status: 'success' | 'reverted';
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  blockNumber: bigint;
  confirmations: number;
}
export interface KeeperGateway {
  prepare(envelope: SignedIntent): Promise<PreparedExecution>;
  getPendingNonce(address: Address): Promise<number>;
  getReceipt(hash: Hex): Promise<ExecutionReceipt | undefined>;
  broadcast(rawTransaction: Hex): Promise<Hex>;
  watch?(wake: () => void): () => void;
}
export interface IntentFeed {
  fetch(): Promise<SignedIntent[]>;
  report(hash: Hex, txHash: Hex): Promise<void>;
  heartbeat?(): Promise<void>;
}
export interface EngineConfig {
  chainId: number;
  router: Address;
  accounts: readonly Address[];
  maxGas: bigint;
  maxFeePerGas: bigint;
  maxDailyWei: bigint;
  confirmations: number;
}
export interface OutboxEntry {
  hash: Hex;
  intentHash: Hex;
  rawTransaction: Hex;
  nonce: number;
  reservedWei: bigint;
  day: string;
  state: 'PREPARED' | 'BROADCAST' | 'MINED' | 'CONFIRMED' | 'REPLACED';
  createdAt: number;
  lastBroadcastAt: number | null;
}
