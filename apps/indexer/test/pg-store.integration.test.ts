import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../../packages/db/src/migrate.js';
import { readFile } from 'node:fs/promises';
import type { Hex } from 'viem';
import { PgIndexerStore } from '../src/pg-store.js';
import {compatibilityReady} from '../src/readiness.js';
import type { DecodedLog, Header } from '../src/types.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `indexer_test_${randomUUID().replaceAll('-', '')}`;
const h = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const account = '0x0000000000000000000000000000000000000001';
const intentId = h(77);
const b = (n: number): Header => ({ number: BigInt(n), hash: h(n), parentHash: h(n - 1), timestamp: 100n + BigInt(n) });
describe.skipIf(!url)('PostgreSQL canonical projections', () => {
  let admin: Pool; let pool: Pool; let store: PgIndexerStore;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema},public` });
    await migrate(pool);
    store = new PgIndexerStore(pool);
    await pool.query(`INSERT INTO app_intents(id,owner,account,chain_id,executor,body,signature,status,created_at,updated_at)
      VALUES($1,$2,$2,50383,$2,$3,'0x','CANCEL_REQUESTED',now(),now())`, [intentId, account, { nonce: '1', epoch: '0' }]);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });
  it('atomically persists an execution log, cursor and app projection', async () => {
    await store.migrate(); await store.initialize(50383, b(0));
    const log: DecodedLog = { address: account, blockNumber: 1n, blockHash: h(1), transactionHash: h(99), logIndex: 0,
      topics: [], data: '0x', eventName: 'IntentExecuted', args: { intentHash: intentId, account, executor: account, nonce: 1n, epoch: 0n, revision: 1n, guaranteedNetQuote: 0n },
      receipt: { blockHash: h(1), status: 'success' } };
    await store.append(50383, b(1), [log]);
    expect((await store.checkpoint(50383))?.number).toBe(1n);
    expect((await pool.query('SELECT status FROM app_intents WHERE id=$1', [intentId])).rows[0]?.status).toBe('MINED');
    await store.confirm(50383, 1n);
    expect((await pool.query('SELECT status FROM app_intents WHERE id=$1', [intentId])).rows[0]?.status).toBe('CONFIRMED');
  });
  it('rewinds canonical projections to the preceding user cancellation request', async () => {
    await store.rollback(50383, 0n);
    expect((await store.checkpoint(50383))?.number).toBe(0n);
    expect((await pool.query('SELECT status FROM app_intents WHERE id=$1', [intentId])).rows[0]?.status).toBe('CANCEL_REQUESTED');
    expect((await pool.query('SELECT status FROM app_executions WHERE tx_hash=$1', [h(99)])).rows[0]?.status).toBe('ORPHANED');
    expect((await pool.query('SELECT canonical FROM chain_logs WHERE transaction_hash=$1', [h(99)])).rows[0]?.canonical).toBe(false);
  });
  it('rejects a noncontiguous append without moving checkpoint', async () => {
    await expect(store.append(50383, b(2), [])).rejects.toThrow(/checkpoint|parent|contiguous/i);
    expect((await store.checkpoint(50383))?.number).toBe(0n);
  });
  it('prunes only expired recovery headers and journals while retaining financial logs and receipts',async()=>{
    const log:DecodedLog={address:account,blockNumber:1n,blockHash:h(1),transactionHash:h(99),logIndex:0,topics:[],data:'0x',eventName:'IntentExecuted',args:{intentHash:intentId,account},receipt:{status:'success'}};
    await store.append(50383,b(1),[log]);await store.confirm(50383,1n);
    await pool.query(`INSERT INTO chain_blocks(chain_id,number,hash,parent_hash,timestamp,canonical) SELECT 50383,n,'0x'||lpad(to_hex(n),64,'0'),'0x'||lpad(to_hex(n-1),64,'0'),100+n,true FROM generate_series(2,1000) n`);
    await pool.query("UPDATE chain_checkpoints SET number=1000,hash=$1 WHERE chain_id=50383",[h(1000)]);await store.confirm(50383,1000n);
    expect(await store.block(50383,487n)).toBeNull();expect(await store.block(50383,488n)).not.toBeNull();expect((await pool.query('SELECT * FROM chain_logs WHERE transaction_hash=$1',[h(99)])).rowCount).toBe(1);
    expect((await pool.query('SELECT receipt,status FROM app_executions WHERE tx_hash=$1',[h(99)])).rows[0]).toMatchObject({receipt:{status:'success'},status:'CONFIRMED'});expect((await pool.query('SELECT * FROM chain_projection_journal')).rowCount).toBe(0);
    await expect(store.rollback(50383,487n)).rejects.toThrow('ancestor');expect((await store.checkpoint(50383))?.number).toBe(1000n);
  });
  it('discovers only canonical accounts and pools and closes readiness on stale checkpoints or unresolved incidents',async()=>{
    const logs:DecodedLog[]=[{address:account,blockNumber:1001n,blockHash:h(1001),transactionHash:h(2000),logIndex:0,topics:[],data:'0x',eventName:'AccountCreated',args:{account}},
      {address:account,blockNumber:1001n,blockHash:h(1001),transactionHash:h(2000),logIndex:1,topics:[],data:'0x',eventName:'PoolConfigured',args:{pool:'0x0000000000000000000000000000000000000002'}}];
    const readiness={rpc:{chainId:async()=>50383,head:async()=>1001n,block:async(n:bigint)=>b(Number(n))},confirmations:12,now:()=>Number(b(1001).timestamp)*1000};
    await store.append(50383,b(1001),logs);expect(await store.watched(50383)).toHaveLength(2);expect((await compatibilityReady(pool,50383,readiness)).ready).toBe(true);
    await store.incident(50383,'IMPLEMENTATION_CHANGED',{address:account});expect((await compatibilityReady(pool,50383,readiness)).reasons).toContain('IMPLEMENTATION_CHANGED');await pool.query('UPDATE chain_incidents SET resolved_at=now()');
    await pool.query("UPDATE chain_checkpoints SET updated_at=now()-interval '61 seconds'");expect((await compatibilityReady(pool,50383,readiness)).reasons).toContain('INDEXER_NOT_INITIALIZED');
    await store.rollback(50383,1000n);expect(await store.watched(50383)).toEqual([]);
  });

});

describe.skipIf(!url)('PostgreSQL indexer fault and recovery boundaries',()=>{
  const faultSchema=`indexer_fault_${randomUUID().replaceAll('-','')}`;
  let admin:Pool,pool:Pool,store:PgIndexerStore;
  const raw=(overrides:Partial<DecodedLog>={}):DecodedLog=>({address:account,blockNumber:1n,blockHash:h(1),transactionHash:h(100),logIndex:0,topics:[h(7)],data:'0x1234',eventName:null,args:null,...overrides});
  beforeAll(async()=>{
    admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA ${faultSchema}`);
    pool=new Pool({connectionString:url,options:`-c search_path=${faultSchema},public`});
    await migrate(pool);store=new PgIndexerStore(pool);await store.migrate();
  });
  beforeEach(async()=>{await pool.query('TRUNCATE chain_checkpoints,chain_blocks,chain_logs,chain_projection_journal,chain_incidents,app_executions,app_intents');});
  afterAll(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA ${faultSchema} CASCADE`);await admin.end();}});
  it('initialization is idempotent and never replaces an existing durable checkpoint',async()=>{
    expect(await store.checkpoint(50383)).toBeNull();await store.initialize(50383,b(0));await store.initialize(50383,b(99));
    expect(await store.checkpoint(50383)).toEqual({number:0n,hash:h(0)});expect(await store.block(50383,99n)).toBeNull();
  });
  it('rejects append without an initialized checkpoint without leaving an orphan header',async()=>{
    await expect(store.append(50383,b(1),[raw()])).rejects.toThrow('Noncontiguous');
    expect(await store.checkpoint(50383)).toBeNull();expect(await store.block(50383,1n)).toBeNull();expect((await pool.query('SELECT * FROM chain_logs')).rowCount).toBe(0);
  });
  it('rejects wrong-parent blocks even when height is contiguous',async()=>{
    await store.initialize(50383,b(0));await expect(store.append(50383,{...b(1),parentHash:h(99)},[])).rejects.toThrow('Noncontiguous');
    expect((await store.checkpoint(50383))?.number).toBe(0n);expect(await store.block(50383,1n)).toBeNull();
  });
  it.each([{blockHash:h(99)},{blockNumber:2n}])('rejects a foreign log atomically: %s',async override=>{
    await store.initialize(50383,b(0));await expect(store.append(50383,b(1),[raw(override)])).rejects.toThrow('Log does not belong');
    expect(await store.block(50383,1n)).toBeNull();expect((await pool.query('SELECT * FROM chain_logs')).rowCount).toBe(0);expect((await store.checkpoint(50383))?.number).toBe(0n);
  });
  it('retains undecoded financial logs through confirm, reorg and canonical replay without duplicates',async()=>{
    await store.initialize(50383,b(0));await store.append(50383,b(1),[raw()]);await store.confirm(50383,1n);
    expect((await pool.query('SELECT args,data,canonical,confirmed FROM chain_logs')).rows[0]).toEqual({args:null,data:'0x1234',canonical:true,confirmed:true});
    await store.rollback(50383,0n);expect((await pool.query('SELECT canonical,confirmed FROM chain_logs')).rows[0]).toEqual({canonical:false,confirmed:false});
    await store.append(50383,b(1),[raw()]);expect((await pool.query('SELECT args,data,canonical,confirmed FROM chain_logs')).rows).toEqual([{args:null,data:'0x1234',canonical:true,confirmed:false}]);
  });
  it('does not confirm any financial logs while the required confirmation height is negative',async()=>{
    await store.initialize(50383,b(0));await store.append(50383,b(1),[raw()]);await store.confirm(50383,-1n);
    expect((await pool.query('SELECT confirmed FROM chain_logs')).rows[0]?.confirmed).toBe(false);expect((await store.checkpoint(50383))?.number).toBe(1n);
  });
  it('rolls back raw logs and headers on a projection failure, releases its connection and can retry',async()=>{
    await store.initialize(50383,b(0));const bad=raw({eventName:'NoncesInvalidated',args:{account,epoch:0n,word:'bad-integer',mask:1n}});
    await expect(store.append(50383,b(1),[bad])).rejects.toThrow();
    expect((await store.checkpoint(50383))?.number).toBe(0n);expect(await store.block(50383,1n)).toBeNull();expect((await pool.query('SELECT * FROM chain_logs')).rowCount).toBe(0);
    await store.append(50383,b(1),[raw()]);expect((await store.checkpoint(50383))?.number).toBe(1n);expect(pool.waitingCount).toBe(0);
  });
  it('ignores malformed discovered addresses and addresses from other chains',async()=>{
    await store.initialize(50383,b(0));await store.append(50383,b(1),[
      raw({eventName:'AccountCreated',args:{account}}),raw({logIndex:1,eventName:'AccountCreated',args:{account:'not-an-address'}}),raw({logIndex:2,eventName:'PoolConfigured',args:{pool:null}}),
    ]);
    expect(await store.watched(50383)).toEqual([{address:account,role:'account'}]);expect(await store.watched(1)).toEqual([]);
  });
  it('supports canonical confirmation and rollback before the API schema is installed',async()=>{
    const standalone=`indexer_standalone_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE SCHEMA ${standalone}`);
    const standalonePool=new Pool({connectionString:url,options:`-c search_path=${standalone}`});
    try{
      await standalonePool.query(await readFile('apps/indexer/sql/0001_canonical_chain.sql','utf8'));const independent=new PgIndexerStore(standalonePool);
      await independent.initialize(50383,b(0));await independent.append(50383,b(1),[raw()]);await independent.confirm(50383,1n);
      expect((await standalonePool.query('SELECT confirmed FROM chain_logs')).rows[0]?.confirmed).toBe(true);
      await independent.rollback(50383,0n);expect((await independent.checkpoint(50383))?.number).toBe(0n);expect((await standalonePool.query('SELECT canonical FROM chain_logs')).rows[0]?.canonical).toBe(false);
    }finally{await standalonePool.end();await admin.query(`DROP SCHEMA ${standalone} CASCADE`);}
  });
});
