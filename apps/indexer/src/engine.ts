import type { Address } from 'viem';
import { decodeLog, discoveredAddresses, uniqueWatched } from './events.js';
import type { ChainClient, ChainLog, Checkpoint, DecodedLog, IndexerConfig, IndexerStore, TickResult, WatchedAddress } from './types.js';

export class CanonicalIndexer {
  private busy = false;
  private readonly headerConcurrency: bigint;
  constructor(readonly config: IndexerConfig, readonly rpc: ChainClient, readonly store: IndexerStore) {
    const concurrency = config.headerConcurrency ?? 16;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64)
      throw new Error('headerConcurrency must be an integer from 1 through 64');
    this.headerConcurrency = BigInt(concurrency);
  }

  async tick(): Promise<TickResult> {
    if (this.busy) throw new Error('Indexer tick already running');
    this.busy = true;
    try { return await this.runTick(); } finally { this.busy = false; }
  }

  private async runTick(): Promise<TickResult> {
    if (await this.rpc.chainId() !== this.config.chainId) throw new Error('RPC chain does not match deployment manifest');
    const head = await this.rpc.head();
    if (head < this.config.startBlock) return { head, indexed: head, blocks: 0, logs: 0, reorg: false };
    await this.checkCodeHashes();
    let checkpoint = await this.store.checkpoint(this.config.chainId);
    if (!checkpoint) {
      const anchor = await this.rpc.block(this.config.startBlock > 0n ? this.config.startBlock - 1n : 0n);
      await this.store.initialize(this.config.chainId, anchor);
      checkpoint = { number: anchor.number, hash: anchor.hash };
    }
    if (head < checkpoint.number) throw new Error('RPC head is behind the durable checkpoint');
    const canonical = await this.rpc.block(checkpoint.number);
    let reorg = false;
    if (canonical.hash.toLowerCase() !== checkpoint.hash.toLowerCase()) {
      checkpoint = await this.rewind(checkpoint);
      reorg = true;
    }
    const chunkSize = Math.min(500, Math.max(1, this.config.chunkSize ?? 500));
    const to = head < checkpoint.number + BigInt(chunkSize) ? head : checkpoint.number + BigInt(chunkSize);
    let watched = uniqueWatched([...this.config.addresses, ...await this.store.watched(this.config.chainId)]);
    let logs = await this.fetchLogs(checkpoint.number + 1n, to, watched);
    const newAddresses = discoveredAddresses(logs).filter(w => !watched.some(old => old.address.toLowerCase() === w.address.toLowerCase() && old.role === w.role));
    if (newAddresses.length) {
      watched = uniqueWatched([...watched, ...newAddresses]);
      logs = [...logs, ...await this.fetchLogs(checkpoint.number + 1n, to, newAddresses)];
    }
    logs = [...new Map(logs.map(l => [`${l.blockHash}:${l.transactionHash}:${l.logIndex}`, l])).values()]
      .sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);
    const headers = new Map<bigint, Awaited<ReturnType<ChainClient['block']>>>();
    // Bounded concurrency catches up on fast chains without one serial HTTP RTT
    // per empty block. Every header/log is still checked before durable append.
    for(let start=checkpoint.number+1n;start<=to;start+=this.headerConcurrency){
      const requests=[];for(let n=start;n<=to&&n<start+this.headerConcurrency;n++)requests.push(this.rpc.block(n));
      for(const header of await Promise.all(requests))headers.set(header.number,header);
    }
    let count = 0;
    for (let number = checkpoint.number + 1n; number <= to; number++) {
      const block = headers.get(number)!;
      if (block.parentHash.toLowerCase() !== checkpoint.hash.toLowerCase()) throw new Error('Chain moved during backfill; retry after canonical reconciliation');
      const blockLogs = logs.filter(l => l.blockNumber === number);
      if (blockLogs.some(l => l.blockHash.toLowerCase() !== block.hash.toLowerCase())) throw new Error('Log block hash does not match canonical header');
      for (const log of blockLogs) if (log.eventName === 'IntentExecuted') {
        log.receipt = await this.rpc.receipt(log.transactionHash);
        const receiptHash = log.receipt.blockHash;
        const transactionHash = log.receipt.transactionHash;
        if (typeof receiptHash !== 'string' || receiptHash.toLowerCase() !== block.hash.toLowerCase()
            || typeof transactionHash !== 'string' || transactionHash.toLowerCase() !== log.transactionHash.toLowerCase()
            || log.receipt.status !== 'success') throw new Error('Receipt does not prove the canonical successful execution');
      }
      await this.store.append(this.config.chainId, block, blockLogs);
      checkpoint = { number, hash: block.hash }; count++;
    }
    const confirmed = head - BigInt(this.config.confirmations ?? 12);
    await this.store.confirm(this.config.chainId, confirmed < to ? confirmed : to);
    return { head, indexed: checkpoint.number, blocks: count, logs: logs.length, reorg };
  }

  private async fetchLogs(from: bigint, to: bigint, watched: WatchedAddress[]): Promise<DecodedLog[]> {
    if (from > to) return [];
    const addresses = [...new Set(watched.map(w => w.address.toLowerCase()))] as Address[];
    const out: ChainLog[] = [];
    for (let i = 0; i < addresses.length; i += 100) out.push(...await this.rpc.logs(from, to, addresses.slice(i, i + 100)));
    return out.map(log => decodeLog(log, watched));
  }

  private async rewind(checkpoint: Checkpoint): Promise<Checkpoint> {
    const depth = this.config.reorgDepth ?? 256;
    const floor = this.config.startBlock > 0n ? this.config.startBlock - 1n : 0n;
    for (let distance = 1; distance <= depth && checkpoint.number - BigInt(distance) >= floor; distance++) {
      const number = checkpoint.number - BigInt(distance);
      const stored = await this.store.block(this.config.chainId, number);
      if (stored && (await this.rpc.block(number)).hash.toLowerCase() === stored.hash.toLowerCase()) {
        await this.store.rollback(this.config.chainId, number);
        return { number, hash: stored.hash };
      }
    }
    await this.store.incident(this.config.chainId, 'DEEP_REORG', { checkpoint: checkpoint.number.toString(), depth });
    throw new Error(`Reorg exceeds ${depth} blocks; operator resync required`);
  }

  private async checkCodeHashes(): Promise<void> {
    for (const [address, expected] of Object.entries(this.config.expectedCodeHashes ?? {})) {
      if (!this.rpc.codeHash) throw new Error('RPC adapter cannot check configured code fingerprints');
      if ((await this.rpc.codeHash(address as Address)).toLowerCase() !== expected!.toLowerCase()) {
        await this.store.incident(this.config.chainId, 'IMPLEMENTATION_CHANGED', { address, expected });
        throw new Error('Contract code fingerprint changed; compatibility review required');
      }
    }
  }
}
