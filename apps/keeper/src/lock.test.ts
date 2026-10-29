import {afterEach,describe,expect,it,vi} from 'vitest';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {acquireKeeperLock} from './lock.js';
const directories:string[]=[];
function fixture(){const dir=mkdtempSync(join(tmpdir(),'spreadlock-lock-'));directories.push(dir);return join(dir,'keeper.lock');}
afterEach(()=>{vi.restoreAllMocks();for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
describe('keeper exclusive lock fault boundaries',()=>{
 it('recovers a stale owner only when the process is confirmed absent',()=>{const path=fixture();writeFileSync(path,'2147483647:stale',{mode:0o600});vi.spyOn(process,'kill').mockImplementation(()=>{throw Object.assign(new Error('not running'),{code:'ESRCH'});});const release=acquireKeeperLock(path);expect(readFileSync(path,'utf8')).toMatch(new RegExp(`^${process.pid}:`));release();expect(existsSync(path)).toBe(false);});
 it.each(['','abc:unknown','0:unknown','-1:unknown','1.5:unknown'])('requires inspection for untrusted lock identity %s',identity=>{const path=fixture();writeFileSync(path,identity);expect(()=>acquireKeeperLock(path)).toThrow('operator inspection');expect(readFileSync(path,'utf8')).toBe(identity);});
 it('does not steal a process lock when permission prevents determining liveness',()=>{const path=fixture();writeFileSync(path,'123:existing');vi.spyOn(process,'kill').mockImplementation(()=>{throw Object.assign(new Error('permission denied'),{code:'EPERM'});});expect(()=>acquireKeeperLock(path)).toThrow('permission denied');expect(readFileSync(path,'utf8')).toBe('123:existing');});
 it('refuses stale recovery when another actor changes the identity during inspection',()=>{const path=fixture();writeFileSync(path,'123:old');vi.spyOn(process,'kill').mockImplementation(()=>{writeFileSync(path,'456:new');throw Object.assign(new Error('gone'),{code:'ESRCH'});});expect(()=>acquireKeeperLock(path)).toThrow('changed during recovery');expect(readFileSync(path,'utf8')).toBe('456:new');});
 it('never removes a replacement lock when the old owner releases',()=>{const path=fixture(),release=acquireKeeperLock(path);writeFileSync(path,'456:new');release();expect(readFileSync(path,'utf8')).toBe('456:new');});
 it('handles repeated release or an already deleted lock idempotently',()=>{const path=fixture(),release=acquireKeeperLock(path);unlinkSync(path);expect(release).not.toThrow();expect(release).not.toThrow();});
 it('propagates filesystem creation and release failures instead of pretending ownership',()=>{const path=fixture();expect(()=>acquireKeeperLock(join(path,'absent','lock'))).toThrow();const release=acquireKeeperLock(path);unlinkSync(path);mkdirSync(path);expect(release).toThrow();});
});
