/** Candidate/staged-file publication guard. Findings never contain matched values. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat,readFile} from 'node:fs/promises';
import {resolve,relative,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
const exec=promisify(execFile);
const privateSegments=new Set(['.git','.aws','.azure','.gcp','.ssh','.gnupg','.agents','.codex','.claude','.cursor','.config','node_modules','dist','out','cache','broadcast','evidence','research','runtime','secrets','backups','backup','internal','private','memory','__pycache__']);
export function forbiddenPath(path){
 const parts=path.replaceAll('\\','/').split('/'),name=parts.at(-1)??'';
 if(parts.some(p=>privateSegments.has(p.toLowerCase())||p==='coverage'||p.startsWith('coverage-')))return true;
 if(path.startsWith('scripts/public-testnet/')||path==='scripts/scrape-dreamdex.cjs')return true;
 if(['ops/RELEASE.md','ops/PRODUCTION_TESTING.md','ops/README.md'].includes(path))return true;
 if(/^(?:AGENTS|CLAUDE|GEMINI)\.md$/i.test(name))return true;
 if(/(?:^|\.)env(?:\..*)?$/i.test(name)&&name!=='.env.example')return true;
 if(/^(?:\.(?:npmrc|pypirc|netrc|bash_history|zsh_history)|(?:wallets?|keystores?)(?:[_-].*)?\.json|service-account.*\.json)$/i.test(name))return true;
 return /(?:\.(?:keystore|pem|key|p12|pfx|jks|sqlite|sqlite3|db|dump|sql\.gz|bak|log|lcov|pyc)|\.sqlite(?:3)?-(?:wal|shm)|\.lock\.pid)$/i.test(name)
  ||/^(?:id_rsa|id_ed25519|credentials(?:\..*)?|runtime_secrets\.json|wallets_config\.json|.*password.*|.*mnemonic.*)$/i.test(name);
}
const fixtures=path=>/(?:^|\/)(?:test|tests|fixtures)(?:\/)|\.(?:test|spec)\.[cm]?[jt]s$/.test(path);
const placeholder=value=>/^\$\{|^<[^>]+>$|^(?:USER|PASSWORD|CHANGE_ME|REPLACE_ME|YOUR_[A-Z_]+|example|test(?:-only)?|dummy|unused|not-a-real-secret)$/i.test(value);
export function inspectText(path,text){
 const findings=[],add=(line,rule)=>{if(!findings.some(f=>f.line===line&&f.rule===rule))findings.push({path,line,rule});};
 const patterns=[['PRIVATE_KEY_BLOCK',/-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],['AWS_ACCESS_KEY',/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],['GITHUB_TOKEN',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],['API_TOKEN',/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/],['NPM_TOKEN',/\bnpm_[A-Za-z0-9]{30,}\b/],['JWT',/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/]];
 for(const [index,line]of text.split(/\r?\n/).entries()){
  for(const [rule,regex]of patterns)if(regex.test(line))add(index+1,rule);
  const assignment=/\b(private_?key|mnemonic|seed_?phrase|client_?secret|api_?key|access_?token|refresh_?token|password|passwd)['"]?\s*(?::\s*[A-Za-z]+)?\s*[:=]\s*(['"`])([^'"`\n]+)\2/ig;
  for(const match of line.matchAll(assignment)){const value=match[3];if(placeholder(value))continue;add(index+1,'LITERAL_CREDENTIAL');}
  const url=/(?:https?|postgres(?:ql)?|redis|mysql|amqp):\/\/([^:\s/'"`]+):([^@\s/'"`]+)@/ig;
  for(const match of line.matchAll(url)){
   // Adversarial origin tests intentionally use a host:port as fake userinfo.
   const originSpoofFixture=fixtures(path)&&/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(match[1])&&/^[0-9]{1,5}$/.test(match[2]);
   if(!placeholder(match[1])&&!placeholder(match[2])&&!originSpoofFixture)add(index+1,'EMBEDDED_CREDENTIAL_URL');
  }
 }
 return findings;
}
export async function auditPublication(root=process.cwd(),{maximumBytes=2*1024*1024}={}){
 const options={cwd:root,maxBuffer:16*1024*1024};
 const [{stdout},{stdout:staged}]=await Promise.all([exec('git',['ls-files','--cached','--others','--exclude-standard','-z'],options),exec('git',['ls-files','--stage','-z'],options)]);
 const files=[...new Set(stdout.split('\0').filter(Boolean))].sort(),findings=[],index=new Map();
 for(const entry of staged.split('\0').filter(Boolean)){const tab=entry.indexOf('\t'),[mode,oid,stage]=entry.slice(0,tab).split(' '),path=entry.slice(tab+1);if(stage!=='0')findings.push({path,rule:'UNMERGED_INDEX'});else index.set(path,{mode,oid});}
 const inspectBytes=(path,bytes,surface)=>{if(bytes.includes(0)){findings.push({path,rule:'BINARY_FILE_REQUIRES_REVIEW',surface});return;}findings.push(...inspectText(path,bytes.toString('utf8')).map(f=>({...f,surface})));};
 for(const path of files){if(forbiddenPath(path)){findings.push({path,rule:'FORBIDDEN_PATH'});continue;}
  const absolute=resolve(root,path);if(relative(root,absolute).startsWith('..'+sep)||absolute===resolve(root)){findings.push({path,rule:'PATH_OUTSIDE_ROOT'});continue;}
  const indexed=index.get(path);
  if(indexed){
   if(indexed.mode==='120000'){findings.push({path,rule:'SYMLINK',surface:'index'});continue;}
   if(!['100644','100755'].includes(indexed.mode)){findings.push({path,rule:'NOT_REGULAR_FILE',surface:'index'});continue;}
   const size=Number((await exec('git',['cat-file','-s',indexed.oid],options)).stdout.trim());
   if(!Number.isSafeInteger(size)||size<0||size>maximumBytes)findings.push({path,rule:'OVERSIZED_FILE',surface:'index'});
   else {const {stdout:bytes}=await exec('git',['cat-file','blob',indexed.oid],{...options,encoding:'buffer'});inspectBytes(path,bytes,'index');}
  }
  let info;try{info=await lstat(absolute);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  if(info.isSymbolicLink()){findings.push({path,rule:'SYMLINK'});continue;}if(!info.isFile()){findings.push({path,rule:'NOT_REGULAR_FILE'});continue;}if(info.size>maximumBytes){findings.push({path,rule:'OVERSIZED_FILE'});continue;}
  inspectBytes(path,await readFile(absolute),'working-tree');
 }
 return {schemaVersion:1,passed:findings.length===0,fileCount:files.length,files,findings};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const report=await auditPublication();process.stdout.write(JSON.stringify(report,null,2)+'\n');if(!report.passed)process.exitCode=1;}catch(error){process.stderr.write(`Publication audit failed: ${error.code??error.name}\n`);process.exitCode=1;}
}
