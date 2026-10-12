import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertPrivate} from './platform-test-helpers.js';

test('released CLI: help provides Terms before explicit headless signup; required consent, stale versions and legacy compatibility', async t => {
  const version='2026-10-10';
  const sha256='074145afe292f1b1d20414a440243166dcfb20847d2dd793a156ef03c51f5054';
  const token=`uk_123456789abc.${'z'.repeat(32)}`;
  const key={id:'terms-test-key',kind:'AGENT',scopes:['billing','manage','read','rent']};
  let requiresConsent=true,changeAfterFetch=false,metadataUnavailable=false;
  let creates=0,metadataReads=0;
  const accepted:Array<{version:string;sha256:string;accepted:boolean}>=[];
  const server=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;
    const body=text?JSON.parse(text):{};
    const reply=(data:unknown,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(status<400?{data}:{error:data}));};
    if(req.url==='/api/v1/terms') {
      metadataReads++;assert.equal(req.headers.authorization,undefined);
      return metadataUnavailable?reply({code:'TERMS_UNAVAILABLE',message:'Terms unavailable.'},503):reply({version,sha256,url:'https://u-kiyo.ai/terms/'});
    }
    if(req.url==='/api/v1/signup') {
      assert.equal(req.headers.authorization,undefined);
      if(requiresConsent && (changeAfterFetch || body.termsAcceptance?.accepted!==true || body.termsAcceptance.version!==version || body.termsAcceptance.sha256!==sha256))
        return reply({code:'TERMS_ACCEPTANCE_REQUIRED',message:'Explicit agreement to the current Terms is required.'},409);
      creates++;if(body.termsAcceptance)accepted.push(body.termsAcceptance);
      return reply({token,key,account:{id:'terms-test-account'}},201);
    }
    assert.equal(req.url,'/api/v1/me');assert.equal(req.headers.authorization,`Bearer ${token}`);
    return reply({key,user:{id:'terms-test-account'}});
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  const homes:string[]=[];
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));for(const home of homes)rmSync(home,{recursive:true,force:true});});
  const run=(args:string[])=>new Promise<{code:number;stdout:string;stderr:string;home:string}>(resolve=>{
    const home=mkdtempSync(join(tmpdir(),'ukiyo terms ü-'));homes.push(home);
    const env:NodeJS.ProcessEnv={...process.env,HOME:home,USERPROFILE:home,UKIYO_API_URL:origin};delete env.UKIYO_API_TOKEN;
    const entry=process.env.UKIYO_TEST_CLI?[process.env.UKIYO_TEST_CLI]:['--import','tsx','src/bin.ts'];
    const child=spawn(process.execPath,[...entry,...args],{env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    child.on('close',code=>resolve({code:code??-1,stdout,stderr,home}));
  });
  const clean=(result:{stdout:string;stderr:string})=>assert.doesNotMatch(result.stdout+result.stderr,/uk_123456789abc|BEGIN .*PRIVATE KEY/);
  const help=await run(['signup','--help']);assert.equal(help.code,0);assert.match(help.stdout,/https:\/\/u-kiyo.ai\/terms\//);assert.match(help.stdout,/--accept-terms/);assert.equal(creates,0);assert.equal(metadataReads,0);
  for(const args of [['signup','--json'],['signup','--accept-terms','older-version','--json']]) {
    const result=await run(args);clean(result);assert.equal(result.code,1);assert.equal(result.stderr,'');
    assert.equal(JSON.parse(result.stdout).error.code,args.includes('--accept-terms')?'TERMS_VERSION_MISMATCH':'TERMS_ACCEPTANCE_REQUIRED');
    assert.equal(existsSync(join(result.home,'.ukiyo','credentials.json')),false);assert.equal(creates,0);
  }
  const signed=await run(['signup','--accept-terms',version,'--json']);clean(signed);assert.equal(signed.code,0,signed.stdout+signed.stderr);assert.equal(signed.stderr,'');
  assert.deepEqual(JSON.parse(signed.stdout).termsAcceptance,{version,sha256});assert.deepEqual(accepted,[{version,sha256,accepted:true}]);assert.equal(creates,1);
  const credential=join(signed.home,'.ukiyo','credentials.json');assert.equal(JSON.parse(readFileSync(credential,'utf8')).token,token);assertPrivate(credential);assertPrivate(join(signed.home,'.ukiyo'),true);
  changeAfterFetch=true;
  const changed=await run(['signup','--accept-terms',version,'--json']);clean(changed);assert.equal(JSON.parse(changed.stdout).error.code,'TERMS_ACCEPTANCE_REQUIRED');assert.equal(creates,1);assert.equal(existsSync(join(changed.home,'.ukiyo','credentials.json')),false);
  changeAfterFetch=false;metadataUnavailable=true;
  const unavailable=await run(['signup','--accept-terms',version,'--json']);clean(unavailable);assert.equal(JSON.parse(unavailable.stdout).error.code,'TERMS_UNAVAILABLE');assert.equal(creates,1);assert.equal(existsSync(join(unavailable.home,'.ukiyo','credentials.json')),false);
  metadataUnavailable=false;requiresConsent=false;const readsBefore=metadataReads;
  const legacy=await run(['signup','--json']);clean(legacy);assert.equal(legacy.code,0);assert.equal(creates,2);assert.equal(metadataReads,readsBefore,'legacy signup has no new mandatory metadata dependency');assert.equal('termsAcceptance' in JSON.parse(legacy.stdout),false);
});
