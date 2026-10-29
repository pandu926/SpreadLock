import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Hex} from 'viem';
import {compatibilityReady,type ReadinessOptions} from '../src/readiness.js';
import type {Header} from '../src/types.js';

const url=process.env.TEST_DATABASE_URL;
const schema=`readiness_${randomUUID().replaceAll('-','')}`;
const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const block=(number:bigint,timestamp=1000n):Header=>({number,hash:hash(Number(number)+1),parentHash:hash(Number(number)),timestamp});
describe.skipIf(!url)('PostgreSQL entry readiness snapshot',()=>{
  let admin:Pool,pool:Pool,options:ReadinessOptions;
  beforeAll(async()=>{
    admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString:url,options:`-c search_path=${schema},public`});
    await pool.query(await readFile('apps/indexer/sql/0001_canonical_chain.sql','utf8'));
  });
  beforeEach(async()=>{
    await pool.query('TRUNCATE chain_checkpoints,chain_blocks,chain_incidents');
    await pool.query('INSERT INTO chain_blocks(chain_id,number,hash,parent_hash,timestamp,canonical) VALUES(50383,100,$1,$2,1000,true)',[hash(101),hash(100)]);
    await pool.query('INSERT INTO chain_checkpoints(chain_id,number,hash) VALUES(50383,100,$1)',[hash(101)]);
    options={confirmations:12,now:()=>1_000_000,rpc:{chainId:vi.fn(async()=>50383),head:vi.fn(async()=>100n),block:vi.fn(async n=>block(n))}};
  });
  afterAll(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}});
  it('returns lag metrics from the current canonical checkpoint',async()=>{
    expect(await compatibilityReady(pool,50383,options)).toMatchObject({ready:true,reasons:[],metrics:{checkpointBlock:'100',headBlock:'100',lagBlocks:'0',lagSeconds:'0'}});
  });
  it('rejects fresh heartbeat with large block backfill lag',async()=>{
    vi.mocked(options.rpc.head).mockResolvedValue(177n);
    expect((await compatibilityReady(pool,50383,options)).reasons).toContain('INDEXER_BLOCK_LAG');
  });
  it('rejects small block lag with old checkpoint time',async()=>{
    await pool.query('UPDATE chain_blocks SET timestamp=969 WHERE number=100');
    vi.mocked(options.rpc.head).mockResolvedValue(101n);vi.mocked(options.rpc.block).mockImplementation(async n=>block(n,n===100n?969n:1000n));
    expect((await compatibilityReady(pool,50383,options)).reasons).toContain('INDEXER_TIME_LAG');
  });
  it('rejects stale heartbeat even when indexed chain position agrees',async()=>{
    await pool.query("UPDATE chain_checkpoints SET updated_at=now()-interval '61 seconds'");
    expect((await compatibilityReady(pool,50383,options)).reasons).toContain('INDEXER_NOT_INITIALIZED');
  });
  it('includes only this chain unresolved compatibility incidents',async()=>{
    await pool.query(`INSERT INTO chain_incidents(chain_id,kind,details,resolved_at) VALUES
      (50383,'IMPLEMENTATION_CHANGED','{}',NULL),(50383,'DEEP_REORG','{}',now()),(1,'DEEP_REORG','{}',NULL)`);
    expect((await compatibilityReady(pool,50383,options)).reasons).toEqual(['IMPLEMENTATION_CHANGED']);
    await pool.query('UPDATE chain_incidents SET resolved_at=now()');
    expect((await compatibilityReady(pool,50383,options)).ready).toBe(true);
  });
  it('rejects absent checkpoint instead of using another chain checkpoint',async()=>{
    expect((await compatibilityReady(pool,1,{...options,rpc:{...options.rpc,chainId:async()=>1}})).reasons).toEqual(['INDEXER_NOT_INITIALIZED']);
  });
  it('rejects checkpoint whose header is absent or noncanonical',async()=>{
    await pool.query('UPDATE chain_blocks SET canonical=false');
    expect((await compatibilityReady(pool,50383,options)).reasons).toEqual(['INDEXER_NOT_INITIALIZED']);
  });
  it('rejects reorg mismatch even when both stores have fresh timestamps',async()=>{
    vi.mocked(options.rpc.block).mockImplementation(async n=>({...block(n),hash:hash(999)}));
    expect((await compatibilityReady(pool,50383,options)).reasons).toEqual(['CHECKPOINT_NOT_CANONICAL']);
  });
});
