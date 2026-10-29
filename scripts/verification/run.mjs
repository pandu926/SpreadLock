import {spawn,spawnSync} from 'node:child_process';
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {once} from 'node:events';
import {Client} from 'pg';
import {sourceManifest,artifact,externalGate,LOCAL_GATES,EXTERNAL_GATES} from './lib.mjs';

const root=process.cwd(),runId=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8);
const runDir=resolve(root,'evidence/verification-runs',runId);
await mkdir(runDir,{recursive:true});
const source=await sourceManifest(root),startedAt=new Date().toISOString();
const version=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8'});return r.status===0?r.stdout.trim().split('\n')[0]:'unavailable';};
let solidity='unavailable';const forgeConfig=spawnSync('forge',['config','--json'],{encoding:'utf8'});
try{const config=JSON.parse(forgeConfig.stdout);solidity=String(config.solc??config.solc_version??'unavailable');}catch{}
let postgresServer='unavailable';
if(process.env.TEST_DATABASE_URL){const c=new Client({connectionString:process.env.TEST_DATABASE_URL,connectionTimeoutMillis:5000});try{await c.connect();postgresServer=(await c.query('SELECT version() AS version')).rows[0].version;}catch{}finally{await c.end().catch(()=>{});}}
const tools={node:process.version,npm:version('npm',['--version']),forge:version('forge',['--version']),solc:solidity,postgresClient:version('pg_config',['--version']),postgresServer};
const report={schemaVersion:1,runId,source,tools,startedAt,completedAt:null,gates:[],productionApproved:false};
const onlyIndex=process.argv.indexOf('--only'),selected=onlyIndex<0?null:new Set((process.argv[onlyIndex+1]??'').split(','));
if(selected&&[...selected].some(id=>!LOCAL_GATES.includes(id)))throw new Error('Unknown gate in --only');
const path=name=>resolve(runDir,name);
const rel=name=>relative(root,path(name));
const harnessFiles=['scripts/verification/harness.test.mjs','scripts/publication.test.mjs'];
for(const folder of ['scripts/public-testnet','ops/testing']){try{for(const name of (await readdir(resolve(root,folder))).sort())if(/\.test\.mjs$/.test(name))harnessFiles.push(`${folder}/${name}`);}catch(error){if(error.code!=='ENOENT')throw error;}}
const opsTsFiles=(await readdir(resolve(root,'ops/scripts')).catch(()=>[])).filter(name=>name.endsWith('.ts')).sort().map(name=>`ops/scripts/${name}`);
const typecheckSteps=[['npm','run','typecheck']];
if(opsTsFiles.length)typecheckSteps.push(['npx','--no-install','tsc','--noEmit','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext','--strict','--noUncheckedIndexedAccess','--skipLibCheck','--esModuleInterop','--types','node',...opsTsFiles]);
const commandGates=[
 {id:'harness',steps:[['node','--test',...harnessFiles],['node','scripts/publication/check.mjs'],['python3','-m','unittest','discover','-s','contracts/script/tools','-p','test_*.py']]},
 {id:'typecheck',steps:typecheckSteps},
 {id:'build',cmd:['npm','run','build']},
 {id:'unit',cmd:['npm','test']},
 {id:'format',cmd:['forge','fmt','--root','contracts','--check']},
 {id:'contracts',steps:['0x01','0x02','0x03'].map(seed=>['forge','test','--root','contracts','--fuzz-seed',seed]),env:{FOUNDRY_PROFILE:'ci'}},
 {id:'contract_mutations',cmd:['python3','contracts/script/tools/security_mutations.py','--output',rel('security-mutations')]},
 {id:'integration',cmd:['npm','run','test:integration'],database:true},
 {id:'e2e',cmd:['npm','run','test:e2e'],database:true},
 {id:'backend_coverage',database:true,steps:[['npm','run','test:coverage','--','--coverage.reportsDirectory',rel('backend-coverage')],['node','scripts/verification/cli.mjs','coverage',rel('backend-coverage/coverage-summary.json'),rel('backend-coverage-gate.json')]]},
 {id:'contract_coverage',steps:[['forge','coverage','--ir-minimum','--exclude-tests','--report','lcov','--report-file',rel('contracts.lcov')],['python3','contracts/script/tools/check_critical_coverage.py',rel('contracts.lcov'),'--output',rel('contract-coverage-gate.json')]]},
 {id:'dependency_audit',cmd:['npm','audit','--audit-level=moderate','--json']},
 {id:'disk_preflight',cmd:['node','ops/scripts/preflight.mjs']},
];
async function runCommand(args,env,stream){
 stream.write(`COMMAND ${JSON.stringify(args)}\n`);
 return new Promise(resolveExit=>{const child=spawn(args[0],args.slice(1),{cwd:root,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let settled=false;
 child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream,{end:false});
 const timer=setTimeout(()=>{child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),5000).unref();},45*60*1000);timer.unref();
 child.on('error',e=>{stream.write(`PROCESS_ERROR ${e.message}\n`);if(!settled){settled=true;clearTimeout(timer);resolveExit(1);}});
 child.on('close',(code,signal)=>{if(!settled){settled=true;clearTimeout(timer);stream.write(`EXIT ${code} SIGNAL ${signal??'none'}\n`);resolveExit(code??1);}});
 });
}
async function save(){await writeFile(path('report.json'),JSON.stringify(report,null,2)+'\n');await writeFile(resolve(root,'evidence/verification.json'),JSON.stringify(report,null,2)+'\n');}
try{
 for(const g of commandGates){
  if(selected&&!selected.has(g.id)){report.gates.push({id:g.id,status:'NOT_RUN',reason:'Not selected; partial run cannot approve production',artifacts:[]});continue;}
  if(g.database&&!process.env.TEST_DATABASE_URL){report.gates.push({id:g.id,status:'BLOCKED',reason:'TEST_DATABASE_URL must point to an isolated disposable database',artifacts:[]});continue;}
  console.log(`[${runId}] Running ${g.id}`);
  const log=path(g.id+'.log'),stream=createWriteStream(log,{flags:'wx',mode:0o600});let code=0;
  for(const args of g.steps??[g.cmd]){const step=await runCommand(args,g.env,stream);if(step!==0)code=step;}
  stream.end();await once(stream,'finish');
  const artifacts=[await artifact(root,log)];
  const extras=g.id==='backend_coverage'?['backend-coverage/coverage-summary.json','backend-coverage-gate.json']:g.id==='contract_coverage'?['contracts.lcov','contract-coverage-gate.json']:g.id==='contract_mutations'?['security-mutations/report.json']:[];
  for(const extra of extras){try{artifacts.push(await artifact(root,path(extra)));}catch{code=1;}}
  report.gates.push({id:g.id,status:code===0?'PASS':'FAIL',reason:code===0?'Command completed successfully':`Command/check failed (exit ${code}); inspect raw artifacts`,artifacts});await save();
 }
 const end=await sourceManifest(root);const snapshot=path('source-final.json');await writeFile(snapshot,JSON.stringify(end,null,2)+'\n');
 report.gates.push({id:'source_stable',status:end.sha256===source.sha256?'PASS':'FAIL',reason:end.sha256===source.sha256?'Source unchanged throughout this run':'Source changed while verification ran; rerun final version',artifacts:[await artifact(root,snapshot)]});
 for(const id of EXTERNAL_GATES)report.gates.push(await externalGate(id,{root,source}));
 report.completedAt=new Date().toISOString();report.productionApproved=report.gates.every(g=>g.status==='PASS');await save();
 const localPass=report.gates.filter(g=>LOCAL_GATES.includes(g.id)).every(g=>g.status==='PASS');
 console.log(JSON.stringify({runId,report:rel('report.json'),localChecksPassed:localPass,productionApproved:report.productionApproved,gates:report.gates.map(({id,status})=>({id,status}))},null,2));
 if(!localPass)process.exitCode=1;
}catch(e){report.completedAt=new Date().toISOString();report.failure=e.message;report.productionApproved=false;for(const id of [...LOCAL_GATES,...EXTERNAL_GATES])if(!report.gates.some(g=>g.id===id))report.gates.push({id,status:'NOT_RUN',reason:'Run aborted',artifacts:[]});await save();console.error(e.message);process.exitCode=1;}
