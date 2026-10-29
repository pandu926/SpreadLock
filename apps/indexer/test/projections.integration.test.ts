import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {Pool,type PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../../packages/db/src/migrate.js';
import type {Hex} from 'viem';
import {PgIndexerStore} from '../src/pg-store.js';
import {applyProjections,undoProjections} from '../src/projections.js';
import type {DecodedLog} from '../src/types.js';
const url=process.env.TEST_DATABASE_URL,schema=`projection_fault_${randomUUID().replaceAll('-','')}`;
const account='0x0000000000000000000000000000000000000001';
const other='0x0000000000000000000000000000000000000002';
const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const log=(eventName:string,args:Record<string,unknown>,index=0):DecodedLog=>({address:account,blockNumber:1n,blockHash:hash(1),transactionHash:hash(10),logIndex:index,topics:[],data:'0x',eventName,args});
describe.skipIf(!url)('canonical projection fault and cancellation semantics',()=>{
 let admin:Pool,pool:Pool,client:PoolClient;
 beforeAll(async()=>{
  admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA ${schema}`);pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});
  await migrate(pool);await new PgIndexerStore(pool).migrate();client=await pool.connect();
 });
 afterAll(async()=>{client?.release();await pool?.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}});
 beforeEach(async()=>{await pool.query('TRUNCATE chain_projection_journal,app_executions,app_intents');});
 async function put(n:number,status='WAITING',body:Record<string,string>={},target=account){
  await pool.query(`INSERT INTO app_intents(id,owner,account,chain_id,executor,body,signature,status,created_at,updated_at) VALUES($1,$2,$3,50383,$2,$4,'0x',$5,now(),now())`,[hash(n),account,target,{nonce:String(n),epoch:'0',expectedRevision:'0',...body},status]);
 }
 async function status(n:number){return (await pool.query('SELECT status FROM app_intents WHERE id=$1',[hash(n)])).rows[0]?.status;}
 it('applies nonce bitmap invalidation only to matching epoch, word and bit',async()=>{
  await put(1);await put(2);await put(257);await put(3,'WAITING',{epoch:'1'});await put(4,'WAITING',{},other);await put(5,'CONFIRMED');
  await applyProjections(client,50383,[log('NoncesInvalidated',{account,epoch:0n,word:0n,mask:(1n<<1n)|(1n<<5n)})]);
  expect(await status(1)).toBe('CANCELLED');for(const n of [2,257,3,4])expect(await status(n)).toBe('WAITING');expect(await status(5)).toBe('CONFIRMED');
  await undoProjections(client,50383,[hash(1)]);expect(await status(1)).toBe('WAITING');
 });
 it.each(['EpochAdvanced','AuthorizationChanged'])('invalidates only older active epochs for %s and reverses them on orphaning',async event=>{
  await put(1);await put(2,'WAITING',{epoch:'1'});await put(3,'MINED');await put(4,'WAITING',{},other);await put(5,'CANCELLED');
  await applyProjections(client,50383,[log(event,{epoch:1n})]);expect(await status(1)).toBe('INVALIDATED');expect(await status(2)).toBe('WAITING');expect(await status(3)).toBe('MINED');expect(await status(4)).toBe('WAITING');expect(await status(5)).toBe('CANCELLED');
  await undoProjections(client,50383,[hash(1)]);expect(await status(1)).toBe('WAITING');
 });
 it('restores all chained status transitions in reverse journal order including an already confirmed execution',async()=>{
  await put(1,'CANCEL_REQUESTED');await put(2,'WAITING',{expectedRevision:'1'});await put(3,'INVALIDATED');
  await applyProjections(client,50383,[log('RevisionAdvanced',{revision:1n}),log('IntentExecuted',{intentHash:hash(1),account},1)]);
  expect(await status(1)).toBe('MINED');expect(await status(2)).toBe('WAITING');
  await pool.query("UPDATE app_intents SET status='CONFIRMED' WHERE id=$1",[hash(1)]);await undoProjections(client,50383,[hash(1)]);
  expect(await status(1)).toBe('CANCEL_REQUESTED');expect((await pool.query('SELECT status FROM app_executions')).rows[0]?.status).toBe('ORPHANED');
 });
 it.each(['PositionUpdated','AccountLiquidated'])('suspends active intents after external %s and preserves mined ones',async event=>{
  for(const [n,state] of [[1,'WAITING'],[2,'ELIGIBLE'],[3,'SUBMITTED'],[4,'CANCEL_REQUESTED'],[5,'MINED'],[6,'CONFIRMED'],[7,'SUSPENDED']] as const)await put(n,state);
  await applyProjections(client,50383,[log(event,{account})]);for(const n of [1,2,3,4,7])expect(await status(n)).toBe('SUSPENDED');expect(await status(5)).toBe('MINED');expect(await status(6)).toBe('CONFIRMED');
  await undoProjections(client,50383,[hash(1)]);expect(await status(4)).toBe('CANCEL_REQUESTED');
 });
 it('recognizes same-transaction router position updates and suspends only the unrelated account',async()=>{
  await put(1);await put(2,'WAITING',{},other);
  await applyProjections(client,50383,[log('PositionUpdated',{account}),log('PositionUpdated',{account:other},1),log('IntentExecuted',{account,intentHash:hash(1)},2)]);
  expect(await status(1)).toBe('MINED');expect(await status(2)).toBe('SUSPENDED');
 });
 it('preserves an API cancellation newer than an orphaned projection',async()=>{
  await put(1);await applyProjections(client,50383,[log('RevisionAdvanced',{revision:1n})]);await pool.query("UPDATE app_intents SET status='CANCEL_REQUESTED' WHERE id=$1",[hash(1)]);
  await undoProjections(client,50383,[hash(1)]);expect(await status(1)).toBe('CANCEL_REQUESTED');expect((await pool.query('SELECT * FROM chain_projection_journal')).rowCount).toBe(0);
 });
 it('preserves raw unknown events and does not invent projections for absent intents',async()=>{
  await applyProjections(client,50383,[{...log('unknown',{}),args:null},log('FundingSettled',{account,payment:1n}),log('IntentExecuted',{account,intentHash:hash(99)})]);
  expect((await pool.query('SELECT * FROM app_executions')).rowCount).toBe(0);await undoProjections(client,50383,[]);
 });
 it('does not journal duplicate MINED events or let later external liquidation override execution',async()=>{
  await put(1);const event=log('IntentExecuted',{account,intentHash:hash(1)});await applyProjections(client,50383,[event,event,log('AccountLiquidated',{account},2)]);
  expect(await status(1)).toBe('MINED');expect((await pool.query('SELECT * FROM chain_projection_journal')).rowCount).toBe(1);expect((await pool.query('SELECT * FROM app_executions')).rowCount).toBe(1);
 });
});
