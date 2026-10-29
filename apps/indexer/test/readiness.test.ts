import {describe,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import type {Hex} from 'viem';
import {compatibilityReady} from '../src/readiness.js';
import type {ChainClient,Header} from '../src/types.js';

const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const header=(number:bigint,timestamp=1000n):Header=>({number,hash:hash(Number(number)+1),parentHash:hash(Number(number)),timestamp});
function fixture(){
  const snapshot={number:'100',hash:hash(101),timestamp:'1000',heartbeat_age_seconds:'0',incident_kinds:[] as string[]};
  const query=vi.fn(async(sql:string):Promise<{rows:Record<string,unknown>[];rowCount:number}>=>{
    if(sql.includes('to_regclass'))return{rows:[{checkpoints:'chain_checkpoints',incidents:'chain_incidents',blocks:'chain_blocks'}],rowCount:1};
    if(sql.trim().startsWith('SELECT DISTINCT kind'))return{rows:snapshot.incident_kinds.map(kind=>({kind})),rowCount:snapshot.incident_kinds.length};
    return{rows:[snapshot],rowCount:1};
  });
  const rpc:Pick<ChainClient,'chainId'|'head'|'block'>={chainId:vi.fn(async()=>50383),head:vi.fn(async()=>100n),block:vi.fn(async n=>header(n))};
  return{snapshot,query,pool:{query} as unknown as Pool,rpc,options:{rpc,confirmations:12,now:()=>1_000_000}};
}

describe('entry readiness uses canonical chain progress',()=>{
  it('rejects a fresh heartbeat while block backfill is behind the head',async()=>{
    const f=fixture();vi.mocked(f.rpc.head).mockResolvedValue(177n);
    expect(await compatibilityReady(f.pool,50383,f.options)).toMatchObject({ready:false,reasons:['INDEXER_BLOCK_LAG']});
  });
  it('rejects stale indexed time even when block distance remains small',async()=>{
    const f=fixture();f.snapshot.timestamp='969';
    vi.mocked(f.rpc.block).mockImplementation(async n=>header(n,n===100n?969n:1000n));vi.mocked(f.rpc.head).mockResolvedValue(101n);
    expect((await compatibilityReady(f.pool,50383,f.options)).reasons).toContain('INDEXER_TIME_LAG');
  });
  it('accepts exact block, time and heartbeat limits and exposes measured values',async()=>{
    const f=fixture();f.snapshot.timestamp='970';f.snapshot.heartbeat_age_seconds='60';
    vi.mocked(f.rpc.head).mockResolvedValue(176n);vi.mocked(f.rpc.block).mockImplementation(async n=>header(n,n===100n?970n:1000n));
    expect(await compatibilityReady(f.pool,50383,f.options)).toEqual({ready:true,reasons:[],metrics:{headBlock:'176',checkpointBlock:'100',lagBlocks:'76',lagSeconds:'30',heartbeatAgeSeconds:60}});
  });
  it('rejects heartbeat just past the limit',async()=>{
    const f=fixture();f.snapshot.heartbeat_age_seconds='60.001';
    expect((await compatibilityReady(f.pool,50383,f.options)).reasons).toContain('INDEXER_NOT_INITIALIZED');
  });
  it('rejects a future database heartbeat',async()=>{
    const f=fixture();f.snapshot.heartbeat_age_seconds='-1';
    expect((await compatibilityReady(f.pool,50383,f.options)).ready).toBe(false);
  });
  it('fails closed when no head RPC is supplied',async()=>{
    const f=fixture();expect((await compatibilityReady(f.pool,50383)).reasons).toContain('HEAD_UNAVAILABLE');
  });
  it('fails closed when RPC chain differs from manifest',async()=>{
    const f=fixture();vi.mocked(f.rpc.chainId).mockResolvedValue(1);
    expect((await compatibilityReady(f.pool,50383,f.options)).reasons).toContain('CHAIN_MISMATCH');expect(f.rpc.head).not.toHaveBeenCalled();
  });
  it.each(['chainId','head','block'] as const)('fails closed when RPC %s fails',async method=>{
    const f=fixture();vi.mocked(f.rpc[method]).mockRejectedValue(new Error('private RPC credentials should never appear'));
    const result=await compatibilityReady(f.pool,50383,f.options);expect(result.reasons).toContain('HEAD_UNAVAILABLE');expect(JSON.stringify(result)).not.toContain('credentials');
  });
  it('rejects head behind the durable checkpoint',async()=>{
    const f=fixture();vi.mocked(f.rpc.head).mockResolvedValue(99n);
    expect((await compatibilityReady(f.pool,50383,f.options)).reasons).toContain('RPC_BEHIND_CHECKPOINT');
  });
  it('rejects a checkpoint that is no longer canonical',async()=>{
    const f=fixture();f.snapshot.hash=hash(999);
    expect((await compatibilityReady(f.pool,50383,f.options)).reasons).toContain('CHECKPOINT_NOT_CANONICAL');
  });
  it('rejects checkpoint timestamp mismatch with canonical RPC header',async()=>{
    const f=fixture();f.snapshot.timestamp='999';
    expect((await compatibilityReady(f.pool,50383,f.options)).reasons).toContain('CHECKPOINT_NOT_CANONICAL');
  });
  it('rejects a reorg while checking the head and checkpoint',async()=>{
    const f=fixture();vi.mocked(f.rpc.head).mockResolvedValue(101n);let calls=0;
    vi.mocked(f.rpc.block).mockImplementation(async n=>n===101n&&++calls===2?{...header(n),hash:hash(999)}:header(n));
    expect((await compatibilityReady(f.pool,50383,f.options)).reasons).toContain('HEAD_CHANGED');
  });
  it('rejects an old RPC head even when database and RPC agree',async()=>{
    const f=fixture();f.options.now=()=>1_031_000;
    expect((await compatibilityReady(f.pool,50383,f.options)).reasons).toContain('HEAD_STALE');
  });
  it('rejects head too far in the future',async()=>{
    const f=fixture();f.options.now=()=>994_000;
    expect((await compatibilityReady(f.pool,50383,f.options)).reasons).toContain('HEAD_TIME_INVALID');
  });
  it('accepts genesis and a chain shorter than confirmation depth',async()=>{
    const f=fixture();f.snapshot.number='0';f.snapshot.hash=hash(1);vi.mocked(f.rpc.head).mockResolvedValue(0n);
    expect((await compatibilityReady(f.pool,50383,f.options)).ready).toBe(true);
  });
  it('preserves unresolved incident reasons while head verification fails',async()=>{
    const f=fixture();f.snapshot.incident_kinds=['IMPLEMENTATION_CHANGED','DEEP_REORG'];vi.mocked(f.rpc.head).mockRejectedValue(new Error('offline'));
    expect((await compatibilityReady(f.pool,50383,f.options)).reasons).toEqual(['IMPLEMENTATION_CHANGED','DEEP_REORG','HEAD_UNAVAILABLE']);
  });
  it('fails closed before querying absent indexer tables',async()=>{
    const f=fixture();f.query.mockReset().mockResolvedValue({rows:[{}],rowCount:1});
    expect((await compatibilityReady(f.pool,50383,f.options)).reasons).toEqual(['INDEXER_NOT_INITIALIZED']);expect(f.rpc.chainId).not.toHaveBeenCalled();
  });
  it('fails closed when database is unavailable without exposing details',async()=>{
    const f=fixture();f.query.mockReset().mockRejectedValue(new Error('password=secret'));
    const result=await compatibilityReady(f.pool,50383,f.options);expect(result.reasons).toEqual(['INDEXER_UNAVAILABLE']);expect(JSON.stringify(result)).not.toContain('secret');
  });
  it.each([{number:null},{hash:null},{timestamp:null},{heartbeat_age_seconds:null},{number:'-1'},{heartbeat_age_seconds:'NaN'}])('fails closed for incomplete or invalid checkpoint %j',async override=>{
    const f=fixture();Object.assign(f.snapshot,override);
    expect((await compatibilityReady(f.pool,50383,f.options)).reasons).toContain('INDEXER_NOT_INITIALIZED');
  });
  it.each([0,257,1.5,NaN])('rejects invalid confirmation policy %s',async confirmations=>{
    const f=fixture();expect((await compatibilityReady(f.pool,50383,{...f.options,confirmations})).reasons).toContain('READINESS_CONFIGURATION_INVALID');
  });
  it('rejects an RPC header for a different requested height',async()=>{
    const f=fixture();vi.mocked(f.rpc.block).mockResolvedValue(header(101n));
    expect((await compatibilityReady(f.pool,50383,f.options)).reasons).toContain('HEAD_UNAVAILABLE');
  });
  it('rejects impossible timestamp ordering',async()=>{
    const f=fixture();vi.mocked(f.rpc.head).mockResolvedValue(101n);f.snapshot.timestamp='1001';vi.mocked(f.rpc.block).mockImplementation(async n=>header(n,n===100n?1001n:1000n));
    expect((await compatibilityReady(f.pool,50383,f.options)).reasons).toContain('HEAD_TIME_INVALID');
  });
});
