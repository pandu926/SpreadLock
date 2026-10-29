import {afterEach, describe, expect, it, vi} from 'vitest';
import {createSiweMessage} from 'viem/siwe';
import {ApiIntentFeed} from './api.js';
import type {KeeperRuntimeConfig} from './config.js';
import type {KeeperSigner, SignedIntent} from './types.js';

const address='0x1111111111111111111111111111111111111111';
const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const item=(n:number)=>({hash:hash(n),intent:{},signature:'0x12'}) as unknown as SignedIntent;
const config={apiBaseUrl:'https://api.example',manifest:{chainId:50383},authorization:{}} as KeeperRuntimeConfig;
const signer:KeeperSigner={address,signMessage:vi.fn(async()=> '0x12' as const),signTransaction:vi.fn()};
const response=(data:unknown,status=200)=>new Response(JSON.stringify({success:true,data}),{status});
function mockApi(pages:(path:string)=>Response){
 const fetcher=vi.fn(async(input:string)=>{
  const path=new URL(input).pathname;
  if(path==='/v1/keeper/session/challenge')return response({challengeId:'challenge',message:createSiweMessage({domain:'api.example',address,statement:'Sign in as a SpreadLock keeper for authorization test.',uri:'https://api.example',version:'1',chainId:50383,nonce:'12345678',issuedAt:new Date(),expirationTime:new Date(Date.now()+60000)})});
  if(path==='/v1/keeper/session')return response({token:'session',expiresAt:Date.now()+60000});
  return pages(input);
 });vi.stubGlobal('fetch',fetcher);return fetcher;
}
afterEach(()=>vi.unstubAllGlobals());
describe('keeper feed API failure boundaries',()=>{
 it('walks bounded pages so an active first page cannot starve later assignments, then rescans',async()=>{
  const fetcher=mockApi(url=>new URL(url).searchParams.get('cursor')===hash(100)?response({items:[item(101)],nextCursor:null}):response({items:Array.from({length:100},(_,n)=>item(n+1)),nextCursor:hash(100)}));
  const feed=new ApiIntentFeed(config,signer);
  expect(await feed.fetch()).toHaveLength(100);
  expect((await feed.fetch()).map(value=>value.hash)).toEqual([hash(101)]);
  expect(await feed.fetch()).toHaveLength(100);
  const urls=fetcher.mock.calls.map(([url])=>url).filter(url=>url.includes('/intents'));
  expect(new URL(urls[0]!).searchParams.get('limit')).toBe('100');
  expect(new URL(urls[1]!).searchParams.get('cursor')).toBe(hash(100));
  expect(new URL(urls[2]!).searchParams.has('cursor')).toBe(false);
 });
 it.each([{items:[],nextCursor:hash(1)},{items:[item(1)],nextCursor:'attacker/path'},{items:[item(1)],nextCursor:hash(2)},{items:Array.from({length:101},()=>item(1)),nextCursor:null}])('rejects malformed or nonprogressing pages without advancing its cursor',async page=>{
  mockApi(()=>response(page));await expect(new ApiIntentFeed(config,signer).fetch()).rejects.toThrow(/feed|cursor/i);
 });
 it('rejects a repeated continuation cursor instead of cycling forever',async()=>{
  mockApi(()=>response({items:[item(1)],nextCursor:hash(1)}));const feed=new ApiIntentFeed(config,signer);
  await feed.fetch();await expect(feed.fetch()).rejects.toThrow(/cursor/i);
 });
 it('does not advance past a failed page and refreshes authentication after HTTP 401',async()=>{
  let calls=0;const fetcher=mockApi(()=>++calls===1?response({items:[item(1)],nextCursor:hash(1)}):calls===2?response({},401):response({items:[item(2)],nextCursor:null}));const feed=new ApiIntentFeed(config,signer);
  await feed.fetch();await expect(feed.fetch()).rejects.toThrow('401');expect((await feed.fetch())[0]?.hash).toBe(hash(2));
  expect(fetcher.mock.calls.filter(([url])=>url.endsWith('/challenge'))).toHaveLength(2);
  expect(new URL(fetcher.mock.calls.at(-1)![0]).searchParams.get('cursor')).toBe(hash(1));
 });
 it('enforces the streamed response limit before JSON decoding',async()=>{
  mockApi(()=>new Response(' '.repeat(2_000_001)));await expect(new ApiIntentFeed(config,signer).fetch()).rejects.toThrow('exceeds limit');
 });
 it('posts authenticated heartbeats without returning or exposing session tokens',async()=>{const fetcher=mockApi(()=>response({accepted:true}));const feed=new ApiIntentFeed(config,signer);await expect(feed.heartbeat()).resolves.toBeUndefined();expect(fetcher.mock.calls.at(-1)?.[0]).toBe('https://api.example/v1/keeper/heartbeat');});

 it('reports the exact intent and transaction under the active authenticated session',async()=>{const fetcher=mockApi(()=>response({accepted:true})),feed=new ApiIntentFeed(config,signer);await feed.report(hash(1) as `0x${string}`,hash(2) as `0x${string}`);expect(fetcher.mock.calls.at(-1)?.[0]).toBe('https://api.example/v1/keeper/executions');const request=vi.mocked(fetch).mock.calls.at(-1)?.[1];expect(request).toMatchObject({method:'POST',headers:{authorization:'Bearer session','content-type':'application/json'},body:JSON.stringify({hash:hash(1),txHash:hash(2)}),redirect:'error'});});

});
