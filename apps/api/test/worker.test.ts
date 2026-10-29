import {describe,expect,it,vi} from 'vitest';
import type {PgStore} from '../../../packages/db/src/index.js';
import {startJobWorker} from '../src/worker.js';
import {FakeChain,ownerWallet,account,keeperWallet,wireIntent} from './fixtures.js';

async function fixture(overrides:Record<string,unknown>={}){
 const chain=new FakeChain(),body=await wireIntent(chain,Date.now());
 const row={id:'intent',owner:ownerWallet.address,account,executor:keeperWallet.address,chainId:50383,body,signature:'0x1234',status:'WAITING',...overrides};
 const query=vi.fn().mockResolvedValue({rows:[{id:'job'}],rowCount:1});
 const store={pool:{query},claimJobs:vi.fn().mockResolvedValueOnce([{id:'job',kind:'intent.revalidate',payload:{hash:'intent'},attempts:1}]).mockResolvedValue([]),getIntent:vi.fn().mockResolvedValue(row),finishJob:vi.fn().mockResolvedValue(undefined),retryJob:vi.fn().mockResolvedValue(undefined)};
 async function run(){const stop=startJobWorker(store as unknown as PgStore,chain,60000);await vi.waitFor(()=>expect(store.finishJob.mock.calls.length+store.retryJob.mock.calls.length+query.mock.calls.filter(c=>String(c[0]).includes('UPDATE app_jobs')).length).toBeGreaterThan(0));await stop();}
 return{chain,row,store,query,run};
}
describe('standing intent worker safety',()=>{
 it('invalidates an independently consumed nonce without advertising execution eligibility',async()=>{
  const f=await fixture();f.chain.nonceUsed=async()=>true;await f.run();
  expect(f.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE app_intents'),['INVALIDATED','intent','job',expect.any(String)]);expect(f.chain.simulations).toBe(0);expect(f.store.finishJob).toHaveBeenCalled();
 });
 it('keeps suspended position state under revalidation so it can recover',async()=>{
  const f=await fixture();f.chain.positionsHash=async()=>`0x${'ff'.repeat(32)}`;await f.run();
  expect(f.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE app_intents'),['SUSPENDED','intent','job',expect.any(String)]);expect(f.store.finishJob).not.toHaveBeenCalled();expect(f.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE app_jobs'),expect.any(Array));
 });
 it.each(['CONFIRMED','MINED','CANCELLED','INVALIDATED','EXPIRED'])('never reevaluates canonical terminal state %s',async status=>{
  const f=await fixture({status});const read=vi.spyOn(f.chain,'account');await f.run();expect(read).not.toHaveBeenCalled();expect(f.query.mock.calls.filter(c=>!String(c[0]).startsWith('SELECT 1'))).toEqual([]);expect(f.store.finishJob).toHaveBeenCalled();
 });
 it('finishes orphaned work without chain calls',async()=>{const f=await fixture();f.store.getIntent.mockResolvedValue(null);const read=vi.spyOn(f.chain,'account');await f.run();expect(read).not.toHaveBeenCalled();expect(f.store.finishJob).toHaveBeenCalled();});
 it('expires before fetching an unavailable oracle',async()=>{const f=await fixture();f.row.body={...f.row.body,validAfter:'1',validUntil:'2'};f.chain.account=async()=>{throw Error('unavailable');};await f.run();expect(f.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE app_intents'),['EXPIRED','intent','job',expect.any(String)]);expect(f.store.retryJob).not.toHaveBeenCalled();});
 it.each([{epoch:1n,revision:0n},{epoch:0n,revision:1n}])('invalidates stale epoch or revision %s',async state=>{const f=await fixture();const snapshot=await f.chain.account(account);f.chain.account=async()=>({...snapshot,...state});await f.run();expect(f.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE app_intents'),['INVALIDATED','intent','job',expect.any(String)]);});
 it.each([{expectedRevision:'1'},{validAfter:String(Math.floor(Date.now()/1000)+500)}])('does not simulate future state %j',async change=>{const f=await fixture();f.row.body={...f.row.body,...change};await f.run();expect(f.chain.simulations).toBe(0);expect(f.query.mock.calls.some(c=>String(c[0]).includes('UPDATE app_intents'))).toBe(false);expect(f.store.finishJob).not.toHaveBeenCalled();});
 it('only advertises eligibility after successful simulation and uses guarded updates',async()=>{const f=await fixture();await f.run();expect(f.chain.simulations).toBe(1);expect(f.query).toHaveBeenCalledWith(expect.stringContaining("status IN ('WAITING','ELIGIBLE','SUSPENDED')"),['ELIGIBLE','intent','job',expect.any(String)]);});
 it('retries transport failure without marking canonical state terminal',async()=>{const f=await fixture();f.chain.quote=async()=>{throw new TypeError('RPC credentials must not be persisted');};await f.run();expect(f.store.retryJob).toHaveBeenCalledWith('job',expect.any(String),'TypeError',expect.any(Number));expect(f.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE app_intents'),['WAITING','intent','job',expect.any(String)]);});
});

describe('worker retry and scheduling faults',()=>{
 it('keeps a valid standing intent retryable after a prolonged outage rather than exhausting its only durable job',async()=>{const f=await fixture();f.store.claimJobs.mockReset().mockResolvedValueOnce([{id:'job',kind:'intent.revalidate',payload:{hash:'intent'},attempts:25}]).mockResolvedValue([]);f.chain.account=async()=>{throw new Error('RPC unavailable');};await f.run();expect(f.query).toHaveBeenCalledWith(expect.stringContaining("attempts=24"),['job',expect.any(String)]);expect(f.store.retryJob).toHaveBeenCalled();});
 it('does not indefinitely retry a malformed durable intent record',async()=>{const f=await fixture();f.row.body={...f.row.body,nonce:'malformed'};f.store.claimJobs.mockReset().mockResolvedValueOnce([{id:'job',kind:'intent.revalidate',payload:{hash:'intent'},attempts:25}]).mockResolvedValue([]);await f.run();expect(f.query.mock.calls.filter(c=>!String(c[0]).startsWith('SELECT 1'))).toEqual([]);expect(f.store.retryJob).toHaveBeenCalled();});

 it('withdraws stale eligibility when current executable depth disappears',async()=>{const f=await fixture({status:'ELIGIBLE'});f.chain.quote=async()=>{throw new Error('no current depth');};await f.run();expect(f.query).toHaveBeenCalledWith(expect.stringContaining("status IN ('WAITING','ELIGIBLE','SUSPENDED')"),['WAITING','intent','job',expect.any(String)]);expect(f.store.retryJob).toHaveBeenCalled();});
 it('redacts non-Error failures when scheduling retries',async()=>{const f=await fixture();f.chain.account=async()=>{throw 'untrusted RPC body';};await f.run();expect(f.store.retryJob).toHaveBeenCalledWith('job',expect.any(String),'REVALIDATION_FAILED',expect.any(Number));});
 it('does not overlap a slow tick and stops only after in-flight work settles',async()=>{const f=await fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const snapshot=await f.chain.account(account);f.chain.account=async()=>{await gate;return snapshot;};const stop=startJobWorker(f.store as unknown as PgStore,f.chain,5);await new Promise(resolve=>setTimeout(resolve,25));expect(f.store.claimJobs).toHaveBeenCalledTimes(1);let stopped=false;const stopping=stop().then(()=>{stopped=true;});await new Promise(resolve=>setTimeout(resolve,10));expect(stopped).toBe(false);release();await stopping;const calls=f.store.claimJobs.mock.calls.length;await new Promise(resolve=>setTimeout(resolve,15));expect(f.store.claimJobs).toHaveBeenCalledTimes(calls);});
 it.each([new Error('password secret'),'untrusted failure'])('logs only a classification for database failure',async failure=>{const f=await fixture();f.store.claimJobs.mockReset().mockRejectedValue(failure);const logged=vi.spyOn(console,'error').mockImplementation(()=>{});const stop=startJobWorker(f.store as unknown as PgStore,f.chain,60000);await vi.waitFor(()=>expect(logged).toHaveBeenCalled());await stop();expect(logged).toHaveBeenCalledWith(JSON.stringify({service:'jobs',error:failure instanceof Error?'Error':'DATABASE_UNAVAILABLE'}));logged.mockRestore();});
 it('skips a claimed batch item whose lease expired while earlier RPC work ran',async()=>{const f=await fixture();f.query.mockResolvedValue({rows:[],rowCount:0});const read=vi.spyOn(f.chain,'account');const stop=startJobWorker(f.store as unknown as PgStore,f.chain,60000);await vi.waitFor(()=>expect(f.query).toHaveBeenCalled());await stop();expect(read).not.toHaveBeenCalled();expect(f.store.getIntent).not.toHaveBeenCalled();expect(f.store.finishJob).not.toHaveBeenCalled();expect(f.store.retryJob).not.toHaveBeenCalled();});

});
