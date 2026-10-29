import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import type {Hex} from 'viem';
import {PgStore} from './pg-store.js';
import {migrate} from './migrate.js';
import {PgIndexerStore} from '../../../apps/indexer/src/pg-store.js';
import type {DecodedLog,Header} from '../../../apps/indexer/src/types.js';

const database=process.env.TEST_DATABASE_URL;
const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const owner='0x1111111111111111111111111111111111111111' as const;
const account='0x2222222222222222222222222222222222222222' as const;
const header=(n:number):Header=>({number:BigInt(n),hash:hash(n),parentHash:hash(n-1),timestamp:BigInt(1000+n)});
describe.skipIf(!database)('canonical execution versus HTTP cancellation races',()=>{
  const schema=`cancel_race_${randomUUID().replaceAll('-','')}`;
  let admin:Pool,store:PgStore,indexer:PgIndexerStore;
  const execution:DecodedLog={address:account,blockNumber:1n,blockHash:hash(1),transactionHash:hash(99),logIndex:0,topics:[],data:'0x',eventName:'IntentExecuted',args:{intentHash:hash(55),account,executor:owner,nonce:1n,epoch:0n,revision:1n,guaranteedNetQuote:0n},receipt:{status:'success',blockHash:hash(1),transactionHash:hash(99)}};
  beforeAll(async()=>{
    admin=new Pool({connectionString:database});await admin.query(`CREATE SCHEMA ${schema}`);
    const url=new URL(database!);url.searchParams.set('options',`-c search_path=${schema}`);
    store=new PgStore(url.toString());await migrate(store.pool);indexer=new PgIndexerStore(store.pool);await indexer.migrate();
  });
  beforeEach(async()=>{
    await store.pool.query('TRUNCATE app_executions,app_intents,chain_blocks,chain_checkpoints,chain_logs,chain_projection_journal');
    await store.putIntent({id:hash(55),owner,account,executor:owner,chainId:50383,body:{nonce:'1',epoch:'0'},signature:'0x',status:'ELIGIBLE',createdAt:Date.now(),updatedAt:Date.now()});
    await indexer.initialize(50383,header(0));
  });
  afterAll(async()=>{await store?.close();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}});
  it('rejects HTTP cancellation after MINED so later confirmation reaches the intent',async()=>{
    await indexer.append(50383,header(1),[execution]);expect((await store.getIntent(hash(55)))?.status).toBe('MINED');
    const cancellation=await store.requestCancellation(hash(55),owner,Date.now());
    await indexer.confirm(50383,1n);await indexer.confirm(50383,1n);
    expect((await store.getIntent(hash(55)))?.status).toBe('CONFIRMED');
    expect((await store.listExecutions(owner,50383,account,undefined,10))[0]?.status).toBe('CONFIRMED');
    expect(cancellation).toBeNull();
  });
  it('preserves earlier cancellation across an execution that wins then becomes orphaned',async()=>{
    expect((await store.requestCancellation(hash(55),owner,Date.now()))?.status).toBe('CANCEL_REQUESTED');
    await indexer.append(50383,header(1),[execution]);await indexer.confirm(50383,1n);
    expect((await store.getIntent(hash(55)))?.status).toBe('CONFIRMED');
    await indexer.rollback(50383,0n);expect((await store.getIntent(hash(55)))?.status).toBe('CANCEL_REQUESTED');
  });
  it('cannot cancel a confirmed execution and restores pre-execution status on a reorg',async()=>{
    await indexer.append(50383,header(1),[execution]);expect(await store.requestCancellation(hash(55),owner,Date.now())).toBeNull();
    await indexer.confirm(50383,1n);expect(await store.requestCancellation(hash(55),owner,Date.now())).toBeNull();
    await indexer.rollback(50383,0n);expect((await store.getIntent(hash(55)))?.status).toBe('ELIGIBLE');
  });
});
