import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sourceManifest,checkCoverage,validateReport,REQUIRED_GATES,externalGate} from './lib.mjs';

async function fixture(fn){const dir=await mkdtemp(join(tmpdir(),'spreadlock-verify-'));try{await mkdir(join(dir,'apps/api/src'),{recursive:true});await writeFile(join(dir,'apps/api/src/auth.ts'),'export const enabled=true;\n');await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}
const metric=(covered=10,total=10)=>({covered,total,skipped:0,pct:total?covered/total*100:100});
const counters=(covered=10,total=10)=>({lines:metric(covered,total),branches:metric(covered,total),functions:metric(covered,total),statements:metric(covered,total)});

test('source manifest is deterministic, ignores generated evidence and detects source changes',()=>fixture(async dir=>{
 const a=await sourceManifest(dir);await mkdir(join(dir,'evidence'),{recursive:true});await writeFile(join(dir,'evidence/output.json'),'{}');assert.deepEqual(await sourceManifest(dir),a);
 await writeFile(join(dir,'apps/api/src/auth.ts'),'export const enabled=false;\n');assert.notEqual((await sourceManifest(dir)).sha256,a.sha256);
}));
test('source inventory includes all runtime source and lock/config files without reading secret dirs',()=>fixture(async dir=>{
 await mkdir(join(dir,'secrets'));await writeFile(join(dir,'secrets/key.ts'),'SECRET');await writeFile(join(dir,'package-lock.json'),'{}');await writeFile(join(dir,'.env'),'SECRET');
 const files=(await sourceManifest(dir)).files.map(f=>f.path);assert.deepEqual(files,['apps/api/src/auth.ts','package-lock.json']);
}));
test('coverage fails closed on missing file and does not trust a forged percentage',()=>{
 assert.equal(checkCoverage({total:counters()},{root:'/project',critical:['apps/api/src/auth.ts']}).passed,false);
 const forged=counters(1);for(const m of Object.values(forged))m.pct=100;
 const r=checkCoverage({total:counters(),'/project/apps/api/src/auth.ts':forged},{root:'/project',critical:['apps/api/src/auth.ts']});assert.equal(r.passed,false);
});
test('coverage checks each critical file, overall threshold and rejects invalid counters',()=>{
 const critical=['apps/api/src/auth.ts'];const root='/project';
 assert.equal(checkCoverage({total:counters(),'/project/apps/api/src/auth.ts':counters(9)},{root,critical}).passed,true);
 assert.equal(checkCoverage({total:counters(7),'/project/apps/api/src/auth.ts':counters()},{root,critical}).passed,false);
 const bad=counters();bad.branches.covered=11;assert.equal(checkCoverage({total:counters(),'/project/apps/api/src/auth.ts':bad},{root,critical}).passed,false);
 assert.equal(checkCoverage(null,{root,critical}).passed,false);
});
test('report cannot approve partial, duplicate or stale gates',()=>fixture(async dir=>{
 const source=await sourceManifest(dir);const now=new Date('2026-10-29T12:00:00Z');const gates=REQUIRED_GATES.map(id=>({id,status:'PASS',artifacts:[{path:'proof.log',sha256:'bad'}]}));
 await writeFile(join(dir,'proof.log'),'ok');const report={schemaVersion:1,runId:'test',source,startedAt:now.toISOString(),completedAt:now.toISOString(),tools:{node:'v24'},gates,productionApproved:true};
 assert.equal((await validateReport(report,{root:dir,now})).passed,false);
 assert.equal((await validateReport({...report,gates:[]},{root:dir,now})).passed,false);
 assert.equal((await validateReport({...report,gates:[...gates,gates[0]]},{root:dir,now})).passed,false);
 assert.equal((await validateReport({...report,completedAt:'2026-10-20T00:00:00Z'},{root:dir,now})).passed,false);
}));
test('a locally complete report remains unapproved when external evidence is unavailable',()=>fixture(async dir=>{
 const source=await sourceManifest(dir);const gate=await externalGate('independent_audit',{root:dir,source,now:new Date()});assert.equal(gate.status,'BLOCKED');
 const result=await validateReport({schemaVersion:1,runId:'test',source,startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),tools:{node:'v24'},gates:[gate],productionApproved:false},{root:dir});assert.equal(result.passed,false);
}));
test('external proof cannot claim soak before seven days or reference another source',()=>fixture(async dir=>{
 const source=await sourceManifest(dir);await mkdir(join(dir,'evidence/external'),{recursive:true});
 const proof={schemaVersion:1,gate:'testnet_soak',sourceSha256:source.sha256,reviewedBy:'operator',startedAt:'2026-10-28T00:00:00Z',completedAt:'2026-10-29T00:00:00Z',measurements:{availability:1,days:7,canonicalTransactions:28},artifacts:[]};
 await writeFile(join(dir,'evidence/external/testnet_soak.json'),JSON.stringify(proof));assert.equal((await externalGate('testnet_soak',{root:dir,source,now:new Date('2026-10-29T12:00:00Z')})).status,'FAIL');
 proof.sourceSha256='0'.repeat(64);await writeFile(join(dir,'evidence/external/testnet_soak.json'),JSON.stringify(proof));assert.equal((await externalGate('testnet_soak',{root:dir,source})).status,'FAIL');
}));

