import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { MemoryStore } from './memory-store.js';
import { FakeChain,config as fullConfig,ownerWallet,otherWallet,keeperWallet,account,otherAccount,wireIntent } from './fixtures.js';
import { parseIntent,getIntentTypedData,DomainError } from '../../../packages/domain/src/index.js';
import { keeperTypedData } from '../src/keeper-auth.js';
import {ApiError} from '../src/http.js';
import type { Address,Hex } from 'viem';

const owner = '0x1111111111111111111111111111111111111111';
const config = { chainId:50383, baseUrl:'http://localhost:18180', router:'0x2222222222222222222222222222222222222222', factory:'0x3333333333333333333333333333333333333333', logger:false } as const;
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async()=>{await Promise.all(apps.splice(0).map(a=>a.close()));});
describe('owner authentication',()=>{
  it('issues a domain-bound one-time challenge',async()=>{
    const app=await buildApp({store:new MemoryStore(),chain:new FakeChain(),config});apps.push(app);
    const response=await app.inject({method:'POST',url:'/v1/auth/challenge',payload:{address:owner,chainId:50383}});
    expect(response.statusCode).toBe(201);
    expect(response.json().data.message).toContain('localhost:18180 wants you to sign in');
    expect(response.json().data.challengeId).toBeTypeOf('string');
  });
});

