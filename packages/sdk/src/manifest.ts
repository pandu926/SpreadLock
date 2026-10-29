import { getAddress, type Address, type Hex } from 'viem';
import { DomainError, type DeploymentManifest } from '../../domain/src/index.js';
export function parseManifest(value: unknown): DeploymentManifest {
  if(!value || typeof value !=='object' || Array.isArray(value)) throw new DomainError('INVALID_MANIFEST','Expected deployment manifest');
  const r=value as Record<string,unknown>;
  if(r.version!==1 || !Number.isSafeInteger(r.chainId) || Number(r.chainId)<=0 ||
    typeof r.deploymentBlock!=='string' || !/^(0|[1-9][0-9]*)$/.test(r.deploymentBlock) ||
    !Number.isSafeInteger(r.confirmations) || Number(r.confirmations)<1 || Number(r.confirmations)>256)
    throw new DomainError('INVALID_MANIFEST','Invalid version, chain, block, or confirmations');
  function addressValue(v:unknown,key:string):Address {
    if(typeof v!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(v)||/^0x0{40}$/i.test(v)) throw new DomainError('INVALID_MANIFEST',`Invalid ${key}`);
    return getAddress(v);
  }
  const addr=(key:string)=>addressValue(r[key],key);
  if(!Array.isArray(r.markets)||r.markets.length===0||r.markets.length>1000) throw new DomainError('INVALID_MANIFEST','Expected market allowlist');
  const markets=r.markets.map((m,i)=>addressValue(m,`market${i}`));
  if(new Set(markets.map(m=>m.toLowerCase())).size!==markets.length) throw new DomainError('INVALID_MANIFEST','Duplicate market');
  const url=(key:string):string|undefined=>{
    if(r[key]===undefined)return undefined;
    if(typeof r[key]!=='string')throw new DomainError('INVALID_MANIFEST','Invalid RPC URL');
    const u=new URL(r[key]);
    if(!['http:','https:','ws:','wss:'].includes(u.protocol)||u.username||u.password)throw new DomainError('INVALID_MANIFEST','Invalid RPC URL');
    return u.toString();
  };
  let fingerprints:DeploymentManifest['fingerprints'];
  if(r.fingerprints!==undefined){
    if(!r.fingerprints||typeof r.fingerprints!=='object'||Array.isArray(r.fingerprints))throw new DomainError('INVALID_MANIFEST','Invalid fingerprints');
    fingerprints={};
    for(const [key,value] of Object.entries(r.fingerprints)){
      const target=addressValue(key,'fingerprint target');
      if(!value||typeof value!=='object')throw new DomainError('INVALID_MANIFEST','Invalid fingerprint');
      const f=value as Record<string,unknown>;
      if(typeof f.codeHash!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(f.codeHash))throw new DomainError('INVALID_MANIFEST','Invalid code hash');
      if(f.implementationCodeHash!==undefined&&(typeof f.implementationCodeHash!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(f.implementationCodeHash)))throw new DomainError('INVALID_MANIFEST','Invalid implementation code hash');
      fingerprints[target]={codeHash:f.codeHash as Hex,
        implementation:f.implementation===undefined?undefined:addressValue(f.implementation,'implementation'),
        implementationCodeHash:f.implementationCodeHash as Hex|undefined,
        beacon:f.beacon===undefined?undefined:addressValue(f.beacon,'beacon')};
    }
  }
  return {version:1,chainId:Number(r.chainId),router:addr('router'),factory:addr('factory'),marketRegistry:addr('marketRegistry'),
    marginBank:addr('marginBank'),collateral:addr('collateral'),permissionsRegistry:addr('permissionsRegistry'),protocolFactory:addr('protocolFactory'),
    deploymentBlock:r.deploymentBlock,confirmations:Number(r.confirmations),markets,fingerprints,rpcHttpUrl:url('rpcHttpUrl'),rpcWsUrl:url('rpcWsUrl')};
}
