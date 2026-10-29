import {statfs} from 'node:fs/promises';
import {freemem} from 'node:os';
const fs=await statfs(process.cwd());const free=fs.bavail*fs.bsize;
const result={diskFreeGiB:Number((free/2**30).toFixed(2)),minimumDiskGiB:15,memoryAvailableGiB:Number((freemem()/2**30).toFixed(2))};
console.log(JSON.stringify(result,null,2));
if(free<15*2**30){console.error('Deployment blocked: obtain 15 GiB free space without deleting unrelated data.');process.exitCode=1;}
