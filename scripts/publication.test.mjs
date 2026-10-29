import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {inspectText,forbiddenPath,auditPublication} from './publication/check.mjs';

test('blocks internal and credential paths while preserving runnable public source',()=>{
 for(const path of ['.aws/config','.codex/config.toml','apps/api/evidence/auth.json','runtime/key.json','contracts/cache/a.json','scripts/public-testnet/mvp.mjs','ops/RELEASE.md','.env.production','backup.dump','signer.keystore','SIGNER.KEY','.ENV.production','.AWS/config','prod.env','.npmrc','keystore.json'])assert.equal(forbiddenPath(path),true,path);
 for(const path of ['apps/api/src/auth.ts','contracts/test/Fixture.sol','ops/testing/campaign.mjs','ops/scripts/preflight.mjs','.github/workflows/ci.yml','.env.example','package-lock.json'])assert.equal(forbiddenPath(path),false,path);
});
test('redacts findings and distinguishes example placeholders/public addresses from secrets',()=>{
 const secret='ghp_'+'a'.repeat(36);
 const finding=inspectText('src/config.ts',`const token = '${secret}';\nconst ${'privateKey'} = '0x${'b'.repeat(64)}';`);
 assert.ok(finding.length>=2);assert.equal(JSON.stringify(finding).includes(secret),false);assert.equal(JSON.stringify(finding).includes('b'.repeat(64)),false);
 assert.deepEqual(inspectText('README.md','postgresql://USER:PASSWORD@127.0.0.1:PORT/test\n0x1111111111111111111111111111111111111111\nconst key=process.env.PRIVATE_KEY;'),[]);
 assert.deepEqual(inspectText('tests/fixture.ts',"const password='test-only';"),[]);
 assert.deepEqual(inspectText('sdk/client.test.ts','https://api.example:443@attacker.example'),[]);
 assert.ok(inspectText('sdk/client.test.ts','https://'+'alice:actual-secret-value@example.com').length);
 assert.ok(inspectText('src/secret.ts','-----BEGIN '+'PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----').length);
});
test('candidate audit excludes ignored files and catches force-added secrets without reading their contents',async()=>{
 const root=await mkdtemp(join(tmpdir(),'spreadlock-publication-'));try{
  execFileSync('git',['init','-q','-b','main',root]);await writeFile(join(root,'.gitignore'),'runtime/\n.env\n');await mkdir(join(root,'runtime'));await writeFile(join(root,'runtime','secret.json'),'private');await writeFile(join(root,'README.md'),'Public source');await writeFile(join(root,'.env'),'DO_NOT_PRINT=secret');
  let r=await auditPublication(root);assert.equal(r.passed,true);assert.equal(r.files.includes('.env'),false);assert.equal(r.files.includes('runtime/secret.json'),false);
  execFileSync('git',['-C',root,'add','-f','.env']);r=await auditPublication(root);assert.equal(r.passed,false);assert.deepEqual(r.findings,[{path:'.env',rule:'FORBIDDEN_PATH'}]);
 }finally{await rm(root,{recursive:true});}
});
test('symlinks and oversized candidate files fail closed',async()=>{
 const {symlink}=await import('node:fs/promises');const root=await mkdtemp(join(tmpdir(),'spreadlock-publication-'));try{
  execFileSync('git',['init','-q','-b','main',root]);await symlink('/does/not/exist',join(root,'linked.ts'));await writeFile(join(root,'huge.txt'),'x'.repeat(21));let r=await auditPublication(root,{maximumBytes:20});assert.equal(r.passed,false);assert.ok(r.findings.some(f=>f.rule==='SYMLINK'));assert.ok(r.findings.some(f=>f.rule==='OVERSIZED_FILE'));
 }finally{await rm(root,{recursive:true});}
});

test('checks staged bytes even after the working copy is cleaned or deleted',async()=>{
 const root=await mkdtemp(join(tmpdir(),'spreadlock-publication-'));try{
  execFileSync('git',['init','-q','-b','main',root]);const file=join(root,'config.ts'),secret='ghp_'+'c'.repeat(36);await writeFile(file,`const apiKey='${secret}';`);execFileSync('git',['-C',root,'add','config.ts']);await writeFile(file,'export const clean=true;');let r=await auditPublication(root);assert.equal(r.passed,false);assert.ok(r.findings.some(f=>f.rule==='GITHUB_TOKEN'&&f.surface==='index'));assert.equal(JSON.stringify(r.findings).includes(secret),false);await rm(file);r=await auditPublication(root);assert.equal(r.passed,false);assert.ok(r.findings.some(f=>f.surface==='index'));
 }finally{await rm(root,{recursive:true});}
});

test('test and fixture filenames cannot waive real credential literals',()=>{
 const values=[['mnemonic',['apple','banana','cherry','dolphin','eagle','forest','garden','harbor','island','jungle','kitten','lemon'].join(' ')],['client_secret','production-'+'x'.repeat(30)],['clientSecret','production-'+'y'.repeat(30)],['password','actual-'+'password-value']];
 for(const path of ['tests/config.ts','src/fixture.test.ts','fixtures/local.ts'])for(const [name,value]of values){const findings=inspectText(path,JSON.stringify({[name]:value}));assert.ok(findings.some(f=>f.rule==='LITERAL_CREDENTIAL'),`${path} ${name}`);assert.equal(JSON.stringify(findings).includes(value),false);}
});