async function setup(entryReady?:()=>Promise<{ready:boolean;reasons:string[]}>){
 const store=new MemoryStore(),chain=new FakeChain();let now=Date.now();
 const app=await buildApp({store,chain,config:fullConfig,now:()=>now,entryReady});apps.push(app);
 async function login(wallet=ownerWallet){
  const c=(await app.inject({method:'POST',url:'/v1/auth/challenge',payload:{address:wallet.address,chainId:50383}})).json().data;
  const signature=await wallet.signMessage({message:c.message});
  const r=await app.inject({method:'POST',url:'/v1/auth/verify',payload:{challengeId:c.challengeId,signature}});
  expect(r.statusCode).toBe(200);return{authorization:`Bearer ${r.json().data.token}`};
 }
 return{app,store,chain,login,now:()=>now,advance:(ms:number)=>{now+=ms;}};
}
describe('session security',()=>{
 it('rejects replay of a valid SIWE signature and stores only token hashes',async()=>{
  const{app,store}=await setup();
  const c=(await app.inject({method:'POST',url:'/v1/auth/challenge',payload:{address:ownerWallet.address,chainId:50383}})).json().data;
  const signature=await ownerWallet.signMessage({message:c.message});
  const body={challengeId:c.challengeId,signature};
  const first=await app.inject({method:'POST',url:'/v1/auth/verify',payload:body});expect(first.statusCode).toBe(200);
  expect(store.sessions.has(first.json().data.token)).toBe(false);
  expect((await app.inject({method:'POST',url:'/v1/auth/verify',payload:body})).statusCode).toBe(401);
 });
 it('expires challenges and sessions',async()=>{
  const s=await setup();const headers=await s.login();s.advance(1800001);
  expect((await s.app.inject({method:'GET',url:'/v1/baskets',headers})).statusCode).toBe(401);
 });
 it('rejects wrong signer without consuming a challenge',async()=>{
  const{app}=await setup();const c=(await app.inject({method:'POST',url:'/v1/auth/challenge',payload:{address:ownerWallet.address,chainId:50383}})).json().data;
  const wrong=await otherWallet.signMessage({message:c.message});
  expect((await app.inject({method:'POST',url:'/v1/auth/verify',payload:{challengeId:c.challengeId,signature:wrong}})).statusCode).toBe(401);
  const correct=await ownerWallet.signMessage({message:c.message});
  expect((await app.inject({method:'POST',url:'/v1/auth/verify',payload:{challengeId:c.challengeId,signature:correct}})).statusCode).toBe(200);
 });
});
describe('tenant and intent boundaries',()=>{
 it('does not expose another owner account',async()=>{const s=await setup();const headers=await s.login();expect((await s.app.inject({method:'GET',url:`/v1/baskets/${otherAccount}`,headers})).statusCode).toBe(404);});
 it('requires authentication for basket actions',async()=>{const s=await setup();expect((await s.app.inject({method:'GET',url:'/v1/baskets'})).statusCode).toBe(401);});
 it('registers accounts only after checking on-chain ownership',async()=>{
  const s=await setup();const headers=await s.login();
  expect((await s.app.inject({method:'POST',url:'/v1/baskets/register',headers,payload:{account,name:'My basket'}})).statusCode).toBe(201);
  expect((await s.app.inject({method:'POST',url:'/v1/baskets/register',headers,payload:{account:otherAccount,name:'Stolen'}})).statusCode).toBe(404);
 });
 it('verifies signed intents, simulates current state, and deduplicates the hash',async()=>{
  const s=await setup();const headers=await s.login();const intent=await wireIntent(s.chain,s.now());
  const signature=await ownerWallet.signTypedData(getIntentTypedData(parseIntent(intent),50383,fullConfig.router));
  const first=await s.app.inject({method:'POST',url:'/v1/intents',headers,payload:{intent,signature}});expect(first.statusCode).toBe(201);expect(first.json().data.status).toBe('ELIGIBLE');
  const second=await s.app.inject({method:'POST',url:'/v1/intents',headers,payload:{intent,signature}});expect(second.statusCode).toBe(200);expect(second.json().data.hash).toBe(first.json().data.hash);expect(s.store.intents.size).toBe(1);
 });
 it('never presents a future-revision intent as simulated',async()=>{
  const s=await setup();const headers=await s.login();const intent=await wireIntent(s.chain,s.now(),{expectedRevision:'1'});const signature=await ownerWallet.signTypedData(getIntentTypedData(parseIntent(intent),50383,fullConfig.router));
  const result=await s.app.inject({method:'POST',url:'/v1/intents',headers,payload:{intent,signature}});expect(result.statusCode).toBe(201);expect(result.json().data.status).toBe('WAITING');expect(s.chain.simulations).toBe(0);
 });
 it('marks HTTP cancellation requested, not cancelled',async()=>{
  const s=await setup();const headers=await s.login();const intent=await wireIntent(s.chain,s.now());const signature=await ownerWallet.signTypedData(getIntentTypedData(parseIntent(intent),50383,fullConfig.router));const first=await s.app.inject({method:'POST',url:'/v1/intents',headers,payload:{intent,signature}});
  const result=await s.app.inject({method:'POST',url:`/v1/intents/${first.json().data.hash}/cancel/prepare`,headers,payload:{}});expect(result.statusCode).toBe(200);expect(result.json().data.status).toBe('CANCEL_REQUESTED');expect([...s.store.intents.values()][0]?.status).toBe('CANCEL_REQUESTED');
 });
 it('rejects JSON numbers in on-chain integer fields',async()=>{
  const s=await setup();const headers=await s.login();const intent=await wireIntent(s.chain,s.now());expect((await s.app.inject({method:'POST',url:'/v1/intents',headers,payload:{intent:{...intent,nonce:1},signature:'0x1234'}})).statusCode).toBe(400);
 });
});
describe('keeper authorization',()=>{
 it('scopes feed access and revokes an existing keeper session',async()=>{
  const s=await setup();const headers=await s.login();const unsigned={owner:ownerWallet.address,keeper:keeperWallet.address,accounts:[account],chainId:50383,validUntil:String(Math.floor(s.now()/1000)+1000),nonce:'1'};const signature=await ownerWallet.signTypedData(keeperTypedData(unsigned,fullConfig.router));const authorization={...unsigned,signature};
  const challenge=await s.app.inject({method:'POST',url:'/v1/keeper/session/challenge',payload:{authorization}});expect(challenge.statusCode).toBe(201);const c=challenge.json().data;
  const login=await s.app.inject({method:'POST',url:'/v1/keeper/session',payload:{challengeId:c.challengeId,signature:await keeperWallet.signMessage({message:c.message})}});expect(login.statusCode).toBe(200);const keeperHeaders={authorization:`Bearer ${login.json().data.token}`};
  expect((await s.app.inject({method:'GET',url:'/v1/keeper/intents',headers:keeperHeaders})).statusCode).toBe(200);
  expect((await s.app.inject({method:'POST',url:'/v1/baskets/register',headers:keeperHeaders,payload:{account,name:'No permission'}})).statusCode).toBe(403);
  const authId=[...s.store.authorizations.keys()][0]!;
  expect((await s.app.inject({method:'DELETE',url:`/v1/keepers/authorizations/${authId}`,headers})).statusCode).toBe(200);
  expect((await s.app.inject({method:'GET',url:'/v1/keeper/intents',headers:keeperHeaders})).statusCode).toBe(401);
  expect((await s.app.inject({method:'POST',url:'/v1/keeper/session/challenge',payload:{authorization}})).statusCode).toBe(409);
 });
});

describe('standing intent with temporarily unavailable depth',()=>{
 it('stores a valid signed intent as WAITING without claiming simulation passed',async()=>{
  const s=await setup(),headers=await s.login(),intent=await wireIntent(s.chain,s.now());
  const signature=await ownerWallet.signTypedData(getIntentTypedData(parseIntent(intent),50383,fullConfig.router));
  s.chain.quote=async()=>{throw new Error('temporary depth unavailable');};
  const result=await s.app.inject({method:'POST',url:'/v1/intents',headers,payload:{intent,signature}});
  expect(result.statusCode).toBe(201);expect(result.json().data.status).toBe('WAITING');expect(result.json().data.simulation.status).toBe('deferred');
 });
});

