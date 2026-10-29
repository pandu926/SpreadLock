import {createHash} from 'node:crypto';
import {readFile,readdir,stat,realpath} from 'node:fs/promises';
import {resolve,relative,join,sep} from 'node:path';

export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const SOURCE_ROOTS=['apps','packages','contracts/src','contracts/test','contracts/script','ops/scripts','ops/testing','scripts','.github'];
const ROOT_FILES=['package.json','package-lock.json','tsconfig.json','foundry.toml','contracts/foundry.toml','vitest.config.ts','vitest.coverage.config.ts','vitest.integration.config.ts','Dockerfile','.gitignore','.env.example','compose.yaml','docker-compose.yml','.dockerignore'];
const IGNORED=new Set(['node_modules','out','cache','broadcast','coverage','coverage-hardening','evidence','__pycache__','dist']);
const SOURCE_EXT=/\.(?:[cm]?js|ts|sol|sql|py|sh|json|toml|ya?ml)$/;
const portable=p=>p.split(sep).join('/');

export async function sourceManifest(root=process.cwd()){
 const paths=[];
 async function walk(path){let entries;try{entries=await readdir(join(root,path),{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}
  for(const e of entries){const p=join(path,e.name);if(e.isSymbolicLink())throw new Error(`Source symlink forbidden: ${p}`);if(e.isDirectory()){if(!IGNORED.has(e.name))await walk(p);}else if(e.isFile()&&SOURCE_EXT.test(e.name))paths.push(portable(p));}}
 for(const path of SOURCE_ROOTS)await walk(path);
 for(const path of ROOT_FILES){try{const s=await stat(join(root,path));if(s.isFile())paths.push(path);}catch(e){if(e.code!=='ENOENT')throw e;}}
 const files=await Promise.all([...new Set(paths)].sort().map(async path=>({path,sha256:sha256(await readFile(join(root,path)))})));
 return {sha256:sha256(JSON.stringify(files)),files};
}

export const CRITICAL_BACKEND=[
 'packages/domain/src/intent.ts','packages/domain/src/math.ts','packages/sdk/src/manifest.ts','packages/sdk/src/client.ts','packages/sdk/src/api.ts','packages/sdk/src/fingerprints.ts',
 'packages/db/src/pg-store.ts','packages/db/src/migrate.ts',
 'apps/api/src/auth.ts','apps/api/src/keeper-auth.ts','apps/api/src/intents.ts','apps/api/src/baskets.ts','apps/api/src/keepers.ts','apps/api/src/gateway.ts','apps/api/src/worker.ts','apps/api/src/http.ts',
 'apps/keeper/src/api.ts','apps/keeper/src/gateway.ts','apps/keeper/src/engine.ts','apps/keeper/src/store.ts','apps/keeper/src/config.ts','apps/keeper/src/signer.ts','apps/keeper/src/lock.ts',
 'apps/indexer/src/engine.ts','apps/indexer/src/pg-store.ts','apps/indexer/src/projections.ts','apps/indexer/src/readiness.ts','apps/indexer/src/rpc.ts',
];
const METRICS=['lines','branches','functions','statements'];
function coverageMetric(value,minimum){
 if(!value||!Number.isSafeInteger(value.total)||!Number.isSafeInteger(value.covered)||value.total<0||value.covered<0||value.covered>value.total)return {passed:false,reason:'INVALID_COUNTERS'};
 const percent=value.total===0?100:value.covered/value.total*100;
 return {covered:value.covered,total:value.total,percent,minimum,passed:percent+1e-9>=minimum};
}
export function checkCoverage(summary,{root=process.cwd(),critical=CRITICAL_BACKEND}={}){
 const results={};
 const entry=(label,counters,min)=>{const metrics=Object.fromEntries(METRICS.map(k=>[k,coverageMetric(counters?.[k],k==='statements'?80:min)]));results[label]={passed:METRICS.every(k=>metrics[k].passed),metrics};};
 entry('total',summary?.total,80);
 for(const file of critical){const counters=summary?.[resolve(root,file)]??summary?.[file];entry(file,counters,90);}
 return {schemaVersion:1,passed:Object.values(results).every(v=>v.passed),files:results};
}

export const LOCAL_GATES=['harness','typecheck','build','unit','integration','e2e','format','contracts','contract_mutations','contract_coverage','backend_coverage','dependency_audit','disk_preflight','source_stable'];
export const EXTERNAL_GATES=['independent_audit','testnet_public','testnet_soak','load','disaster_recovery','operations','mainnet_compatibility','governance','mainnet_canary_authorization'];
export const REQUIRED_GATES=[...LOCAL_GATES,...EXTERNAL_GATES];
export const STATUSES=['PASS','FAIL','BLOCKED','NOT_RUN'];
const isHash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const time=v=>typeof v==='string'?Date.parse(v):NaN;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const positive=v=>finite(v)&&v>0;
const address=v=>typeof v==='string'&&/^0x[0-9a-fA-F]{40}$/.test(v)&&!/^0x0{40}$/i.test(v);
export async function artifact(root,path){
 const target=resolve(root,path),base=await realpath(root);
 if(!target.startsWith(resolve(root)+sep))throw new Error('Artifact outside root');
 const actual=await realpath(target);if(!actual.startsWith(base+sep))throw new Error('Artifact symlink outside root');
 return {path:portable(relative(root,target)),sha256:sha256(await readFile(actual))};
}
async function artifactProblems(artifacts,root){
 if(!Array.isArray(artifacts)||artifacts.length===0)return ['MISSING_ARTIFACTS'];
 const errors=[];
 for(const a of artifacts){try{if(!a||typeof a.path!=='string'||!isHash(a.sha256))throw new Error('INVALID_ARTIFACT');const expected=await artifact(root,a.path);if(expected.sha256!==a.sha256)errors.push(`ARTIFACT_CHANGED:${a.path}`);}catch{errors.push(`INVALID_OR_MISSING_ARTIFACT:${a?.path??'unknown'}`);}}
 return errors;
}
const NUMERIC_MEASUREMENTS={
 independent_audit:['criticalOpen','highOpen'],testnet_public:['chainId','confirmations','canonicalTransactions'],
 testnet_soak:['availability','reconciliationsPassed','roundTrips','stateLosses','criticalFindingsOpen','healthCheckIntervalSeconds'],
 load:['users','keepers','requestsPerSecond','durationSeconds','burstRequestsPerSecond','burstDurationSeconds','readP95Ms','writeP95Ms','quoteP95Ms','http5xxRatio','authFailures','accountingFailures','lostJobs','ooms','queueRecoverySeconds'],
 disaster_recovery:['rpoSeconds','rtoSeconds','restoredRows'],operations:['diskFreeGiB','alertDeliveryMaxSeconds'],mainnet_compatibility:['chainId'],governance:['threshold','owners','timelockSeconds'],mainnet_canary_authorization:[],
};
function externalCriteria(id,p){const m=p.measurements??{};
 if(!NUMERIC_MEASUREMENTS[id]||NUMERIC_MEASUREMENTS[id].some(k=>!finite(m[k])||m[k]<0))return false;
 switch(id){
 case 'independent_audit':return m.independent===true&&m.criticalOpen===0&&m.highOpen===0&&m.retestsPassed===true;
 case 'testnet_public':return m.chainId===50383&&m.confirmations>=12&&m.broadcast===true&&m.impersonation===false&&m.reconciled===true&&[2,4,8].every(n=>m.legCounts?.includes(n))&&positive(m.canonicalTransactions)&&m.gasSpentWei!==undefined&&/^\d+$/.test(m.gasSpentWei)&&BigInt(m.gasSpentWei)<=10n*10n**18n&&/^\d+$/.test(m.maxCollateralWei??'')&&BigInt(m.maxCollateralWei)<=100n*10n**18n;
 case 'testnet_soak':return time(p.completedAt)-time(p.startedAt)>=7*86400000&&m.availability>=0.995&&m.availability<=1&&m.reconciliationsPassed>=7&&m.roundTrips>=14&&m.stateLosses===0&&m.criticalFindingsOpen===0&&positive(m.healthCheckIntervalSeconds)&&m.healthCheckIntervalSeconds<=60;
 case 'load':return m.users>=100&&m.keepers>=10&&m.requestsPerSecond>=100&&m.durationSeconds>=3600&&m.burstRequestsPerSecond>=300&&m.burstDurationSeconds>=300&&m.readP95Ms<=200&&m.writeP95Ms<=500&&m.quoteP95Ms<=2000&&m.http5xxRatio<0.001&&m.authFailures===0&&m.accountingFailures===0&&m.lostJobs===0&&m.ooms===0&&m.queueRecoverySeconds<=300&&m.controlledRpc===true;
 case 'disaster_recovery':return m.secondHost===true&&m.offsiteEncrypted===true&&m.walArchiving===true&&m.rpoSeconds<=900&&m.rtoSeconds<=14400&&m.chainReconciled===true&&positive(m.restoredRows);
 case 'operations':return m.diskFreeGiB>=15&&m.tlsVerified===true&&m.proxyCidrsVerified===true&&m.nonRootContainers===true&&m.ownerSignerSeparated===true&&m.alertDeliveryMaxSeconds<=120&&m.isolatedDatabase===true;
 case 'mainnet_compatibility':return Number.isSafeInteger(m.chainId)&&m.chainId>0&&![50383,31337].includes(m.chainId)&&m.protocolAvailable===true&&m.officialAddressesVerified===true&&m.proxyFingerprintsVerified===true&&m.forkPassed===true&&m.sourceVerified===true;
 case 'governance':return m.threshold>=2&&m.owners>=3&&m.threshold<=m.owners&&m.timelockSeconds>=172800&&m.guardianSeparated===true&&m.pauseExitDrillPassed===true&&address(m.multisig)&&address(m.guardian);
 case 'mainnet_canary_authorization':return m.explicitOwnerApproval===true&&m.mainnetCanaryPassed===true&&m.emergencyDrillPassed===true&&/^\d+$/.test(m.maxCollateralWei??'')&&BigInt(m.maxCollateralWei)>0n&&/^\d+$/.test(m.maxGasSpendWei??'')&&BigInt(m.maxGasSpendWei)>0n;
 default:return false;
 }}
async function operationalProofProblems(id,p,root){
 const kind={load:'load',testnet_soak:'soak',disaster_recovery:'dr'}[id];if(!kind)return [];
 const candidates=[];
 for(const ref of p.artifacts??[]){try{const bytes=await readFile(join(root,ref.path),'utf8'),raw=JSON.parse(bytes);if(raw?.type===kind)candidates.push(raw);}catch{}}
 if(candidates.length!==1)return ['MISSING_OR_AMBIGUOUS_TYPED_OPERATIONAL_PROOF'];
 const raw=candidates[0],m=raw.metrics;
 if(raw.schemaVersion!==1||raw.sourceSha256!==p.sourceSha256||raw.status!=='PASS'||raw.startedAt!==p.startedAt||raw.completedAt!==p.completedAt||!m)return ['INVALID_RAW_OPERATIONAL_PROVENANCE'];
 try{
  const {assessLoad,assessSoak,assessDr}=await import('../../ops/testing/campaign.mjs');
  if(id==='load'){
   if(assessLoad(m).status!=='PASS'||m.profile!=='full'||m.sourceUnchanged!==true||!finite(m.activeOwners)||m.activeOwners<100||!finite(m.activeKeepers)||m.activeKeepers<10||m.authFailures!==0||m.accountingFailures!==0||m.lostJobs!==0)return ['RAW_LOAD_CRITERIA_FAILED'];
  }else if(id==='testnet_soak'){
   const assessment=assessSoak(m,time(raw.completedAt));
   if(m.sourceSha256!==p.sourceSha256||assessment.status!=='PASS'||assessment.availability>1||!['probes','readyProbes','unreadyProbes','missingProbes','canonicalCycles'].every(k=>Number.isSafeInteger(m[k])&&m[k]>=0)||m.readyProbes+m.unreadyProbes!==m.probes)return ['RAW_SOAK_CRITERIA_FAILED'];
  }else{
   if(assessDr(m).status!=='PASS')return ['RAW_DR_CRITERIA_FAILED'];
   const failures=await artifactProblems(raw.artifacts,root);if(failures.length)return failures.map(e=>`RAW_DR:${e}`);
   if(![m.backupSha256,m.restoreArtifactSha256].every(hash=>raw.artifacts.some(a=>a.sha256===hash)))return ['RAW_DR_BACKUP_OR_RESTORE_PROOF_MISSING'];
   const hosts=[];for(const a of raw.artifacts){try{const host=JSON.parse(await readFile(join(root,a.path),'utf8'));if(host?.type==='host-observation'&&host.schemaVersion===1&&host.sourceSha256===p.sourceSha256&&Number.isFinite(time(host.at)))hosts.push(host);}catch{}}
   if(![m.sourceHostId,m.restoreHostId].every(hostId=>hosts.some(h=>h.hostId===hostId)))return ['RAW_DR_HOST_OBSERVATIONS_MISSING'];
  }
 }catch{return ['INVALID_RAW_OPERATIONAL_MEASUREMENTS'];}
 return [];
}
export async function externalGate(id,{root=process.cwd(),source,now=new Date()}={}){
 const file=`evidence/external/${id}.json`;let p;
 try{p=JSON.parse(await readFile(join(root,file),'utf8'));}catch(e){return {id,status:e.code==='ENOENT'?'BLOCKED':'FAIL',reason:e.code==='ENOENT'?'External measured evidence not available':'Malformed external evidence',artifacts:[]};}
 if(!p||typeof p!=='object'||Array.isArray(p))return {id,status:'FAIL',reason:'External evidence must be an object',artifacts:[]};
 const errors=[];
 if(p.schemaVersion!==1||p.gate!==id||p.sourceSha256!==source?.sha256||typeof p.reviewedBy!=='string'||!p.reviewedBy.trim())errors.push('INVALID_PROVENANCE');
 const start=time(p.startedAt),end=time(p.completedAt);if(!Number.isFinite(start)||!Number.isFinite(end)||start>end||end>now.getTime()+60000)errors.push('INVALID_TIMESTAMPS');
 errors.push(...await artifactProblems(p.artifacts,root));
 if(!errors.length)errors.push(...await operationalProofProblems(id,p,root));
 if(!externalCriteria(id,p))errors.push('ACCEPTANCE_CRITERIA_NOT_MET');
 return {id,status:errors.length?'FAIL':'PASS',reason:errors.length?errors.join('; '):'Measured external evidence meets acceptance criteria',artifacts:[await artifact(root,file)]};
}

export async function validateReport(report,{root=process.cwd(),now=new Date(),maxAgeMs=86400000}={}){
 const errors=[];
 if(report?.schemaVersion!==1||typeof report.runId!=='string'||!report.runId||!report.tools||typeof report.tools.node!=='string')errors.push('INVALID_REPORT');
 const source=await sourceManifest(root);if(!isHash(report?.source?.sha256)||source.sha256!==report.source.sha256)errors.push('SOURCE_CHANGED');
 if(JSON.stringify(report?.source?.files)!==JSON.stringify(source.files))errors.push('SOURCE_INVENTORY_CHANGED');
 for(const tool of ['node','npm','forge','solc','postgresServer'])if(typeof report?.tools?.[tool]!=='string'||!report.tools[tool].trim()||report.tools[tool]==='unavailable')errors.push(`MISSING_TOOL_VERSION:${tool}`);
 const start=time(report?.startedAt),end=time(report?.completedAt);if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||end>now.getTime()+60000||now.getTime()-end>maxAgeMs)errors.push('STALE_OR_INVALID_TIME');
 const gates=Array.isArray(report?.gates)?report.gates:[];const ids=new Set();
 for(const g of gates){if(!g||typeof g.id!=='string'||ids.has(g.id)||!REQUIRED_GATES.includes(g.id)||!STATUSES.includes(g.status)){errors.push('INVALID_OR_DUPLICATE_GATE');continue;}ids.add(g.id);if(g.status==='PASS')errors.push(...(await artifactProblems(g.artifacts,root)).map(e=>`${g.id}:${e}`));}
 for(const id of REQUIRED_GATES){const gate=gates.find(g=>g?.id===id);if(!gate)errors.push(`MISSING_GATE:${id}`);else if(gate.status!=='PASS')errors.push(`GATE_${gate.status}:${id}`);}
 for(const id of EXTERNAL_GATES){if(gates.some(g=>g?.id===id&&g.status==='PASS')){const actual=await externalGate(id,{root,source,now});if(actual.status!=='PASS')errors.push(`EXTERNAL_PROOF_INVALID:${id}`);}}
 const productionApproved=errors.length===0;
 if(report?.productionApproved!==productionApproved)errors.push('APPROVAL_FLAG_MISMATCH');
 return {schemaVersion:1,passed:errors.length===0,productionApproved:errors.length===0,errors};
}