test('artifact hash mismatch and source changes are explicitly reported',()=>fixture(async dir=>{
 const source=await sourceManifest(dir);await writeFile(join(dir,'proof.log'),'ok');
 const report={schemaVersion:1,runId:'integrity',source,startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),tools:{node:'v24'},productionApproved:false,gates:[{id:'unit',status:'PASS',artifacts:[{path:'proof.log',sha256:'0'.repeat(64)}]}]};
 let result=await validateReport(report,{root:dir});assert.ok(result.errors.includes('unit:ARTIFACT_CHANGED:proof.log'));
 await writeFile(join(dir,'apps/api/src/auth.ts'),'changed');result=await validateReport(report,{root:dir});assert.ok(result.errors.includes('SOURCE_CHANGED'));
}));
test('fresh reports reject future, inverted, stale timestamps and duplicate gate identities',()=>fixture(async dir=>{
 const now=new Date('2026-10-29T12:00:00Z'),source=await sourceManifest(dir);
 const base={schemaVersion:1,runId:'time',source,startedAt:now.toISOString(),completedAt:now.toISOString(),tools:{node:'v24'},gates:[],productionApproved:false};
 for(const completedAt of ['2026-10-30T12:00:00Z','2026-10-28T11:59:59Z','broken']){const r=await validateReport({...base,completedAt},{root:dir,now});assert.ok(r.errors.includes('STALE_OR_INVALID_TIME'));}
 const r=await validateReport({...base,gates:[{id:'unit',status:'NOT_RUN'},{id:'unit',status:'NOT_RUN'}]},{root:dir,now});assert.ok(r.errors.includes('INVALID_OR_DUPLICATE_GATE'));
}));
test('valid measured external proof needs matching artifact bytes',()=>fixture(async dir=>{
 const source=await sourceManifest(dir);await mkdir(join(dir,'evidence/external'),{recursive:true});await writeFile(join(dir,'evidence/audit.txt'),'review');
 const {artifact}=await import('./lib.mjs');const proof={schemaVersion:1,gate:'independent_audit',sourceSha256:source.sha256,reviewedBy:'Independent auditor',startedAt:'2026-10-28T00:00:00Z',completedAt:'2026-10-29T00:00:00Z',measurements:{independent:true,criticalOpen:0,highOpen:0,retestsPassed:true},artifacts:[await artifact(dir,'evidence/audit.txt')]};
 await writeFile(join(dir,'evidence/external/independent_audit.json'),JSON.stringify(proof));assert.equal((await externalGate('independent_audit',{root:dir,source,now:new Date('2026-10-29T12:00:00Z')})).status,'PASS');
 await writeFile(join(dir,'evidence/audit.txt'),'different');assert.equal((await externalGate('independent_audit',{root:dir,source,now:new Date('2026-10-29T12:00:00Z')})).status,'FAIL');
}));
test('negative operational measurements cannot satisfy an external gate',()=>fixture(async dir=>{
 const source=await sourceManifest(dir);await mkdir(join(dir,'evidence/external'),{recursive:true});await writeFile(join(dir,'evidence/dr.txt'),'restore');const {artifact}=await import('./lib.mjs');
 const proof={schemaVersion:1,gate:'disaster_recovery',sourceSha256:source.sha256,reviewedBy:'Operator',startedAt:'2026-10-28T00:00:00Z',completedAt:'2026-10-29T00:00:00Z',measurements:{secondHost:true,offsiteEncrypted:true,walArchiving:true,rpoSeconds:-1,rtoSeconds:-1,chainReconciled:true,restoredRows:1},artifacts:[await artifact(dir,'evidence/dr.txt')]};
 await writeFile(join(dir,'evidence/external/disaster_recovery.json'),JSON.stringify(proof));assert.equal((await externalGate('disaster_recovery',{root:dir,source,now:new Date('2026-10-29T12:00:00Z')})).status,'FAIL');
}));

