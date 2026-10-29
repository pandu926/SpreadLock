import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, type Address, type Hex } from 'viem';
import { encodeExecution, keeperIntentHash } from './codec.js';
import { KeeperStore } from './store.js';
import { KeeperEngine } from './engine.js';
import type { EngineConfig, KeeperGateway, KeeperSigner, SignedIntent } from './types.js';

const router = '0x1111111111111111111111111111111111111111' as Address;
const executor = '0x2222222222222222222222222222222222222222' as Address;
const account = '0x3333333333333333333333333333333333333333' as Address;
const pool = '0x4444444444444444444444444444444444444444' as Address;
const hash = `0x${'aa'.repeat(32)}` as Hex;
const config: EngineConfig = { chainId: 50383, router, accounts: [account], maxGas: 40_000_000n,
  maxFeePerGas: 10n, maxDailyWei: 1_000_000_000n, confirmations: 12 };
const envelope: SignedIntent = { hash, signature: '0x1234', intent: { account, executor,
  nonce: '0', epoch: '0', expectedRevision: '0', expectedPositionsHash: `0x${'00'.repeat(32)}`,
  validAfter: '1789999900', validUntil: '1790001000', operation: 0,
  legs: [{ pool, delta: '1000', limitPrice: '1000000000000000000', maxTakerFeeBpsTimes1k: 0 },
    { pool: '0x5555555555555555555555555555555555555555', delta: '-1000', limitPrice: '1000000000000000000', maxTakerFeeBpsTimes1k: 0 }],
  minNetQuote: '0', triggerKind: 0, triggerValue: '0', minPostEquity: '0', minPostHealthBps: 20000 } };
