'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {browserModule}=require('./helpers/browser-module.cjs');
const modulePromise=browserModule('public/js/store/shopier-availability.js');
const ready={payments:{shopier:{status:'ready',available:true,topupAvailable:true}}};
test('Shopier status normalizer is fail-closed for malformed, unknown or contradictory status',async()=>{
 const {normalizeShopierAvailability:n}=await modulePromise;
 for(const v of [null,[],'ready',1,{}])assert.equal(n(v).available,false);
 assert.equal(n({available:true}).status,'ready');
 for(const status of ['disabled','unavailable','maintenance','unknown']){const r=n({status,available:true,topupAvailable:true});assert.equal(r.available,false);assert.equal(r.topupAvailable,false);}
});
test('untrusted catalog cannot widen wallet topup limits',async()=>{
 const {normalizeShopierAvailability:n}=await modulePromise;assert.deepEqual(n({topupLimits:{minKurus:1,maxKurus:999999999}}).topupLimits,{minKurus:10000,maxKurus:1000000});
});
test('parallel availability reads share a request and loading state',async()=>{
 const {createShopierAvailabilityRefresh:create}=await modulePromise;let resolve,calls=0,updates=0;const loading=[];
 const refresh=create({load:()=>{calls++;return new Promise(done=>{resolve=done;});},onUpdate:()=>updates++,onLoading:v=>loading.push(v)});
 const a=refresh(),b=refresh({force:true});assert.equal(a,b);await Promise.resolve();resolve(ready);await a;
 assert.equal(calls,1);assert.equal(updates,1);assert.deepEqual(loading,[true,false]);
});
test('view refresh TTL never prevents a manual forced status read',async()=>{
 const {createShopierAvailabilityRefresh:create}=await modulePromise;let time=1,calls=0;
 const refresh=create({load:async()=>{calls++;return ready;},onUpdate(){},now:()=>time});await refresh();await refresh();assert.equal(calls,1);
 await refresh({force:true});assert.equal(calls,2);time+=15001;await refresh();assert.equal(calls,3);
});
test('connection failure disables payment and allows an immediate safe read retry',async()=>{
 const {createShopierAvailabilityRefresh:create}=await modulePromise;let broken=true,last;
 const refresh=create({load:async()=>{if(broken)throw new TypeError('network');return ready;},onUpdate:v=>{last=v;}});
 await refresh();assert.equal(last.status,'unavailable');assert.equal(last.topupAvailable,false);broken=false;await refresh();assert.equal(last.status,'ready');
});
test('stale cached catalog cannot keep payment capabilities enabled',async()=>{
 const {createShopierAvailabilityRefresh:create}=await modulePromise;let last;
 const refresh=create({load:async()=>({...ready,stale:true}),onUpdate:v=>{last=v;}});await refresh();assert.equal(last.status,'unavailable');assert.equal(last.available,false);
});
test('notices distinguish checking, connection error, disabled and maintenance without secrets',async()=>{
 const {shopierUnavailableMessage:m}=await modulePromise;
 assert.match(m({status:'disabled'},{topup:true}),/kapalı/);assert.match(m({status:'unavailable'}),/doğrulanamadı/);assert.match(m({status:'maintenance'}),/bakımda/);assert.match(m({},{checking:true}),/kontrol ediliyor/);
 for(const status of ['disabled','unavailable','maintenance'])assert.doesNotMatch(m({status}),/ENV|TOKEN|PAT|Render/);
});
test('foreground refresh can apply changed server capability within the ordinary TTL',async()=>{
 const {createShopierAvailabilityRefresh:create}=await modulePromise;let catalog=ready,last;
 const refresh=create({load:async()=>catalog,onUpdate:v=>{last=v;}});await refresh();catalog={payments:{shopier:{status:'disabled'}}};await refresh({force:true});assert.equal(last.topupAvailable,false);
});
