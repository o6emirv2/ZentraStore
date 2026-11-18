'use strict';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { applicationFixture } = require('./helpers/application-fixture.cjs');
let app, owner;
before(async () => { app = await applicationFixture(); owner = await app.openAdmin(); });
after(async () => app?.close());
// Each independent case starts with an unused fixture TOTP counter.
beforeEach(() => { for (const key of app.db.records.keys()) if (key.startsWith('storeAdminTotpState/')) app.db.records.delete(key); });
async function begin(uid = 'owneruid', until = 'five') {
 const token = app.idToken(uid); let ticket = '', cookie = '', last;
 for (const [step, extra] of [['email', {}], ['uid', {}], ['firebase-password', {password: app.password}], ['four', {password: app.four}], ['five', {password: app.five}]]) {
  last = await app.request('/api/auth/admin/gate/step-' + step, {token,cookie,method:'POST',body:{...(ticket?{ticket}:{}),...extra}});
  assert.equal(last.status,200,step); ticket=last.body.ticket;
  cookie=[cookie,...last.headers.getSetCookie().map(v=>v.split(';')[0])].filter(Boolean).join('; ');
  if(until===step)return {token,cookie,ticket,last};
 }
}
const step=(name,s,body={})=>app.request('/api/auth/admin/gate/step-'+name,{...s,method:'POST',body:{ticket:s.ticket,...body}});
const grant=(uid,role='admin',active=true,s=owner)=>app.adminWrite(s,'/api/admin/store/staff/'+uid,'PUT',{email:`${uid}@zentra.invalid`,role,active});
test('five correct checks never grant access before the separate sixth TOTP step',async()=>{
 const s=await begin(); assert.equal(s.last.body.redirectTo,undefined);assert.equal(s.last.body.browserSession,undefined);
 assert.equal((await app.request('/api/auth/admin/gate/status',s)).body.authenticated,false);
 assert.equal((await app.request('/api/admin/store/catalog',s)).status,401);
 const r=await step('six',s,{totpCode:app.totp()});assert.equal(r.status,200);assert.equal(r.body.redirectTo,'/admin/');
});
test('skipped password stages, wrong code and tickets moved to a different account fail closed',async()=>{
 for(const stage of ['firebase-password','four']) assert.equal((await step('six',await begin('owneruid',stage),{totpCode:app.totp()})).status,401);
 const fifth=await begin('owneruid','four');assert.equal((await step('five',fifth,{password:'invalid-long-password'})).status,403);
 const ready=await begin();assert.equal((await step('six',ready,{totpCode:'not-a-code'})).status,401);
 assert.equal((await step('six',{...ready,token:app.idToken('finance')},{totpCode:app.totp()})).status,401);
});
test('expired or legacy five-step tickets cannot complete the new gate',async()=>{
 const {sealAdminStep,readAdminStep}=require('../server/core/adminAccessService');const s=await begin(),p=readAdminStep(s.ticket);
 for(const delta of [{type:'zentra-admin-step-v42'},{expiresAt:Date.now()-1}])assert.equal((await step('six',{...s,ticket:sealAdminStep({...p,...delta})},{totpCode:app.totp()})).status,401);
});
test('full administrator has the owner permission set and can manage another staff account',async()=>{
 assert.equal((await grant('finance')).status,200);const s=await app.openAdmin('finance');
 const identity=(await app.request('/api/auth/admin/gate/identity',s)).body.adminContext;
 assert.equal(identity.role,'admin');assert.deepEqual(identity.permissions,['*']);
 for(const path of ['staff','catalog','users','audit','security'])assert.equal((await app.request('/api/admin/store/'+path,s)).status,200,path);
 assert.equal((await grant('viewer','support',true,s)).status,200);
 const service=require('../server/core/adminStoreService');assert.deepEqual(service.ROLE_PERMISSIONS.admin,service.ROLE_PERMISSIONS.owner);
});
test('ordinary users and restricted staff cannot promote themselves or other accounts',async()=>{
 const s=await app.openAdmin('viewer');assert.equal((await grant('member','admin',true,s)).status,403);
 assert.equal((await app.request('/api/admin/store/staff/member',{uid:'member',method:'PUT',body:{email:'member@zentra.invalid',role:'admin',active:true}})).status,403);
 await assert.rejects(require('../server/core/adminStoreService').upsertStaff({uid:'member',email:'member@zentra.invalid',role:'admin',active:true,actor:{uid:'viewer',email:'viewer@zentra.invalid'}}),{code:'ADMIN_PERMISSION_REQUIRED'});
 assert.equal(app.db.records.has('adminUsers/member'),false);
});
test('protected owner and own role cannot be edited by a full administrator',async()=>{
 const s=await app.openAdmin('finance');
 assert.equal((await app.adminWrite(s,'/api/admin/store/staff/owneruid','PUT',{email:'owner@zentra.invalid',role:'viewer',active:false})).body.error,'ADMIN_OWNER_IMMUTABLE');
 assert.equal((await grant('finance','viewer',false,s)).body.error,'ADMIN_STAFF_SELF_CHANGE_FORBIDDEN');
 assert.equal((await grant('member','owner')).body.error,'ADMIN_STAFF_ROLE_INVALID');
});
test('role downgrade and deactivation invalidate existing sessions and unfinished gate tickets',async()=>{
 const s=await app.openAdmin('finance'),t=await begin('finance');assert.equal((await grant('finance','viewer')).status,200);
 assert.equal((await app.request('/api/auth/admin/gate/status',s)).body.authenticated,false);
 assert.equal((await step('six',t,{totpCode:app.totp()})).status,401);
 app.db.records.delete('storeAdminTotpState/'+crypto.createHash('sha256').update('finance').digest('hex'));
 const limited=await app.openAdmin('finance');assert.equal((await app.request('/api/admin/store/catalog',limited)).status,200);
 assert.equal((await app.request('/api/admin/store/staff',limited)).status,403);assert.equal((await grant('finance','viewer',false)).status,200);
 assert.equal((await app.request('/api/admin/store/catalog',limited)).status,403);
});
test('role mutation and before/after audit roll back together when commit fails',async()=>{
 const before=structuredClone(app.db.records.get('adminUsers/viewer')),count=[...app.db.records].filter(([p])=>p.startsWith('audit/')).length;
 app.db.setFailure(true);
 try{await assert.rejects(require('../server/core/adminStoreService').upsertStaff({uid:'viewer',email:'viewer@zentra.invalid',role:'admin',active:true,actor:{uid:'owneruid',email:'owner@zentra.invalid'}}));}finally{app.db.setFailure(false);}
 assert.deepEqual(app.db.records.get('adminUsers/viewer'),before);assert.equal([...app.db.records].filter(([p])=>p.startsWith('audit/')).length,count);
 assert.equal((await grant('viewer','viewer')).status,200);
 const audit=[...app.db.records.values()].find(v=>v.action==='store.staff.update'&&v.details?.uid==='viewer'&&v.details?.after?.role==='viewer');assert(audit?.details.before);assert(audit.details.after.policyVersion>0);
});
test('concurrent role grants serialize revisions; arbitrary stored permissions are ignored',async()=>{
 const service=require('../server/core/adminStoreService'),before=app.db.records.get('adminUsers/viewer').policyVersion;
 await Promise.all(['finance','viewer'].map(role=>service.upsertStaff({uid:'viewer',email:'viewer@zentra.invalid',role,active:true,actor:{uid:'owneruid',email:'owner@zentra.invalid'}})));
 const row=app.db.records.get('adminUsers/viewer');assert.equal(row.policyVersion,before+2);
 app.db.records.set('adminUsers/viewer',{...row,role:'viewer',permissions:['*']});assert.equal(service.staffHasPermission(await service.resolveStaffPolicy('viewer','viewer@zentra.invalid'),'store.staff.write'),false);
});
test('rotated credential verifiers invalidate old admin sessions without altering inventory keys',async()=>{
 const s=await app.openAdmin(),old=process.env.ADMIN_GATE_FOUR_HASH_HEX,vault=process.env.STORE_KEY_ENCRYPTION_SECRET;
 process.env.ADMIN_GATE_FOUR_HASH_HEX=crypto.randomBytes(32).toString('hex');
 try{assert.equal((await app.request('/api/auth/admin/gate/status',s)).body.authenticated,false);}finally{process.env.ADMIN_GATE_FOUR_HASH_HEX=old;}
 assert.equal(process.env.STORE_KEY_ENCRYPTION_SECRET,vault);
});
test('disabled or unverified Firebase accounts cannot receive an active admin grant',async()=>{
 app.users.get('member').emailVerified=false;try{assert.equal((await grant('member')).body.error,'ADMIN_STAFF_ACCOUNT_NOT_READY');}finally{app.users.get('member').emailVerified=true;}
 app.users.get('member').disabled=true;try{assert.equal((await grant('member')).body.error,'ADMIN_STAFF_ACCOUNT_NOT_READY');}finally{app.users.get('member').disabled=false;}
});

test('a legacy unknown admin role cannot silently inherit new full authority without an explicit grant',async()=>{
 const service=require('../server/core/adminStoreService');
 app.db.records.set('adminUsers/member',{email:'member@zentra.invalid',role:'admin',active:true,permissions:['*']});
 try{
  const legacy=await service.resolveStaffPolicy('member','member@zentra.invalid');assert.equal(legacy.role,'viewer');assert.equal(service.staffHasPermission(legacy,'store.staff.write'),false);
  await assert.rejects(service.upsertStaff({uid:'viewer',email:'viewer@zentra.invalid',role:'admin',active:true,actor:{uid:'member',email:'member@zentra.invalid'}}),{code:'ADMIN_PERMISSION_REQUIRED'});
  assert.equal((await grant('member')).status,200);
  const assigned=await service.resolveStaffPolicy('member','member@zentra.invalid');assert.equal(assigned.role,'admin');assert.deepEqual(assigned.permissions,['*']);assert(assigned.policyVersion>0);
 }finally{app.db.records.delete('adminUsers/member');}
});
