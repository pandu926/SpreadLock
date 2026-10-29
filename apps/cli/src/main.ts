import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {Wallet} from 'ethers';
import {createWalletClient,http,type Address,type Hex} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {parseManifest,SpreadLockClient,accountAbi} from '../../../packages/sdk/src/index.js';
import {getIntentTypedData,parseIntent,serializeIntent} from '../../../packages/domain/src/index.js';
import {readPrivateFile} from '../../keeper/src/config.js';
import {keeperTypedData} from '../../api/src/keeper-auth.js';
const parsed=parseArgs({allowPositionals:true,options:{manifest:{type:'string'},rpc:{type:'string'},api:{type:'string'},keystore:{type:'string'},'password-file':{type:'string'},file:{type:'string'},output:{type:'string'},account:{type:'string'},salt:{type:'string'},amount:{type:'string'},pools:{type:'string'},accounts:{type:'string'},nonce:{type:'string'},keeper:{type:'string'},'send':{type:'boolean',default:false}}});
const o=parsed.values,command=parsed.positionals[0]??'help';
const requireOption=(name:keyof typeof o):string=>{const v=o[name];if(typeof v!=='string'||!v)throw new Error(`--${name} is required`);return v;};
const json=(v:unknown)=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x,2);
const output=async(v:unknown)=>{const text=json(v)+'\n';if(o.output){await mkdir(dirname(resolve(o.output)),{recursive:true});await writeFile(o.output,text,{mode:0o600,flag:'wx'});}else process.stdout.write(text);};
async function signer(){const w=await Wallet.fromEncryptedJson(readPrivateFile(requireOption('keystore')),readPrivateFile(requireOption('password-file')).replace(/\r?\n$/,''));return privateKeyToAccount(w.privateKey as Hex);}
async function run(){
 if(command==='help'){process.stdout.write('SpreadLock CLI\nCommands: key-create, manifest-check, account-create, account-fund, account-deposit, account-withdraw, account-invalidate, account-grant, account-state, intent-sign, intent-submit, intent-execute, intent-cancel, keeper-authorize, emergency-close\nAll calls are prepared only unless --send is passed. Owner keys remain in encrypted local keystores.\nUse --manifest FILE --rpc URL --keystore FILE --password-file FILE.\n');return;}
 if(command==='key-create'){const key=generatePrivateKey(),wallet=new Wallet(key);const encrypted=await wallet.encrypt(readPrivateFile(requireOption('password-file')).replace(/\r?\n$/,''));await writeFile(requireOption('output'),encrypted,{mode:0o600,flag:'wx'});process.stdout.write(json({address:wallet.address})+'\n');return;}
 const manifest=parseManifest(JSON.parse(await readFile(requireOption('manifest'),'utf8'))),sdk=new SpreadLockClient(manifest,o.rpc??manifest.rpcHttpUrl);
 const protective=['account-withdraw','account-invalidate','intent-cancel','emergency-close'].includes(command);
 if(protective){if(await sdk.publicClient.getChainId()!==manifest.chainId)throw new Error('Wrong chain');}else await sdk.verifyDeployment();
 if(command==='manifest-check'){await output({verified:true,chainId:manifest.chainId,router:manifest.router});return;}
 const account=o.account as Address;
 if(command==='account-state'){if(!account)throw new Error('--account required');await output(await sdk.accountState(account));return;}
 const owner=await signer();
 if(protective&&(await sdk.accountOwner(requireOption('account') as Address)).toLowerCase()!==owner.address.toLowerCase())throw new Error('Signing wallet does not own basket');
 const call=async(tx:{to:Address;data:Hex;value:bigint})=>{if(!o.send){await output(tx);return;}const client=createWalletClient({account:owner,chain:sdk.publicClient.chain,transport:http(o.rpc??manifest.rpcHttpUrl!)});await sdk.publicClient.call({...tx,account:owner.address});const hash=await client.sendTransaction(tx);const receipt=await sdk.publicClient.waitForTransactionReceipt({hash});if(receipt.status!=='success')throw new Error(`Transaction reverted ${hash}`);await output({hash,status:receipt.status,blockNumber:receipt.blockNumber});};
 if(command==='account-create'){await call(sdk.createAccountCall(requireOption('salt') as Hex));return;}
 if(command==='account-fund'){await call(sdk.fundAccountCall(requireOption('account') as Address,BigInt(requireOption('amount'))));return;}
 if(command==='account-deposit'){await call(sdk.depositCall(requireOption('account') as Address,BigInt(requireOption('amount'))));return;}
 if(command==='account-withdraw'){const {encodeFunctionData}=await import('viem');await call({to:requireOption('account') as Address,data:encodeFunctionData({abi:accountAbi,functionName:'withdrawMargin',args:[BigInt(requireOption('amount'))]}),value:0n});return;}
 if(command==='account-invalidate'){const {encodeFunctionData}=await import('viem');await call({to:requireOption('account') as Address,data:encodeFunctionData({abi:accountAbi,functionName:'invalidateIntents'}),value:0n});return;}
 if(command==='account-grant'){await call(sdk.grantCall(requireOption('account') as Address,requireOption('pools').split(',') as Address[],true));return;}
 if(command==='intent-cancel'){await call(sdk.cancelCall(requireOption('account') as Address,BigInt(requireOption('nonce'))));return;}
 if(command==='intent-sign'){const intent=parseIntent(JSON.parse(await readFile(requireOption('file'),'utf8')));const state=await sdk.accountState(intent.account);if(state.owner.toLowerCase()!==owner.address.toLowerCase())throw new Error('Signing wallet does not own basket');await output({intent:serializeIntent(intent),signature:await owner.signTypedData(getIntentTypedData(intent,manifest.chainId,manifest.router))});return;}
 if(command==='keeper-authorize'){const cert={owner:owner.address,keeper:requireOption('keeper') as Address,accounts:requireOption('accounts').split(',') as Address[],chainId:manifest.chainId,validUntil:String(Math.floor(Date.now()/1000)+86400),nonce:requireOption('nonce')};await output({...cert,signature:await owner.signTypedData(keeperTypedData(cert,manifest.router))});return;}
 if(command==='intent-execute'){const e=JSON.parse(await readFile(requireOption('file'),'utf8')),i=parseIntent(e.intent);if(i.executor.toLowerCase()!==owner.address.toLowerCase())throw new Error('Local signer must be assigned executor');await call(await sdk.prepareExecution(i,e.signature));return;}
 if(command==='intent-submit'){
  const api=new URL(requireOption('api'));if(!['https:','http:'].includes(api.protocol)||api.username||api.password)throw new Error('Invalid API URL');
  if(api.protocol==='http:'&&!['localhost','127.0.0.1'].includes(api.hostname))throw new Error('HTTPS required');
  const request=async(path:string,body:unknown,token?:string)=>{const r=await fetch(new URL(path,api),{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:json(body),signal:AbortSignal.timeout(20000),redirect:'error'});const result=await r.json() as {success:boolean;data:any};if(!r.ok||!result.success)throw new Error(`API rejected ${path} (${r.status})`);return result.data;};
  const challenge=await request('/v1/auth/challenge',{address:owner.address,chainId:manifest.chainId});
  const {parseSiweMessage}=await import('viem/siwe');const message=parseSiweMessage(challenge.message);if(message.domain!==api.host||message.address?.toLowerCase()!==owner.address.toLowerCase()||message.chainId!==manifest.chainId||message.statement!=='Sign in to SpreadLock. This does not authorize trading.'||!message.expirationTime||message.expirationTime.getTime()<=Date.now()||message.expirationTime.getTime()>Date.now()+310000||!message.uri||new URL(message.uri).origin!==api.origin)throw new Error('Invalid SIWE challenge');
  const session=await request('/v1/auth/verify',{challengeId:challenge.challengeId,signature:await owner.signMessage({message:challenge.message})});
  await output(await request('/v1/intents',JSON.parse(await readFile(requireOption('file'),'utf8')),session.token));return;
 }
 if(command==='emergency-close'){const {encodeFunctionData}=await import('viem');const v=JSON.parse(await readFile(requireOption('file'),'utf8'));await call({to:requireOption('account') as Address,data:encodeFunctionData({abi:accountAbi,functionName:'emergencyClose',args:[v.pool,BigInt(v.quantity),BigInt(v.limitPrice),BigInt(v.expiryNs),v.immediateOrCancel===true]}),value:0n});return;}
 throw new Error(`Unknown command ${command}`);
}
run().catch(e=>{process.stderr.write(`${e instanceof Error?e.message:'CLI failed'}\n`);process.exitCode=1;});
