/** Read-only deployment/account inspection. No wallet, signing or broadcasting. */
import {readFile} from 'node:fs/promises';
import {getAddress} from 'viem';
import {parseManifest, SpreadLockClient} from '../packages/sdk/src/index.js';
function required(name:string):string {
  const value=process.env[name];
  if(!value)throw new Error(`${name} is required`);
  return value;
}
async function main():Promise<void> {
  const manifest=parseManifest(JSON.parse(await readFile(required('SPREADLOCK_MANIFEST'),'utf8')));
  const account=getAddress(required('BASKET_ACCOUNT'));
  const client=new SpreadLockClient(manifest,process.env.RPC_HTTP_URL??manifest.rpcHttpUrl);
  await client.verifyDeployment();
  const state=await client.accountState(account);
  console.log(JSON.stringify({chainId:manifest.chainId,account,...state},(_,value)=>typeof value==='bigint'?value.toString():value,2));
}
main().catch(error=>{
  process.stderr.write(`${error instanceof Error?error.message.split('\n')[0]:'Read-only inspection failed'}\n`);
  process.exitCode=1;
});
