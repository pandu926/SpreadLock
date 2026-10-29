import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Address, type Hex } from 'viem';
import { CanonicalIndexer } from '../src/engine.js';
import type { ChainClient, ChainLog, Checkpoint, DecodedLog, Header, IndexerStore, WatchedAddress } from '../src/types.js';

const address = '0x0000000000000000000000000000000000000011' as Address;
const account = '0x0000000000000000000000000000000000000022' as Address;
const owner = '0x0000000000000000000000000000000000000033' as Address;
const h = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const header = (n: number, version = 0): Header => ({ number: BigInt(n), hash: h(n + version * 1000), parentHash: h(n - 1 + (n > 1 ? version * 1000 : 0)), timestamp: BigInt(100 + n) });
const creationAbi = parseAbi(['event AccountCreated(address indexed owner,address indexed account,bytes32 indexed salt)']);
class MemoryStore implements IndexerStore {
  headers = new Map<bigint, Header>(); rows: DecodedLog[] = []; cursor: Checkpoint | null = null;
  known: WatchedAddress[] = []; rollbackCalls: bigint[] = []; incidents: string[] = []; confirmed = -1n;
  async checkpoint() { return this.cursor; }
  async block(_chain: number, n: bigint) { return this.headers.get(n) ?? null; }
  async initialize(_chain: number, b: Header) { this.headers.set(b.number, b); this.cursor = { number: b.number, hash: b.hash }; }
  async watched() { return this.known; }
  async append(_chain: number, b: Header, rows: DecodedLog[]) {
    this.headers.set(b.number, b); this.rows.push(...rows); this.cursor = { number: b.number, hash: b.hash };
    for (const row of rows) if (row.eventName === 'AccountCreated') this.known.push({ address: row.args!.account as Address, role: 'account' });
  }
  async rollback(_chain: number, to: bigint) {
    this.rollbackCalls.push(to); for (const n of this.headers.keys()) if (n > to) this.headers.delete(n);
    this.rows = this.rows.filter(r => r.blockNumber <= to); const b = this.headers.get(to)!; this.cursor = { number: to, hash: b.hash };
  }
  async confirm(_chain: number, n: bigint) { this.confirmed = n; }
  async incident(_chain: number, kind: string) { this.incidents.push(kind); }
}
class FakeRpc implements ChainClient {
  blocks = new Map<bigint, Header>([0, 1, 2, 3].map(n => [BigInt(n), header(n)]));
  allLogs: ChainLog[] = []; queries: Address[][] = [];
  async chainId() { return 50383; }
  async head() { return 3n; }
  async block(n: bigint) { const b = this.blocks.get(n); if (!b) throw new Error('missing block'); return b; }
  async logs(from: bigint, to: bigint, addresses: Address[]) { this.queries.push(addresses); return this.allLogs.filter(l => l.blockNumber >= from && l.blockNumber <= to && addresses.includes(l.address)); }
  async receipt() { return { status: 'success' }; }
}
describe('canonical indexer', () => {
  it('backfills a bounded range, commits a durable checkpoint and is idempotent on restart', async () => {
    const rpc = new FakeRpc(); const store = new MemoryStore();
    const indexer = new CanonicalIndexer({ chainId: 50383, startBlock: 1n, addresses: [{ address, role: 'factory' }], confirmations: 1 }, rpc, store);
    expect((await indexer.tick()).blocks).toBe(3); expect(store.cursor?.number).toBe(3n);
    expect((await indexer.tick()).blocks).toBe(0); expect(store.confirmed).toBe(2n);
  });
  it('rewinds an orphaned suffix to its actual common ancestor', async () => {
    const rpc = new FakeRpc(); const store = new MemoryStore();
    const indexer = new CanonicalIndexer({ chainId: 50383, startBlock: 1n, addresses: [] }, rpc, store);
    await indexer.tick(); rpc.blocks.set(2n, { ...header(2, 1), parentHash: h(1) }); rpc.blocks.set(3n, header(3, 1));
    expect((await indexer.tick()).reorg).toBe(true); expect(store.rollbackCalls).toEqual([1n]); expect(store.cursor?.hash).toBe(h(1003));
  });
  it('discovers new accounts inside the same backfill chunk and fetches their logs', async () => {
    const rpc = new FakeRpc(); const store = new MemoryStore();
    rpc.allLogs = [{ address, blockNumber: 1n, blockHash: h(1), transactionHash: h(44), logIndex: 0,
      topics: encodeEventTopics({ abi: creationAbi, eventName: 'AccountCreated', args: { owner, account, salt: h(5) } }) as `0x${string}`[], data: '0x' },
    { address: account, blockNumber: 2n, blockHash: h(2), transactionHash: h(45), logIndex: 0, topics: [h(999)], data: '0x' }];
    const indexer = new CanonicalIndexer({ chainId: 50383, startBlock: 1n, addresses: [{ address, role: 'factory' }] }, rpc, store);
    await indexer.tick(); expect(rpc.queries.some(q => q.includes(account))).toBe(true);
    expect(store.rows).toHaveLength(2); expect(store.rows[1]?.eventName).toBeNull();
  });
  it('rejects the wrong chain before writing any checkpoint', async () => {
    const rpc = new FakeRpc(); rpc.chainId = async () => 1; const store = new MemoryStore();
    const indexer = new CanonicalIndexer({ chainId: 50383, startBlock: 1n, addresses: [] }, rpc, store);
    await expect(indexer.tick()).rejects.toThrow(/chain/i); expect(store.cursor).toBeNull();
  });
  it('stops on a reorg deeper than the configured recovery window', async () => {
    const rpc = new FakeRpc(); const store = new MemoryStore();
    const indexer = new CanonicalIndexer({ chainId: 50383, startBlock: 1n, addresses: [], reorgDepth: 1 }, rpc, store);
    await indexer.tick(); rpc.blocks.set(2n, { ...header(2, 1), parentHash: h(1) }); rpc.blocks.set(3n, header(3, 1));
    await expect(indexer.tick()).rejects.toThrow(/reorg/i); expect(store.incidents).toContain('DEEP_REORG');
  });
  it('does not initialize while the chain has not reached the deployment block',async()=>{
    const rpc=new FakeRpc(),store=new MemoryStore();const indexer=new CanonicalIndexer({chainId:50383,startBlock:4n,addresses:[]},rpc,store);
    expect((await indexer.tick()).blocks).toBe(0);expect(store.cursor).toBeNull();
  });
  it('rejects an RPC behind the durable checkpoint without rewinding evidence',async()=>{
    const rpc=new FakeRpc(),store=new MemoryStore();const indexer=new CanonicalIndexer({chainId:50383,startBlock:1n,addresses:[]},rpc,store);await indexer.tick();rpc.head=async()=>2n;
    await expect(indexer.tick()).rejects.toThrow('behind');expect(store.rollbackCalls).toEqual([]);expect(store.cursor?.number).toBe(3n);
  });
  it('releases its busy guard after failed RPC calls and prevents overlapping ticks',async()=>{
    const rpc=new FakeRpc(),store=new MemoryStore();let release!:()=>void;rpc.head=()=>new Promise(resolve=>{release=()=>resolve(3n);});
    const indexer=new CanonicalIndexer({chainId:50383,startBlock:1n,addresses:[]},rpc,store);const first=indexer.tick();await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    await expect(indexer.tick()).rejects.toThrow('already running');release();await first;rpc.head=async()=>{throw new Error('offline');};await expect(indexer.tick()).rejects.toThrow('offline');rpc.head=async()=>3n;expect((await indexer.tick()).blocks).toBe(0);
  });
  it('bounds chunk work and rejects a parent change before appending the inconsistent suffix',async()=>{
    const rpc=new FakeRpc(),store=new MemoryStore();const indexer=new CanonicalIndexer({chainId:50383,startBlock:1n,addresses:[],chunkSize:1},rpc,store);expect((await indexer.tick()).blocks).toBe(1);
    rpc.blocks.set(2n,{...header(2),parentHash:h(99)});await expect(indexer.tick()).rejects.toThrow('Chain moved');expect(store.cursor?.number).toBe(1n);
  });
  it('does not append logs that disagree with the canonical header',async()=>{
    const rpc=new FakeRpc(),store=new MemoryStore();rpc.allLogs=[{address,blockNumber:1n,blockHash:h(99),transactionHash:h(44),logIndex:0,topics:[],data:'0x'}];
    await expect(new CanonicalIndexer({chainId:50383,startBlock:1n,addresses:[{address,role:'router'}]},rpc,store).tick()).rejects.toThrow('Log block hash');expect(store.cursor?.number).toBe(0n);
  });
  it.each(['missing adapter','changed code'])('halts on a fingerprint failure: %s',async reason=>{
    const rpc:ChainClient=new FakeRpc(),store=new MemoryStore();if(reason==='changed code')rpc.codeHash=async()=>h(2);
    const indexer=new CanonicalIndexer({chainId:50383,startBlock:1n,addresses:[],expectedCodeHashes:{[address]:h(1)}},rpc,store);
    await expect(indexer.tick()).rejects.toThrow(/fingerprint/i);expect(store.cursor).toBeNull();expect(store.incidents).toEqual(reason==='changed code'?['IMPLEMENTATION_CHANGED']:[]);
  });
  it.each(['block','transaction','status'])('rejects inconsistent execution receipt %s before committing financial state',async mismatch=>{
    const rpc=new FakeRpc(),store=new MemoryStore();const abi=parseAbi(['event IntentExecuted(bytes32 indexed intentHash,address indexed account,address indexed executor,uint256 nonce,uint256 epoch,uint256 revision,int256 guaranteedNetQuote)']);
    rpc.allLogs=[{address,blockNumber:1n,blockHash:h(1),transactionHash:h(44),logIndex:0,topics:encodeEventTopics({abi,eventName:'IntentExecuted',args:{intentHash:h(55),account,executor:owner}}) as Hex[],data:encodeAbiParameters([{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'int256'}],[0n,0n,1n,0n])}];
    rpc.receipt=async()=>({blockHash:mismatch==='block'?h(9):h(1),transactionHash:mismatch==='transaction'?h(45):h(44),status:mismatch==='status'?'reverted':'success'});
    await expect(new CanonicalIndexer({chainId:50383,startBlock:1n,addresses:[{address,role:'router'}]},rpc,store).tick()).rejects.toThrow(/Receipt/i);expect(store.cursor?.number).toBe(0n);expect(store.rows).toEqual([]);
  });

  it('bounds concurrent header retrieval and batches address filters while checking matching fingerprints',async()=>{
    const rpc=new FakeRpc(),store=new MemoryStore();for(let n=4;n<=33;n++)rpc.blocks.set(BigInt(n),header(n));rpc.head=async()=>33n;
    const original=rpc.block.bind(rpc);let active=0,maxActive=0;rpc.block=async n=>{active++;maxActive=Math.max(active,maxActive);await Promise.resolve();const result=await original(n);active--;return result;};
    const typed:ChainClient=rpc;typed.codeHash=async()=>h(1);
    const addresses=Array.from({length:101},(_,n)=>({address:`0x${(n+1).toString(16).padStart(40,'0')}` as Address,role:'pool' as const}));
    const indexer=new CanonicalIndexer({chainId:50383,startBlock:1n,addresses,expectedCodeHashes:{[address]:h(1)}},rpc,store);
    expect((await indexer.tick()).blocks).toBe(33);expect(maxActive).toBe(16);expect(rpc.queries.map(q=>q.length)).toEqual([100,1]);expect(store.incidents).toEqual([]);
  });
  it('catches up in bounded chunks while reading a fresh head for each tick',async()=>{
    const rpc=new FakeRpc(),store=new MemoryStore();for(let n=0;n<=520;n++)rpc.blocks.set(BigInt(n),header(n));
    let head=510n;rpc.head=vi.fn(async()=>head);const blockRequests:bigint[]=[];const original=rpc.block.bind(rpc);
    rpc.block=async n=>{blockRequests.push(n);return original(n);};
    const indexer=new CanonicalIndexer({chainId:50383,startBlock:1n,addresses:[],chunkSize:500},rpc,store);
    expect(await indexer.tick()).toMatchObject({head:510n,indexed:500n,blocks:500});
    head=520n;expect(await indexer.tick()).toMatchObject({head:520n,indexed:520n,blocks:20});expect(rpc.head).toHaveBeenCalledTimes(2);
    expect([...store.headers.keys()]).toEqual(Array.from({length:521},(_,n)=>BigInt(n)));
    expect(blockRequests.filter(n=>n>0n&&n!==500n)).toHaveLength(519);
  });
  it.each([1,16,64])('retrieves every header with configured concurrency bounded at %i',async headerConcurrency=>{
    const rpc=new FakeRpc(),store=new MemoryStore();for(let n=0;n<=129;n++)rpc.blocks.set(BigInt(n),header(n));rpc.head=async()=>129n;
    let active=0,maximum=0;const requests:bigint[]=[];const original=rpc.block.bind(rpc);
    rpc.block=async n=>{active++;maximum=Math.max(maximum,active);requests.push(n);await Promise.resolve();try{return await original(n);}finally{active--;}};
    const result=await new CanonicalIndexer({chainId:50383,startBlock:1n,addresses:[],headerConcurrency},rpc,store).tick();
    expect(maximum).toBe(headerConcurrency);expect(result.blocks).toBe(129);expect([...store.headers.keys()]).toEqual(Array.from({length:130},(_,n)=>BigInt(n)));
    expect(requests.filter(n=>n>0n)).toEqual(Array.from({length:129},(_,n)=>BigInt(n+1)));expect(active).toBe(0);
  });
  it.each([0,65,NaN,1.5,-1,Infinity])('rejects unsafe header concurrency %s before any RPC or persistence',headerConcurrency=>{
    const rpc=new FakeRpc(),store=new MemoryStore();rpc.chainId=vi.fn(async()=>50383);
    expect(()=>new CanonicalIndexer({chainId:50383,startBlock:1n,addresses:[],headerConcurrency},rpc,store)).toThrow('headerConcurrency');
    expect(rpc.chainId).not.toHaveBeenCalled();expect(store.cursor).toBeNull();
  });

  it.each([1,12,256])('rebuilds a %i-block canonical suffix to the same state as a clean replay',async depth=>{
    const tip=300,ancestor=tip-depth;const rpc=new FakeRpc(),store=new MemoryStore();
    for(let n=0;n<=tip;n++)rpc.blocks.set(BigInt(n),header(n));rpc.head=async()=>BigInt(tip);
    const logAt=(n:number,version=0):ChainLog=>({address,blockNumber:BigInt(n),blockHash:h(n+version*1000),transactionHash:h(5000+n+version*1000),logIndex:0,topics:[h(999)],data:'0x'});
    rpc.allLogs=[logAt(1),logAt(tip)];const config={chainId:50383,startBlock:1n,addresses:[{address,role:'pool' as const}],reorgDepth:256,headerConcurrency:64};
    const indexer=new CanonicalIndexer(config,rpc,store);await indexer.tick();
    for(let n=ancestor+1;n<=tip;n++)rpc.blocks.set(BigInt(n),{...header(n,1),parentHash:n===ancestor+1?h(ancestor):h(n-1+1000)});
    rpc.allLogs=[logAt(1),logAt(tip,1)];const result=await indexer.tick();
    expect(result.reorg).toBe(true);expect(store.rollbackCalls).toEqual([BigInt(ancestor)]);expect(store.incidents).toEqual([]);
    const replay=new MemoryStore();await new CanonicalIndexer(config,rpc,replay).tick();
    expect(store.cursor).toEqual(replay.cursor);expect(store.rows).toEqual(replay.rows);expect([...store.headers]).toEqual([...replay.headers]);expect(store.confirmed).toBe(replay.confirmed);
  });
  it('halts without deleting history when a 257-block reorg exceeds the recovery window',async()=>{
    const rpc=new FakeRpc(),store=new MemoryStore();for(let n=0;n<=300;n++)rpc.blocks.set(BigInt(n),header(n));rpc.head=async()=>300n;
    const indexer=new CanonicalIndexer({chainId:50383,startBlock:1n,addresses:[],reorgDepth:256},rpc,store);await indexer.tick();
    for(let n=44;n<=300;n++)rpc.blocks.set(BigInt(n),{...header(n,1),parentHash:n===44?h(43):h(n-1+1000)});
    await expect(indexer.tick()).rejects.toThrow('exceeds 256');expect(store.rollbackCalls).toEqual([]);expect(store.incidents).toEqual(['DEEP_REORG']);expect(store.cursor?.hash).toBe(h(300));
  });
  it('initializes at genesis without skipping the first post-genesis block',async()=>{
    const rpc=new FakeRpc(),store=new MemoryStore();const result=await new CanonicalIndexer({chainId:50383,startBlock:0n,addresses:[]},rpc,store).tick();
    expect(store.headers.get(0n)?.hash).toBe(h(0));expect(result.blocks).toBe(3);expect(store.cursor?.number).toBe(3n);
  });
  it('commits successful execution receipt evidence and removes duplicate raw events before accounting',async()=>{
    const rpc=new FakeRpc(),store=new MemoryStore();const abi=parseAbi(['event IntentExecuted(bytes32 indexed intentHash,address indexed account,address indexed executor,uint256 nonce,uint256 epoch,uint256 revision,int256 guaranteedNetQuote)']);
    const event:ChainLog={address,blockNumber:1n,blockHash:h(1),transactionHash:h(44),logIndex:0,topics:encodeEventTopics({abi,eventName:'IntentExecuted',args:{intentHash:h(55),account,executor:owner}}) as Hex[],data:encodeAbiParameters([{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'int256'}],[0n,0n,1n,0n])};
    rpc.allLogs=[event,event];rpc.receipt=vi.fn(async()=>({blockHash:h(1),transactionHash:h(44),status:'success'}));
    expect((await new CanonicalIndexer({chainId:50383,startBlock:1n,addresses:[{address,role:'router'}]},rpc,store).tick()).logs).toBe(1);
    expect(rpc.receipt).toHaveBeenCalledTimes(1);expect(store.rows[0]?.receipt).toEqual({blockHash:h(1),transactionHash:h(44),status:'success'});
  });
  it('orders financial logs by block and log index before durable append',async()=>{
    const rpc=new FakeRpc(),store=new MemoryStore();rpc.allLogs=[3,1,2].flatMap(n=>[2,0,1].map(logIndex=>({address,blockNumber:BigInt(n),blockHash:h(n),transactionHash:h(44+n),logIndex,topics:[h(999)],data:'0x' as Hex})));
    await new CanonicalIndexer({chainId:50383,startBlock:1n,addresses:[{address,role:'pool'}]},rpc,store).tick();
    expect(store.rows.map(r=>[r.blockNumber,r.logIndex])).toEqual([1n,2n,3n].flatMap(n=>[0,1,2].map(i=>[n,i])));
  });

});
