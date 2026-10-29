import { getAddress, hashTypedData, type Address, type Hex } from 'viem';
import { DomainError, type Intent, type Leg, type WireIntent } from './types.js';
const fields = ['account','executor','nonce','epoch','expectedRevision','expectedPositionsHash','validAfter','validUntil','operation','legs','minNetQuote','triggerKind','triggerValue','minPostEquity','minPostHealthBps'];
function record(value: unknown, allowed: string[]): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('INVALID_INTENT','Expected object');
  const r=value as Record<string,unknown>;
  if (Object.keys(r).some(k=>!allowed.includes(k)) || allowed.some(k=>!(k in r))) throw new DomainError('INVALID_INTENT','Missing or unknown field');
  return r;
}
function integer(value:unknown,bits:number,signed=false):bigint {
  if(typeof value!=='string'||!/^(0|-?[1-9][0-9]*)$/.test(value)||value.length>79) throw new DomainError('INVALID_INTEGER','Integers must be canonical decimal strings');
  const n=BigInt(value),min=signed?-(1n<<BigInt(bits-1)):0n,max=signed?(1n<<BigInt(bits-1))-1n:(1n<<BigInt(bits))-1n;
  if(n<min||n>max) throw new DomainError('INTEGER_RANGE',`Value outside ${signed?'int':'uint'}${bits}`);
  return n;
}
function small(v:unknown,max:number):number {
  if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0||v>max) throw new DomainError('INVALID_INTEGER','Invalid bounded integer');
  return v;
}
function address(v:unknown):Address {
  if(typeof v!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(v)||/^0x0{40}$/i.test(v)) throw new DomainError('INVALID_ADDRESS','Expected nonzero address');
  try{
    const normalized=getAddress(v),body=v.slice(2);
    if(body!==body.toLowerCase()&&body!==body.toUpperCase()&&v!==normalized)throw new Error('Invalid mixed-case checksum');
    return normalized;
  }catch{throw new DomainError('INVALID_ADDRESS','Invalid address checksum');}
}
export function parseIntent(input:unknown):Intent {
  const r=record(input,fields),operation=small(r.operation,2) as 0|1|2;
  if(!Array.isArray(r.legs)||r.legs.length<(operation===0?2:1)||r.legs.length>8) throw new DomainError('INVALID_LEGS','Open needs 2–8 legs, other operations 1–8');
  const legs:Leg[]=r.legs.map(v=>{
    const l=record(v,['pool','delta','limitPrice','maxTakerFeeBpsTimes1k']);
    const p={pool:address(l.pool),delta:integer(l.delta,128,true),limitPrice:integer(l.limitPrice,256),maxTakerFeeBpsTimes1k:small(l.maxTakerFeeBpsTimes1k,9_999_999)};
    if(!p.delta||p.delta===-(1n<<127n)||!p.limitPrice) throw new DomainError('INVALID_LEG','Nonzero bounded quantity and positive price required');
    return p;
  });
  if(new Set(legs.map(l=>l.pool.toLowerCase())).size!==legs.length) throw new DomainError('DUPLICATE_POOL','One leg per pool');
  const validAfter=integer(r.validAfter,64),validUntil=integer(r.validUntil,64);
  if(validUntil<=validAfter||validUntil-validAfter>30n*86400n||validUntil*1_000_000_000n>=1n<<64n) throw new DomainError('INVALID_WINDOW','Invalid intent window or nanosecond overflow');
  if(typeof r.expectedPositionsHash!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(r.expectedPositionsHash)) throw new DomainError('INVALID_HASH','Expected bytes32 positions hash');
  return {account:address(r.account),executor:address(r.executor),nonce:integer(r.nonce,256),epoch:integer(r.epoch,256),expectedRevision:integer(r.expectedRevision,256),expectedPositionsHash:r.expectedPositionsHash as Hex,validAfter,validUntil,operation,legs,minNetQuote:integer(r.minNetQuote,256,true),triggerKind:small(r.triggerKind,2) as 0|1|2,triggerValue:integer(r.triggerValue,256,true),minPostEquity:integer(r.minPostEquity,256),minPostHealthBps:small(r.minPostHealthBps,0xffffffff)};
}
export function serializeIntent(i:Intent):WireIntent {
  return {...i,nonce:i.nonce.toString(),epoch:i.epoch.toString(),expectedRevision:i.expectedRevision.toString(),validAfter:i.validAfter.toString(),validUntil:i.validUntil.toString(),legs:i.legs.map(l=>({...l,delta:l.delta.toString(),limitPrice:l.limitPrice.toString()})),minNetQuote:i.minNetQuote.toString(),triggerValue:i.triggerValue.toString(),minPostEquity:i.minPostEquity.toString()};
}
export const intentTypes={
  Leg:[{name:'pool',type:'address'},{name:'delta',type:'int128'},{name:'limitPrice',type:'uint256'},{name:'maxTakerFeeBpsTimes1k',type:'uint32'}],
  Intent:[{name:'account',type:'address'},{name:'executor',type:'address'},{name:'nonce',type:'uint256'},{name:'epoch',type:'uint256'},{name:'expectedRevision',type:'uint256'},{name:'expectedPositionsHash',type:'bytes32'},{name:'validAfter',type:'uint64'},{name:'validUntil',type:'uint64'},{name:'operation',type:'uint8'},{name:'legs',type:'Leg[]'},{name:'minNetQuote',type:'int256'},{name:'triggerKind',type:'uint8'},{name:'triggerValue',type:'int256'},{name:'minPostEquity',type:'uint256'},{name:'minPostHealthBps',type:'uint32'}],
} as const;
export function getIntentTypedData(intent:Intent,chainId:number,router:Address){return {domain:{name:'SpreadLock',version:'1',chainId,verifyingContract:router},types:intentTypes,primaryType:'Intent' as const,message:{...intent}};}
export function hashIntent(intent:Intent,chainId:number,router:Address):Hex{return hashTypedData(getIntentTypedData(intent,chainId,router));}
export const fromWireIntent=parseIntent;
export const toWireIntent=serializeIntent;
