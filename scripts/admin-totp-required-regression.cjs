'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {applicationFixture}=require('./helpers/application-fixture.cjs');
test('production admin gate cannot skip Google code even when an optional TOTP configuration reaches the minimum score',async()=>{
 process.env.ADMIN_SECURITY_MIN_SCORE='86';
 const app=await applicationFixture({nodeEnv:'production',totpMode:'optional',configuredTotp:false});
 try{
  const token=app.idToken('owneruid');let ticket='',cookie='';
  for(const [stage,data] of [['email',{}],['uid',{}],['firebase-password',{password:app.password}],['four',{password:app.four}],['five',{password:app.five}]]){
   const r=await app.request('/api/auth/admin/gate/step-'+stage,{token,cookie,method:'POST',body:{...(ticket?{ticket}:{}),...data}});
   assert.equal(r.status,200,stage+' '+JSON.stringify(r.body));ticket=r.body.ticket;
   cookie=[cookie,...r.headers.getSetCookie().map(v=>v.split(';')[0])].filter(Boolean).join('; ');
  }
  const r=await app.request('/api/auth/admin/gate/step-six',{token,cookie,method:'POST',body:{ticket,totpCode:'123456'}});
  assert.equal(r.body.security.ready,true);assert.equal(r.body.security.score,86);
  assert.equal(r.status,503);assert.equal(r.body.error,'ADMIN_TOTP_NOT_CONFIGURED');assert.equal(r.body.redirectTo,undefined);
  assert.equal([...app.db.records.keys()].filter(p=>p.startsWith('storeAdminSessions/')).length,0);
 }finally{await app.close();}
});