describe('protective actions during an oracle outage',()=>{
 it('prepares on-chain cancellation and account invalidation using ownership reads only',async()=>{
  const s=await setup(),headers=await s.login(),intent=await wireIntent(s.chain,s.now());
  const signature=await ownerWallet.signTypedData(getIntentTypedData(parseIntent(intent),50383,fullConfig.router));
  const stored=await s.app.inject({method:'POST',url:'/v1/intents',headers,payload:{intent,signature}});
  Object.assign(s.chain,{ownerOf:async()=>ownerWallet.address});s.chain.account=async()=>{throw new Error('Oracle unavailable');};
  const cancel=await s.app.inject({method:'POST',url:`/v1/intents/${stored.json().data.hash}/cancel/prepare`,headers,payload:{}});expect(cancel.statusCode).toBe(200);
  const invalidate=await s.app.inject({method:'POST',url:`/v1/baskets/${account}/actions/prepare`,headers,payload:{action:'invalidate'}});expect(invalidate.statusCode).toBe(200);
 });
});

describe('malformed HTTP request classification',()=>{
 it('returns 400 for malformed JSON without exposing parser internals',async()=>{const s=await setup();const result=await s.app.inject({method:'POST',url:'/v1/auth/challenge',headers:{'content-type':'application/json'},payload:'{"address":'});expect(result.statusCode).toBe(400);expect(result.json().error.code).toBe('INVALID_REQUEST');});
 it('enforces the body cap with a client error',async()=>{const s=await setup();const result=await s.app.inject({method:'POST',url:'/v1/auth/challenge',headers:{'content-type':'application/json'},payload:JSON.stringify({padding:'x'.repeat(66000)})});expect(result.statusCode).toBe(413);expect(result.json().error.code).toBe('PAYLOAD_TOO_LARGE');});
});

describe('authentication expiry and revocation boundaries',()=>{
 it('rejects a challenge at its exact expiry and does not consume it',async()=>{const s=await setup();const c=(await s.app.inject({method:'POST',url:'/v1/auth/challenge',payload:{address:ownerWallet.address,chainId:50383}})).json().data;s.advance(300000);const result=await s.app.inject({method:'POST',url:'/v1/auth/verify',payload:{challengeId:c.challengeId,signature:await ownerWallet.signMessage({message:c.message})}});expect(result.statusCode).toBe(401);expect(s.store.challenges.get(c.challengeId)?.consumedAt).toBeNull();});
 it('rejects unsupported challenge chains before storing state',async()=>{const s=await setup();expect((await s.app.inject({method:'POST',url:'/v1/auth/challenge',payload:{address:ownerWallet.address,chainId:1}})).json().error.code).toBe('CHAIN_UNSUPPORTED');expect(s.store.challenges.size).toBe(0);});
 it.each(['Basic abc','Bearer short',`Bearer ${'a'.repeat(43)}`])('rejects invalid or unknown credentials %s',async authorization=>{const s=await setup();expect((await s.app.inject({method:'GET',url:'/v1/baskets',headers:{authorization}})).statusCode).toBe(401);});
 it('revokes a session immediately and does not accept its old token',async()=>{const s=await setup(),headers=await s.login();expect((await s.app.inject({method:'DELETE',url:'/v1/auth/session',headers})).statusCode).toBe(200);expect((await s.app.inject({method:'GET',url:'/v1/baskets',headers})).statusCode).toBe(401);});
 it('rejects sessions bound to a different chain',async()=>{const s=await setup(),headers=await s.login();for(const [hash,session]of s.store.sessions)s.store.sessions.set(hash,{...session,chainId:1});expect((await s.app.inject({method:'GET',url:'/v1/baskets',headers})).statusCode).toBe(401);});
 it.each(['revoked','expired','wrong role'])('cannot exchange a keeper challenge after %s',async kind=>{const s=await setup(),headers=await s.login();const unsigned={owner:ownerWallet.address,keeper:keeperWallet.address,accounts:[account],chainId:50383,validUntil:String(Math.floor(s.now()/1000)+100),nonce:'5'};const authorization={...unsigned,signature:await ownerWallet.signTypedData(keeperTypedData(unsigned,fullConfig.router))};const c=(await s.app.inject({method:'POST',url:'/v1/keeper/session/challenge',payload:{authorization}})).json().data;if(kind==='revoked')await s.app.inject({method:'DELETE',url:`/v1/keepers/authorizations/${[...s.store.authorizations.keys()][0]!}`,headers});if(kind==='expired')s.advance(100000);const result=await s.app.inject({method:'POST',url:kind==='wrong role'?'/v1/auth/verify':'/v1/keeper/session',payload:{challengeId:c.challengeId,signature:await keeperWallet.signMessage({message:c.message})}});expect(result.statusCode).toBe(401);expect([...s.store.sessions.values()].filter(v=>v.role==='keeper')).toHaveLength(0);});
 it.each([{chainId:1},{validUntil:'1'},{validUntil:(2n**64n).toString()},{nonce:(2n**256n).toString()},{accounts:[account,account.toUpperCase().replace('0X','0x') as Address]}])('rejects an invalid keeper certificate before registration %j',async change=>{const s=await setup(),headers=await s.login();const cert={owner:ownerWallet.address,keeper:keeperWallet.address,accounts:[account],chainId:50383,validUntil:String(Math.floor(s.now()/1000)+100),nonce:'5',signature:'0x1234',...change};const result=await s.app.inject({method:'POST',url:'/v1/keepers/authorizations',headers,payload:cert});expect(result.statusCode).toBe(400);expect(s.store.authorizations.size).toBe(0);});
 it('rejects owner certificates attempting to grant access to another owner account',async()=>{const s=await setup(),headers=await s.login();const unsigned={owner:otherWallet.address,keeper:keeperWallet.address,accounts:[otherAccount],chainId:50383,validUntil:String(Math.floor(s.now()/1000)+100),nonce:'5'};const result=await s.app.inject({method:'POST',url:'/v1/keepers/authorizations',headers,payload:{...unsigned,signature:await otherWallet.signTypedData(keeperTypedData(unsigned,fullConfig.router))}});expect(result.statusCode).toBe(403);});
});

