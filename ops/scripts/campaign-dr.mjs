/** Evidence verifier only. Does not restore, decrypt, run SQL, or alter hosts. */
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {hostname} from 'node:os';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {assessDr} from '../testing/campaign.mjs';
import {sourceManifest,sha256,artifact} from '../../scripts/verification/lib.mjs';
const args=process.argv.slice(2),mode=args[0]??'verify';
const source=await sourceManifest();
if(mode==='host-observation'){
 const file=args[1];if(!file)throw new Error('host-observation OUTPUT.json');
 const machine=await readFile('/etc/machine-id','utf8');
 const report={schemaVersion:1,type:'host-observation',sourceSha256:source.sha256,at:new Date().toISOString(),hostId:createHash('sha256').update(machine.trim()).digest('hex'),hostname:hostname()};
 await mkdir(dirname(resolve(file)),{recursive:true});await writeFile(file,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({output:file,hostId:report.hostId}));
}else if(mode==='verify'){
 const file=args[1],output=args[2]??'evidence/operations/disaster-recovery.json';
 let measurements={},artifacts=[],reviewedBy=null,reason,hostProofs=[];
 if(file){const input=JSON.parse(await readFile(file,'utf8'));measurements=input.measurements??{};artifacts=input.artifacts??[];reviewedBy=input.reviewedBy;if(input.sourceSha256!==source.sha256)throw new Error('DR evidence source mismatch');if(!Array.isArray(artifacts))throw new Error('Invalid DR artifact list');
  for(const entry of artifacts){if(typeof entry.path!=='string'||!entry.path.startsWith('evidence/')||entry.path.split('/').includes('..')||!/^([a-f0-9]{64})$/.test(entry.sha256??''))throw new Error('Invalid DR artifact');const verified=await artifact(process.cwd(),entry.path);const bytes=await readFile(entry.path);if(verified.sha256!==entry.sha256||sha256(bytes)!==entry.sha256)throw new Error('DR artifact hash mismatch');try{const data=JSON.parse(bytes.toString('utf8'));if(data.type==='host-observation')hostProofs.push(data);}catch{}}
 }else reason='Provide independently reviewed encrypted offsite backup/WAL evidence and empty-target restore measurements from a second host.';
 let assessment=assessDr(measurements);
 if(assessment.status==='PASS'&&!['sourceHostId','restoreHostId'].every(key=>hostProofs.some(proof=>proof.schemaVersion===1&&proof.sourceSha256===source.sha256&&proof.hostId===measurements[key]&&Number.isFinite(Date.parse(proof.at))))){assessment={status:'BLOCKED',checks:[...assessment.checks,{id:'actual_host_observations',passed:false}]};}
 if(assessment.status==='PASS'&&(artifacts.length<3||typeof reviewedBy!=='string'||!reviewedBy.trim()))assessment={status:'BLOCKED',checks:[...assessment.checks,{id:'reviewed_raw_evidence',passed:false}]};
 const report={schemaVersion:1,type:'dr',sourceSha256:source.sha256,startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),...assessment,reviewedBy,reason,metrics:measurements,artifacts,scope:'Validates supplied recovery proof; never treats a local dump restore as second-host disaster recovery'};
 await mkdir(dirname(resolve(output)),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({output,status:report.status,checks:report.checks},null,2));if(report.status==='FAIL')process.exitCode=1;
}else throw new Error('Usage: campaign-dr.mjs host-observation OUTPUT | verify [EVIDENCE.json] [OUTPUT.json]');
