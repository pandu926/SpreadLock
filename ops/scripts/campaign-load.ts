/** Controlled-chain capacity harness: actual Fastify HTTP + PostgreSQL; no public RPC. */
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,statfs} from 'node:fs/promises';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import pg from 'pg';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {verifyMessage,verifyTypedData,type Address,type Hex} from 'viem';
import {buildApp} from '../../apps/api/src/app.js';
import {startJobWorker} from '../../apps/api/src/worker.js';
import {hashToken} from '../../apps/api/src/http.js';
import type {ChainGateway,AccountSnapshot} from '../../apps/api/src/types.js';
import {PgStore} from '../../packages/db/src/pg-store.js';
import {migrate} from '../../packages/db/src/migrate.js';
import {canonicalPositionsHash,getIntentTypedData,hashIntent,serializeIntent,type Intent,type Leg} from '../../packages/domain/src/index.js';
// @ts-ignore operational JS shared with node:test.
import {assessLoad,percentile} from '../testing/campaign.mjs';
// @ts-ignore operational evidence helper.
import {sourceManifest,artifact} from '../../scripts/verification/lib.mjs';
const args=process.argv.slice(2),full=args.includes('--full'),outArg=args.indexOf('--output');
const output=outArg>=0?args[outArg+1]!:resolve('evidence/operations',`load-${Date.now()}.json`);
const durationMs=full?3600000:10000,burstDurationMs=full?300000:3000;
const targetRps=100,burstRps=300,concurrency=100,chainId=31338;
const database=process.env.TEST_DATABASE_URL;if(!database)throw new Error('TEST_DATABASE_URL required; isolated schema is created, never shared tables');
if(full){const disk=await statfs(process.cwd());if(disk.bavail*disk.bsize<15*2**30)throw new Error('Full load blocked: minimum15GiB free disk required');}
const source=await sourceManifest(process.cwd());
const startedAt=new Date().toISOString(),schema=`spreadlock_load_${randomUUID().replaceAll('-','')}`;
const admin=new pg.Pool({connectionString:database,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
const scoped=new URL(database);scoped.searchParams.set('options',`-c search_path=${schema}`);
const store=new PgStore(scoped.toString(),{max:16});
const router='0x2222222222222222222222222222222222222222' as Address;
const factory='0x3333333333333333333333333333333333333333' as Address;
const pools=['0x6666666666666666666666666666666666666666','0x7777777777777777777777777777777777777777'] as Address[];
const wallets=Array.from({length:100},()=>privateKeyToAccount(generatePrivateKey()));
const accounts=Array.from({length:1000},(_,i)=>`0x${(10000+i).toString(16).padStart(40,'0')}` as Address);
const accountOwners=new Map(accounts.map((a,i)=>[a,wallets[Math.floor(i/10)]!.address.toLowerCase() as Address]));
const keepers=Array.from({length:10},()=>privateKeyToAccount(generatePrivateKey()));
class ControlledChain implements ChainGateway{
 readonly chainId=chainId;async ready(){}
 async verifyMessage(address:Address,message:string,signature:Hex){return verifyMessage({address,message,signature});}
 async verifyTypedData(address:Address,data:any,signature:Hex){return verifyTypedData({...data,address:accountOwners.get(address.toLowerCase() as Address)??address,signature});}
 async ownerOf(account:Address){const owner=accountOwners.get(account.toLowerCase() as Address);if(!owner)throw new Error('UNKNOWN_TEST_ACCOUNT');return owner;}
 async account(account:Address):Promise<AccountSnapshot>{return{owner:await this.ownerOf(account),epoch:0n,revision:0n,positions:[],equity:1000000n,initialMargin:10n,maintenanceMargin:5n};}
 async markets(){return pools.map(pool=>({pool,oneBase:1n,tickSize:1n,lotSize:1n,minQuantity:1n,takerFeeBpsTimes1k:0,entryEnabled:true}));}
 async positionsHash(_account:Address,legs:Leg[]){return canonicalPositionsHash(legs.map(l=>({pool:l.pool,size:0n})));}
 async nonceUsed(){return false;}
 async quote(_account:Address,legs:Leg[]){await new Promise(r=>setTimeout(r,5));const now=String(Math.floor(Date.now()/1000));return{blockNumber:'100',blockTimestamp:now,expiresAt:String(Number(now)+10),executablePrices:legs.map(l=>l.limitPrice.toString()),conservativeNetQuote:'0',markNetQuote:'0',markets:[],simulationStatus:'not_signed' as const};}
 async simulate(){return{gas:'500000'};}
 async prepareCreate(){return{to:factory,data:'0x1234',value:'0'};}
 async prepareAccountAction(account:Address,action:Record<string,unknown>){return{to:account,data:'0x1234',value:'0',action};}
 async prepareCancel(){return{to:router,data:'0x1234',value:'0'};}
 async execution(txHash:Hex){return{txHash,status:'SUBMITTED' as const,blockNumber:null,blockHash:null,receipt:null};}
}
const chain=new ControlledChain();
const makeIntent=async(i:number,nonce:bigint):Promise<Intent>=>{const legs=pools.map((pool,j)=>({pool,delta:j? -10n:10n,limitPrice:100n,maxTakerFeeBpsTimes1k:0}));return{account:accounts[i]!,executor:keepers[Math.floor(i/10)%10]!.address,nonce,epoch:0n,expectedRevision:0n,expectedPositionsHash:await chain.positionsHash(accounts[i]!,legs),validAfter:BigInt(Math.floor(Date.now()/1000)-1),validUntil:BigInt(Math.floor(Date.now()/1000)+86400),operation:0,legs,minNetQuote:0n,triggerKind:0,triggerValue:0n,minPostEquity:0n,minPostHealthBps:20000};};
let app:Awaited<ReturnType<typeof buildApp>>|undefined,stopWorker:(()=>Promise<void>)|undefined;
try{
 await migrate(store.pool);
 const ownerTokens:string[]=[],keeperTokens:string[]=[];
 for(let i=0;i<100;i++){const owner=wallets[i]!.address.toLowerCase() as Address,token=randomBytes(32).toString('base64url');ownerTokens.push(token);await store.createSession({tokenHash:hashToken(token),owner,signer:owner,chainId,role:'owner',authorizationId:null,expiresAt:Date.now()+7200000});}
 await store.pool.query(`INSERT INTO app_baskets(id,account,owner,chain_id,name,created_at) SELECT $1||':'||a,a,o,$1::bigint,'load fixture',now() FROM unnest($2::text[],$3::text[]) AS q(a,o)`,[String(chainId),accounts,accounts.map(a=>accountOwners.get(a))]);
 // Seed history intentionally without broadcasting or generating jobs; write phase uses real signed route validation.
 const seedRows=[];for(let i=0;i<10000;i++){const index=i%1000,intent=await makeIntent(index,BigInt(i));seedRows.push({id:hashIntent(intent,chainId,router),owner:accountOwners.get(accounts[index]!),account:accounts[index]!,executor:intent.executor.toLowerCase(),body:serializeIntent(intent)});}
 await store.pool.query(`INSERT INTO app_intents(id,owner,account,chain_id,executor,body,signature,status,created_at,updated_at) SELECT r.id,r.owner,r.account,$1,r.executor,r.body,'0x'||repeat('11',65),'WAITING',now(),now() FROM jsonb_to_recordset($2::jsonb) AS r(id text,owner text,account text,executor text,body jsonb)`,[chainId,JSON.stringify(seedRows)]);
 for(let i=0;i<10;i++){const owner=wallets[i]!.address.toLowerCase() as Address,keeper=keepers[i]!.address.toLowerCase() as Address,id=`0x${(100+i).toString(16).padStart(64,'0')}`,token=randomBytes(32).toString('base64url');keeperTokens.push(token);await store.putAuthorization({id,owner,keeper,accounts:accounts.slice(i*10,i*10+10),chainId,validUntil:String(Math.floor(Date.now()/1000)+7200),nonce:String(i),signature:`0x${'11'.repeat(65)}`,revokedAt:null,createdAt:Date.now()});await store.createSession({tokenHash:hashToken(token),owner,signer:keeper,chainId,role:'keeper',authorizationId:id,expiresAt:Date.now()+7200000});}
 app=await buildApp({store,chain,config:{chainId,baseUrl:'http://127.0.0.1',router,factory,development:true,rateLimitMax:100000000}});
 const origin=await app.listen({host:'127.0.0.1',port:0});stopWorker=startJobWorker(store,chain,50);
 const samples:{read:number[];write:number[];quote:number[]}={read:[],write:[],quote:[]};
 const acceptedWrites=new Map<string,{owner:string;nonce:string}>();
 const activeOwners=new Set<number>(),activeKeepers=new Set<number>();let peakInFlight=0;
 let total=0,serverErrors=0,unexpectedResponses=0,dropped=0,assertionFailures=0,completedWrites=0,sequence=0,peakMemoryBytes=0;
 const cgroupOom=async()=>{try{const group=(await readFile('/proc/self/cgroup','utf8')).split('\n').find(line=>line.startsWith('0::'))?.slice(3);if(!group||group.includes('..'))return null;const text=await readFile('/sys/fs/cgroup'+group+'/memory.events','utf8');const match=text.match(/^oom_kill (\d+)$/m);return match?Number(match[1]):null;}catch{return null;}};
 const initialOom=await cgroupOom();
 const memoryTimer=setInterval(()=>{peakMemoryBytes=Math.max(peakMemoryBytes,process.memoryUsage().rss);},100);
 const inflight=new Set<Promise<void>>();
 const request=async(index:number,scheduled:number)=>{
  const bucket=index%100,ownerIndex=(index+Math.floor(index/100)*17)%100,accountIndex=ownerIndex*10+(Math.floor(index/100)%10),owner=wallets[ownerIndex]!,account=accounts[accountIndex]!;
  activeOwners.add(ownerIndex);
  let kind:'read'|'write'|'quote'='read',path='/v1/intents',method='GET',body:unknown,token=ownerTokens[ownerIndex]!;
  if(bucket<5){kind='write';path='/v1/intents';method='POST';const intent=await makeIntent(accountIndex,1000000n+BigInt(index));body={intent:serializeIntent(intent),signature:await owner.signTypedData(getIntentTypedData(intent,chainId,router))};}
  else if(bucket<10){kind='quote';path='/v1/quotes';method='POST';body={intent:serializeIntent(await makeIntent(accountIndex,2000000n+BigInt(index)))};}
  else if(bucket<20){path='/v1/keeper/intents';token=keeperTokens[index%10]!;activeKeepers.add(index%10);}
  else if(bucket<50)path='/v1/baskets';else if(bucket<60)path=`/v1/baskets/${account}/positions`;else if(bucket<70)path='/v1/executions';else if(bucket<75)path='/v1/markets';
  try{const response=await fetch(origin+path,{method,headers:{authorization:`Bearer ${token}`,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});const payload=await response.json() as any;const elapsed=performance.now()-scheduled;samples[kind].push(elapsed);total++;if(response.status>=500)serverErrors++;if(!response.ok||payload.success!==true)unexpectedResponses++;if(kind==='write'&&response.ok){completedWrites++;const expected=hashIntent((await import('../../packages/domain/src/index.js')).parseIntent((body as any).intent),chainId,router);if(payload.data?.hash!==expected)assertionFailures++;acceptedWrites.set(expected,{owner:owner.address.toLowerCase(),nonce:(body as any).intent.nonce});}
   const expectedOwner=(bucket>=10&&bucket<20?wallets[index%10]!:owner).address.toLowerCase();for(const row of payload.data?.items??[])if(row.owner&&row.owner!==expectedOwner)assertionFailures++;
  }catch{total++;serverErrors++;unexpectedResponses++;samples[kind].push(performance.now()-scheduled);}
 };
 const phase=async(ms:number,rps:number)=>{const start=performance.now(),count=Math.floor(ms*rps/1000);for(let i=0;i<count;i++){const scheduled=start+i*1000/rps,wait=scheduled-performance.now();if(wait>0)await new Promise(r=>setTimeout(r,wait));if(inflight.size>=concurrency){dropped++;continue;}const p=request(sequence++,scheduled);inflight.add(p);peakInFlight=Math.max(peakInFlight,inflight.size);void p.finally(()=>inflight.delete(p));}await Promise.all(inflight);};
 await phase(durationMs,targetRps);await phase(burstDurationMs,burstRps);
 const recoveryStart=performance.now();let queueRecoveryMs:number|null=null;
 while(performance.now()-recoveryStart<=300000){const q=await store.pool.query("SELECT count(*)::integer AS overdue FROM app_jobs WHERE status='leased' OR (status='queued' AND run_at<now()-interval '5 seconds')");if(q.rows[0]?.overdue===0){queueRecoveryMs=performance.now()-recoveryStart;break;}await new Promise(r=>setTimeout(r,100));}
 clearInterval(memoryTimer);peakMemoryBytes=Math.max(peakMemoryBytes,process.memoryUsage().rss);const finalOom=await cgroupOom();
 const persisted=await store.pool.query("SELECT i.id,i.owner,i.body->>'nonce' AS nonce,j.id AS job_id FROM app_intents i LEFT JOIN app_jobs j ON j.dedupe_key=i.id AND j.kind='intent.revalidate' WHERE i.id=ANY($1::text[])",[[...acceptedWrites.keys()]]);
 let lostJobs=0,accountingFailures=0;for(const row of persisted.rows){const expected=acceptedWrites.get(row.id);if(!expected||row.owner!==expected.owner||row.nonce!==expected.nonce)accountingFailures++;if(!row.job_id)lostJobs++;}accountingFailures+=Math.abs(acceptedWrites.size-persisted.rowCount!);assertionFailures+=accountingFailures+lostJobs;
 const sourceUnchanged=(await sourceManifest()).sha256===source.sha256;
 const metrics={activeOwners:activeOwners.size,activeKeepers:activeKeepers.size,peakInFlight,sourceUnchanged,authFailures:assertionFailures-accountingFailures-lostJobs,accountingFailures,lostJobs,profile:full?'full':'smoke',durationMs,burstDurationMs,targetRps,burstRps,concurrency,owners:100,keepers:10,baskets:1000,intents:10000,total,serverErrors,unexpectedResponses,dropped,assertionFailures,completedWrites,readP95Ms:percentile(samples.read),writeP95Ms:percentile(samples.write),quoteP95Ms:percentile(samples.quote),queueRecoveryMs,peakMemoryBytes,oomEvents:initialOom===null||finalOom===null?null:finalOom-initialOom};
 const assessment=assessLoad(metrics);if(!sourceUnchanged&&full){assessment.status='FAIL';assessment.checks.push({id:'source_unchanged',passed:false});}const report={schemaVersion:1,type:'load',sourceSha256:source.sha256,startedAt,completedAt:new Date().toISOString(),scope:'Actual Fastify HTTP + isolated PostgreSQL schema + controlled ChainGateway, never public RPC; not chain throughput evidence',...assessment,metrics};
 await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({output,status:report.status,metrics},null,2));if(full&&report.status==='PASS'&&process.env.CAMPAIGN_REVIEWER?.trim()){const proof={schemaVersion:1,gate:'load',sourceSha256:source.sha256,reviewedBy:process.env.CAMPAIGN_REVIEWER,startedAt,completedAt:report.completedAt,measurements:{users:metrics.activeOwners,keepers:metrics.activeKeepers,requestsPerSecond:metrics.targetRps,durationSeconds:metrics.durationMs/1000,burstRequestsPerSecond:metrics.burstRps,burstDurationSeconds:metrics.burstDurationMs/1000,readP95Ms:metrics.readP95Ms,writeP95Ms:metrics.writeP95Ms,quoteP95Ms:metrics.quoteP95Ms,http5xxRatio:metrics.serverErrors/metrics.total,authFailures:metrics.authFailures,accountingFailures:metrics.accountingFailures,lostJobs:metrics.lostJobs,ooms:metrics.oomEvents,queueRecoverySeconds:metrics.queueRecoveryMs!/1000,controlledRpc:true},artifacts:[await artifact(process.cwd(),output)]};await mkdir('evidence/external',{recursive:true});await writeFile('evidence/external/load.json',JSON.stringify(proof,null,2)+'\n',{flag:'wx',mode:0o600});}if(report.status==='FAIL')process.exitCode=1;
}finally{await stopWorker?.();await app?.close();await store.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
