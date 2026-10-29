import {describe,it,expect,vi} from 'vitest';
import {keccak256,toHex,type PublicClient} from 'viem';
import {fingerprint,fingerprintMatches} from './fingerprints.js';
import {parseManifest} from './manifest.js';
const a='0x1111111111111111111111111111111111111111' as const,b='0x2222222222222222222222222222222222222222' as const;
const code='0x60006000' as const,zero='0x'+'0'.repeat(64),word='0x'+'0'.repeat(24)+b.slice(2);
describe('pinned protocol fingerprints',()=>{
 it('detects bytecode changes on a non-proxy contract',async()=>{const c={getCode:vi.fn(async()=>code),getBlockNumber:vi.fn(async()=>10n),getStorageAt:vi.fn(async()=>zero)} as unknown as PublicClient;const f=await fingerprint(c,a);expect(f.codeHash).toBe(keccak256(code));expect(fingerprintMatches(f,{...f,codeHash:keccak256('0x12')})).toBe(false);});
 it('pins both EIP1967 beacon and its implementation bytecode',async()=>{let n=0;const c={getCode:vi.fn(async()=>code),getBlockNumber:vi.fn(async()=>10n),getStorageAt:vi.fn(async()=>++n===2?word:zero),readContract:vi.fn(async()=>b)} as unknown as PublicClient;const f=await fingerprint(c,a);expect(f.beacon?.toLowerCase()).toBe(b.toLowerCase());expect(f.implementationCodeHash).toBe(keccak256(code));expect(fingerprintMatches({...f,implementation:a},f)).toBe(false);});
 it('fails closed when target bytecode is missing',async()=>{const c={getCode:vi.fn(async()=>undefined)} as unknown as PublicClient;await expect(fingerprint(c,a)).rejects.toThrow('Contract missing');});
 it('pins direct EIP1967 implementations and rejects implementations with missing code',async()=>{
  const getCode=vi.fn(async()=>code as `0x${string}`|undefined);
  let storage=0;const c={getCode,getBlockNumber:vi.fn(async()=>10n),getStorageAt:vi.fn(async()=>++storage%2===1?word:undefined)} as unknown as PublicClient;
  const actual=await fingerprint(c,a);expect(actual.implementation?.toLowerCase()).toBe(b.toLowerCase());
  expect(actual.beacon).toBeUndefined();expect(fingerprintMatches(actual,{...actual,implementation:actual.implementation?.toUpperCase() as `0x${string}`})).toBe(true);
  getCode.mockResolvedValueOnce(code).mockResolvedValueOnce('0x');await expect(fingerprint(c,a)).rejects.toThrow('implementation has no code');
  getCode.mockResolvedValueOnce(code).mockResolvedValueOnce(undefined);await expect(fingerprint(c,a)).rejects.toThrow('implementation has no code');
 });
 it('validates manifests without mutating input and rejects unsafe RPC URLs',()=>{const v={version:1,chainId:50383,router:a,factory:b,marketRegistry:a,marginBank:b,collateral:a,permissionsRegistry:b,protocolFactory:a,deploymentBlock:'1',confirmations:12,markets:[a,b],fingerprints:{[a]:{codeHash:keccak256(code)}},rpcHttpUrl:'https://rpc.example'};const original=JSON.stringify(v);expect(parseManifest(v).markets).toHaveLength(2);expect(JSON.stringify(v)).toBe(original);expect(()=>parseManifest({...v,rpcHttpUrl:'file:///etc/passwd'})).toThrow();expect(()=>parseManifest({...v,markets:[a,a]})).toThrow();expect(()=>parseManifest({...v,fingerprints:{[a]:{codeHash:'0x12'}}})).toThrow();expect(()=>parseManifest({...v,router:'0x'+'0'.repeat(40)})).toThrow();});
});
