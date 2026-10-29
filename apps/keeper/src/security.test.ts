import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Wallet,encryptKeystoreJson} from 'ethers';
import {parseTransaction,recoverTransactionAddress,verifyMessage} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {readPrivateFile} from './config.js';
import {acquireKeeperLock} from './lock.js';
import {loadKeeperSigner} from './signer.js';
import {ApiIntentFeed} from './api.js';
import type {KeeperRuntimeConfig} from './config.js';
const dirs:string[]=[];afterEach(()=>{vi.unstubAllGlobals();for(const p of dirs.splice(0))rmSync(p,{recursive:true,force:true});});
const temp=()=>{const p=mkdtempSync(join(tmpdir(),'spreadlock-security-'));dirs.push(p);return p;};
describe('local key custody and process isolation',()=>{
 it('refuses shared-readable secrets and locks a keeper instance',()=>{const dir=temp(),f=join(dir,'secret');writeFileSync(f,'secret',{mode:0o644});expect(()=>readPrivateFile(f)).toThrow();chmodSync(f,0o600);expect(readPrivateFile(f)).toBe('secret');const unlock=acquireKeeperLock(join(dir,'lock'));expect(()=>acquireKeeperLock(join(dir,'lock'))).toThrow();unlock();const unlock2=acquireKeeperLock(join(dir,'lock'));unlock2();});
 // Small KDF work factor is test-only; production CLI keeps ethers secure defaults.
 it('decrypts a local keystore, checks expected address and signs locally',async()=>{const dir=temp(),key=generatePrivateKey(),owner=privateKeyToAccount(key),w=new Wallet(key);const password=join(dir,'password'),keystore=join(dir,'wallet');writeFileSync(password,'correct horse',{mode:0o600});writeFileSync(keystore,await encryptKeystoreJson({address:w.address,privateKey:key},'correct horse',{scrypt:{N:1024,r:8,p:1}}),{mode:0o600});const s=await loadKeeperSigner(keystore,password,owner.address);expect(s.address).toBe(owner.address);expect(await verifyMessage({address:owner.address,message:'local test',signature:await s.signMessage('local test')})).toBe(true);const to='0x2222222222222222222222222222222222222222' as const;const signed=await s.signTransaction({chainId:50383,to,data:'0x1234',value:999n,prices:[100n],gasEstimate:21000n,nonce:7,gas:25000n,maxFeePerGas:10n,maxPriorityFeePerGas:2n});expect(parseTransaction(signed)).toMatchObject({type:'eip1559',chainId:50383,to,data:'0x1234',nonce:7,gas:25000n,maxFeePerGas:10n,maxPriorityFeePerGas:2n});expect(parseTransaction(signed).value??0n).toBe(0n);expect((await recoverTransactionAddress({serializedTransaction:signed as `0x02${string}`})).toLowerCase()).toBe(owner.address.toLowerCase());await expect(loadKeeperSigner(keystore,password,'0x1111111111111111111111111111111111111111')).rejects.toThrow('does not match');},30000);
 it('does not sign an API-controlled challenge for another domain',async()=>{const sign=vi.fn();vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({success:true,data:{challengeId:'test',message:'attacker.example wants you to sign in with your Ethereum account:\n0x1111111111111111111111111111111111111111\n\nSign in\n\nURI: https://attacker.example\nVersion: 1\nChain ID: 50383\nNonce: 12345678\nIssued At: 2026-10-28T00:00:00.000Z'}}),{status:200})));const config={apiBaseUrl:'https://api.example',manifest:{chainId:50383},authorization:{}} as KeeperRuntimeConfig;const feed=new ApiIntentFeed(config,{address:'0x1111111111111111111111111111111111111111',signMessage:sign,signTransaction:vi.fn()});await expect(feed.authenticate()).rejects.toThrow();expect(sign).not.toHaveBeenCalled();});
});
