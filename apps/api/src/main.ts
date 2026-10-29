import {readFile} from 'node:fs/promises';
import {DomainError} from '../../../packages/domain/src/index.js';
import {PgStore,migrate} from '../../../packages/db/src/index.js';
import {parseManifest,SpreadLockClient} from '../../../packages/sdk/src/index.js';
import {compatibilityReady,type ReadinessOptions} from '../../indexer/src/readiness.js';
import {buildApp} from './app.js';
import {LiveChainGateway} from './gateway.js';
import {startJobWorker} from './worker.js';
const required=(name:string)=>{const v=process.env[name];if(!v)throw new Error(`${name} required`);return v;};
const manifest=parseManifest(JSON.parse(await readFile(required('SPREADLOCK_MANIFEST'),'utf8')));
const baseUrl=required('PUBLIC_BASE_URL');
if(process.env.NODE_ENV==='production'){
 const dependencies=[manifest.router,manifest.factory,manifest.marketRegistry,manifest.marginBank,manifest.collateral,manifest.permissionsRegistry,manifest.protocolFactory,...manifest.markets];
 if(dependencies.some(a=>!Object.keys(manifest.fingerprints??{}).some(k=>k.toLowerCase()===a.toLowerCase())))throw new Error('Production requires reviewed fingerprints for every dependency');
}

if(process.env.NODE_ENV==='production'&&new URL(baseUrl).protocol!=='https:')throw new Error('Production PUBLIC_BASE_URL requires HTTPS');
const store=new PgStore(required('DATABASE_URL'),{max:4});
if(process.env.AUTO_MIGRATE!=='false')await migrate(store.pool);
const chain=new LiveChainGateway(new SpreadLockClient(manifest,process.env.RPC_HTTP_URL??manifest.rpcHttpUrl));
const readinessOptions:ReadinessOptions={confirmations:manifest.confirmations,rpc:{
 chainId:()=>chain.sdk.publicClient.getChainId(),
 head:()=>chain.sdk.publicClient.getBlockNumber({cacheTime:0}),
 block:async number=>{const block=await chain.sdk.publicClient.getBlock({blockNumber:number});return{number:block.number,hash:block.hash,parentHash:block.parentHash,timestamp:block.timestamp};},
}};
try{await chain.ready();}catch(error){if(!(error instanceof DomainError)||error.code!=='IMPLEMENTATION_CHANGED')throw error;console.error('Protocol fingerprint changed: protective API only until compatibility review');}
const app=await buildApp({store,chain,config:{chainId:manifest.chainId,baseUrl,router:manifest.router,factory:manifest.factory,logger:true,development:process.env.NODE_ENV!=='production'},entryReady:async()=>{try{await chain.ready();}catch{return{ready:false,reasons:['PROTOCOL_COMPATIBILITY_FAILED']};}return compatibilityReady(store.pool,manifest.chainId,readinessOptions);}});
await app.listen({host:process.env.HOST??'127.0.0.1',port:Number(process.env.PORT??18180)});
const stopJobs=startJobWorker(store,chain);
let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await app.close();await stopJobs();await store.close();};
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{void stop().catch(()=>{process.exitCode=1;});});