test('null measurements and artifacts traversing symlinks fail closed',()=>fixture(async dir=>{
 const source=await sourceManifest(dir);await mkdir(join(dir,'evidence/external'),{recursive:true});await writeFile(join(dir,'evidence/dr.txt'),'restore');const {artifact}=await import('./lib.mjs');
 const proof={schemaVersion:1,gate:'disaster_recovery',sourceSha256:source.sha256,reviewedBy:'Operator',startedAt:'2026-10-28T00:00:00Z',completedAt:'2026-10-29T00:00:00Z',measurements:{secondHost:true,offsiteEncrypted:true,walArchiving:true,rpoSeconds:null,rtoSeconds:100,chainReconciled:true,restoredRows:1},artifacts:[await artifact(dir,'evidence/dr.txt')]};
 await writeFile(join(dir,'evidence/external/disaster_recovery.json'),JSON.stringify(proof));assert.equal((await externalGate('disaster_recovery',{root:dir,source,now:new Date('2026-10-29T12:00:00Z')})).status,'FAIL');
 const {symlink}=await import('node:fs/promises');await symlink('/etc/hostname',join(dir,'outside'));await assert.rejects(artifact(dir,'outside'),/outside root/);
}));

const measured={
 independent_audit:{independent:true,criticalOpen:0,highOpen:0,retestsPassed:true},
 testnet_public:{chainId:50383,confirmations:12,broadcast:true,impersonation:false,reconciled:true,legCounts:[2,4,8],canonicalTransactions:10,gasSpentWei:'100',maxCollateralWei:'100'},
 testnet_soak:{availability:0.999,reconciliationsPassed:7,roundTrips:14,stateLosses:0,criticalFindingsOpen:0,healthCheckIntervalSeconds:60},
 load:{users:100,keepers:10,requestsPerSecond:100,durationSeconds:3600,burstRequestsPerSecond:300,burstDurationSeconds:300,readP95Ms:100,writeP95Ms:200,quoteP95Ms:1000,http5xxRatio:0,authFailures:0,accountingFailures:0,lostJobs:0,ooms:0,queueRecoverySeconds:100,controlledRpc:true},
 disaster_recovery:{secondHost:true,offsiteEncrypted:true,walArchiving:true,rpoSeconds:100,rtoSeconds:1000,chainReconciled:true,restoredRows:1},
 operations:{diskFreeGiB:15,tlsVerified:true,proxyCidrsVerified:true,nonRootContainers:true,ownerSignerSeparated:true,alertDeliveryMaxSeconds:100,isolatedDatabase:true},
 mainnet_compatibility:{chainId:5031,protocolAvailable:true,officialAddressesVerified:true,proxyFingerprintsVerified:true,forkPassed:true,sourceVerified:true},
 governance:{threshold:2,owners:3,timelockSeconds:172800,guardianSeparated:true,pauseExitDrillPassed:true,multisig:'0x1111111111111111111111111111111111111111',guardian:'0x2222222222222222222222222222222222222222'},
 mainnet_canary_authorization:{explicitOwnerApproval:true,mainnetCanaryPassed:true,emergencyDrillPassed:true,maxCollateralWei:'1',maxGasSpendWei:'1'},
};
async function measuredArtifacts(dir,gate,source,base){
 if(!['load','testnet_soak','disaster_recovery'].includes(gate))return base;
 const {artifact}=await import('./lib.mjs');let metrics,type;
 if(gate==='load'){type='load';metrics={profile:'full',sourceUnchanged:true,activeOwners:100,activeKeepers:10,authFailures:0,accountingFailures:0,lostJobs:0,durationMs:3600000,burstDurationMs:300000,targetRps:100,burstRps:300,concurrency:100,owners:100,keepers:10,baskets:1000,intents:10000,total:450000,serverErrors:0,unexpectedResponses:0,dropped:0,readP95Ms:100,writeP95Ms:200,quoteP95Ms:1000,queueRecoveryMs:100000,peakMemoryBytes:1000,oomEvents:0,assertionFailures:0,completedWrites:22000};}
 if(gate==='testnet_soak'){type='soak';metrics={sourceSha256:source.sha256,startedAt:Date.parse('2026-10-21T00:00:00Z'),lastAt:Date.parse('2026-10-29T00:00:00Z'),probes:11520,readyProbes:11520,unreadyProbes:0,missingProbes:0,gasSpentWei:'100',maxCollateralCommittedWei:'100',canonicalCycles:14,days:Object.fromEntries(Array.from({length:7},(_,i)=>[i,{reconciliations:1,cycles:2}])),failures:[]};}
 let nested=[];
 if(gate==='disaster_recovery'){type='dr';await writeFile(join(dir,'evidence/backup.bin'),'backup');await writeFile(join(dir,'evidence/restore.txt'),'restore');nested=[await artifact(dir,'evidence/backup.bin'),await artifact(dir,'evidence/restore.txt')];
 metrics={sourceHostId:'host-a',restoreHostId:'host-b',encrypted:true,offsite:true,walArchived:true,targetWasEmpty:true,restoreStartedAt:1000000,restoreCompletedAt:2000000,lastRecoverableAt:900000,incidentAt:1000000,reconciled:true,backupSha256:nested[0].sha256,restoreArtifactSha256:nested[1].sha256};
 for(const hostId of ['host-a','host-b']){const file=`evidence/${hostId}.json`;await writeFile(join(dir,file),JSON.stringify({schemaVersion:1,type:'host-observation',sourceSha256:source.sha256,hostId,at:'2026-10-29T00:00:00Z'}));nested.push(await artifact(dir,file));}}
 const file=`evidence/raw-${gate}.json`;await writeFile(join(dir,file),JSON.stringify({schemaVersion:1,type,status:'PASS',sourceSha256:source.sha256,startedAt:'2026-10-21T00:00:00Z',completedAt:'2026-10-29T00:00:00Z',metrics,artifacts:nested}));return [...base,await artifact(dir,file)];
}
test('every external gate enforces its own measured acceptance criteria',()=>fixture(async dir=>{
 const source=await sourceManifest(dir),now=new Date('2026-10-29T12:00:00Z');await mkdir(join(dir,'evidence/external'),{recursive:true});await writeFile(join(dir,'evidence/proof.log'),'measured proof');const {artifact}=await import('./lib.mjs');
 for(const [gate,measurements]of Object.entries(measured)){
  const p={schemaVersion:1,gate,sourceSha256:source.sha256,reviewedBy:'test reviewer',startedAt:'2026-10-21T00:00:00Z',completedAt:'2026-10-29T00:00:00Z',measurements,artifacts:await measuredArtifacts(dir,gate,source,[await artifact(dir,'evidence/proof.log')])};const file=join(dir,`evidence/external/${gate}.json`);await writeFile(file,JSON.stringify(p));assert.equal((await externalGate(gate,{root:dir,source,now})).status,'PASS',gate);
  p.measurements={};await writeFile(file,JSON.stringify(p));assert.equal((await externalGate(gate,{root:dir,source,now})).status,'FAIL',gate);
 }
}));
test('production approval requires all local artifacts plus all measured external proofs',()=>fixture(async dir=>{
 const source=await sourceManifest(dir),now=new Date('2026-10-29T12:00:00Z');const {artifact,LOCAL_GATES}=await import('./lib.mjs');await mkdir(join(dir,'evidence/external'),{recursive:true});await writeFile(join(dir,'evidence/proof.log'),'measured proof');const proof=await artifact(dir,'evidence/proof.log');
 const gates=LOCAL_GATES.map(id=>({id,status:'PASS',artifacts:[proof]}));
 for(const [gate,measurements]of Object.entries(measured)){
  await writeFile(join(dir,`evidence/external/${gate}.json`),JSON.stringify({schemaVersion:1,gate,sourceSha256:source.sha256,reviewedBy:'test reviewer',startedAt:'2026-10-21T00:00:00Z',completedAt:'2026-10-29T00:00:00Z',measurements,artifacts:await measuredArtifacts(dir,gate,source,[proof])}));gates.push(await externalGate(gate,{root:dir,source,now}));
 }
 const report={schemaVersion:1,runId:'complete',source,tools:{node:'v24',forge:'1.5.1',npm:'11',solc:'0.8.30',postgresServer:'17'},startedAt:now.toISOString(),completedAt:now.toISOString(),gates,productionApproved:true};let result=await validateReport(report,{root:dir,now});assert.equal(result.passed,true,result.errors.join('\n'));
 result=await validateReport({...report,gates:gates.slice(1)},{root:dir,now});assert.equal(result.productionApproved,false);assert.ok(result.errors.some(e=>e.startsWith('MISSING_GATE')));
 result=await validateReport({...report,source:{...source,files:[]}},{root:dir,now});assert.ok(result.errors.includes('SOURCE_INVENTORY_CHANGED'));
}));

