import { createPublicClient, defineChain, http, keccak256, parseAbi, type Address, type Hex } from 'viem';
import { keeperIntentHash, keeperTypedData, parseKeeperIntent, encodeExecution } from './codec.js';
import { KeeperFailure } from './engine.js';
import type { KeeperRuntimeConfig } from './config.js';
import type { KeeperGateway, PreparedExecution, SignedIntent, ExecutionReceipt } from './types.js';
import { fingerprint, fingerprintMatches } from '../../indexer/src/fingerprints.js';
import {conservativeQuote,isFillOrKillNotFillable,registryAbi,routerAbi} from '../../../packages/sdk/src/index.js';

const accountAbi = parseAbi([
  'function epoch() view returns (uint256)', 'function revision() view returns (uint256)',
  'function owner() view returns (address)',
]);
const factoryAbi = parseAbi(['function isAccount(address) view returns (bool)']);
const poolAbi = parseAbi([
  'function getBookLevels(bool,uint64) view returns ((uint256 price,uint256 quantity)[])',
  'function getPerpPoolParameters() view returns ((uint256 initialMarginBps,uint256 maintenanceMarginBps,uint256 closeOutMarginBps,uint256 maxOpenInterest,uint256 maxPositionSize,uint256 takerFeeBpsTimes1k,int256 makerFeeBpsTimes1k,uint256 insuranceFundShareBps))',
]);

