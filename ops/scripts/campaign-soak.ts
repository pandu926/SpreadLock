/** Persistent read-only seven-day observer. Never signs or broadcasts transactions. */
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {decodeEventLog,type Address,type Hex} from 'viem';
import {parseManifest,SpreadLockClient,routerAbi,bankAbi} from '../../packages/sdk/src/index.js';
import {hashIntent,parseIntent} from '../../packages/domain/src/index.js';
// @ts-ignore shared operational validators.
import {initialSoak,recordSoak,assessSoak} from '../testing/campaign.mjs';
// @ts-ignore actual token event accounting.
import {collateralDelta} from '../testing/transfers.mjs';
// @ts-ignore durable state helpers.
import {atomicJson,lockState} from '../testing/state.mjs';
// @ts-ignore version-bound evidence helper.
import {sourceManifest} from '../../scripts/verification/lib.mjs';
const configFile=process.argv[2];if(!configFile)throw new Error('Usage: node --import tsx ops/scripts/campaign-soak.ts CONFIG [--once]');
const config=JSON.parse(await readFile(configFile,'utf8'));
if(!config.stateFile||!config.reportFile||!config.manifestFile||!config.apiBaseUrl||!Array.isArray(config.campaignFiles)||!/^0x[0-9a-fA-F]{40}$/.test(config.owner??''))throw new Error('Missing soak configuration');
const origin=new URL(config.apiBaseUrl);if(origin.username||origin.password||!['https:','http:'].includes(origin.protocol)||(origin.protocol==='http:'&&!['localhost','127.0.0.1'].includes(origin.hostname)))throw new Error('HTTPS required except localhost');
const manifest=parseManifest(JSON.parse(await readFile(config.manifestFile,'utf8')));if(manifest.chainId!==50383)throw new Error('Soak observer is testnet50383 only');
const sdk=new SpreadLockClient(manifest,config.rpcHttpUrl??manifest.rpcHttpUrl);
const source=await sourceManifest();
const owner=config.owner.toLowerCase();
await mkdir(dirname(resolve(config.stateFile)),{recursive:true});await mkdir(dirname(resolve(config.reportFile)),{recursive:true});
const unlock=await lockState(config.stateFile);
let stopping=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
let state:any;try{state=JSON.parse(await readFile(config.stateFile,'utf8'));if(state.schemaVersion!==1||state.sourceSha256!==source.sha256)throw new Error('Soak source changed; begin a new stable period with a new stateFile');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;state=initialSoak(source.sha256);await atomicJson(config.stateFile,state);}
let verified:{gasSpentWei:string;collateralCommittedWei:string;canonicalCycles:number;completedCycles?:{hash:Hex;at:number}[]}|undefined;
let reconciledAt=0;
async function reconcile(){
 // Reload only the runtime campaign list, allowing new daily evidence without changing source.
 const dynamic=JSON.parse(await readFile(configFile!,'utf8'));if(!Array.isArray(dynamic.campaignFiles))throw new Error('Invalid campaign file list');
 const transactions=new Map<Hex,{hash:Hex;closeHash?:Hex;account:Address;senders:string[];expectedFailure:boolean}>();
 for(const file of dynamic.campaignFiles){const c=JSON.parse(await readFile(file,'utf8'));if(c.sourceSha256!==source.sha256||!/^0x[0-9a-fA-F]{40}$/.test(c.account??'')||!Array.isArray(c.transactions))throw new Error('Campaign source/account/transactions invalid');
  const closes=new Map<string,Hex>();for(const [name,v] of Object.entries(c.intents??{}) as [string,any][]){if(!/^([248])-close$/.test(name))continue;const intent=parseIntent(v.intent);if(intent.operation!==2||intent.account.toLowerCase()!==c.account.toLowerCase()||hashIntent(intent,50383,manifest.router).toLowerCase()!==String(v.hash).toLowerCase())throw new Error('Invalid signed close proof');closes.set(String(v.transactionHash).toLowerCase(),v.hash);}
  for(const t of c.transactions){if(!/^0x[0-9a-fA-F]{64}$/.test(t.hash??''))throw new Error('Invalid campaign transaction hash');const hash=t.hash.toLowerCase() as Hex,old=transactions.get(hash);if(old&&old.account.toLowerCase()!==c.account.toLowerCase())throw new Error('Conflicting campaign transaction');transactions.set(hash,{hash,closeHash:closes.get(hash),account:c.account,senders:[owner,String(c.keeper).toLowerCase()],expectedFailure:t.expectedFailure===true});}
 }
 if(!transactions.size)throw new Error('No public transaction evidence supplied');
 if(await sdk.publicClient.getChainId()!==50383)throw new Error('Wrong RPC chain');await sdk.verifyDeployment();
 const head=await sdk.publicClient.getBlockNumber({cacheTime:0});
 const receipts=[];for(const entry of transactions.values()){
  const receipt=await sdk.publicClient.getTransactionReceipt({hash:entry.hash});if(receipt.status!==(entry.expectedFailure?'reverted':'success')||receipt.transactionHash.toLowerCase()!==entry.hash||head+1n<receipt.blockNumber+BigInt(manifest.confirmations))throw new Error('Failed/unconfirmed campaign transaction');
  const block=await sdk.publicClient.getBlock({blockNumber:receipt.blockNumber});if(block.hash!==receipt.blockHash)throw new Error('Orphaned campaign receipt');
  const transaction=await sdk.publicClient.getTransaction({hash:entry.hash});
  if(!entry.senders.includes(transaction.from.toLowerCase()))throw new Error('Unexpected campaign transaction sender');receipts.push({...entry,receipt,at:Number(block.timestamp)*1000});
 }
 receipts.sort((a,b)=>a.receipt.blockNumber===b.receipt.blockNumber?Number(a.receipt.transactionIndex)-Number(b.receipt.transactionIndex):a.receipt.blockNumber<b.receipt.blockNumber?-1:1);
 let gas=0n,committed=0n,peak=0n,cycles=0;const knownAccounts=new Set(receipts.map(r=>r.account.toLowerCase()));
 const completedCycles:{hash:Hex;at:number}[]=[];
 for(const entry of receipts){gas+=entry.receipt.gasUsed*entry.receipt.effectiveGasPrice;
  for(const log of entry.receipt.logs){try{committed+=collateralDelta(log,manifest.collateral,owner,knownAccounts);if(committed<0n)committed=0n;if(committed>peak)peak=committed;}catch{throw new Error('Malformed collateral Transfer log');}}
  if(entry.closeHash){let executed=false;for(const log of entry.receipt.logs){if(log.address.toLowerCase()!==manifest.router.toLowerCase())continue;try{const event=decodeEventLog({abi:routerAbi,data:log.data,topics:log.topics});if(event.eventName==='IntentExecuted'&&event.args.intentHash.toLowerCase()===entry.closeHash.toLowerCase()&&event.args.account.toLowerCase()===entry.account.toLowerCase())executed=true;}catch{}}if(!executed)throw new Error('Close execution event mismatch');const active=await sdk.publicClient.readContract({address:manifest.marginBank,abi:bankAbi,functionName:'getActivePerpPools',args:[entry.account],blockNumber:entry.receipt.blockNumber});if(active.length!==0)throw new Error('Close did not leave account flat');if(entry.at>=state.startedAt){cycles++;completedCycles.push({hash:entry.hash,at:entry.at});}}
 }
 for(const account of knownAccounts){const snapshot=await sdk.accountState(account as Address);if(snapshot.owner.toLowerCase()!==owner||snapshot.positions.length!==0)throw new Error('Campaign account owner/flat-state reconciliation failed');}
 return {gasSpentWei:gas.toString(),collateralCommittedWei:peak.toString(),canonicalCycles:cycles,completedCycles,head:head.toString(),receiptCount:receipts.length,reconciledAt:Date.now()};
}
try{
 do{
  const at=Date.now();let ready=false,reconciled=false,error:string|undefined;
  try{
   if((await sourceManifest()).sha256!==source.sha256)throw new Error('Source changed during soak');
   const response=await fetch(new URL('/health/ready',origin),{signal:AbortSignal.timeout(15000),redirect:'error'});const body=await response.json() as any;ready=response.ok&&body.success===true;
   if(at-reconciledAt>=86400000||!verified){const next=await reconcile();verified=next;reconciledAt=Date.now();reconciled=true;await atomicJson(config.stateFile+'.reconciliation.json',next);}
  }catch(e){error=e instanceof Error?e.message:'PROBE_FAILED';ready=false;}
  const budget=verified??{gasSpentWei:state.gasSpentWei,collateralCommittedWei:state.maxCollateralCommittedWei,canonicalCycles:state.canonicalCycles};
  state=recordSoak(state,{at:Date.now(),ready,reconciled,...budget,error});await atomicJson(config.stateFile,state);
  const assessment=assessSoak(state);const report={schemaVersion:1,type:'soak',sourceSha256:source.sha256,startedAt:new Date(state.startedAt).toISOString(),completedAt:new Date().toISOString(),scope:'Read-only public-testnet observer; no signing/broadcast; seven-day PASS requires real elapsed time and verified daily round trips',...assessment,metrics:state};
  await atomicJson(config.reportFile,report);console.log(JSON.stringify({at:new Date().toISOString(),status:report.status,ready,reconciled,probes:state.probes,availability:report.availability,error}));
  if(report.status==='FAIL'){process.exitCode=1;break;}if(process.argv.includes('--once')||report.status==='PASS'||stopping)break;
  // One second waits permit prompt termination without inventing missed probes.
  for(let i=0;i<60&&!stopping;i++)await new Promise(r=>setTimeout(r,1000));
 }while(!stopping);
}finally{await unlock();}