const stores: KeeperStore[] = [];
const dirs: string[] = [];
function fixture(input = envelope) {
  const canonical = { ...input, hash: keeperIntentHash(input.intent, config.chainId, config.router) };
  const dir = mkdtempSync(join(tmpdir(), 'spreadlock-keeper-'));
  dirs.push(dir);
  const store = new KeeperStore(join(dir, 'keeper.sqlite'));
  stores.push(store);
  const gateway: KeeperGateway = {
    prepare: vi.fn(async () => ({ to: router, data: encodeExecution(canonical, [1n, 1n]), value: 0n, chainId: 50383,
      prices: [1n, 1n], gasEstimate: 100n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n })),
    getPendingNonce: vi.fn(async () => 7), getReceipt: vi.fn(async () => undefined),
    broadcast: vi.fn(async () => { throw new Error('network unavailable'); }),
  };
  const signer: KeeperSigner = { address: executor,
    signTransaction: vi.fn(async () => '0x0102' as Hex), signMessage: vi.fn(async () => '0x1234' as Hex) };
  const feed = { fetch: vi.fn(async () => [canonical]), report: vi.fn(async () => {}) };
  const clock = { now: 1_790_000_000_000 };
  const options = { config: { ...config }, store, gateway, signer, feed, now: () => clock.now };
  const engine = new KeeperEngine(options);
  return { store, gateway, signer, feed, engine, dir, options, clock, canonical };
}
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('keeper safety and crash recovery', () => {
  it('rejects another executor before signing or broadcasting', async () => {
    const f = fixture({ ...envelope, intent: { ...envelope.intent, executor: pool } });
    expect(await f.engine.tick()).toBe('IDLE');
    expect(f.signer.signTransaction).not.toHaveBeenCalled();
    expect(f.gateway.broadcast).not.toHaveBeenCalled();
  });
  it('never considers an account outside the locally approved account scope', async () => {
    const f = fixture({ ...envelope, intent: { ...envelope.intent, account: pool } });
    await f.engine.tick();
    expect(f.gateway.prepare).not.toHaveBeenCalled();
  });
  it('does not sign when independent preparation changes the destination', async () => {
    const f = fixture();
    vi.mocked(f.gateway.prepare).mockResolvedValue({ to: pool, data: '0x1234', value: 0n,
      chainId: 50383, prices: [1n, 1n], gasEstimate: 100n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
    await f.engine.tick();
    expect(f.signer.signTransaction).not.toHaveBeenCalled();
    expect(f.gateway.prepare).toHaveBeenCalledOnce();
  });
  it('persists signed bytes before any broadcast and recovers without re-signing', async () => {
    const f = fixture();
    vi.mocked(f.gateway.broadcast).mockImplementation(async raw => {
      expect(f.store.pending()?.rawTransaction).toBe(raw);
      throw new Error('connection interrupted');
    });
    expect(await f.engine.tick()).toBe('PREPARED');
    expect(f.store.pending()?.nonce).toBe(7);
    expect(f.signer.signTransaction).toHaveBeenCalledOnce();
    f.feed.fetch.mockRejectedValue(new Error('API offline'));
    vi.mocked(f.gateway.broadcast).mockImplementation(async raw => keccak256(raw));
    const restarted = new KeeperEngine(f.options);
    expect(await restarted.tick()).toBe('BROADCAST');
    expect(f.signer.signTransaction).toHaveBeenCalledOnce();
    expect(f.gateway.getPendingNonce).toHaveBeenCalledOnce();
  });
  it('survives a closed and reopened SQLite database', async () => {
    const f = fixture();
    await f.engine.tick();
    const pending = f.store.pending();
    f.store.close();
    const reopened = new KeeperStore(join(f.dir, 'keeper.sqlite'));
    stores.push(reopened);
    expect(reopened.pending()).toEqual(pending);
    f.feed.fetch.mockRejectedValue(new Error('API offline'));
    const restarted = new KeeperEngine({ ...f.options, store: reopened });
    await restarted.tick();
    expect(f.signer.signTransaction).toHaveBeenCalledOnce();
  });
  it('refuses changed calldata even when the target is the pinned router', async () => {
    const f = fixture();
    const original = await f.gateway.prepare(f.canonical);
    vi.mocked(f.gateway.prepare).mockResolvedValue({ ...original, data: '0x1234' });
    expect(await f.engine.tick()).toBe('IDLE');
    expect(f.signer.signTransaction).not.toHaveBeenCalled();
    expect(f.engine.lastError).toBe('UNSAFE_TRANSACTION');
  });
  it('refuses an altered chain id or nonzero native transfer', async () => {
    const f = fixture();
    const original = await f.gateway.prepare(f.canonical);
    vi.mocked(f.gateway.prepare).mockResolvedValue({ ...original, chainId: 1, value: 1n });
    await f.engine.tick();
    expect(f.signer.signTransaction).not.toHaveBeenCalled();
  });
  it('reserves worst-case gas with a 25 percent buffer and applies a daily limit', async () => {
    const f = fixture();
    f.options.config.maxDailyWei = 249n; // ceil(100 * 1.25) * 2 = 250.
    await f.engine.tick();
    expect(f.signer.signTransaction).not.toHaveBeenCalled();
    expect(f.engine.lastError).toBe('DAILY_BUDGET_EXCEEDED');
  });
  it('does not sign a second pending transaction for the same wallet', async () => {
    const f = fixture();
    await f.engine.tick();
    const other = { ...f.canonical, intent: { ...f.canonical.intent, nonce: '1' } };
    other.hash = keeperIntentHash(other.intent, config.chainId, router);
    f.feed.fetch.mockResolvedValue([other]);
    await f.engine.tick();
    expect(f.signer.signTransaction).toHaveBeenCalledOnce();
  });
  it('charges actual receipt cost once and waits for confirmations', async () => {
    const f = fixture();
    await f.engine.tick();
    vi.mocked(f.gateway.getReceipt).mockResolvedValue({ status: 'success', gasUsed: 60n,
      effectiveGasPrice: 2n, blockNumber: 10n, confirmations: 1 });
    expect(await f.engine.tick()).toBe('MINED');
    expect(await f.engine.tick()).toBe('MINED');
    expect(f.store.spend(new Date(f.clock.now).toISOString().slice(0, 10))).toBe(120n);
    vi.mocked(f.gateway.getReceipt).mockResolvedValue({ status: 'success', gasUsed: 60n,
      effectiveGasPrice: 2n, blockNumber: 10n, confirmations: 12 });
    expect(await f.engine.tick()).toBe('CONFIRMED');
    expect(f.store.pending()).toBeUndefined();
    expect(f.store.due(f.clock.now)).toHaveLength(0);
  });
  it('reverses provisional gas accounting when a mined receipt is reorged out', async () => {
    const f = fixture();
    await f.engine.tick();
    vi.mocked(f.gateway.getReceipt).mockResolvedValue({ status: 'success', gasUsed: 60n,
      effectiveGasPrice: 2n, blockNumber: 10n, confirmations: 1 });
    await f.engine.tick();
    vi.mocked(f.gateway.getReceipt).mockResolvedValue(undefined);
    await f.engine.tick();
    expect(f.store.spend(new Date(f.clock.now).toISOString().slice(0, 10))).toBe(0n);
    expect(f.store.pending()).toBeDefined();
    expect(f.signer.signTransaction).toHaveBeenCalledOnce();
  });
  it('rejects tampered intent hashes without chain calls', async () => {
    const f = fixture();
    f.feed.fetch.mockResolvedValue([{ ...f.canonical, hash }]);
    await f.engine.tick();
    expect(f.gateway.prepare).not.toHaveBeenCalled();
  });
  it('binds a durable database to a single signer and deployment', () => {
    const f = fixture();
    expect(() => new KeeperEngine({ ...f.options, signer: { ...f.signer, address: pool } })).toThrow('another deployment');
  });
});

describe('same-nonce fee replacement',()=>{
 it('bumps only identical execution calldata and accepts the original transaction if it wins',async()=>{
  const {privateKeyToAccount,generatePrivateKey}=await import('viem/accounts');
  const {parseTransaction}=await import('viem');
  const f=fixture(),key=privateKeyToAccount(generatePrivateKey());
  vi.mocked(f.signer.signTransaction).mockImplementation(async tx=>key.signTransaction({chainId:50383,to:tx.to,data:tx.data,value:0n,nonce:tx.nonce,gas:tx.gas,maxFeePerGas:tx.maxFeePerGas,maxPriorityFeePerGas:tx.maxPriorityFeePerGas,type:'eip1559'}));
  await f.engine.tick();const original=f.store.pending()!;
  f.clock.now+=121000;await f.engine.tick();const replacement=f.store.pending()!;
  expect(replacement.hash).not.toBe(original.hash);
  expect(replacement.nonce).toBe(original.nonce);
  const old=parseTransaction(original.rawTransaction),next=parseTransaction(replacement.rawTransaction);
  expect(next.data).toBe(old.data);expect(next.to).toBe(old.to);
  expect(next.maxFeePerGas!).toBeGreaterThan(old.maxFeePerGas!);
  vi.mocked(f.gateway.getReceipt).mockImplementation(async hash=>hash===original.hash?{status:'success',gasUsed:100n,effectiveGasPrice:2n,blockNumber:100n,confirmations:12}:undefined);
  expect(await f.engine.tick()).toBe('CONFIRMED');
  expect(f.store.pending()).toBeUndefined();
  expect(f.store.spend(new Date(f.clock.now).toISOString().slice(0,10))).toBe(200n);
 });
});

describe('replacement policy failure boundaries',()=>{
 it.each(['chain','calldata','destination','value','fee','priority','gas','budget','prepare failure'])('retains the original durable bytes when replacement violates %s policy',async reason=>{
  const {privateKeyToAccount,generatePrivateKey}=await import('viem/accounts');const key=privateKeyToAccount(generatePrivateKey()),f=fixture();
  vi.mocked(f.signer.signTransaction).mockImplementation(async tx=>key.signTransaction({chainId:tx.chainId,to:tx.to,data:tx.data,value:tx.value,nonce:tx.nonce,gas:tx.gas,maxFeePerGas:tx.maxFeePerGas,maxPriorityFeePerGas:tx.maxPriorityFeePerGas,type:'eip1559'}));
  await f.engine.tick();const original=f.store.pending()!,fresh=await f.gateway.prepare(f.canonical);
  if(reason==='chain')fresh.chainId=1;if(reason==='calldata')fresh.data='0x1234';if(reason==='destination')fresh.to=pool;if(reason==='value')fresh.value=1n;
  if(reason==='fee')fresh.maxFeePerGas=11n;if(reason==='priority')fresh.maxPriorityFeePerGas=11n;if(reason==='gas')fresh.gasEstimate=40_000_001n;
  if(reason==='budget')f.options.config.maxDailyWei=1n;
  if(reason==='prepare failure')vi.mocked(f.gateway.prepare).mockRejectedValue(new Error('RPC offline'));else vi.mocked(f.gateway.prepare).mockResolvedValue(fresh);
  f.clock.now+=121000;await f.engine.tick();expect(f.store.pending()?.hash).toBe(original.hash);expect(f.signer.signTransaction).toHaveBeenCalledOnce();expect(f.gateway.getPendingNonce).toHaveBeenCalledOnce();
  expect(vi.mocked(f.gateway.broadcast).mock.calls.at(-1)?.[0]).toBe(original.rawTransaction);
 });
});

describe('replacement receipt atomicity',()=>{
 it('retains the pending replacement if selecting the old winner fails during receipt storage',async()=>{
  const f=fixture();await f.engine.tick();const old=f.store.pending()!;
  const replacement={...old,hash:keccak256('0x0103'),rawTransaction:'0x0103' as Hex};f.store.replace(old,replacement,f.options.config.maxDailyWei);
  f.store.db.exec("CREATE TEMP TRIGGER receipt_fault BEFORE UPDATE OF actual_wei ON outbox BEGIN SELECT RAISE(ABORT,'injected storage failure'); END");
  expect(()=>f.store.receipt(old.hash,{status:'success',gasUsed:100n,effectiveGasPrice:2n,blockNumber:10n,confirmations:12},f.clock.now,true)).toThrow();
  expect(f.store.pending()?.hash).toBe(replacement.hash);expect(f.store.spend(new Date(f.clock.now).toISOString().slice(0,10))).toBe(0n);
 });
});

describe('receipt accounting across same-hash re-inclusion',()=>{
 it('adjusts the charged budget when canonical re-inclusion changes the effective gas price, and fully refunds on orphaning',async()=>{
  const f=fixture();await f.engine.tick();const pending=f.store.pending()!,day=new Date(f.clock.now).toISOString().slice(0,10);
  f.store.receipt(pending.hash,{status:'success',gasUsed:100n,effectiveGasPrice:2n,blockNumber:10n,confirmations:1},f.clock.now,false);expect(f.store.spend(day)).toBe(200n);
  f.clock.now+=86400000;
  f.store.receipt(pending.hash,{status:'success',gasUsed:100n,effectiveGasPrice:3n,blockNumber:11n,confirmations:2},f.clock.now,false);expect(f.store.spend(day)).toBe(300n);
  f.store.receipt(pending.hash,{status:'success',gasUsed:100n,effectiveGasPrice:3n,blockNumber:11n,confirmations:12},f.clock.now,true);expect(f.store.spend(day)).toBe(300n);
  f.store.unmine(pending.hash);expect(f.store.spend(day)).toBe(0n);expect(f.store.pending()?.hash).toBe(pending.hash);
 });
});

describe('keeper retry and durable queue boundaries',()=>{
 it('continues a previously signed cached intent when the API is unavailable',async()=>{const f=fixture();f.store.putIntent(f.canonical,f.clock.now);f.feed.fetch.mockRejectedValue(new Error('offline'));expect(await f.engine.tick()).toBe('PREPARED');expect(f.engine.metrics.feedFailures).toBe(1);expect(f.signer.signTransaction).toHaveBeenCalledOnce();});
 it('rejects malformed feed objects without blocking a later valid assignment',async()=>{const f=fixture();f.feed.fetch.mockResolvedValue([null,{...f.canonical,intent:{...f.canonical.intent,nonce:'bad'}},f.canonical] as unknown as SignedIntent[]);expect(await f.engine.tick()).toBe('PREPARED');expect(f.engine.metrics.failures).toBe(1);expect(f.signer.signTransaction).toHaveBeenCalledOnce();});
 it.each(['future','expired'])('does not prepare %s signed intents',async reason=>{const f=fixture({...envelope,intent:{...envelope.intent,...(reason==='future'?{validAfter:'1790000100'}:{validUntil:'1790000000'})}});expect(await f.engine.tick()).toBe('IDLE');expect(f.gateway.prepare).not.toHaveBeenCalled();expect(f.signer.signTransaction).not.toHaveBeenCalled();});
 it('coalesces concurrent ticks without asking for two nonces or signing twice',async()=>{const f=fixture();let release!:()=>void;f.feed.fetch.mockImplementation(()=>new Promise(resolve=>{release=()=>resolve([f.canonical]);}));const tick=f.engine.tick();expect(f.engine.isRunning).toBe(true);expect(await f.engine.tick()).toBe('BUSY');release();await tick;expect(f.engine.isRunning).toBe(false);expect(f.signer.signTransaction).toHaveBeenCalledOnce();});
 it('reopens a recently confirmed transaction after a reorg and rebroadcasts its original bytes',async()=>{const f=fixture();await f.engine.tick();const pending=f.store.pending()!,day=new Date(f.clock.now).toISOString().slice(0,10);vi.mocked(f.gateway.getReceipt).mockResolvedValue({status:'success',gasUsed:100n,effectiveGasPrice:2n,blockNumber:1n,confirmations:12});expect(await f.engine.tick()).toBe('CONFIRMED');expect(f.store.pending()).toBeUndefined();vi.mocked(f.gateway.getReceipt).mockResolvedValue(undefined);f.clock.now+=10001;expect(await f.engine.tick()).toBe('PREPARED');expect(f.store.pending()?.hash).toBe(pending.hash);expect(f.store.spend(day)).toBe(0n);expect(f.signer.signTransaction).toHaveBeenCalledOnce();});
 it('blocks duplicate pending enqueue and invalid replacements atomically',async()=>{const f=fixture();await f.engine.tick();const entry=f.store.pending()!,next={...entry,hash:keccak256('0x0103'),rawTransaction:'0x0103' as Hex};expect(()=>f.store.enqueue(next,f.options.config.maxDailyWei)).toThrow('pending');expect(()=>f.store.replace(entry,{...next,nonce:8},f.options.config.maxDailyWei)).toThrow('preserve');expect(()=>f.store.replace(entry,{...next,intentHash:hash},f.options.config.maxDailyWei)).toThrow('preserve');expect(()=>f.store.replace(entry,next,1n)).toThrow('budget');expect(f.store.pending()?.hash).toBe(entry.hash);});
 it('rejects receipts for unknown transactions and preserves the pending outbox after rollback',async()=>{const f=fixture();await f.engine.tick();const entry=f.store.pending()!;expect(()=>f.store.receipt(hash,{status:'success',gasUsed:1n,effectiveGasPrice:1n,blockNumber:1n,confirmations:1},f.clock.now,false)).toThrow('Unknown');expect(()=>f.store.unmine(hash)).toThrow('Unknown');expect(f.store.pending()?.hash).toBe(entry.hash);});
 it('charges a reverted transaction and requeues its intent after backoff',async()=>{const f=fixture();await f.engine.tick();vi.mocked(f.gateway.getReceipt).mockResolvedValue({status:'reverted',gasUsed:100n,effectiveGasPrice:2n,blockNumber:1n,confirmations:12});expect(await f.engine.tick()).toBe('CONFIRMED');expect(f.store.pending()).toBeUndefined();expect(f.store.due(f.clock.now)).toEqual([]);expect(f.store.due(f.clock.now+1000)[0]?.hash).toBe(f.canonical.hash);expect(f.store.spend(new Date(f.clock.now).toISOString().slice(0,10))).toBe(200n);});
});

describe('remaining engine policy and telemetry boundaries',()=>{
 it.each(['gas','priority','value'])('refuses unsafe initial %s before signing and nonce allocation',async reason=>{const f=fixture(),prepared=await f.gateway.prepare(f.canonical);if(reason==='gas')prepared.gasEstimate=f.options.config.maxGas;if(reason==='priority')prepared.maxPriorityFeePerGas=prepared.maxFeePerGas+1n;if(reason==='value')prepared.value=1n;vi.mocked(f.gateway.prepare).mockResolvedValue(prepared);await f.engine.tick();expect(f.signer.signTransaction).not.toHaveBeenCalled();expect(f.gateway.getPendingNonce).not.toHaveBeenCalled();expect(f.engine.lastError).toBe(reason==='gas'?'GAS_LIMIT_EXCEEDED':reason==='priority'?'GAS_PRICE_EXCEEDED':'UNSAFE_TRANSACTION');});
 it('quarantines a cached intent if local scope no longer permits its account',async()=>{const f=fixture();f.feed.fetch.mockResolvedValue([]);f.store.putIntent({...f.canonical,intent:{...f.canonical.intent,account:pool}},f.clock.now);await f.engine.tick();expect(f.gateway.prepare).not.toHaveBeenCalled();expect(f.store.due(f.clock.now+100000)).toEqual([]);});
 it('keeps broadcast and confirmation healthy when reporting to API fails',async()=>{const f=fixture();f.feed.report.mockRejectedValue(new Error('API unavailable'));vi.mocked(f.gateway.broadcast).mockImplementation(async raw=>keccak256(raw));expect(await f.engine.tick()).toBe('BROADCAST');expect(f.engine.lastHealthyAt).toBe(f.clock.now);expect(f.engine.lastError).toBeNull();expect(await f.engine.tick()).toBe('PENDING');vi.mocked(f.gateway.getReceipt).mockResolvedValue({status:'success',gasUsed:100n,effectiveGasPrice:2n,blockNumber:100n,confirmations:12});expect(await f.engine.tick()).toBe('CONFIRMED');expect(f.engine.metrics.confirmed).toBe(1);expect(f.feed.report).toHaveBeenCalledTimes(2);f.clock.now+=10001;expect(await f.engine.tick()).toBe('IDLE');expect(f.store.pending()).toBeUndefined();});
 it('uses wall time to expire cached signatures when no custom clock is provided',async()=>{const f=fixture({...envelope,intent:{...envelope.intent,validAfter:'1',validUntil:'2'}}),engine=new KeeperEngine({...f.options,now:undefined});expect(await engine.tick()).toBe('IDLE');expect(f.gateway.prepare).not.toHaveBeenCalled();});
});