test('malformed external JSON shapes become FAIL rather than crash the release verifier',()=>fixture(async dir=>{
 const source=await sourceManifest(dir);await mkdir(join(dir,'evidence/external'),{recursive:true});const file=join(dir,'evidence/external/independent_audit.json');
 for(const content of ['null','[]','{"broken":','"string"']){await writeFile(file,content);assert.equal((await externalGate('independent_audit',{root:dir,source})).status,'FAIL');}
}));
test('source symlinks, artifact traversal and incomplete counter objects are rejected',()=>fixture(async dir=>{
 const {symlink}=await import('node:fs/promises');const {artifact}=await import('./lib.mjs');await symlink('/etc/hostname',join(dir,'apps/api/src/bad.ts'));await assert.rejects(sourceManifest(dir),/Source symlink/);await assert.rejects(artifact(dir,'../outside'),/outside root/);
 const r=checkCoverage({total:{},'/project/a.ts':{lines:{covered:1,total:0}}},{root:'/project',critical:['a.ts']});assert.equal(r.passed,false);
}));
test('invalid gate identities and missing tool versions cannot approve a report',()=>fixture(async dir=>{
 const source=await sourceManifest(dir),now=new Date();const report={schemaVersion:1,runId:'bad',source,tools:{node:'v24'},startedAt:now.toISOString(),completedAt:now.toISOString(),gates:[null,{id:'unknown',status:'PASS'},{id:'unit',status:'MAYBE'}],productionApproved:false};const r=await validateReport(report,{root:dir,now});assert.ok(r.errors.includes('INVALID_OR_DUPLICATE_GATE'));assert.ok(r.errors.includes('MISSING_TOOL_VERSION:forge'));
}));

