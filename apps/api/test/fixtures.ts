import { createHash } from 'node:crypto';
import { verifyMessage,verifyTypedData,type Address,type Hex,type TypedDataDefinition } from 'viem';
import { generatePrivateKey,privateKeyToAccount } from 'viem/accounts';
import { canonicalPositionsHash,conservativeQuote,type Intent,type Leg,type WireIntent } from '../../../packages/domain/src/index.js';
import type { ChainGateway,AccountSnapshot } from '../src/types.js';
import { ApiError } from '../src/http.js';
export const ownerWallet=privateKeyToAccount(generatePrivateKey());
export const otherWallet=privateKeyToAccount(generatePrivateKey());
export const keeperWallet=privateKeyToAccount(generatePrivateKey());
export const account='0x4444444444444444444444444444444444444444' as Address;
export const otherAccount='0x5555555555555555555555555555555555555555' as Address;
export const poolA='0x6666666666666666666666666666666666666666' as Address;
export const poolB='0x7777777777777777777777777777777777777777' as Address;
export const config={chainId:50383,baseUrl:'http://localhost:18180',router:'0x2222222222222222222222222222222222222222' as Address,factory:'0x3333333333333333333333333333333333333333' as Address,logger:false,rateLimitMax:10000};
export class FakeChain implements ChainGateway {
 readonly chainId=50383;
 simulations=0;
 async ready(){}
 async verifyMessage(address:Address,message:string,signature:Hex){return verifyMessage({address,message,signature});}
 async verifyTypedData(address:Address,typedData:TypedDataDefinition,signature:Hex){const signer=address.toLowerCase()===account?ownerWallet.address:address.toLowerCase()===otherAccount?otherWallet.address:address;return verifyTypedData({...typedData,address:signer,signature});}
 async account(address:Address):Promise<AccountSnapshot>{if(![account,otherAccount].includes(address.toLowerCase() as Address))throw new ApiError(404,'NOT_FOUND','Unknown account');return{owner:address.toLowerCase()===account?ownerWallet.address:otherWallet.address,epoch:0n,revision:0n,positions:[],equity:1000n,initialMargin:10n,maintenanceMargin:5n};}
 async markets(){return [poolA,poolB].map(pool=>({pool,oneBase:1n,tickSize:1n,lotSize:1n,minQuantity:1n,takerFeeBpsTimes1k:0,entryEnabled:true}));}
 async positionsHash(_account:Address,legs:Leg[]){return canonicalPositionsHash(legs.map(l=>({pool:l.pool,size:0n})));}
 async nonceUsed(){return false;}
 async quote(_account:Address,legs:Leg[]){return{blockNumber:'100',blockTimestamp:'1700000000',expiresAt:'1700000010',executablePrices:legs.map(l=>l.limitPrice.toString()),conservativeNetQuote:conservativeQuote(legs.map(l=>({delta:l.delta,price:l.limitPrice,lotSize:1n,oneBase:1n,feeRate:0n}))).toString(),markNetQuote:'0',markets:[],simulationStatus:'not_signed' as const};}
 async simulate(_intent:Intent,_signature:Hex,_prices:bigint[]){this.simulations++;return{gas:'500000'};}
 async prepareCreate(_owner:Address,_salt:Hex){return{to:config.factory,data:'0x1234',value:'0'};}
 async prepareAccountAction(address:Address,action:Record<string,unknown>){return{to:address,data:'0x1234',value:'0',action};}
 async prepareCancel(_intent:Intent){return{to:config.router,data:'0x1234',value:'0'};}
 async execution(txHash:Hex,_intentHash:Hex,_executor:Address){return{txHash,status:'SUBMITTED' as const,blockNumber:null,blockHash:null,receipt:null};}
}
export async function wireIntent(chain:FakeChain,now:number,overrides:Partial<WireIntent>={}):Promise<WireIntent>{
 const legs=[{pool:poolA,delta:'10',limitPrice:'100',maxTakerFeeBpsTimes1k:0},{pool:poolB,delta:'-10',limitPrice:'100',maxTakerFeeBpsTimes1k:0}];
 return{account,executor:keeperWallet.address,nonce:'1',epoch:'0',expectedRevision:'0',expectedPositionsHash:await chain.positionsHash(account,legs.map(l=>({...l,delta:BigInt(l.delta),limitPrice:BigInt(l.limitPrice)}))),validAfter:String(Math.floor(now/1000)-1),validUntil:String(Math.floor(now/1000)+1000),operation:0,legs,minNetQuote:'0',triggerKind:0,triggerValue:'0',minPostEquity:'0',minPostHealthBps:20000,...overrides};
}