describe('signed intent rejection and deferral policy',()=>{
 async function submit(s:Awaited<ReturnType<typeof setup>>,change:Parameters<typeof wireIntent>[2]={}){const headers=await s.login(),intent=await wireIntent(s.chain,s.now(),change);return s.app.inject({method:'POST',url:'/v1/intents',headers,payload:{intent,signature:await ownerWallet.signTypedData(getIntentTypedData(parseIntent(intent),50383,fullConfig.router))}});}
 it('rejects an expired signed intent without persistence',async()=>{const s=await setup();expect((await submit(s,{validAfter:'1',validUntil:'2'})).json().error.code).toBe('INTENT_EXPIRED');expect(s.store.intents.size).toBe(0);});
 it('rejects a stale epoch',async()=>{const s=await setup();expect((await submit(s,{epoch:'1'})).json().error.code).toBe('INTENT_STALE');});
 it('rejects a consumed nonce before quote or simulation',async()=>{const s=await setup();s.chain.nonceUsed=async()=>true;expect((await submit(s)).json().error.code).toBe('NONCE_USED');expect(s.chain.simulations).toBe(0);});
 it('rejects changed positions even before a future activation time',async()=>{const s=await setup();expect((await submit(s,{expectedPositionsHash:`0x${'ff'.repeat(32)}`,validAfter:String(Math.floor(s.now()/1000)+5)})).json().error.code).toBe('POSITIONS_CHANGED');});
 it('waits for future activation without attempting simulation',async()=>{const s=await setup();const result=await submit(s,{validAfter:String(Math.floor(s.now()/1000)+500)});expect(result.statusCode).toBe(201);expect(result.json().data.status).toBe('WAITING');expect(s.chain.simulations).toBe(0);});
 it('does not leak internal RPC or database errors',async()=>{const s=await setup();s.chain.markets=async()=>{throw Error('postgresql://supersecret@private');};const result=await s.app.inject('/v1/markets');expect(result.statusCode).toBe(500);expect(result.body).not.toContain('supersecret');expect(result.json().error.code).toBe('INTERNAL_ERROR');});
 it('rejects an arbitrary router authorization even for a valid owner',async()=>{const s=await setup(),headers=await s.login();const result=await s.app.inject({method:'POST',url:`/v1/baskets/${account}/actions/prepare`,headers,payload:{action:'authorize',router:otherAccount,pools:[account],approved:true}});expect(result.json().error.code).toBe('ROUTER_UNSUPPORTED');});
 it('does not allow cross-owner protective operations during oracle failure',async()=>{const s=await setup(),headers=await s.login();Object.assign(s.chain,{ownerOf:async()=>otherWallet.address});s.chain.account=async()=>{throw Error('oracle down');};expect((await s.app.inject({method:'POST',url:`/v1/baskets/${account}/actions/prepare`,headers,payload:{action:'invalidate'}})).statusCode).toBe(404);});
});

