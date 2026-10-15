'use strict';
const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const {applicationFixture}=require('./helpers/application-fixture.cjs');
const email='o6emirv2@gmail.com';let f;
before(async()=>{f=await applicationFixture({ownerEmail:email});});
after(async()=>f?.close());
beforeEach(()=>{f.resetLimits();f.networkState.blocked=false;f.networkState.unavailable=false;});
const login=(identifier=email)=>f.request('/api/auth/login',{method:'POST',body:{identifier,password:f.password},deviceProof:false});
test('only the verified and UID-pinned owner receives the administrator network exemption',async()=>{
 f.networkState.blocked=true;f.networkState.unavailable=true;
 const result=await login();assert.equal(result.status,200);assert.equal(result.body.accountSecurity.exempt,true);assert.equal(result.body.accountSecurity.uid,'owneruid');
 const session=await f.request('/api/auth/session',{method:'POST',deviceProof:false,body:{idToken:f.idToken('owneruid'),remember:false}});
 assert.equal(session.status,200);assert.equal(session.body.accountSecurity.exempt,true);
 const account=await f.request('/api/store/account',{uid:'owneruid',deviceProof:false});assert.equal(account.status,200);assert.equal(account.body.account.security.exempt,true);
 assert.equal(f.db.records.get('users/owneruid').storeRegistrationSecurity.kind,'admin_exemption');
 assert.equal([...f.db.records.keys()].filter(path=>path.startsWith('storeRegistrationIps/')).length,0);
});
test('exempt owner financial requests still use normal prices, fees, balances and idempotency',async()=>{
 f.networkState.ip='8.8.4.40';assert.equal((await f.request('/api/store/account',{uid:'member'})).status,200);
 f.db.records.get('users/owneruid').storeBalanceKurus=10000;const balance=f.db.records.get('users/member').storeBalanceKurus;
 f.networkState.unavailable=true;f.networkState.blocked=true;
 const body={recipientUsername:'EmirHan',recipientUid:'member',amountKurus:10000,idempotencyKey:'exempt-owner-transfer-0001'};
 const result=await f.request('/api/store/transfers',{uid:'owneruid',method:'POST',body,deviceProof:false});
 assert.equal(result.status,201,JSON.stringify(result.body));assert.equal(result.body.transfer.feeKurus,7500);assert.equal(result.body.transfer.netKurus,2500);
 assert.equal(f.db.records.get('users/owneruid').storeBalanceKurus,0);assert.equal(f.db.records.get('users/member').storeBalanceKurus,balance+2500);
 assert.equal((await f.request('/api/store/transfers',{uid:'owneruid',method:'POST',body,deviceProof:false})).body.idempotentReplay,true);
});
test('ordinary accounts can sign in during classifier failure, but cannot start financial writes',async()=>{
 f.networkState.unavailable=true;
 const result=await login('member@zentra.invalid');assert.equal(result.status,200);assert.equal(result.body.accountSecurity.exempt,false);
 assert.equal((await f.request('/api/auth/session',{method:'POST',deviceProof:false,body:{idToken:f.idToken('member'),remember:false}})).status,200);
 const account=await f.request('/api/store/account',{uid:'member'});assert.equal(account.status,200);assert.equal(account.body.account.security.limited,true);
 const money=await f.request('/api/store/transfers/preview',{uid:'member',method:'POST',body:{recipientUsername:'ShopOwner',amountKurus:100}});
 assert.equal(money.status,503);assert.equal(money.body.error,'SECURITY_NETWORK_UNAVAILABLE');
});
test('read-only account recovery cannot settle debt or change a stored wallet balance',async()=>{
 const row=f.db.records.get('users/member');row.storeBalanceKurus=10000;row.storeAffiliateDebtKurus=1000;
 const result=await f.request('/api/store/account',{uid:'member',deviceProof:false});assert.equal(result.status,200);assert.equal(result.body.account.security.limited,true);
 assert.equal(row.storeBalanceKurus,10000);assert.equal(row.storeAffiliateDebtKurus,1000);
 assert.equal(f.db.records.get('users/member').storeBalanceKurus,10000);assert.equal(f.db.records.get('users/member').storeAffiliateDebtKurus,1000);
});
test('request headers and profile email cannot grant another UID the administrator exemption',async()=>{
 f.db.records.get('users/member').email=email;
 const result=await f.request('/api/store/transfers/preview',{uid:'member',method:'POST',body:{recipientUsername:'ShopOwner',amountKurus:100},deviceProof:false,headers:{'x-admin-email':email,'x-account-security-exempt':'true'}});
 assert.equal(result.status,403);assert.equal(result.body.error,'SECURITY_DEVICE_REQUIRED');
});
test('stale token email and unverified identities do not satisfy the administrator exception',async()=>{
 const owner=f.users.get('owneruid'),token=f.idToken('owneruid');owner.email='changed@zentra.invalid';
 try {
  const result=await f.request('/api/store/transfers/preview',{token,method:'POST',body:{recipientUsername:'EmirHan',amountKurus:100},deviceProof:false});assert.equal(result.status,403);assert.equal(result.body.error,'SECURITY_DEVICE_REQUIRED');
 } finally {owner.email=email;}
 owner.emailVerified=false;
 try {const result=await login();assert.equal(result.status,200);assert.equal(result.body.accountSecurity.exempt,false);}finally{owner.emailVerified=true;}
});
test('a deliberate account suspension remains effective for the configured administrator',async()=>{
 const row=f.db.records.get('users/owneruid');row.storeSecurity={...row.storeSecurity,state:'blocked'};
 try {const result=await login();assert.equal(result.status,403);assert.equal(result.body.error,'SECURITY_ACCOUNT_BLOCKED');}
 finally {row.storeSecurity.state='active';}
});
