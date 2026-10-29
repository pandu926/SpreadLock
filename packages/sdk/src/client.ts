import { createPublicClient, defineChain, encodeFunctionData, http, type Address, type Hex } from 'viem';
import { abs, conservativeQuote, DomainError, getIntentTypedData, hashIntent, type DeploymentManifest, type Intent, type MarketMetadata } from '../../domain/src/index.js';
import {fingerprint,fingerprintMatches} from './fingerprints.js';
import {isFillOrKillNotFillable} from './errors.js';
import { accountAbi, bankAbi, factoryAbi, poolAbi, registryAbi, routerAbi, tokenAbi } from './abi.js';
export interface BookLevel {price:bigint;quantity:bigint}
export function selectExecutionPrice(delta:bigint,limit:bigint,levels:readonly BookLevel[]):bigint {
  if(!delta||limit<=0n)throw new DomainError('INVALID_LEG','Invalid quantity or limit');
  const sorted=[...levels].sort((a,b)=>a.price===b.price?0:(a.price<b.price?-1:1)*(delta>0n?1:-1));
  let available=0n;
  for(const l of sorted){
    if(l.quantity<=0n||l.price<=0n)continue;
    if(delta>0n?l.price>limit:l.price<limit)break;
    available+=l.quantity;
    if(available>=abs(delta))return l.price;
  }
  throw new DomainError('INSUFFICIENT_DEPTH','Full FOK size unavailable within signed price limit');
}
export class SpreadLockClient {
  readonly publicClient;
  constructor(readonly manifest:DeploymentManifest,rpcUrl=manifest.rpcHttpUrl){
    if(!rpcUrl)throw new DomainError('MISSING_RPC','RPC HTTP URL required');
    const chain=defineChain({id:manifest.chainId,name:'SpreadLock network',nativeCurrency:{name:'Gas',symbol:'GAS',decimals:18},rpcUrls:{default:{http:[rpcUrl]}}});
    this.publicClient=createPublicClient({chain,transport:http(rpcUrl,{timeout:20000,retryCount:2})});
  }
  async verifyDeployment():Promise<void>{
    if(await this.publicClient.getChainId()!==this.manifest.chainId)throw new DomainError('CHAIN_MISMATCH','RPC chain differs from local manifest');
    for(const address of [this.manifest.router,this.manifest.factory,this.manifest.marketRegistry,this.manifest.marginBank,this.manifest.collateral]){
      const code=await this.publicClient.getCode({address});if(!code||code==='0x')throw new DomainError('MISSING_CONTRACT','Manifest address has no deployed code');
    }
    for(const [target,expected] of Object.entries(this.manifest.fingerprints??{})){
      if(!fingerprintMatches(expected,await fingerprint(this.publicClient,target as Address)))throw new DomainError('IMPLEMENTATION_CHANGED','Pinned protocol implementation changed');
    }
    const factory=await this.publicClient.readContract({address:this.manifest.router,abi:routerAbi,functionName:'accountFactory'});
    const registry=await this.publicClient.readContract({address:this.manifest.router,abi:routerAbi,functionName:'marketRegistry'});
    if(registry.toLowerCase()!==this.manifest.marketRegistry.toLowerCase())throw new DomainError('MANIFEST_MISMATCH','Router registry mismatch');
    if(factory.toLowerCase()!==this.manifest.factory.toLowerCase())throw new DomainError('MANIFEST_MISMATCH','Router factory mismatch');
  }
  async accountOwner(account:Address):Promise<Address>{
    const blockNumber=await this.publicClient.getBlockNumber();
    const known=await this.publicClient.readContract({address:this.manifest.factory,abi:factoryAbi,functionName:'isAccount',args:[account],blockNumber});
    if(!known)throw new DomainError('UNKNOWN_ACCOUNT','Account was not created by pinned factory');
    return this.publicClient.readContract({address:account,abi:accountAbi,functionName:'owner',blockNumber});
  }
  async accountState(account:Address){
    const blockNumber=await this.publicClient.getBlockNumber();
    if(!await this.publicClient.readContract({address:this.manifest.factory,abi:factoryAbi,functionName:'isAccount',args:[account],blockNumber}))throw new DomainError('UNKNOWN_ACCOUNT','Account was not created by pinned factory');
    const [owner,epoch,revision,activePools,health]=await Promise.all([
      this.publicClient.readContract({address:account,abi:accountAbi,functionName:'owner',blockNumber}),
      this.publicClient.readContract({address:account,abi:accountAbi,functionName:'epoch',blockNumber}),
      this.publicClient.readContract({address:account,abi:accountAbi,functionName:'revision',blockNumber}),
      this.publicClient.readContract({address:this.manifest.marginBank,abi:bankAbi,functionName:'getActivePerpPools',args:[account],blockNumber}),
      this.publicClient.readContract({address:this.manifest.marginBank,abi:bankAbi,functionName:'getAccountHealth',args:[account],blockNumber}),
    ]);
    const positions=await Promise.all(activePools.map(async pool=>({pool,...await this.publicClient.readContract({address:this.manifest.marginBank,abi:bankAbi,functionName:'getPosition',args:[account,pool],blockNumber})})));
    return {blockNumber,owner,epoch,revision,positions,health:{equity:health[0],imReq:health[1],mmReq:health[2],cmReq:health[3]}};
  }
  async positionsHash(intent:Pick<Intent,'account'|'legs'>):Promise<Hex>{
    return this.publicClient.readContract({address:this.manifest.router,abi:routerAbi,functionName:'positionsHash',args:[intent.account,intent.legs]});
  }
  async quote(intent:Intent){
    const blockNumber=await this.publicClient.getBlockNumber();
    const block=await this.publicClient.getBlock({blockNumber});
    const rows=[];
    for(const leg of intent.legs){
      if(!this.manifest.markets.some(p=>p.toLowerCase()===leg.pool.toLowerCase()))throw new DomainError('UNSUPPORTED_MARKET','Market not enabled in pinned manifest');
      const [m,levels,mark]=await Promise.all([
        this.publicClient.readContract({address:this.manifest.marketRegistry,abi:registryAbi,functionName:'marketMetadata',args:[leg.pool],blockNumber}),
        this.publicClient.readContract({address:leg.pool,abi:poolAbi,functionName:'getBookLevels',args:[leg.delta<0n,100n],blockNumber}),
        this.publicClient.readContract({address:leg.pool,abi:poolAbi,functionName:'tryGetMarkPrice',blockNumber}),
      ]);
      const metadata:MarketMetadata={pool:leg.pool,oneBase:m[0],tickSize:m[1],minQuantity:m[2],lotSize:m[3],takerFeeBpsTimes1k:Number(m[4])};
      if(!mark[0])throw new DomainError('STALE_ORACLE','Market mark not live');
      if(metadata.takerFeeBpsTimes1k>leg.maxTakerFeeBpsTimes1k)throw new DomainError('FEE_LIMIT','Taker fee exceeds signed cap');
      if(abs(leg.delta)<metadata.minQuantity||abs(leg.delta)%metadata.lotSize)throw new DomainError('LOT_SIZE','Quantity violates market grid');
      const price=selectExecutionPrice(leg.delta,leg.limitPrice,levels);
      rows.push({leg,metadata,price,mark:mark[1]});
    }
    const guaranteedNetQuote=conservativeQuote(rows.map(r=>({delta:r.leg.delta,price:r.price,lotSize:r.metadata.lotSize,oneBase:r.metadata.oneBase,feeRate:BigInt(r.metadata.takerFeeBpsTimes1k)})));
    if(guaranteedNetQuote<intent.minNetQuote)throw new DomainError('QUOTE_BOUND','Combined conservative quote is below signed minimum');
    return {blockNumber,timestamp:block.timestamp,prices:rows.map(r=>r.price),guaranteedNetQuote,rows,simulationStatus:'not_signed' as const};
  }
  async prepareExecution(intent:Intent,signature:Hex){
    let quote=await this.quote(intent);
    const valid=await this.publicClient.verifyTypedData({address:intent.account,...getIntentTypedData(intent,this.manifest.chainId,this.manifest.router),signature});
    if(!valid)throw new DomainError('INVALID_SIGNATURE','Intent signature is invalid for basket account');
    const simulate=(prices:bigint[])=>this.publicClient.simulateContract({address:this.manifest.router,abi:routerAbi,functionName:'execute',args:[intent,prices,signature],account:intent.executor});
    try{await simulate(quote.prices);}catch(error){
      if(!isFillOrKillNotFillable(error))throw error;
      // Snapshot depth can move before simulation. Retry only at limits already
      // authorized by the signature; preserve the combined conservative bound.
      const rows=quote.rows.map(row=>({...row,price:row.leg.limitPrice}));
      const guaranteedNetQuote=conservativeQuote(rows.map(row=>({delta:row.leg.delta,price:row.price,lotSize:row.metadata.lotSize,oneBase:row.metadata.oneBase,feeRate:BigInt(row.metadata.takerFeeBpsTimes1k)})));
      if(guaranteedNetQuote<intent.minNetQuote)throw new DomainError('QUOTE_BOUND','Signed-limit fallback is below combined signed minimum');
      quote={...quote,rows,prices:rows.map(row=>row.price),guaranteedNetQuote};
      await simulate(quote.prices);
    }
    const args=[intent,quote.prices,signature] as const;
    const gas=await this.publicClient.estimateContractGas({address:this.manifest.router,abi:routerAbi,functionName:'execute',args,account:intent.executor});
    const data=encodeFunctionData({abi:routerAbi,functionName:'execute',args});
    return {to:this.manifest.router,data,value:0n,gas,prices:quote.prices,hash:hashIntent(intent,this.manifest.chainId,this.manifest.router),quote};
  }
  createAccountCall(salt:Hex){return {to:this.manifest.factory,data:encodeFunctionData({abi:factoryAbi,functionName:'createAccount',args:[salt]}),value:0n};}
  fundAccountCall(account:Address,amount:bigint){return {to:this.manifest.collateral,data:encodeFunctionData({abi:tokenAbi,functionName:'transfer',args:[account,amount]}),value:0n};}
  depositCall(account:Address,amount:bigint){return {to:account,data:encodeFunctionData({abi:accountAbi,functionName:'depositMargin',args:[amount]}),value:0n};}
  grantCall(account:Address,pools:Address[],approved:boolean){return {to:account,data:encodeFunctionData({abi:accountAbi,functionName:'setRouterApproval',args:[this.manifest.router,pools,approved]}),value:0n};}
  cancelCall(account:Address,nonce:bigint){return {to:this.manifest.router,data:encodeFunctionData({abi:routerAbi,functionName:'invalidateNonces',args:[account,nonce>>8n,1n<<(nonce&255n)]}),value:0n};}
}
