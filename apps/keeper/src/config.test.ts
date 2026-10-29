import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadKeeperConfig} from './config.js';
const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
function files(rawChange:Record<string,unknown>={},authChange:Record<string,unknown>={},manifestChange:Record<string,unknown>={}){
 const dir=mkdtempSync(join(tmpdir(),'keeper-config-'));dirs.push(dir);
 const manifest={version:1,chainId:50383,router:address(1),factory:address(2),marketRegistry:address(3),marginBank:address(4),collateral:address(5),permissionsRegistry:address(6),protocolFactory:address(7),deploymentBlock:'1',confirmations:12,markets:[address(8)],fingerprints:Object.fromEntries(Array.from({length:8},(_,n)=>[address(n+1),{codeHash:`0x${'11'.repeat(32)}`}])) ,...manifestChange};
 const auth={owner:address(10),keeper:address(11),accounts:[address(12)],chainId:50383,validUntil:'1999999999',nonce:'0',signature:'0x1234',...authChange};
 const raw={manifestFile:'manifest.json',authorizationFile:'authorization.json',rpcHttpUrl:'https://rpc.example',rpcWsUrl:'wss://rpc.example',apiBaseUrl:'https://api.example',routerCodeHash:`0x${'11'.repeat(32)}`,databasePath:'keeper.sqlite',keystorePath:'keystore.json',passwordFile:'password',maxFeePerGas:'100',maxDailyWei:'1000000',...rawChange};
 writeFileSync(join(dir,'manifest.json'),JSON.stringify(manifest));writeFileSync(join(dir,'authorization.json'),JSON.stringify(auth),{mode:0o600});writeFileSync(join(dir,'keeper.json'),JSON.stringify(raw));
 return {dir,path:join(dir,'keeper.json')};
}
describe('keeper production configuration boundaries',()=>{
 it('loads pinned production dependencies and resolves only local custody paths',()=>{const {dir,path}=files();const c=loadKeeperConfig(path);expect(c.databasePath).toBe(join(dir,'keeper.sqlite'));expect(c.maxGas).toBe(40_000_000n);expect(c.pollIntervalMs).toBe(1000);expect(c.allowLocalDevelopment).toBe(false);});
 it('permits HTTP only for explicit loopback development and accepts an absolute custody path',()=>{const {path}=files({allowLocalDevelopment:true,rpcHttpUrl:'http://127.0.0.1:8545',rpcWsUrl:'ws://[::1]:8546',apiBaseUrl:'http://localhost:3000',databasePath:'/tmp/keeper.sqlite',maxGas:'1',pollIntervalMs:250,healthPort:0},{},{fingerprints:undefined});const c=loadKeeperConfig(path);expect(c.databasePath).toBe('/tmp/keeper.sqlite');expect(c.healthPort).toBe(0);});
 it.each([
  {rpcHttpUrl:'http://127.0.0.1:8545'},{rpcWsUrl:'ws://localhost:8546'},{apiBaseUrl:'http://api.example',allowLocalDevelopment:true},
  {rpcHttpUrl:'https://user:secret@rpc.example'},{maxGas:'40000001'},{maxGas:'0'},{maxFeePerGas:'-1'},{maxDailyWei:'1'.repeat(79)},
  {pollIntervalMs:249},{pollIntervalMs:30001},{pollIntervalMs:1.5},{healthPort:-1},{healthPort:65536},{routerCodeHash:'0x12'},{manifestFile:''},
 ])('rejects unsafe runtime settings %j',raw=>{const {path}=files(raw);expect(()=>loadKeeperConfig(path)).toThrow();});
 it.each([{chainId:1},{accounts:[]},{accounts:['bad']},{accounts:Array.from({length:101},()=>address(12))},{owner:'bad'},{validUntil:'0'},{nonce:'-1'},{signature:'hello'}])('rejects invalid certificate scope %j',auth=>{const {path}=files({},auth);expect(()=>loadKeeperConfig(path)).toThrow();});
 it('refuses a production manifest missing even one dependency fingerprint',()=>{const {path}=files({},{},{fingerprints:{[address(1)]:{codeHash:`0x${'11'.repeat(32)}`}}});expect(()=>loadKeeperConfig(path)).toThrow('Production requires pinned');});
 it('rejects malformed top-level configurations',()=>{const {path}=files();writeFileSync(path,'[]');expect(()=>loadKeeperConfig(path)).toThrow('configuration object');});
});