test('runner preserves a failing command log and never approves a partial run',()=>fixture(async dir=>{
 const {copyFile,symlink,chmod}=await import('node:fs/promises');const {spawn}=await import('node:child_process');
 await mkdir(join(dir,'scripts/verification'),{recursive:true});for(const file of ['run.mjs','lib.mjs'])await copyFile(new URL(file,import.meta.url),join(dir,'scripts/verification',file));await symlink(new URL('../../node_modules',import.meta.url).pathname,join(dir,'node_modules'),'dir');
 const bin=join(dir,'fake-bin');await mkdir(bin);const fake=join(bin,'npm');await writeFile(fake,'#!/bin/sh\nif [ "$1" = "--version" ]; then echo 11; exit 0; fi\necho intended_typecheck_failure\nexit 42\n');await chmod(fake,0o700);
 const code=await new Promise(resolveCode=>{const env={...process.env,PATH:bin+':'+process.env.PATH};delete env.TEST_DATABASE_URL;const c=spawn(process.execPath,['scripts/verification/run.mjs','--only','typecheck'],{cwd:dir,env,stdio:'ignore'});c.on('close',resolveCode);});assert.equal(code,1);
 const {readFile}=await import('node:fs/promises');const report=JSON.parse(await readFile(join(dir,'evidence/verification.json'),'utf8'));assert.equal(report.productionApproved,false);assert.equal(report.gates.find(g=>g.id==='typecheck').status,'FAIL');assert.ok((await readFile(join(dir,report.gates.find(g=>g.id==='typecheck').artifacts[0].path),'utf8')).includes('intended_typecheck_failure'));assert.equal(report.gates.find(g=>g.id==='unit').status,'NOT_RUN');assert.equal(report.gates.find(g=>g.id==='testnet_soak').status,'BLOCKED');
}));

