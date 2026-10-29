import { describe,expect,it } from 'vitest';
import {privateKeyToAccount} from 'viem/accounts';
import {verifyTypedData} from 'viem';
import {canonicalPositionsHash,conservativeQuote,ceilDiv,getIntentTypedData,hashIntent,parseIntent,serializeIntent,type WireIntent} from './index.js';
const a='0x0000000000000000000000000000000000000001' as const,b='0x0000000000000000000000000000000000000002' as const;
function fixture():WireIntent{return {account:a,executor:b,nonce:'1',epoch:'0',expectedRevision:'0',expectedPositionsHash:canonicalPositionsHash([{pool:a,size:0n},{pool:b,size:0n}]),validAfter:'100',validUntil:'1000',operation:0,legs:[{pool:a,delta:'10',limitPrice:'100',maxTakerFeeBpsTimes1k:0},{pool:b,delta:'-20',limitPrice:'50',maxTakerFeeBpsTimes1k:0}],minNetQuote:'-100',triggerKind:0,triggerValue:'0',minPostEquity:'0',minPostHealthBps:20000};}
describe('intent wire and signature boundaries',()=>{
 it('roundtrips canonical integers without precision loss',()=>{const w=fixture();w.nonce=((1n<<256n)-1n).toString();expect(serializeIntent(parseIntent(w))).toEqual(w);});
 it.each(['01','-0','1.0','1e8','0x10','900.1'])('rejects noncanonical integer %s',n=>{expect(()=>parseIntent({...fixture(),nonce:n})).toThrow();});
 it('rejects unsigned overflow and invalid signs',()=>{expect(()=>parseIntent({...fixture(),nonce:(1n<<256n).toString()})).toThrow();expect(()=>parseIntent({...fixture(),epoch:'-1'})).toThrow();});
 it('rejects duplicate markets, zero quantity, zero address and invalid hash',()=>{
  const w=fixture();expect(()=>parseIntent({...w,legs:[w.legs[0],w.legs[0]]})).toThrow();
  expect(()=>parseIntent({...w,legs:[{...w.legs[0],delta:'0'},w.legs[1]]})).toThrow();
  expect(()=>parseIntent({...w,executor:'0x'+'0'.repeat(40)})).toThrow();
  expect(()=>parseIntent({...w,expectedPositionsHash:'0x12'})).toThrow();
 });
 it('rejects unknown fields and invalid windows',()=>{expect(()=>parseIntent({...fixture(),owner:a})).toThrow();expect(()=>parseIntent({...fixture(),validUntil:'1'})).toThrow();expect(()=>parseIntent({...fixture(),validUntil:'3000000'})).toThrow();});
 it('domain separates accounts, chains and routers',async()=>{
  // Ephemeral unit-test key only; never used on a public chain.
  const signer=privateKeyToAccount('0x'+'0'.repeat(63)+'1' as `0x${string}`);
  const i=parseIntent(fixture()),data=getIntentTypedData(i,31337,a);
  const signature=await signer.signTypedData(data);
  expect(await verifyTypedData({address:signer.address,...data,signature})).toBe(true);
  expect(hashIntent(i,31337,a)).not.toBe(hashIntent(i,31337,b));
  expect(hashIntent(i,31337,a)).not.toBe(hashIntent(i,50383,a));
  expect(hashIntent(i,31337,a)).not.toBe(hashIntent({...i,account:b},31337,a));
 });
});
describe('rounding safety across fragmented fills',()=>{
 it('is conservative against varied lot-aligned fragmented fills with per-fill fees',()=>{
  for(let lot=1n;lot<8n;lot++)for(let base=1n;base<13n;base++)for(let price=1n;price<17n;price++){
   const q=lot*5n,rate=12345n;
   const n1=lot*price/base,n2=lot*4n*price/base;
   const actualSell=n1-ceilDiv(n1*rate,10000000n)+n2-ceilDiv(n2*rate,10000000n);
   const actualBuy=-(n1+ceilDiv(n1*rate,10000000n)+n2+ceilDiv(n2*rate,10000000n));
   expect(conservativeQuote([{delta:-q,price,lotSize:lot,oneBase:base,feeRate:rate}])).toBeLessThanOrEqual(actualSell);
   expect(conservativeQuote([{delta:q,price,lotSize:lot,oneBase:base,feeRate:rate}])).toBeLessThanOrEqual(actualBuy);
  }
 });
 it('rejects invalid arithmetic and duplicate position snapshots',()=>{
  expect(()=>ceilDiv(-1n,1n)).toThrow();expect(()=>ceilDiv(1n,0n)).toThrow();
  expect(()=>conservativeQuote([{delta:3n,price:1n,lotSize:2n,oneBase:1n,feeRate:0n}])).toThrow();
  expect(()=>conservativeQuote([{delta:2n,price:1n,lotSize:2n,oneBase:1n,feeRate:10000000n}])).toThrow();
  expect(()=>canonicalPositionsHash([{pool:a,size:0n},{pool:a,size:1n}])).toThrow();
 });
});
