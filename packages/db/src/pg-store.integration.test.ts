import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {PgStore} from './pg-store.js';
import {migrate} from './migrate.js';
const url=process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('PostgreSQL durable security and job leases',()=>{
 let store:PgStore;const id=randomUUID(),now=Date.now(),owner='0x1111111111111111111111111111111111111111' as const;
 beforeAll(async()=>{store=new PgStore(url!);await migrate(store.pool);});afterAll(async()=>{await store.pool.query('DELETE FROM app_challenges WHERE id=$1',[id]);await store.close();});
 it('consumes a challenge atomically exactly once',async()=>{
  await store.createChallenge({id,owner,signer:owner,chainId:31337,message:'test',role:'owner',authorizationId:null,expiresAt:now+60000,consumedAt:null});
  const r=await Promise.all(Array.from({length:8},()=>store.consumeChallenge(id,now)));expect(r.filter(Boolean)).toHaveLength(1);
 });
 it('uses hashed sessions and rejects cross-owner basket registration',async()=>{
  const hash='a'.repeat(64);await store.createSession({tokenHash:hash,owner,signer:owner,chainId:31337,role:'owner',authorizationId:null,expiresAt:now+60000});expect((await store.getSession(hash))?.owner).toBe(owner);await store.deleteSession(hash);expect(await store.getSession(hash)).toBeNull();
  const account='0x'+randomUUID().replaceAll('-','').padEnd(40,'0') as `0x${string}`;await store.putBasket({id:account,owner,account,chainId:31337,name:'one',createdAt:now});
  await expect(store.putBasket({id:account,owner:'0x2222222222222222222222222222222222222222',account,chainId:31337,name:'takeover',createdAt:now})).rejects.toThrow('BASKET_OWNER_CONFLICT');
  await store.pool.query('DELETE FROM app_baskets WHERE account=$1',[account]);
 });
 it('does not lease the same due job to concurrent workers',async()=>{
  const key=randomUUID();await store.enqueueJob('test',key,{},now);
  const batches=await Promise.all(['a','b','c'].map(w=>store.claimJobs(w,now,100)));
  const ids=batches.flat().map(j=>j.id);expect(new Set(ids).size).toBe(ids.length);
  await store.pool.query('DELETE FROM app_jobs WHERE dedupe_key=$1',[key]);
 });
});
