import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import {assertPrivate} from './platform-test-helpers.js';

test('actual CLI processes: fresh signup, topup, filters, replay, wait, SSH, termination and JSON/error/secret contract', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ukiyo cli process-'));
  const token = `uk_123456789abc.${'a'.repeat(32)}`;
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-fixture\n-----END OPENSSH PRIVATE KEY-----';
  const key = { id: 'k1', kind: 'AGENT', scopes: ['billing','manage','read','rent'], remainingBudgetMinor: 5000 };
  const account = { id: 'u1' };
  const catalogue = [{ id:'o1',name:'NVIDIA RTX 4090',gpuCount:1,pricePerHourMinor:87,currency:'USD' },{ id:'o2',name:'NVIDIA RTX 4090',gpuCount:2,pricePerHourMinor:174,currency:'USD' }];
  let terminal = false; let createCount = 0; let debitCount = 0; let slow = false; let fail = false; let stalledBody = false; let accountBalance = false;
  const requests = new Map<string, object>();
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    const path = req.url!;
    const reply = (data: unknown, status = 200) => { res.writeHead(status, {'content-type':'application/json'});res.end(JSON.stringify(status < 400 ? {data} : data)); };
    if (path.endsWith('/terms')) { assert.equal(req.headers.authorization, undefined); return reply({version:'SYNTHETIC_TEST_ONLY',url:'https://u-kiyo.ai/terms/',sha256:'a'.repeat(64)}); }
    if (path.endsWith('/signup')) { assert.equal(req.headers.authorization, undefined); assert.deepEqual(body.termsAcceptance,{version:'SYNTHETIC_TEST_ONLY',sha256:'a'.repeat(64),accepted:true}); return reply({ account, key, token }); }
    if (path.endsWith('/offers')) return reply(catalogue);
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    if (fail) return reply({error:{code:'ACCOUNT_FROZEN',message:'Account frozen.',requestId:'req-fixture'}},403);
    if (path.endsWith('/me')) return reply({user:account,key,balance:{availableMinor:500,currency:'USD'},billing:{model:accountBalance?'ACCOUNT_BALANCE':'LEGACY_PREPAID',budgetRequired:!accountBalance}});
    if (path.endsWith('/topups')) { assert.equal(body.amountMinor,500);return reply({checkoutUrl:'https://checkout.stripe.com/fixture',topUpId:'t1'}); }
    if (path.endsWith('/rentals')) {
      assert.deepEqual(body,{gpuModel:accountBalance?'rtx-4090':'RTX4090',gpuCount:1,...accountBalance?{}:{budgetMinor:500},maxHourlyPriceMinor:87});const id = String(req.headers['idempotency-key']);
      if (!requests.has(id)) {createCount++;debitCount++;requests.set(id,{rentalId:'r1',deploymentId:'d1',status:'PROVISIONING'});}
      return reply(requests.get(id));
    }
    if (path.endsWith('/rentals/r1')) {
      if(stalledBody){res.writeHead(200,{'content-type':'application/json'});res.write('{');return;}
      return reply({rentalId:'r1',deploymentId:'d1',status:slow?'PROVISIONING':'ACTIVE'});
    }
    if (path.endsWith('/credentials/reveal')) return reply({host:'127.0.0.1',port:22,username:'root',privateKey:pem});
    if (path.endsWith('/terminate')) {terminal=true;return reply({accepted:true});}
    if (path.endsWith('/deployments/d1')) return reply({id:'d1',status:slow?'ACTIVE':terminal?'TERMINATED':'ACTIVE'});
    reply({error:{code:'NOT_FOUND',message:'Not found.',requestId:'req-404'}},404);
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(home,{recursive:true,force:true});});
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const executable = join(home,'bin');mkdirSync(executable);
  // Fake SSH proves CLI argv, key permissions, exit handling and deletion without a provider.
  if(process.platform==='win32') {
    const source=join(executable,'ssh.cs');
    writeFileSync(source,`using System; using System.IO; using System.Security.Principal; using System.Security.AccessControl;
class Fixture { static int Main(string[] args) {
string path=args[Array.IndexOf(args,"-i")+1];
if(args[Array.IndexOf(args,"-F")+1]!="NUL")return 98;
var acl=File.GetAccessControl(path); var sid=WindowsIdentity.GetCurrent().User;
if(!acl.AreAccessRulesProtected || acl.GetOwner(typeof(SecurityIdentifier)).Value!=sid.Value)return 99;
foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))if(rule.AccessControlType==AccessControlType.Allow && rule.IdentityReference.Value!=sid.Value)return 99;
File.WriteAllText(${JSON.stringify(join(home,'key-path'))},path);
Console.WriteLine(File.ReadAllText(path));Console.Error.WriteLine(${JSON.stringify(token)});Console.WriteLine("GPU OK");
return args[args.Length-1].Contains("false")?7:0; }}\n`);
    execFileSync(join(process.env.SystemRoot!,'Microsoft.NET','Framework64','v4.0.30319','csc.exe'),['/nologo','/target:exe',`/out:${join(executable,'ssh.exe')}`,source]);
  } else writeFileSync(join(executable,'ssh'),`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);const p=args[args.indexOf('-i')+1];if((fs.statSync(p).mode&511)!==384)process.exit(99);fs.writeFileSync(${JSON.stringify(join(home,'key-path'))},p);console.log(fs.readFileSync(p,'utf8'));console.error(${JSON.stringify(token)});console.log('GPU OK');process.exit(args.at(-1).includes('false')?7:0);\n`,{mode:0o700});
  const run = (args: string[]) => new Promise<{code:number;stdout:string;stderr:string;json:any}>(resolve => {
    const entry = process.env.UKIYO_TEST_CLI ? [process.env.UKIYO_TEST_CLI] : ['--import','tsx','src/bin.ts'];
    const env:NodeJS.ProcessEnv={...process.env,HOME:home,USERPROFILE:home,PATH:`${executable}${delimiter}${process.env.PATH}`,UKIYO_API_URL:origin}; delete env.UKIYO_API_TOKEN;
    const child = spawn(process.execPath,[...entry,...args],{env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    child.on('close',code=>{ let json: any;try {json=JSON.parse(stdout);}catch{}resolve({code:code??-1,stdout,stderr,json}); });
  });
  const clean = (result: {stdout:string;stderr:string;json:any}) => {assert.ok(result.json);assert.doesNotMatch(result.stdout+result.stderr,/secret-fixture|BEGIN OPENSSH PRIVATE KEY|uk_123456789abc/);};
  try {
    let result=await run(['signup','--accept-terms','SYNTHETIC_TEST_ONLY','--json']);clean(result);assert.equal(result.code,0);assert.equal(result.json.account.id,'u1');assert.equal(result.json.termsAcceptance.sha256,'a'.repeat(64));
    assertPrivate(join(home,'.ukiyo','credentials.json'));assertPrivate(join(home,'.ukiyo'),true);
    result=await run(['balance','--json']);clean(result);assert.equal(result.json.availableMinor,500);assert.equal(result.json.key.remainingBudgetMinor,5000);
    result=await run(['topup','link','--amount','5','--json']);clean(result);assert.equal(result.json.checkoutUrl,'https://checkout.stripe.com/fixture');assert.ok(result.json.idempotencyKey);
    result=await run(['offers','--gpu','RTX4090','--count','1','--json']);clean(result);assert.deepEqual(result.json,[catalogue[0]]);
    const rent=['rent','--gpu','RTX4090','--count','1','--budget','5','--idempotency-key','stable-key','--wait','--timeout','1','--json'];
    for(let i=0;i<2;i++){result=await run(rent);clean(result);assert.equal(result.code,0);assert.equal(result.json.status,'ACTIVE');assert.equal(result.json.deploymentId,'d1');}
    assert.equal(createCount,1);assert.equal(debitCount,1);
    slow=true;result=await run(rent);clean(result);assert.equal(result.code,3);assert.equal(result.json.rentalId,'r1');assert.equal(result.json.deploymentId,'d1');assert.equal(result.json.idempotencyKey,'stable-key');assert.equal(createCount,1);slow=false;
    stalledBody=true;result=await run(rent);clean(result);assert.equal(result.code,3);assert.equal(result.json.rentalId,'r1');assert.equal(result.json.deploymentId,'d1');stalledBody=false;
    for(const [command,code,exitCode] of [['nvidia-smi',0,0],['false',1,7]] as const){
      result=await run(['exec','d1','--json','--',command]);clean(result);assert.equal(result.code,code);assert.equal(result.json.exitCode,exitCode);assert.equal(result.json.deploymentId,'d1');assert.match(result.json.stdout,/GPU OK/);
      assert.equal(existsSync(readFileSync(join(home,'key-path'),'utf8')),false);
    }
    slow=true;result=await run(['terminate','d1','--yes','--wait','--timeout','1','--json']);clean(result);assert.equal(result.code,3);assert.equal(result.json.deploymentId,'d1');slow=false;
    for(let i=0;i<2;i++){result=await run(['terminate','d1','--yes','--wait','--json']);clean(result);assert.equal(result.code,0);assert.equal(result.json.status,'TERMINATED');}
    result=await run(['rent','--json']);clean(result);assert.equal(result.code,2);assert.equal(result.json.error.code,'INVALID_USAGE');assert.equal(result.stderr,'');
    const budgetFree=['rent','--gpu','rtx-4090','--count','1','--idempotency-key','metered-key','--json'];
    result=await run(budgetFree);clean(result);assert.equal(result.code,2);assert.match(result.json.error.message,/--budget/);assert.equal(createCount,1);
    accountBalance=true;
    for(let i=0;i<2;i++){result=await run(budgetFree);clean(result);assert.equal(result.code,0);assert.equal(result.json.deploymentId,'d1');assert.equal('budgetMinor' in result.json,false);}
    assert.equal(createCount,2,'one new intent, no duplicate on replay');
    fail=true;result=await run(['topup','link','--amount','5','--json','--idempotency-key','topup-safe']);clean(result);assert.equal(result.code,1);assert.deepEqual(result.json.error,{code:'ACCOUNT_FROZEN',status:403,message:'Account frozen.',requestId:'req-fixture'});assert.equal(result.json.idempotencyKey,'topup-safe');
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(home,{recursive:true,force:true});}
});
