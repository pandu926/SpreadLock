import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {atomicJson,lockState} from './state.mjs';
test('durable state replacement and exclusive campaign lock',async()=>{const dir=await mkdtemp(join(tmpdir(),'spreadlock-state-test-')),file=join(dir,'state.json');try{const unlock=await lockState(file);await assert.rejects(lockState(file),/already running/);await atomicJson(file,{gas:'123'});await atomicJson(file,{gas:'124'});assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{gas:'124'});assert.equal((await stat(file)).mode&0o777,0o600);await unlock();const release=await lockState(file);await release();}finally{await rm(dir,{recursive:true,force:true});}});
