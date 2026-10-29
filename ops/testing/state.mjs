import {open,readFile,rename,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
export async function atomicJson(file,value){
 const temporary=`${file}.${randomUUID()}.tmp`,handle=await open(temporary,'wx',0o600);
 try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}
 try{await rename(temporary,file);const dir=await open(dirname(file),'r');try{await dir.sync();}finally{await dir.close();}}catch(error){await unlink(temporary).catch(()=>{});throw error;}
}
export async function lockState(file){
 const lock=file+'.lock';let handle;
 try{handle=await open(lock,'wx',0o600);}catch(error){if(error.code!=='EEXIST')throw error;const old=JSON.parse(await readFile(lock,'utf8'));if(!Number.isSafeInteger(old.pid)||old.pid<=0)throw new Error('Invalid lock; manual investigation required');let alive=true;try{process.kill(old.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}if(alive)throw new Error('Campaign already running');await unlink(lock);handle=await open(lock,'wx',0o600);}
 await handle.writeFile(JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}));await handle.sync();await handle.close();
 return async()=>{await unlink(lock);};
}
