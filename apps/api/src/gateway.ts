import { decodeEventLog, decodeFunctionData, encodeFunctionData, type Address, type Hex, type TypedDataDefinition } from 'viem';
import { SpreadLockClient, accountAbi, factoryAbi, registryAbi, routerAbi } from '../../../packages/sdk/src/index.js';
import { abs, conservativeQuote, hashIntent, type Intent, type Leg } from '../../../packages/domain/src/index.js';
import { ApiError, jsonify } from './http.js';
import type { ChainGateway } from './types.js';
export class LiveChainGateway implements ChainGateway {
 readonly chainId:number;
 constructor(readonly sdk:SpreadLockClient){this.chainId=sdk.manifest.chainId;}
 async ready(){await this.sdk.verifyDeployment();}
 async verifyMessage(address:Address,message:string,signature:Hex){return this.sdk.publicClient.verifyMessage({address,message,signature});}
 async verifyTypedData(address:Address,typedData:TypedDataDefinition,signature:Hex){return this.sdk.publicClient.verifyTypedData({...typedData,address,signature});}
 ownerOf(address:Address){return this.sdk.accountOwner(address);}
 async account(address:Address){const a=await this.sdk.accountState(address);return{owner:a.owner,epoch:a.epoch,revision:a.revision,positions:a.positions.map(p=>({pool:p.pool,size:p.size})),equity:a.health.equity,initialMargin:a.health.imReq,maintenanceMargin:a.health.mmReq};}
 async markets(){return Promise.all(this.sdk.manifest.markets.map(async pool=>{const [m,entryEnabled]=await Promise.all([this.sdk.publicClient.readContract({address:this.sdk.manifest.marketRegistry,abi:registryAbi,functionName:'marketMetadata',args:[pool]}),this.sdk.publicClient.readContract({address:this.sdk.manifest.marketRegistry,abi:registryAbi,functionName:'entryEnabled',args:[pool]})]);return{pool,oneBase:m[0],tickSize:m[1],minQuantity:m[2],lotSize:m[3],takerFeeBpsTimes1k:Number(m[4]),entryEnabled};}));}
 positionsHash(account:Address,legs:Leg[]){return this.sdk.positionsHash({account,legs});}
 nonceUsed(account:Address,epoch:bigint,nonce:bigint){return this.sdk.publicClient.readContract({address:this.sdk.manifest.router,abi:routerAbi,functionName:'nonceUsed',args:[account,epoch,nonce]});}
 async quote(account:Address,legs:Leg[]){const q=await this.sdk.quote({account,legs,minNetQuote:-(1n<<255n)} as Intent);const mark=q.rows.reduce((s,r)=>s-(r.leg.delta*r.mark/r.metadata.oneBase),0n);return{blockNumber:q.blockNumber.toString(),blockTimestamp:q.timestamp.toString(),expiresAt:(q.timestamp+10n).toString(),executablePrices:q.prices.map(String),conservativeNetQuote:q.guaranteedNetQuote.toString(),markNetQuote:mark.toString(),markets:jsonify(q.rows) as Record<string,unknown>[],simulationStatus:'not_signed' as const};}
 async simulate(intent:Intent,signature:Hex,prices:bigint[]){const args=[intent,prices,signature] as const;await this.sdk.publicClient.simulateContract({address:this.sdk.manifest.router,abi:routerAbi,functionName:'execute',args,account:intent.executor});const gas=await this.sdk.publicClient.estimateContractGas({address:this.sdk.manifest.router,abi:routerAbi,functionName:'execute',args,account:intent.executor});return{gas:gas.toString()};}
 async prepareCreate(owner:Address,salt:Hex):Promise<Record<string,unknown>>{return{...jsonify(this.sdk.createAccountCall(salt)) as Record<string,unknown>,account:await this.sdk.publicClient.readContract({address:this.sdk.manifest.factory,abi:factoryAbi,functionName:'predictAccount',args:[owner,salt]})};}
 async prepareAccountAction(account:Address,action:Record<string,unknown>){
  const n=(key:string,bits=256)=>{const v=action[key];if(typeof v!=='string'||!/^[1-9][0-9]*$/.test(v)||v.length>78)throw new ApiError(400,'INVALID_ACTION',`${key} must be positive integer`);const parsed=BigInt(v);if(parsed>=2n**BigInt(bits))throw new ApiError(400,'INVALID_ACTION',`${key} exceeds uint${bits}`);return parsed;};
  let data:Hex;
  switch(action.action){
   case'deposit':return jsonify(this.sdk.depositCall(account,n('amount'))) as Record<string,unknown>;
   case'withdraw':data=encodeFunctionData({abi:accountAbi,functionName:'withdrawMargin',args:[n('amount')]});break;
   case'authorize':{if(!Array.isArray(action.pools)||typeof action.approved!=='boolean')throw new ApiError(400,'INVALID_ACTION','Pools and approved required');return jsonify(this.sdk.grantCall(account,action.pools as Address[],action.approved)) as Record<string,unknown>;}
   case'invalidate':data=encodeFunctionData({abi:accountAbi,functionName:'invalidateIntents'});break;
   case'emergencyClose':if(typeof action.pool!=='string')throw new ApiError(400,'INVALID_ACTION','pool required');data=encodeFunctionData({abi:accountAbi,functionName:'emergencyClose',args:[action.pool as Address,n('quantity'),n('limitPrice'),n('expiryNs',64),action.immediateOrCancel===true]});break;
   case'withdrawToken':if(typeof action.token!=='string')throw new ApiError(400,'INVALID_ACTION','token required');data=encodeFunctionData({abi:accountAbi,functionName:'withdrawToken',args:[action.token as Address,n('amount')]});break;
   default:throw new ApiError(400,'INVALID_ACTION','Unsupported action');
  }return{to:account,data,value:'0'};
 }
 async prepareCancel(intent:Intent){return jsonify(this.sdk.cancelCall(intent.account,intent.nonce)) as Record<string,unknown>;}
 async execution(hash:Hex,intentHash:Hex,executor:Address){
  const tx=await this.sdk.publicClient.getTransaction({hash});
  if(tx.from.toLowerCase()!==executor.toLowerCase()||tx.to?.toLowerCase()!==this.sdk.manifest.router.toLowerCase())throw new ApiError(400,'WRONG_TRANSACTION','Transaction is not from the assigned keeper to the router');
  let call:ReturnType<typeof decodeFunctionData<typeof routerAbi>>;
  try{call=decodeFunctionData({abi:routerAbi,data:tx.input});}catch{throw new ApiError(400,'WRONG_INTENT','Transaction calldata is not a valid router call');}
  if(call.functionName!=='execute'||hashIntent(call.args[0] as Intent,this.chainId,this.sdk.manifest.router).toLowerCase()!==intentHash.toLowerCase())throw new ApiError(400,'WRONG_INTENT','Transaction calldata does not match the reported intent');
  let r;try{r=await this.sdk.publicClient.getTransactionReceipt({hash});}catch(e){if((e as Error).name!=='TransactionReceiptNotFoundError')throw e;return{txHash:hash,status:'SUBMITTED' as const,blockNumber:null,blockHash:null,receipt:null};}
  if(r.status==='success'&&!r.logs.some(l=>{try{const d=decodeEventLog({abi:routerAbi,data:l.data,topics:l.topics});return l.address.toLowerCase()===this.sdk.manifest.router.toLowerCase()&&d.eventName==='IntentExecuted'&&d.args.intentHash.toLowerCase()===intentHash.toLowerCase();}catch{return false;}}))throw new ApiError(400,'WRONG_INTENT','Receipt does not execute the specified intent');
  return{txHash:hash,status:r.status==='success'?'MINED' as const:'REVERTED' as const,blockNumber:r.blockNumber.toString(),blockHash:r.blockHash,receipt:jsonify(r) as Record<string,unknown>};
 }
}
