import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProgram } from './main.js';
import { ApiError, UkiyoClient } from './client.js';
import { waitFor } from './wait.js';
import { safeOutput } from './output.js';

const offers=[{id:'o1',name:'NVIDIA RTX 4090',gpuCount:1,pricePerHourMinor:88,currency:'USD'},{id:'o2',name:'NVIDIA RTX 4090',gpuCount:2,pricePerHourMinor:176,currency:'USD'},{id:'o3',name:'NVIDIA A100',gpuCount:1,pricePerHourMinor:200,currency:'USD'}];
const meteredAccount = { billing: { model: 'ACCOUNT_BALANCE', budgetRequired: false } };
function harness(handler:(path:string,init:RequestInit)=>unknown){
 const lines:string[]=[];const calls:Array<{path:string,init:RequestInit}>=[];
 const client=new UkiyoClient({token:'uk_test.secret',fetcher:async(url,init={})=>{const path=new URL(String(url)).pathname;calls.push({path,init});return Response.json({data:handler(path,init)});}});
 return {calls,lines,run:(args:string[])=>buildProgram({client,out:s=>lines.push(s)}).parseAsync(['node','ukiyo',...args]),value:()=>JSON.parse(lines.at(-1)!)};
}
test('offers filters GPU aliases and count without changing backend price',async()=>{
 const h=harness(()=>offers);await h.run(['offers','--gpu','RTX4090','--count','1','--json']);assert.deepEqual(h.value(),[offers[0]]);
});
test('balance includes backend key remaining budget, without client arithmetic',async()=>{
 const h=harness(()=>({balance:{availableMinor:500,currency:'USD'},key:{remainingBudgetMinor:700,maxPerRentalMinor:500}}));
 await h.run(['balance','--json']);assert.equal(h.value().availableMinor,500);assert.equal(h.value().key.remainingBudgetMinor,700);
});
test('rent sends GPU/count intent with quoted ceiling and waits on its stable rental ID; repeat key is forwarded unchanged',async()=>{
 const rental={rentalId:'r1',deploymentId:'d1',status:'PROVISIONING'};
 const h=harness(path=>path.endsWith('/offers')?offers:path.endsWith('/rentals')?rental:{...rental,status:'ACTIVE'});
 const args=['rent','--gpu','RTX4090','--count','1','--budget','5','--idempotency-key','request-1','--wait','--timeout','1','--json'];
 await h.run(args);await h.run(args);
 assert.equal(h.value().rentalId,'r1');assert.equal(h.value().deploymentId,'d1');assert.equal(h.value().status,'ACTIVE');
 for(const call of h.calls.filter(c=>c.path.endsWith('/rentals'))){assert.deepEqual(JSON.parse(String(call.init.body)),{gpuModel:'RTX4090',gpuCount:1,budgetMinor:500,maxHourlyPriceMinor:88});assert.equal(new Headers(call.init.headers).get('idempotency-key'),'request-1');}
});
test('explicit offer forwards exactly offerId/budget and never fetches inventory',async()=>{
 const h=harness(()=>({rentalId:'r1',deploymentId:'d1',status:'ACTIVE'}));
 await h.run(['rent','--offer','chosen-offer','--budget','5','--idempotency-key','explicit-key','--json']);
 assert.equal(h.calls.length,1);assert.deepEqual(JSON.parse(String(h.calls[0]!.init.body)),{offerId:'chosen-offer',budgetMinor:500});
 assert.equal(new Headers(h.calls[0]!.init.headers).get('idempotency-key'),'explicit-key');
});
test('budget-free GPU rental negotiates capability, retains the quote and forwards no allocation', async () => {
 const h=harness(path=>path.endsWith('/me')?meteredAccount:path.endsWith('/offers')?offers:{rentalId:'r1',deploymentId:'d1',status:'ACTIVE'});
 await h.run(['rent','--gpu','rtx-4090','--count','1','--idempotency-key','metered-intent','--json']);
 assert.deepEqual(h.calls.map(c=>c.path),['/api/v1/me','/api/v1/offers','/api/v1/rentals']);
 assert.deepEqual(JSON.parse(String(h.calls[2]!.init.body)),{gpuModel:'rtx-4090',gpuCount:1,maxHourlyPriceMinor:88});
 assert.equal(new Headers(h.calls[2]!.init.headers).get('idempotency-key'),'metered-intent');
 assert.equal('budgetMinor' in h.value(),false); assert.equal(h.value().deploymentId,'d1');
});
test('budget-free explicit offer and replay preserve exact ID/body/key without quote lookup', async () => {
 const h=harness(path=>path.endsWith('/me')?meteredAccount:{rentalId:'r1',deploymentId:'d1',status:'ACTIVE'});
 const args=['rent','--offer','chosen-offer','--idempotency-key','metered-explicit','--json'];
 await h.run(args);await h.run(args);
 const writes=h.calls.filter(c=>c.path.endsWith('/rentals'));assert.equal(writes.length,2);
 for(const call of writes){assert.deepEqual(JSON.parse(String(call.init.body)),{offerId:'chosen-offer'});assert.equal(new Headers(call.init.headers).get('idempotency-key'),'metered-explicit');}
 assert.equal(h.calls.some(c=>c.path.endsWith('/offers')),false);
});
test('legacy, unknown and inconsistent billing capabilities require budget before any rental write', async () => {
 for(const account of [{}, {billing:{model:'LEGACY_PREPAID',budgetRequired:true}}, {billing:{model:'ACCOUNT_BALANCE',budgetRequired:true}}, {billing:{model:'OTHER',budgetRequired:false}}, {billing:{model:'ACCOUNT_BALANCE'}}]) {
  const h=harness(()=>account);
  await assert.rejects(h.run(['rent','--gpu','rtx-4090','--json']),(e:any)=>e.code==='INVALID_USAGE'&&/--budget/.test(e.message));
  assert.deepEqual(h.calls.map(c=>c.path),['/api/v1/me']);assert.equal(h.lines.length,0);
 }
});
test('supplied budget retains old transport on both billing models without extra capability request', async () => {
 const h=harness(()=>({rentalId:'r1',deploymentId:'d1',status:'ACTIVE'}));
 await h.run(['rent','--offer','o1','--budget','5','--json']);
 assert.equal(h.calls.length,1);assert.deepEqual(JSON.parse(String(h.calls[0]!.init.body)),{offerId:'o1',budgetMinor:500});
});
test('metered retry with accepted ceiling skips inventory; wait timeout preserves identity without budget', async () => {
 const h=harness(path=>path.endsWith('/me')?meteredAccount:{rentalId:'r1',deploymentId:'d1',status:'PROVISIONING'});
 await assert.rejects(h.run(['rent','--gpu','rtx-4090','--max-hourly-price','0.88','--idempotency-key','metered-wait','--wait','--timeout','1','--json']),(e:any)=>e.code==='WAIT_TIMEOUT'&&e.context.rentalId==='r1'&&e.context.deploymentId==='d1'&&e.context.budgetMinor===undefined&&e.context.idempotencyKey==='metered-wait');
 assert.equal(h.calls.filter(c=>c.path.endsWith('/rentals')).length,1);assert.equal(h.calls.some(c=>c.path.endsWith('/offers')),false);
});
test('metered null duration survives CLI rental, list and status output without client synthesis', async () => {
 const deployment={id:'d1',status:'ACTIVE',billingModel:'ACCOUNT_BALANCE',hoursPurchased:null,durationSeconds:null,endsAt:null,endedAt:null};
 const rental={rentalId:'r1',deploymentId:'d1',status:'ACTIVE',deployment,quote:{durationSeconds:null},credits:{billingModel:'ACCOUNT_BALANCE'}};
 const h=harness(path=>path.endsWith('/deployments')?[deployment]:path.endsWith('/deployments/d1')?deployment:rental);
 for(const args of [['rental','r1','--json'],['list','--json'],['status','d1','--json']]) {
  await h.run(args);const value=h.value();const actual=Array.isArray(value)?value[0]:value.deployment??value;
  assert.deepEqual(actual,deployment);
 }
});
test('CLI shows actual endedAt for legacy and metered rental/status/list/terminate without synthesizing expiry', async () => {
 const endedAt='2026-10-08T10:15:00.000Z';
 for(const model of ['LEGACY_PREPAID','ACCOUNT_BALANCE']) {
  const deployment={id:'d1',status:'TERMINATED',billingModel:model,endsAt:model==='ACCOUNT_BALANCE'?null:'2026-10-08T12:00:00Z',endedAt};
  const rental={rentalId:'r1',deploymentId:'d1',status:'TERMINATED',endedAt,deployment};
  const h=harness(path=>path.endsWith('/deployments')?[deployment]:path.endsWith('/deployments/d1')?deployment:path.endsWith('/terminate')?{accepted:true}:rental);
  for(const args of [['rental','r1','--json'],['list','--json'],['status','d1','--json'],['terminate','d1','--yes','--wait','--json']]) {
   await h.run(args);const value=h.value();const actual=Array.isArray(value)?value[0]:value.deployment??value;
   assert.equal(actual.endedAt,endedAt);assert.equal(actual.endsAt,deployment.endsAt);
   if(value.rentalId)assert.equal(value.endedAt,endedAt);
  }
 }
});
test('GPU retry forwards original accepted ceiling without resolving/fetching a marketplace row',async()=>{
 const h=harness(()=>({rentalId:'r1',deploymentId:'d1',status:'ACTIVE'}));
 const args=['rent','--gpu','RTX4090','--count','1','--budget','5','--max-hourly-price','0.88','--idempotency-key','retry-key','--json'];
 await h.run(args);await h.run(args);
 assert.equal(h.calls.length,2);
 for(const call of h.calls){assert.deepEqual(JSON.parse(String(call.init.body)),{gpuModel:'RTX4090',gpuCount:1,budgetMinor:500,maxHourlyPriceMinor:88});assert.equal(new Headers(call.init.headers).get('idempotency-key'),'retry-key');}
});
test('GPU quote ceiling comes from live customer data without price arithmetic or offer binding',async()=>{
 const h=harness(path=>path.endsWith('/offers')?[...offers,{id:'cheaper',name:'NVIDIA RTX 4090',gpuCount:1,pricePerHourMinor:80,currency:'USD'}]:{rentalId:'r1',deploymentId:'d1',status:'ACTIVE'});
 await h.run(['rent','--gpu','RTX4090','--count','1','--budget','5','--json']);
 const input=JSON.parse(String(h.calls[1]!.init.body));assert.equal(input.maxHourlyPriceMinor,80);assert.equal(input.offerId,undefined);assert.equal(h.value().maxHourlyPriceMinor,80);
});
test('rent wait timeout preserves both identities and key, without a second rent',async()=>{
 const rental={rentalId:'r1',deploymentId:'d1',status:'PROVISIONING'};const h=harness(()=>rental);
 await assert.rejects(()=>h.run(['rent','--offer','o1','--budget','5','--idempotency-key','request-2','--wait','--timeout','1','--json']),(e:any)=>e.code==='WAIT_TIMEOUT'&&e.context?.rentalId==='r1'&&e.context?.deploymentId==='d1'&&e.context?.idempotencyKey==='request-2');
 assert.equal(h.calls.filter(c=>c.path.endsWith('/rentals')).length,1);
});
test('terminate wait confirms TERMINATED; repeated terminate remains predictable',async()=>{
 const h=harness(path=>path.endsWith('/terminate')?{accepted:true}:{id:'d1',status:'TERMINATED'});
 for(let i=0;i<2;i++){await h.run(['terminate','d1','--yes','--wait','--timeout','1','--json']);assert.equal(h.value().status,'TERMINATED');assert.equal(h.value().deploymentId,'d1');}
});
test('credentials output never exposes key material',async()=>{
 const h=harness(()=>({host:'127.0.0.1',port:22,username:'root',privateKey:'-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----'}));
 await h.run(['credentials','d1','--json']);assert.doesNotMatch(h.lines.join(''),/SECRET|BEGIN PRIVATE KEY/);
});
test('backend request metadata survives errors and secret-shaped values are redacted recursively',async()=>{
 const client=new UkiyoClient({token:'test',fetcher:async()=>Response.json({error:{code:'INSUFFICIENT_BALANCE',message:'Fund the account.',requestId:'req-1'}},{status:409})});
 await assert.rejects(client.rent('o1',500,'key'),(e:any)=>e.status===409&&e.code==='INSUFFICIENT_BALANCE'&&e.message==='Fund the account.'&&e.requestId==='req-1');
 const text=JSON.stringify(safeOutput({nested:[{privateKey:'secret',token:'secret',password:'secret',stdout:`uk_123456789abc.${'a'.repeat(32)} -----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----`}]}));
 assert.doesNotMatch(text,/secret|uk_123|BEGIN PRIVATE KEY/);
});
test('invalid selection, count, timeout and amount reject as CLI usage errors',async()=>{
 const h=harness(()=>offers);
 for(const args of [
  ['rent','--offer','o1','--gpu','RTX4090','--budget','5'],
  ['rent','--offer','o1','--budget','5','--max-hourly-price','1'],
  ['rent','--gpu','RTX4090','--count','3','--budget','5'],
  ['rent','--gpu','RTX4090','--budget','5','--count','0'],
  ['rent','--offer','o1','--budget','5','--timeout','Infinity'],
  ['offers','--count','1.5'],
  ['rent','--offer','o1','--budget','999999999999999999999'],
 ]) await assert.rejects(()=>h.run(args),(e:any)=>['INVALID_USAGE','INVALID_BUDGET'].includes(e.code));
 await assert.rejects(()=>h.run(['rent','--gpu','H999','--budget','5']),(e:any)=>e.code==='NO_MATCHING_OFFER');
});
test('wait preserves resource context when a status API fails',async()=>{
 await assert.rejects(waitFor(async()=>{throw new ApiError(503,'UPSTREAM_UNAVAILABLE','Try later.',{error:{requestId:'req-2'}});},()=>false,1,{rentalId:'r1',deploymentId:'d1'}),(e:any)=>e.code==='UPSTREAM_UNAVAILABLE'&&e.requestId==='req-2'&&e.context.deploymentId==='d1');
});
