import { keccak256, parseTransaction } from 'viem';
import { encodeExecution, keeperIntentHash, parseKeeperIntent } from './codec.js';
import type { EngineConfig, IntentFeed, KeeperGateway, KeeperSigner, OutboxEntry, SignedIntent } from './types.js';
import type { KeeperStore } from './store.js';

export class KeeperFailure extends Error {
  constructor(readonly code: string, readonly permanent = false) { super(code); }
}
export interface EngineOptions {
  config: EngineConfig; store: KeeperStore; gateway: KeeperGateway;
  signer: KeeperSigner; feed: IntentFeed; now?: () => number;
}
export class KeeperEngine {
  private readonly now: () => number;
  private running = false;
  private lastReconcile = 0;
  readonly metrics = { ticks: 0, signed: 0, broadcasts: 0, confirmed: 0, failures: 0, feedFailures: 0 };
  lastError: string | null = null;
  lastHealthyAt = 0;
  get isRunning(): boolean { return this.running; }
  constructor(private readonly options: EngineOptions) {
    this.now = options.now ?? Date.now;
    options.store.bind(`${options.config.chainId}:${options.config.router.toLowerCase()}:${options.signer.address.toLowerCase()}`);
  }
  async tick(): Promise<string> {
    if (this.running) return 'BUSY';
    this.running = true;
    this.metrics.ticks++;
    try {
      await this.refreshFeed();
      await this.reconcileRecent();
      const pending = this.options.store.pending();
      if (pending) return await this.recover(pending);
      for (const envelope of this.options.store.due(this.now())) {
        const result = await this.consider(envelope);
        if (result === 'BROADCAST' || result === 'PREPARED') return result;
      }
      return 'IDLE';
    } finally { this.running = false; }
  }
  private async refreshFeed(): Promise<void> {
    try {
      const envelopes = await this.options.feed.fetch();
      for (const envelope of envelopes.slice(0, 100)) {
        if (!this.inScope(envelope)) continue;
        try {
          parseKeeperIntent(envelope.intent);
          if (keeperIntentHash(envelope.intent, this.options.config.chainId, this.options.config.router).toLowerCase() !== envelope.hash.toLowerCase()) continue;
          this.options.store.putIntent(envelope, this.now());
        } catch { this.metrics.failures++; }
      }
    } catch { this.metrics.feedFailures++; }
  }
  private inScope(envelope: SignedIntent): boolean {
    return typeof envelope?.intent?.executor === 'string' && typeof envelope.intent.account === 'string'
      && envelope.intent.executor.toLowerCase() === this.options.signer.address.toLowerCase()
      && this.options.config.accounts.some(address => address.toLowerCase() === envelope.intent.account.toLowerCase());
  }
  private async consider(envelope: SignedIntent): Promise<string> {
    const { store, config, gateway, signer } = this.options;
    if (!this.inScope(envelope)) { store.finish(envelope.hash, 'SUSPENDED'); return 'REJECTED'; }
    const seconds = BigInt(Math.floor(this.now() / 1000));
    if (BigInt(envelope.intent.validUntil) <= seconds) { store.finish(envelope.hash, 'EXPIRED'); return 'EXPIRED'; }
    if (BigInt(envelope.intent.validAfter) > seconds) return 'WAITING';
    try {
      const prepared = await gateway.prepare(envelope);
      if (prepared.to.toLowerCase() !== config.router.toLowerCase() || prepared.chainId !== config.chainId
          || prepared.value !== 0n || prepared.data !== encodeExecution(envelope, prepared.prices)) {
        throw new KeeperFailure('UNSAFE_TRANSACTION', true);
      }
      const gas = (prepared.gasEstimate * 125n + 99n) / 100n;
      if (gas > config.maxGas) throw new KeeperFailure('GAS_LIMIT_EXCEEDED');
      if (prepared.maxFeePerGas > config.maxFeePerGas || prepared.maxPriorityFeePerGas > prepared.maxFeePerGas) throw new KeeperFailure('GAS_PRICE_EXCEEDED');
      const reservedWei = gas * prepared.maxFeePerGas;
      const day = new Date(this.now()).toISOString().slice(0, 10);
      if (store.spend(day) + reservedWei > config.maxDailyWei) throw new KeeperFailure('DAILY_BUDGET_EXCEEDED');
      const nonce = await gateway.getPendingNonce(signer.address);
      const rawTransaction = await signer.signTransaction({ ...prepared, nonce, gas });
      const entry: OutboxEntry = { hash: keccak256(rawTransaction), intentHash: envelope.hash,
        rawTransaction, nonce, reservedWei, day, state: 'PREPARED', createdAt: this.now(), lastBroadcastAt: null };
      store.enqueue(entry, config.maxDailyWei);
      this.metrics.signed++;
      return await this.recover(entry);
    } catch (error) {
      const failure = error instanceof KeeperFailure ? error : new KeeperFailure('PREPARATION_FAILED');
      store.defer(envelope.hash, this.now(), failure.code, failure.permanent);
      this.lastError = failure.code;
      this.metrics.failures++;
      return 'REJECTED';
    }
  }
  private async recover(entry: OutboxEntry): Promise<string> {
    const { gateway, store, config } = this.options;
    let candidate=entry;
    let receipt=await gateway.getReceipt(entry.hash);
    if(!receipt){for(const previous of store.family(entry)){if(previous.hash===entry.hash)continue;const mined=await gateway.getReceipt(previous.hash);if(mined){candidate=previous;receipt=mined;break;}}}
    if(receipt&&candidate.hash!==entry.hash){entry=candidate;}

    if (receipt) {
      const confirmed = receipt.confirmations >= config.confirmations;
      store.receipt(entry.hash, receipt, this.now(), confirmed);
      this.lastHealthyAt = this.now();
      if (confirmed) this.metrics.confirmed++;
      await this.options.feed.report(entry.intentHash, entry.hash).catch(() => {});
      return confirmed ? 'CONFIRMED' : 'MINED';
    }
    if (entry.state === 'MINED') store.unmine(entry.hash);
    if (entry.lastBroadcastAt !== null && this.now() - entry.lastBroadcastAt < 30000) return 'PENDING';
    if(this.now()-entry.createdAt>=120000){
      try {
        const original=parseTransaction(entry.rawTransaction),envelope=store.envelope(entry.intentHash);
        if(envelope&&original.type==='eip1559'&&original.maxFeePerGas!==undefined&&original.maxPriorityFeePerGas!==undefined){
          const fresh=await gateway.prepare(envelope);
          // Only replace the exact original execution; changed price calldata waits.
          if(fresh.chainId===config.chainId&&fresh.data===original.data&&fresh.to.toLowerCase()===config.router.toLowerCase()&&fresh.value===0n){
            const bump=(x:bigint)=>(x*113n+99n)/100n+1n;
            const maxFeePerGas=fresh.maxFeePerGas>bump(original.maxFeePerGas)?fresh.maxFeePerGas:bump(original.maxFeePerGas);
            const maxPriorityFeePerGas=fresh.maxPriorityFeePerGas>bump(original.maxPriorityFeePerGas)?fresh.maxPriorityFeePerGas:bump(original.maxPriorityFeePerGas);
            const gas=(fresh.gasEstimate*125n+99n)/100n;
            if(maxFeePerGas<=config.maxFeePerGas&&gas<=config.maxGas&&maxPriorityFeePerGas<=maxFeePerGas){
              const day=new Date(this.now()).toISOString().slice(0,10),reservedWei=gas*maxFeePerGas;
              if(store.spend(day)+reservedWei<=config.maxDailyWei){
                const rawTransaction=await this.options.signer.signTransaction({...fresh,nonce:entry.nonce,gas,maxFeePerGas,maxPriorityFeePerGas});
                const next={...entry,rawTransaction,hash:keccak256(rawTransaction),reservedWei,day,state:'PREPARED' as const,createdAt:this.now(),lastBroadcastAt:null};
                store.replace(entry,next,config.maxDailyWei);entry=next;
              }
            }
          }
        }
      }catch{ /* Keep the durable original when repricing or signing is unavailable. */ }
    }
    try {
      const hash = await gateway.broadcast(entry.rawTransaction);
      if (hash.toLowerCase() !== entry.hash.toLowerCase()) throw new KeeperFailure('BROADCAST_HASH_MISMATCH');
      store.markBroadcast(entry.hash, this.now());
      this.lastHealthyAt = this.now();
      this.lastError = null;
      this.metrics.broadcasts++;
      await this.options.feed.report(entry.intentHash, hash).catch(() => {});
      return 'BROADCAST';
    } catch {
      this.lastError = 'BROADCAST_PENDING_RECOVERY';
      return 'PREPARED';
    }
  }
  private async reconcileRecent(): Promise<void> {
    if (this.options.store.pending() || this.now() - this.lastReconcile < 10000) return;
    this.lastReconcile = this.now();
    for (const entry of this.options.store.recentConfirmed()) {
      const receipt = await this.options.gateway.getReceipt(entry.hash);
      if (!receipt) { this.options.store.unmine(entry.hash); return; }
    }
  }
}
