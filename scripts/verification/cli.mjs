import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {sourceManifest,checkCoverage,validateReport} from './lib.mjs';
const [command,input,output]=process.argv.slice(2);
try{
 let result;
 if(command==='source')result=await sourceManifest();
 else if(command==='coverage')result=checkCoverage(JSON.parse(await readFile(input??'coverage/coverage-summary.json','utf8')));
 else if(command==='validate')result=await validateReport(JSON.parse(await readFile(input??'evidence/verification.json','utf8')));
 else throw new Error('Usage: cli.mjs source | coverage [coverage-summary.json] [output.json] | validate [report.json] [output.json]');
 const json=JSON.stringify(result,null,2)+'\n';
 if(output){await mkdir(dirname(resolve(output)),{recursive:true});await writeFile(output,json);}
 process.stdout.write(json);
 if(result.passed===false)process.exitCode=1;
}catch(error){process.stderr.write(`Verification failed: ${error.message}\n`);process.exitCode=1;}
