import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PgIndexerStore} from '../src/pg-store.js';

const database=process.env.TEST_DATABASE_URL;
const account='0x1111111111111111111111111111111111111111';
const market='0x2222222222222222222222222222222222222222';
const wrongChain='0x3333333333333333333333333333333333333333';
const orphan='0x4444444444444444444444444444444444444444';
describe.skipIf(!database)('bounded canonical discovery lookup on growing financial history',()=>{
  const schema=`discovery_index_${randomUUID().replaceAll('-','')}`;
  let admin:Pool,pool:Pool,store:PgIndexerStore;
  let discoveryQuery:{text:string;values:unknown[]}|undefined;
  let confirmationQuery:{text:string;values:unknown[]}|undefined;
  beforeAll(async()=>{
    admin=new Pool({connectionString:database});await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString:database,options:`-c search_path=${schema}`});
    // Represent a running installation created by the original migration.
    await pool.query(await readFile('apps/indexer/sql/0001_canonical_chain.sql','utf8'));
    await pool.query(`INSERT INTO chain_logs(chain_id,block_number,block_hash,transaction_hash,log_index,address,topics,data,event_name,args,canonical)
      SELECT 50383,n,'0x'||lpad(to_hex(n),64,'0'),'0x'||lpad(to_hex(n+10000),64,'0'),0,$1,'[]','0x','PositionUpdated',jsonb_build_object('account',$1::text,'size',n),true
      FROM generate_series(1,8000) n`,[account]);
    await pool.query(`INSERT INTO chain_logs(chain_id,block_number,block_hash,transaction_hash,log_index,address,topics,data,event_name,args,canonical) VALUES
      (50383,9001,'b1','tx1',0,$1,'[]','0x','AccountCreated',jsonb_build_object('account',$1::text),true),
      (50383,9002,'b2','tx2',0,$1,'[]','0x','PoolConfigured',jsonb_build_object('pool',$2::text),true),
      (50383,9003,'b3','tx3',0,$1,'[]','0x','AccountCreated',jsonb_build_object('account',$1::text),true),
      (1,9004,'b4','tx4',0,$1,'[]','0x','AccountCreated',jsonb_build_object('account',$3::text),true),
      (50383,9005,'b5','tx5',0,$1,'[]','0x','AccountCreated',jsonb_build_object('account',$4::text),false)`,[account,market,wrongChain,orphan]);
    const capture=(text:string,values:unknown[]|undefined)=>{
      if(text.includes("SELECT DISTINCT args->>'account'"))discoveryQuery={text,values:values??[]};
      if(text.startsWith('UPDATE chain_logs SET confirmed=true'))confirmationQuery={text,values:values??[]};
    };
    const monitored=new Proxy(pool,{get(target,key){
      if(key==='query')return(text:string,values?:unknown[])=>{capture(text,values);return target.query(text,values);};
      if(key==='connect')return async()=>new Proxy(await target.connect(),{get(client,field){
        if(field==='query')return(text:string,values?:unknown[])=>{capture(text,values);return client.query(text,values);};
        const value=Reflect.get(client,field);return typeof value==='function'?value.bind(client):value;
      }});
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    store=new PgIndexerStore(monitored);
  });
  afterAll(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}});
  it('upgrades idempotently and makes the actual watched query use a small covering discovery index',async()=>{
    const before=await pool.query('SELECT count(*)::int AS count FROM chain_logs');
    await store.migrate();await store.migrate();await pool.query('ANALYZE chain_logs');
    expect((await store.watched(50383)).sort((a,b)=>a.address.localeCompare(b.address))).toEqual([{address:account,role:'account'},{address:market,role:'pool'}]);
    expect(discoveryQuery).toBeDefined();
    const plan=await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${discoveryQuery!.text}`,discoveryQuery!.values);
    const serialized=JSON.stringify(plan.rows[0]['QUERY PLAN']);
    expect(serialized).toContain('chain_logs_canonical_discovery');
    expect(serialized).not.toContain('Seq Scan');
    const index=await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='chain_logs_canonical_discovery'",[schema]);
    expect(index.rows).toHaveLength(1);expect(index.rows[0]?.indexdef).toContain('INCLUDE (args)');
    expect((await pool.query('SELECT count(*)::int AS count FROM chain_logs')).rows).toEqual(before.rows);
    expect(await store.watched(1)).toEqual([{address:wrongChain,role:'account'}]);
  });
  it('confirms only pending canonical rows without rewriting prior financial history',async()=>{
    await pool.query('UPDATE chain_logs SET confirmed=true');
    await pool.query('UPDATE chain_logs SET confirmed=false WHERE chain_id=50383 AND block_number BETWEEN 7989 AND 8000');
    await pool.query('ANALYZE chain_logs');
    const rowIdentity=()=>pool.query("SELECT block_hash,ctid::text AS identity FROM chain_logs WHERE chain_id=50383 AND block_number=1");
    const original=(await rowIdentity()).rows;
    await store.confirm(50383,7994n);
    expect((await rowIdentity()).rows).toEqual(original);
    expect((await pool.query('SELECT count(*)::int AS count FROM chain_logs WHERE canonical AND NOT confirmed')).rows[0]?.count).toBe(6);
    expect(confirmationQuery).toBeDefined();
    const plan=await pool.query(`EXPLAIN (FORMAT JSON) ${confirmationQuery!.text}`,confirmationQuery!.values);
    const serialized=JSON.stringify(plan.rows[0]['QUERY PLAN']);
    expect(serialized).toContain('chain_logs_pending_confirmation');expect(serialized).not.toContain('Seq Scan');
    const current=(await pool.query('SELECT block_hash,ctid::text AS identity FROM chain_logs WHERE chain_id=50383 ORDER BY block_hash')).rows;
    await store.confirm(50383,7994n);
    expect((await pool.query('SELECT block_hash,ctid::text AS identity FROM chain_logs WHERE chain_id=50383 ORDER BY block_hash')).rows).toEqual(current);
    await store.confirm(50383,8000n);
    expect((await pool.query('SELECT count(*)::int AS count FROM chain_logs WHERE canonical AND NOT confirmed')).rows[0]?.count).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS count FROM chain_logs')).rows[0]?.count).toBe(8005);
  });
});