describe('readiness and simulation error policy',()=>{
 it('rejects cancellation preparation of an already mined intent without reporting a cancellation request',async()=>{
  const s=await setup(),headers=await s.login(),intent=await wireIntent(s.chain,s.now());
  const submitted=await s.app.inject({method:'POST',url:'/v1/intents',headers,payload:{intent,signature:await ownerWallet.signTypedData(getIntentTypedData(parseIntent(intent),50383,fullConfig.router))}});
  const hash=submitted.json().data.hash,stored=s.store.intents.get(hash)!;s.store.intents.set(hash,{...stored,status:'MINED'});
  const cancelled=await s.app.inject({method:'POST',url:`/v1/intents/${hash}/cancel/prepare`,headers,payload:{}});
  expect(cancelled.statusCode).toBe(409);expect(cancelled.json().error.code).toBe('INTENT_TERMINAL');expect(cancelled.json().data).toBeUndefined();expect(s.store.intents.get(hash)?.status).toBe('MINED');
 });
 it('blocks entry but retains close and protective transaction preparation during readiness failure',async()=>{const s=await setup(async()=>({ready:false,reasons:['indexer behind']})),headers=await s.login(),intent=await wireIntent(s.chain,s.now());const quote=await s.app.inject({method:'POST',url:'/v1/quotes',headers,payload:{intent}});expect(quote.statusCode).toBe(503);expect(quote.json().error.code).toBe('ENTRY_SUSPENDED');const close=await s.app.inject({method:'POST',url:'/v1/quotes',headers,payload:{intent:{...intent,operation:2}}});expect(close.statusCode).toBe(200);expect((await s.app.inject('/health/ready')).statusCode).toBe(503);expect((await s.app.inject('/health/live')).statusCode).toBe(200);});
 it('prepares exact user-selected constraints and safe defaults before signing',async()=>{const s=await setup(async()=>({ready:true,reasons:[]})),headers=await s.login(),wire=await wireIntent(s.chain,s.now());const {account:address,executor,nonce,operation,legs}=wire;const minimal=await s.app.inject({method:'POST',url:'/v1/intents/prepare',headers,payload:{account:address,executor,nonce,operation,legs}});expect(minimal.statusCode).toBe(200);expect(minimal.json().data.intent).toMatchObject({epoch:'0',expectedRevision:'0',expectedPositionsHash:wire.expectedPositionsHash,minPostHealthBps:20000});const exact=await s.app.inject({method:'POST',url:'/v1/intents/prepare',headers,payload:wire});expect(exact.statusCode).toBe(200);expect(exact.json().data.intent).toEqual(wire);});
 it.each(['LOT_SIZE','UNSUPPORTED_MARKET','INVALID_LEG','INVALID_QUOTE'])('rejects permanent quote defect %s without creating a standing intent',async code=>{const s=await setup(),headers=await s.login(),intent=await wireIntent(s.chain,s.now());s.chain.quote=async()=>{throw new DomainError(code,'Invalid market constraints');};const result=await s.app.inject({method:'POST',url:'/v1/intents',headers,payload:{intent,signature:await ownerWallet.signTypedData(getIntentTypedData(parseIntent(intent),50383,fullConfig.router))}});expect(result.statusCode).toBe(400);expect(result.json().error.code).toBe(code);expect(s.store.intents.size).toBe(0);});
 it.each([new DomainError('DEPTH_UNAVAILABLE','temporary'),new ApiError(503,'RPC_UNAVAILABLE','temporary')])('retains recoverable simulation errors as explicitly deferred',async error=>{const s=await setup(),headers=await s.login(),intent=await wireIntent(s.chain,s.now());s.chain.simulate=async()=>{throw error;};const result=await s.app.inject({method:'POST',url:'/v1/intents',headers,payload:{intent,signature:await ownerWallet.signTypedData(getIntentTypedData(parseIntent(intent),50383,fullConfig.router))}});expect(result.statusCode).toBe(201);expect(result.json().data).toMatchObject({status:'WAITING',simulation:{status:'deferred',reason:error.code}});});
 it('does not accept a signature from another owner',async()=>{const s=await setup(),headers=await s.login(),intent=await wireIntent(s.chain,s.now());const result=await s.app.inject({method:'POST',url:'/v1/intents',headers,payload:{intent,signature:await otherWallet.signTypedData(getIntentTypedData(parseIntent(intent),50383,fullConfig.router))}});expect(result.json().error.code).toBe('SIGNATURE_INVALID');expect(s.store.intents.size).toBe(0);});
 it('keeps intent reads and cancellation scoped by owner and canonical terminal state',async()=>{const s=await setup(),headers=await s.login(),intent=await wireIntent(s.chain,s.now());const result=await s.app.inject({method:'POST',url:'/v1/intents',headers,payload:{intent,signature:await ownerWallet.signTypedData(getIntentTypedData(parseIntent(intent),50383,fullConfig.router))}});const hash=result.json().data.hash,otherHeaders=await s.login(otherWallet);expect((await s.app.inject({method:'GET',url:`/v1/intents/${hash}`,headers})).statusCode).toBe(200);for(const method of ['GET','POST']as const)expect((await s.app.inject({method,url:`/v1/intents/${hash}${method==='POST'?'/cancel/prepare':''}`,headers:otherHeaders,...(method==='POST'?{payload:{}}:{})})).statusCode).toBe(404);const stored=s.store.intents.get(hash)!;s.store.intents.set(hash,{...stored,status:'CONFIRMED'});expect((await s.app.inject({method:'POST',url:`/v1/intents/${hash}/cancel/prepare`,headers,payload:{}})).statusCode).toBe(409);expect((await s.app.inject({method:'GET',url:'/v1/intents?limit=1',headers})).json().data.items).toHaveLength(1);});
});

