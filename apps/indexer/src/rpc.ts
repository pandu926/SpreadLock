import { createPublicClient, http, keccak256, type Address, type Hex } from 'viem';
import type { ChainClient, ChainLog } from './types.js';

export function createChainClient(rpcUrl: string): ChainClient {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 20000, retryCount: 2, batch: { batchSize: 16, wait: 5 } }) });
  return {
    chainId: () => client.getChainId(), head: () => client.getBlockNumber({ cacheTime: 0 }),
    block: async number => { const b = await client.getBlock({ blockNumber: number }); return { number: b.number, hash: b.hash, parentHash: b.parentHash, timestamp: b.timestamp }; },
    logs: async (fromBlock, toBlock, address) => {
      if (!address.length) return [];
      const logs = await client.getLogs({ address, fromBlock, toBlock });
      return logs.filter(log => !log.removed && log.blockNumber !== null && log.blockHash !== null && log.transactionHash !== null && log.logIndex !== null)
        .map(log => ({ address: log.address, blockNumber: log.blockNumber!, blockHash: log.blockHash!, transactionHash: log.transactionHash!, logIndex: log.logIndex!, topics: log.topics, data: log.data }) as ChainLog);
    },
    receipt: async hash => await client.getTransactionReceipt({ hash }) as unknown as Record<string, unknown>,
    codeHash: async address => { const code = await client.getCode({ address }); if (!code) throw new Error(`Missing contract ${address}`); return keccak256(code); },
  };
}
