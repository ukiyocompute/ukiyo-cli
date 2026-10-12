import test from 'node:test';
import assert from 'node:assert/strict';
import {constants,closeSync,existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {execFile} from 'node:child_process';
import {credentialDirectory,ensureCredentialDirectory,openPrivateFile,validateStoragePath} from './storage.js';
import {assertPrivate,grantOtherUser} from './platform-test-helpers.js';
import {executeSsh} from './ssh.js';
import {signupAgent} from './credentials.js';

async function isolated(run:(home:string)=>Promise<void>) {
  const home=mkdtempSync(join(tmpdir(),'ukiyo storage ü-'));
  const names=['HOME','USERPROFILE','UKIYO_API_TOKEN'] as const;
  const before=names.map(name=>process.env[name]);process.env.HOME=home;process.env.USERPROFILE=home;delete process.env.UKIYO_API_TOKEN;
  try{await run(home);}finally{names.forEach((name,i)=>{if(before[i]===undefined)delete process.env[name];else process.env[name]=before[i];});rmSync(home,{recursive:true,force:true});}
}
test('native credential directory and exclusive file are private; existing identity is never overwritten',()=>isolated(async home=>{
  assert.equal(credentialDirectory(),join(home,'.ukiyo'));
  const directory=ensureCredentialDirectory();assertPrivate(directory,true);
  const file=join(directory,'identity');const fd=openPrivateFile(file,constants.O_WRONLY,true);
  try{writeFileSync(fd,'original-identity');}finally{closeSync(fd);}
  assertPrivate(file);assert.throws(()=>openPrivateFile(file,constants.O_WRONLY,true),{code:'EEXIST'});
  assert.equal(readFileSync(file,'utf8'),'original-identity');
}));
test('unsafe storage is rejected before signup can consume a credential',()=>isolated(async()=>{
  const directory=ensureCredentialDirectory();
  if(process.platform==='win32')grantOtherUser(directory);else chmodSync(directory,0o755);
  let requests=0;
  await assert.rejects(signupAgent({maxPerRentalMinor:500,budgetLimitMinor:50000,maxConcurrentDeployments:1},undefined,(async()=>{requests++;throw new Error('must not call');}) as typeof fetch),/private|access controls/);
  assert.equal(requests,0);
}));
test('SSH transport failure cleans up the key and does not include credentials in errors',()=>isolated(async()=>{
  ensureCredentialDirectory();let keyPath='';
  const secret='-----BEGIN OPENSSH PRIVATE KEY-----\nTEST-ONLY-SECRET\n-----END OPENSSH PRIVATE KEY-----';
  const runner=((_file:string,args:string[],_options:any,callback:any)=>{
    keyPath=args[args.indexOf('-i')+1]!;assertPrivate(keyPath);
    callback(Object.assign(new Error(secret),{code:'ENOENT'}),'',secret);
  }) as unknown as typeof execFile;
  await assert.rejects(executeSsh('d1',{host:'127.0.0.1',port:22,username:'root',privateKey:secret},['true'],1,runner),error=>{
    assert.doesNotMatch(String(error),/TEST-ONLY-SECRET|BEGIN OPENSSH/);return /transport failed/.test(String(error));
  });
  assert.equal(existsSync(keyPath),false);assert.equal(existsSync(join(keyPath,'..')),false);
}));
test('insecure known_hosts is rejected without running SSH',()=>isolated(async()=>{
  const file=join(ensureCredentialDirectory(),'known_hosts');const fd=openPrivateFile(file,constants.O_WRONLY,true);closeSync(fd);
  if(process.platform==='win32')grantOtherUser(file);else chmodSync(file,0o644);
  let ran=false;
  await assert.rejects(executeSsh('d1',{host:'127.0.0.1',port:22,username:'root',privateKey:'TEST PRIVATE KEY'},['true'],1,(()=>{ran=true;}) as unknown as typeof execFile),/private|access controls/);
  assert.equal(ran,false);
}));
