'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { applicationFixture } = require('./helpers/application-fixture.cjs');
let f, owner, sequence = 10;
before(async()=>{f=await applicationFixture();owner=await f.openAdmin();});
after(async()=>f?.close());
beforeEach(()=>{f.resetLimits();f.networkState.blocked=false;f.networkState.unavailable=false;f.networkState.ip=`8.8.4.${++sequence}`;});
function add(uid) {
 f.users.set(uid,{uid,email:`${uid}@zentra.invalid`,emailVerified:true,disabled:false,generation:0,password:f.password,metadata:{creationTime:new Date().toISOString()}});
 return {firstName:'Deniz',lastName:'Deneme',username:'User'+uid,birthDate:'2000-01-01'};
}
const register=(uid,body,deviceName)=>f.request('/api/profile/update',{uid,method:'POST',body,deviceName});
test('same registration IP rejects a second account even with a different verified device',async()=>{
 const a=add('sameip01'),b=add('sameip02');
 assert.equal((await register('sameip01',a,'ip-device-a')).status,200);
 const denied=await register('sameip02',b,'ip-device-b');assert.equal(denied.status,403);assert.equal(denied.body.error,'SECURITY_IP_ACCOUNT_EXISTS');
 assert.equal(f.db.records.has('users/sameip02'),false);assert.equal(f.db.records.get('users/sameip01').storeSecurity.state,'active');
});
test('same verified device rejects a second account even after its source IP changes',async()=>{
 const a=add('samedev01'),b=add('samedev02');
 assert.equal((await register('samedev01',a,'one-device')).status,200);
 f.networkState.ip='8.8.4.220';
 const denied=await register('samedev02',b,'one-device');assert.equal(denied.status,403);assert.equal(denied.body.error,'SECURITY_DEVICE_ACCOUNT_EXISTS');
});
test('two simultaneous registration transactions acquire only one shared IP slot',async()=>{
 const a=add('parallel01'),b=add('parallel02');
 const results=await Promise.all([register('parallel01',a,'parallel-device-a'),register('parallel02',b,'parallel-device-b')]);
 assert.equal(results.filter(x=>x.status===200).length,1);assert.equal(results.filter(x=>x.body.error==='SECURITY_IP_ACCOUNT_EXISTS').length,1);
});
test('spoofed forwarded IP cannot change the source used by the development server',async()=>{
 const a=add('spoofed01'),b=add('spoofed02');
 assert.equal((await register('spoofed01',a,'spoof-a')).status,200);
 const denied=await f.request('/api/profile/update',{uid:'spoofed02',method:'POST',body:b,deviceName:'spoof-b',headers:{'x-forwarded-for':'1.1.1.1'}});
 assert.equal(denied.body.error,'SECURITY_IP_ACCOUNT_EXISTS');assert.equal(f.networkState.lastInput,'127.0.0.1');
});
test('a request signature is one-use and bound to the exact path, method and body',async()=>{
 const headers=await f.deviceHeaders('/api/store/security/preflight','POST',{},'proof-test');
 const first=await f.request('/api/store/security/preflight',{method:'POST',body:{},headers,deviceProof:false});assert.equal(first.status,200);
 const replay=await f.request('/api/store/security/preflight',{method:'POST',body:{},headers,deviceProof:false});assert.equal(replay.body.error,'SECURITY_DEVICE_REPLAY');
 const mismatch=await f.deviceHeaders('/api/store/transfers','POST',{amountKurus:10000},'proof-test');
 const forged=await f.request('/api/store/security/preflight',{method:'POST',body:{},headers:mismatch,deviceProof:false});assert.equal(forged.body.error,'SECURITY_DEVICE_INVALID');
 const missing=await f.request('/api/store/security/preflight',{method:'POST',body:{},deviceProof:false});assert.equal(missing.body.error,'SECURITY_DEVICE_REQUIRED');
});
test('VPN detection and provider outages block preflight and economic access without creating a profile',async()=>{
 const body=add('vpnuser01');f.networkState.blocked=true;
 const vpn=await register('vpnuser01',body,'vpn-device');assert.equal(vpn.body.error,'SECURITY_NETWORK_BLOCKED');
 assert.equal(f.db.records.has('users/vpnuser01'),false);
 f.networkState.blocked=false;f.networkState.unavailable=true;
 const outage=await f.request('/api/store/security/preflight',{method:'POST',body:{},deviceName:'outage-device'});assert.equal(outage.status,503);assert.equal(outage.body.error,'SECURITY_NETWORK_UNAVAILABLE');
 const money=await f.request('/api/store/transfers/preview',{uid:'member',method:'POST',body:{recipientUsername:'ShopOwner',amountKurus:10000}});assert.equal(money.status,503);
});
test('raw Firebase identities cannot bypass registration to redeem a promotion or purchase',async()=>{
 add('pending001');
 const redeem=await f.request('/api/store/balance-codes/redeem',{uid:'pending001',method:'POST',body:{code:'ANYCODE'}});assert.equal(redeem.body.error,'SECURITY_REGISTRATION_REQUIRED');
 const order=await f.request('/api/store/orders',{uid:'pending001',method:'POST',body:{items:[],paymentMethod:'wallet',idempotencyKey:'pending-request-0001'}});assert.equal(order.body.error,'SECURITY_REGISTRATION_REQUIRED');
 assert.equal([...f.db.records.values()].filter(x=>x.uid==='pending001'&&x.amountKurus).length,0);
});
test('admin suspension blocks the account and its owned identifiers, revokes tokens, preserves money, and restores with revision checks',async()=>{
 const body=add('moderate01');assert.equal((await register('moderate01',body,'moderate-device')).status,200);
 f.db.records.get('users/moderate01').storeBalanceKurus=12000;
 const token=f.idToken('moderate01');
 assert.equal((await f.request('/api/admin/store/abuse/users/moderate01',{uid:'member'})).status,403);
 const denied=await f.request('/api/admin/store/abuse/users/moderate01',{...owner,method:'PUT',body:{action:'suspend',reason:'Confirmed multiple account case',revision:0}});assert.equal(denied.status,401);
 const suspended=await f.adminWrite(owner,'/api/admin/store/abuse/users/moderate01','PUT',{action:'suspend',reason:'Confirmed multiple account case',revision:0});
 assert.equal(suspended.status,200,JSON.stringify(suspended.body));assert.equal(suspended.body.result.revocationPending,false);
 assert.equal(f.db.records.get('users/moderate01').storeBalanceKurus,12000);assert.equal(f.users.get('moderate01').disabled,true);
 assert.equal((await f.request('/api/store/account',{token,deviceName:'moderate-device'})).status,401);
 const ip=f.db.records.get('users/moderate01').storeRegistrationSecurity.ipHash;assert.equal(f.db.records.get('storeRegistrationIps/'+ip).blocked,true);
 const stale=await f.adminWrite(owner,'/api/admin/store/abuse/users/moderate01','PUT',{action:'restore',reason:'Verified review completed',revision:0});assert.equal(stale.status,409);assert.equal(f.users.get('moderate01').disabled,true);
 const restored=await f.adminWrite(owner,'/api/admin/store/abuse/users/moderate01','PUT',{action:'restore',reason:'Verified review completed',revision:1});assert.equal(restored.status,200);
 assert.equal(f.users.get('moderate01').disabled,false);assert.equal(f.db.records.get('storeRegistrationIps/'+ip).blocked,false);
 assert.equal((await f.request('/api/store/account',{uid:'moderate01',deviceName:'moderate-device'})).status,200);
});
test('a provider revocation outage never rolls back the durable server block, and a later retry completes',async()=>{
 const body=add('revoke001');assert.equal((await register('revoke001',body,'revoke-device')).status,200);
 const update=f.auth.updateUser;f.auth.updateUser=async()=>{throw new Error('provider unavailable');};
 const suspended=await f.adminWrite(owner,'/api/admin/store/abuse/users/revoke001','PUT',{action:'suspend',reason:'Confirmed security investigation',revision:0});
 assert.equal(suspended.status,200);assert.equal(suspended.body.result.revocationPending,true);
 const access=await f.request('/api/store/account',{uid:'revoke001',deviceName:'revoke-device'});assert.equal(access.status,403);
 f.auth.updateUser=update;
 const retried=await f.adminWrite(owner,'/api/admin/store/abuse/users/revoke001','PUT',{action:'retry-revocation',reason:'Retry provider revocation',revision:1});assert.equal(retried.body.result.revocationPending,false);
});
test('legacy admission records an observation and does not invent a historical registration IP',async()=>{
 const result=await f.request('/api/store/account',{uid:'member',deviceName:'legacy-observation-device'});assert.equal(result.status,200);
 const data=f.db.records.get('users/member').storeRegistrationSecurity;
 assert.equal(data.kind,'legacy_observation');assert.equal(data.historicalRegistrationKnown,false);
});
test('account inspection includes a shared device observed after registration on another device',async()=>{
 const a=add('related01'),b=add('related02');
 assert.equal((await register('related01',a,'related-device-a')).status,200);
 f.networkState.ip='8.8.4.231';assert.equal((await register('related02',b,'related-device-b')).status,200);
 assert.equal((await f.request('/api/store/account',{uid:'related02',deviceName:'related-device-a'})).status,200);
 const inspected=await f.request('/api/admin/store/abuse/users/related02',owner);
 assert.equal(inspected.status,200);assert(inspected.body.account.relatedAccounts.some(row=>row.uid==='related01'&&row.matches.includes('registration-device')));
});
test('security restoration cannot silently enable a Firebase account disabled outside this workflow',async()=>{
 const body=add('external01');assert.equal((await register('external01',body,'external-device')).status,200);
 f.users.get('external01').disabled=true;
 const denied=await f.adminWrite(owner,'/api/admin/store/abuse/users/external01','PUT',{action:'restore',reason:'External suspension review',revision:0});
 assert.equal(denied.status,409);assert.equal(denied.body.error,'SECURITY_EXTERNAL_ACCOUNT_DISABLED');assert.equal(f.users.get('external01').disabled,true);
});