export class ViemKeeperGateway implements KeeperGateway {
  readonly client;
  constructor(readonly config: KeeperRuntimeConfig, private readonly executor: Address) {
    const chain = defineChain({ id: config.manifest.chainId, name: 'SpreadLock deployment',
      nativeCurrency: { name: 'Native gas', symbol: 'GAS', decimals: 18 },
      rpcUrls: { default: { http: [config.rpcHttpUrl] } } });
    this.client = createPublicClient({ chain, transport: http(config.rpcHttpUrl, { timeout: 15000, retryCount: 1 }) });
  }
  async assertDeployment(): Promise<void> {
    const [chainId, code] = await Promise.all([
      this.client.getChainId(), this.client.getCode({ address: this.config.manifest.router }),
    ]);
    if (chainId !== this.config.manifest.chainId || !code || code === '0x'
        || keccak256(code).toLowerCase() !== this.config.routerCodeHash.toLowerCase()) {
      throw new KeeperFailure('DEPLOYMENT_MISMATCH', true);
    }
    for (const [address, expected] of Object.entries(this.config.manifest.fingerprints ?? {})) {
      const actual = await fingerprint(this.client, address as Address);
      if (!fingerprintMatches(expected, actual)) throw new KeeperFailure('PROTOCOL_IMPLEMENTATION_CHANGED', true);
    }
  }
  async prepare(envelope: SignedIntent): Promise<PreparedExecution> {
    await this.assertDeployment();
    const { manifest } = this.config;
    const intent = parseKeeperIntent(envelope.intent);
    if (intent.executor.toLowerCase() !== this.executor.toLowerCase()) throw new KeeperFailure('WRONG_EXECUTOR', true);
    if (keeperIntentHash(envelope.intent, manifest.chainId, manifest.router).toLowerCase() !== envelope.hash.toLowerCase()) throw new KeeperFailure('INVALID_INTENT_HASH', true);
    const block = await this.client.getBlock();
    if (block.timestamp < intent.validAfter) throw new KeeperFailure('NOT_YET_VALID');
    if (block.timestamp >= intent.validUntil) throw new KeeperFailure('EXPIRED', true);
    const readAccount = (functionName: 'epoch' | 'revision' | 'owner') => this.client.readContract({
      address: intent.account, abi: accountAbi, functionName, blockNumber: block.number });
    const [known, epoch, revision, owner, used, positions, valid] = await Promise.all([
      this.client.readContract({ address: manifest.factory, abi: factoryAbi, functionName: 'isAccount', args: [intent.account], blockNumber: block.number }),
      readAccount('epoch'), readAccount('revision'), readAccount('owner'),
      this.client.readContract({ address: manifest.router, abi: routerAbi, functionName: 'nonceUsed', args: [intent.account, intent.epoch, intent.nonce], blockNumber: block.number }),
      this.client.readContract({ address: manifest.router, abi: routerAbi, functionName: 'positionsHash', args: [intent.account, intent.legs], blockNumber: block.number }),
      this.client.verifyTypedData({ address: intent.account, ...keeperTypedData(envelope.intent, manifest.chainId, manifest.router), signature: envelope.signature, blockNumber: block.number }),
    ]);
    if (!known || !valid || (owner as Address).toLowerCase() === this.executor.toLowerCase()
        || (owner as Address).toLowerCase() !== this.config.authorization.owner.toLowerCase()) throw new KeeperFailure('INVALID_ACCOUNT_OR_SIGNATURE', true);
    if (used || epoch !== intent.epoch) throw new KeeperFailure('INTENT_INVALIDATED', true);
    if (BigInt(revision) < intent.expectedRevision) throw new KeeperFailure('WAITING_DEPENDENCY');
    if (revision !== intent.expectedRevision || positions.toLowerCase() !== intent.expectedPositionsHash.toLowerCase()) throw new KeeperFailure('STALE_POSITIONS', true);
    let prices: bigint[] = [];
    for (const leg of intent.legs) prices.push(await this.executionPrice(leg, block.number));
    const simulate=(executionPrices:bigint[])=>this.client.simulateContract({address:manifest.router,abi:routerAbi,functionName:'execute',args:[intent,executionPrices,envelope.signature],account:this.executor});
    try{await simulate(prices);}catch(error){
      if(!isFillOrKillNotFillable(error))throw error;
      const bounds=await Promise.all(intent.legs.map(async leg=>{
        const metadata=await this.client.readContract({address:manifest.marketRegistry,abi:registryAbi,functionName:'marketMetadata',args:[leg.pool],blockNumber:block.number});
        if(metadata[4]>BigInt(leg.maxTakerFeeBpsTimes1k))throw new KeeperFailure('FEE_LIMIT_EXCEEDED');
        return {delta:leg.delta,price:leg.limitPrice,lotSize:metadata[3],oneBase:metadata[0],feeRate:metadata[4]};
      }));
      if(conservativeQuote(bounds)<intent.minNetQuote)throw new KeeperFailure('QUOTE_BOUND');
      prices=intent.legs.map(leg=>leg.limitPrice);
      await simulate(prices);
    }
    const [gasEstimate, fees] = await Promise.all([
      this.client.estimateContractGas({ address: manifest.router, abi: routerAbi, functionName: 'execute',
        args: [intent, prices, envelope.signature], account: this.executor }),
      this.client.estimateFeesPerGas(),
    ]);
    return { to: manifest.router, data: encodeExecution(envelope, prices), value: 0n,
      chainId: manifest.chainId, prices, gasEstimate, maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
  }
  private async executionPrice(leg: ReturnType<typeof parseKeeperIntent>['legs'][number], blockNumber: bigint): Promise<bigint> {
    if (!this.config.manifest.markets.some(pool => pool.toLowerCase() === leg.pool.toLowerCase())) throw new KeeperFailure('MARKET_NOT_PINNED', true);
    const [levels, parameters] = await Promise.all([
      this.client.readContract({ address: leg.pool, abi: poolAbi, functionName: 'getBookLevels', args: [leg.delta < 0n, 64n], blockNumber }),
      this.client.readContract({ address: leg.pool, abi: poolAbi, functionName: 'getPerpPoolParameters', blockNumber }),
    ]);
    if (parameters.takerFeeBpsTimes1k > BigInt(leg.maxTakerFeeBpsTimes1k)) throw new KeeperFailure('FEE_LIMIT_EXCEEDED');
    let remaining = leg.delta < 0n ? -leg.delta : leg.delta;
    for (const level of levels) {
      if ((leg.delta > 0n && level.price > leg.limitPrice) || (leg.delta < 0n && level.price < leg.limitPrice)) break;
      remaining -= remaining < level.quantity ? remaining : level.quantity;
      if (remaining === 0n) return level.price;
    }
    throw new KeeperFailure('INSUFFICIENT_EXECUTABLE_DEPTH');
  }
  getPendingNonce(address: Address): Promise<number> {
    return this.client.getTransactionCount({ address, blockTag: 'pending' });
  }
  async getReceipt(hash: Hex): Promise<ExecutionReceipt | undefined> {
    let receipt;
    try { receipt = await this.client.getTransactionReceipt({ hash }); }
    catch (error) {
      if ((error as { name?: string }).name === 'TransactionReceiptNotFoundError') return undefined;
      throw error;
    }
    if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error('RPC receipt belongs to another transaction');
    const [head, block] = await Promise.all([this.client.getBlockNumber({ cacheTime: 0 }), this.client.getBlock({ blockNumber: receipt.blockNumber })]);
    if (head < receipt.blockNumber) throw new Error('RPC head is behind the receipt block');
    if (block.hash !== receipt.blockHash) return undefined;
    return { status: receipt.status, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice,
      blockNumber: receipt.blockNumber, confirmations: Number(head - receipt.blockNumber + 1n) };
  }
  broadcast(rawTransaction: Hex): Promise<Hex> {
    return this.client.sendRawTransaction({ serializedTransaction: rawTransaction });
  }
  watch(wake: () => void): () => void {
    if (!this.config.rpcWsUrl) return () => {};
    const socket = new WebSocket(this.config.rpcWsUrl);
    let closed = false;
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe',
        params: ['somnia_watch', { address: this.config.manifest.markets, eth_calls: [] }] }));
    });
    socket.addEventListener('message', event => {
      if (closed) return;
      try {
        const message = JSON.parse(String(event.data)) as { method?: string; error?: unknown };
        if (message.method === 'eth_subscription') wake();
        if (message.error) socket.close();
      } catch { socket.close(); }
    });
    socket.addEventListener('error', () => socket.close());
    return () => { closed = true; socket.close(); };
  }
}
