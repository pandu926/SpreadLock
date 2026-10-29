import type {PgStore} from '../../../packages/db/src/index.js';
import {parseIntent} from '../../../packages/domain/src/index.js';
import type {ChainGateway} from './types.js';
import {randomUUID} from 'node:crypto';
// Lock the job row before checking ownership. A concurrent reclaim serializes with
// this statement, so stale RPC observations cannot write after lease takeover.
const intentStatusSql=`WITH lease AS MATERIALIZED (
 SELECT locked_by,status,locked_until FROM app_jobs WHERE id=$3 FOR UPDATE
) UPDATE app_intents SET status=$1,updated_at=now() WHERE id=$2
 AND status IN ('WAITING','ELIGIBLE','SUSPENDED')
 AND EXISTS(SELECT 1 FROM lease WHERE locked_by=$4 AND status='leased' AND locked_until>clock_timestamp())`;
/** SQL leases serialize jobs. Canonical chain events remain authoritative for fills/cancels. */
export function startJobWorker(store:PgStore,chain:ChainGateway,intervalMs=2000){
 const worker=randomUUID();let running=false,stopped=false;
 const tick=async()=>{if(stopped||running)return;running=true;try{
  const jobs=await store.claimJobs(worker,Date.now(),10);
  for(const job of jobs){let parsed=false;try{
   const lease=await store.pool.query("SELECT 1 FROM app_jobs WHERE id=$1 AND locked_by=$2 AND status='leased' AND locked_until>clock_timestamp()",[job.id,worker]);
   if(lease.rowCount===0)continue;
   const hash=String(job.payload.hash??'');const row=await store.getIntent(hash);
   if(!row||['CONFIRMED','MINED','CANCELLED','INVALIDATED','EXPIRED'].includes(row.status)){await store.finishJob(job.id,worker);continue;}
   const intent=parseIntent(row.body),now=BigInt(Math.floor(Date.now()/1000));parsed=true;
   let status:string|undefined;
   if(intent.validUntil<=now)status='EXPIRED';
   else{const snapshot=await chain.account(intent.account);
    if(snapshot.epoch!==intent.epoch||snapshot.revision>intent.expectedRevision||await chain.nonceUsed(intent.account,intent.epoch,intent.nonce))status='INVALIDATED';
    else if(snapshot.revision===intent.expectedRevision && (await chain.positionsHash(intent.account,intent.legs)).toLowerCase()!==intent.expectedPositionsHash.toLowerCase())status='SUSPENDED';
    else if(snapshot.revision===intent.expectedRevision&&intent.validAfter<=now){
      try{const q=await chain.quote(intent.account,intent.legs);await chain.simulate(intent,row.signature,q.executablePrices.map(BigInt));status='ELIGIBLE';}
      catch(error){await store.pool.query(intentStatusSql,['WAITING',hash,job.id,worker]);throw error;}
    }
   }
   if(status)await store.pool.query(intentStatusSql,[status,hash,job.id,worker]);
   if(status==='EXPIRED'||status==='INVALIDATED')await store.finishJob(job.id,worker);
   else await store.pool.query("UPDATE app_jobs SET status='queued',attempts=0,locked_by=NULL,locked_until=NULL,run_at=now()+interval '30 seconds',updated_at=now() WHERE id=$1 AND locked_by=$2 AND status='leased' AND locked_until>clock_timestamp()",[job.id,worker]);
  }catch(error){
   // Valid standing intents survive long RPC/depth outages until their signed expiry.
   // Malformed records retain the database poison-job retry ceiling.
   if(parsed&&job.attempts>=25)await store.pool.query("UPDATE app_jobs SET attempts=24 WHERE id=$1 AND locked_by=$2 AND status='leased' AND locked_until>clock_timestamp()",[job.id,worker]);
   await store.retryJob(job.id,worker,error instanceof Error?error.name:'REVALIDATION_FAILED',Date.now()+Math.min(30000,1000*2**Math.min(job.attempts,5)));}}
 }catch(error){console.error(JSON.stringify({service:'jobs',error:error instanceof Error?error.name:'DATABASE_UNAVAILABLE'}));}finally{running=false;}};
 const timer=setInterval(()=>{void tick();},intervalMs);void tick();
 return async()=>{stopped=true;clearInterval(timer);while(running)await new Promise(r=>setTimeout(r,25));};
}