describe('keeper execution API scope',()=>{
 async function keeperSetup(){const s=await setup(),headers=await s.login();const unsigned={owner:ownerWallet.address,keeper:keeperWallet.address,accounts:[account],chainId:50383,validUntil:String(Math.floor(s.now()/1000)+1000),nonce:'99'};const authorization={...unsigned,signature:await ownerWallet.signTypedData(keeperTypedData(unsigned,fullConfig.router))};const c=(await s.app.inject({method:'POST',url:'/v1/keeper/session/challenge',payload:{authorization}})).json().data;const login=await s.app.inject({method:'POST',url:'/v1/keeper/session',payload:{challengeId:c.challengeId,signature:await keeperWallet.signMessage({message:c.message})}});const keeperHeaders={authorization:`Bearer ${login.json().data.token}`};const intent=await wireIntent(s.chain,s.now()),saved=await s.app.inject({method:'POST',url:'/v1/intents',headers,payload:{intent,signature:await ownerWallet.signTypedData(getIntentTypedData(parseIntent(intent),50383,fullConfig.router))}});return{...s,headers,keeperHeaders,hash:saved.json().data.hash as Hex};}
 it('provides signed assigned intents and records verified reports without canonical confirmation',async()=>{const s=await keeperSetup();const feed=await s.app.inject({method:'GET',url:'/v1/keeper/intents?limit=1',headers:s.keeperHeaders});expect(feed.json().data.items[0].hash).toBe(s.hash);expect((await s.app.inject({method:'POST',url:'/v1/keeper/heartbeat',headers:s.keeperHeaders,payload:{}})).statusCode).toBe(200);const result=await s.app.inject({method:'POST',url:'/v1/keeper/executions',headers:s.keeperHeaders,payload:{hash:s.hash,txHash:`0x${'ab'.repeat(32)}`}});expect(result.statusCode).toBe(202);expect(s.store.intents.get(s.hash)?.status).toBe('ELIGIBLE');const list=await s.app.inject({method:'GET',url:`/v1/executions?account=${account}`,headers:s.headers});expect(list.json().data.items).toHaveLength(1);expect((await s.app.inject({method:'GET',url:'/v1/keepers/authorizations',headers:s.headers})).json().data.items).toHaveLength(1);});
 it.each(['owner','chain','executor','account'])('rejects reports after assigned intent %s scope changes',async kind=>{const s=await keeperSetup(),row=s.store.intents.get(s.hash)!;const changes={owner:{owner:otherWallet.address},chain:{chainId:1},executor:{executor:otherWallet.address},account:{account:otherAccount}};s.store.intents.set(s.hash,{...row,...changes[kind as keyof typeof changes]});const result=await s.app.inject({method:'POST',url:'/v1/keeper/executions',headers:s.keeperHeaders,payload:{hash:s.hash,txHash:`0x${'ab'.repeat(32)}`}});expect(result.statusCode).toBe(404);expect(s.store.executions.size).toBe(0);});
 it('rejects owner session on keeper endpoints and malformed execution cursors before storage',async()=>{const s=await setup(),headers=await s.login();expect((await s.app.inject({method:'GET',url:'/v1/keeper/intents',headers})).statusCode).toBe(403);expect((await s.app.inject({method:'GET',url:'/v1/executions?cursor=invalid',headers})).statusCode).toBe(400);});
 it('paginates assigned signatures without skipping the next intent and supports unfiltered execution history',async()=>{const s=await keeperSetup(),intent=await wireIntent(s.chain,s.now(),{nonce:'2'});expect((await s.app.inject({method:'POST',url:'/v1/intents',headers:s.headers,payload:{intent,signature:await ownerWallet.signTypedData(getIntentTypedData(parseIntent(intent),50383,fullConfig.router))}})).statusCode).toBe(201);const first=(await s.app.inject({method:'GET',url:'/v1/keeper/intents?limit=1',headers:s.keeperHeaders})).json().data;expect(first.items).toHaveLength(1);expect(first.nextCursor).toBe(first.items[0].hash);const second=(await s.app.inject({method:'GET',url:`/v1/keeper/intents?limit=1&cursor=${first.nextCursor}`,headers:s.keeperHeaders})).json().data;expect(second.items).toHaveLength(1);expect(second.items[0].hash).not.toBe(first.items[0].hash);expect(second.nextCursor).toBeNull();expect((await s.app.inject({method:'GET',url:'/v1/executions',headers:s.headers})).json().data.items).toEqual([]);});
 it.each(['feed','report'])('fails closed if the authorization disappears between authentication and %s processing',async kind=>{const s=await keeperSetup(),original=s.store.getAuthorization.bind(s.store);let calls=0;s.store.getAuthorization=async id=>++calls===1?original(id):null;const result=await s.app.inject({method:kind==='feed'?'GET':'POST',url:kind==='feed'?'/v1/keeper/intents':'/v1/keeper/executions',headers:s.keeperHeaders,...(kind==='report'?{payload:{hash:s.hash,txHash:`0x${'ab'.repeat(32)}`}}:{})});expect(result.statusCode).toBe(kind==='feed'?401:404);expect(s.store.executions.size).toBe(0);});
 it('rejects reports for missing intents before validating transaction evidence',async()=>{const s=await keeperSetup();const result=await s.app.inject({method:'POST',url:'/v1/keeper/executions',headers:s.keeperHeaders,payload:{hash:`0x${'ff'.repeat(32)}`,txHash:`0x${'ab'.repeat(32)}`}});expect(result.statusCode).toBe(404);expect(s.store.executions.size).toBe(0);});

});