test('SQL migrations are source-bound while generated fixtures and caches stay excluded',()=>fixture(async dir=>{
 await mkdir(join(dir,'packages/db/migrations'),{recursive:true});const migration=join(dir,'packages/db/migrations/0002.sql');await writeFile(migration,'ALTER TABLE a ADD COLUMN b text;');const before=await sourceManifest(dir);assert.ok(before.files.some(f=>f.path.endsWith('0002.sql')));
 await mkdir(join(dir,'packages/db/cache'),{recursive:true});await writeFile(join(dir,'packages/db/cache/generated.sql'),'generated');assert.deepEqual(await sourceManifest(dir),before);
 await writeFile(migration,'ALTER TABLE a ADD COLUMN b bigint;');assert.notEqual((await sourceManifest(dir)).sha256,before.sha256);
}));

test('operational gate rejects smoke/failed daily soak/invalid DR even when envelope claims success',()=>fixture(async dir=>{
 const {artifact}=await import('./lib.mjs');const source=await sourceManifest(dir),now=new Date('2026-10-29T12:00:00Z');await mkdir(join(dir,'evidence/external'),{recursive:true});
 for(const gate of ['load','testnet_soak','disaster_recovery']){const refs=await measuredArtifacts(dir,gate,source,[]),rawFile=refs[0].path;const raw=JSON.parse(await (await import('node:fs/promises')).readFile(join(dir,rawFile),'utf8'));
 if(gate==='load')raw.metrics.profile='smoke';if(gate==='testnet_soak')delete raw.metrics.days[6];if(gate==='disaster_recovery')raw.metrics.restoreHostId=raw.metrics.sourceHostId;
 await writeFile(join(dir,rawFile),JSON.stringify(raw));const proof={schemaVersion:1,gate,sourceSha256:source.sha256,reviewedBy:'test reviewer',startedAt:raw.startedAt,completedAt:raw.completedAt,measurements:measured[gate],artifacts:[await artifact(dir,rawFile)]};await writeFile(join(dir,`evidence/external/${gate}.json`),JSON.stringify(proof));assert.equal((await externalGate(gate,{root:dir,source,now})).status,'FAIL',gate);
 }
}));