describe('authorization race and validation failures',()=>{
 it('rejects a challenge when a concurrent verifier wins atomic consumption',async()=>{const s=await setup(),c=(await s.app.inject({method:'POST',url:'/v1/auth/challenge',payload:{address:ownerWallet.address,chainId:50383}})).json().data;s.store.consumeChallenge=async()=>false;const result=await s.app.inject({method:'POST',url:'/v1/auth/verify',payload:{challengeId:c.challengeId,signature:await ownerWallet.signMessage({message:c.message})}});expect(result.statusCode).toBe(401);expect(s.store.sessions.size).toBe(0);});
 it('rejects missing challenges and nonexistent revocations',async()=>{const s=await setup(),headers=await s.login();expect((await s.app.inject({method:'POST',url:'/v1/auth/verify',payload:{challengeId:'00000000-0000-4000-8000-000000000000',signature:'0x1234'}})).statusCode).toBe(401);expect((await s.app.inject({method:'DELETE',url:`/v1/keepers/authorizations/0x${'ff'.repeat(32)}`,headers})).statusCode).toBe(404);});
 it('normalizes account casing before duplicate certificate checks',async()=>{const s=await setup();const a=`0x${'a'.repeat(40)}`,b=`0x${'A'.repeat(40)}`;const result=await s.app.inject({method:'POST',url:'/v1/keeper/session/challenge',payload:{authorization:{owner:ownerWallet.address,keeper:keeperWallet.address,accounts:[a,b],chainId:50383,validUntil:String(Math.floor(s.now()/1000)+100),nonce:'1',signature:'0x1234'}}});expect(result.json().error.code).toBe('AUTHORIZATION_INVALID');});
 it('rejects a keeper certificate signed by the keeper instead of its owner',async()=>{const s=await setup();const unsigned={owner:ownerWallet.address,keeper:keeperWallet.address,accounts:[account],chainId:50383,validUntil:String(Math.floor(s.now()/1000)+100),nonce:'1'};const result=await s.app.inject({method:'POST',url:'/v1/keeper/session/challenge',payload:{authorization:{...unsigned,signature:await keeperWallet.signTypedData(keeperTypedData(unsigned,fullConfig.router))}}});expect(result.json().error.code).toBe('SIGNATURE_INVALID');});
 it('keeps unexpected authorization storage errors as server faults',async()=>{const s=await setup();s.store.putAuthorization=async()=>{throw Error('secret database error');};const unsigned={owner:ownerWallet.address,keeper:keeperWallet.address,accounts:[account],chainId:50383,validUntil:String(Math.floor(s.now()/1000)+100),nonce:'1'};const result=await s.app.inject({method:'POST',url:'/v1/keeper/session/challenge',payload:{authorization:{...unsigned,signature:await ownerWallet.signTypedData(keeperTypedData(unsigned,fullConfig.router))}}});expect(result.statusCode).toBe(500);expect(result.body).not.toContain('secret');});
});

describe('HTTP operations and infrastructure boundaries',()=>{
 it('serves machine-readable identity, health, metrics and documented API contracts',async()=>{const s=await setup();expect((await s.app.inject('/health/ready')).json().data.status).toBe('ready');expect((await s.app.inject('/v1/info')).json().data).toMatchObject({chainId:50383,router:fullConfig.router,custody:'user-controlled'});const spec=(await s.app.inject('/openapi.json')).json();expect(spec.paths['/v1/intents']).toBeDefined();expect(spec.components.securitySchemes.bearerAuth).toMatchObject({type:'http',scheme:'bearer'});const metrics=await s.app.inject('/metrics');expect(metrics.headers['content-type']).toContain('text/plain');expect(metrics.body).toContain('spreadlock_api_requests_total 3');});
 it('prepares factory calldata and reads owner positions through authenticated routes',async()=>{const s=await setup(),headers=await s.login();expect((await s.app.inject({method:'POST',url:'/v1/baskets/prepare',headers,payload:{salt:`0x${'ab'.repeat(32)}`}})).json().data.to).toBe(fullConfig.factory);const positions=await s.app.inject({method:'GET',url:`/v1/baskets/${account}/positions`,headers});expect(positions.json().data).toEqual({items:[],equity:'1000',initialMargin:'10',maintenanceMargin:'5'});});
 it('rejects mismatched chain configuration at startup',async()=>{await expect(buildApp({store:new MemoryStore(),chain:new FakeChain(),config:{...fullConfig,chainId:1}})).rejects.toThrow('Chain configuration mismatch');});
 it('classifies unsupported body encodings as client errors',async()=>{const s=await setup();const result=await s.app.inject({method:'POST',url:'/v1/auth/challenge',headers:{'content-type':'application/octet-stream'},payload:'untrusted bytes'});expect(result.statusCode).toBe(415);expect(result.json().error.code).toBe('INVALID_REQUEST');});
 it('enforces request quotas even when the client forges forwarded IP headers',async()=>{const app=await buildApp({store:new MemoryStore(),chain:new FakeChain(),config:{...fullConfig,development:true,rateLimitMax:1}});apps.push(app);expect((await app.inject({url:'/v1/info',headers:{'x-forwarded-for':'198.51.100.1'}})).statusCode).toBe(200);const result=await app.inject({url:'/v1/info',headers:{'x-forwarded-for':'198.51.100.2'}});expect(result.statusCode).toBe(429);expect(result.json().error.code).toBe('RATE_LIMITED');});
 it('marks readiness unavailable when persistence fails while preserving liveness',async()=>{const s=await setup();s.store.ready=async()=>{throw Error('database unavailable');};expect((await s.app.inject('/health/ready')).statusCode).toBe(500);expect((await s.app.inject('/health/live')).statusCode).toBe(200);expect((await s.app.inject('/metrics')).body).toContain('spreadlock_api_errors_total 1');});
});

describe('operator readiness diagnostics',()=>{
 const metrics={headBlock:'1234',checkpointBlock:'1200',lagBlocks:'34',lagSeconds:'20',heartbeatAgeSeconds:2.5};
 it.each([true,false])('exposes lag metrics while entry readiness is %s',async ready=>{const s=await setup(async()=>({ready,reasons:ready?[]:['INDEXER_BLOCK_LAG'],metrics}));const health=await s.app.inject('/health/ready');expect(health.statusCode).toBe(ready?200:503);expect(health.json().data.metrics).toEqual(metrics);if(!ready)expect(health.json().error.code).toBe('NOT_READY');const scrape=await s.app.inject('/metrics');expect(scrape.statusCode).toBe(200);expect(scrape.body).toContain(`spreadlock_entry_ready ${ready?1:0}`);expect(scrape.body).toContain('spreadlock_indexer_lag_blocks 34');expect(scrape.body).toContain('spreadlock_indexer_lag_seconds 20');expect(scrape.body).toContain('spreadlock_indexer_heartbeat_age_seconds 2.5');const headers=await s.login();expect((await s.app.inject({method:'POST',url:`/v1/baskets/${account}/actions/prepare`,headers,payload:{action:'invalidate'}})).statusCode).toBe(200);});
 it('retains basic telemetry and emits entry_ready0 when readiness diagnostics throw',async()=>{const s=await setup(async()=>{throw Error('unavailable readiness source');});const result=await s.app.inject('/metrics');expect(result.statusCode).toBe(200);expect(result.body).toContain('spreadlock_entry_ready 0');expect(result.body).toContain('spreadlock_api_requests_total');expect(result.body).not.toContain('unavailable readiness source');});
});
