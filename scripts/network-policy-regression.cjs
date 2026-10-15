'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { mockModule } = require('./helpers/memory-firestore.cjs');
const folder = fs.mkdtempSync(path.join(os.tmpdir(),'zentra-network-test-')), filename = path.join(folder,'test.mmdb');
fs.writeFileSync(filename,Buffer.alloc(128));
process.env.STORE_ANONYMOUS_IP_DB_PATH = filename;
process.env.STORE_TRUSTED_PROXY_CIDRS = '10.0.0.0/8';
process.env.STORE_NETWORK_DB_MAX_AGE_HOURS = '72';
mockModule('../../server/config/env',{ nodeEnv:'production' });
let row = null;
const reader = { metadata:{databaseType:'GeoIP-Anonymous-Plus',buildEpoch:new Date()}, get:()=>row };
const packagePath = require.resolve('maxmind');
require.cache[packagePath] = { id:packagePath,filename:packagePath,loaded:true,exports:{ open:async()=>reader } };
const network = require('../server/core/storeNetworkPolicy');
after(()=>fs.rmSync(folder,{recursive:true,force:true}));
test('real IP normalization merges IPv4-mapped IPv6, and rejects private, invalid and scoped addresses',()=>{
 assert.equal(network.normalizeIp('::ffff:8.8.8.8'),'8.8.8.8');
 assert.equal(network.normalizeIp('2001:4860:4860:0:0:0:0:8888'),network.normalizeIp('2001:4860:4860::8888'));
 for(const ip of ['127.0.0.1','10.0.0.1','192.168.1.1','::1','fe80::1%eth0','garbage','0.0.0.0']) assert.throws(()=>network.normalizeIp(ip),{code:'SECURITY_IP_UNAVAILABLE'});
});
test('VPN, Tor, hosting, public and residential proxies are all blocked by strict classification',async()=>{
 for(const field of ['is_anonymous','is_anonymous_vpn','is_hosting_provider','is_public_proxy','is_residential_proxy','is_tor_exit_node']) {
  row={[field]:true};const result=await network.checkNetwork('8.8.8.8');assert.equal(result.blocked,true);assert(result.categories.includes(field));
 }
 row=null;assert.equal((await network.checkNetwork('8.8.8.8')).blocked,false);
 row={is_anonymous_vpn:'false'};await assert.rejects(network.checkNetwork('8.8.8.8'),{code:'SECURITY_NETWORK_DB_INVALID'});row=null;
});
test('missing, stale, invalid and future-dated provider data never becomes an allow decision',async()=>{
 const original=process.env.STORE_ANONYMOUS_IP_DB_PATH;
 delete process.env.STORE_ANONYMOUS_IP_DB_PATH;await assert.rejects(network.checkNetwork('8.8.8.8'),{code:'SECURITY_NETWORK_UNCONFIGURED'});
 process.env.STORE_ANONYMOUS_IP_DB_PATH=original;
 reader.metadata.buildEpoch=new Date(Date.now()-73*3600000);await assert.rejects(network.checkNetwork('8.8.8.8'),{code:'SECURITY_NETWORK_DB_STALE'});
 reader.metadata.buildEpoch=new Date(Date.now()+3600000);await assert.rejects(network.checkNetwork('8.8.8.8'),{code:'SECURITY_NETWORK_DB_STALE'});
 reader.metadata.buildEpoch=new Date();reader.metadata.databaseType='GeoLite2-Country';await assert.rejects(network.checkNetwork('8.8.8.8'),{code:'SECURITY_NETWORK_DB_INVALID'});
 reader.metadata.databaseType='GeoIP-Anonymous-Plus';assert.equal((await network.networkReadiness()).ready,true);
});
test('production requires an explicit trusted proxy boundary and rejects trust-everything networks',async()=>{
 for(const value of ['', '0.0.0.0/0', '::/0', 'invalid']) {
  process.env.STORE_TRUSTED_PROXY_CIDRS=value;assert.equal(network.trustedProxySetting(),false);
  await assert.rejects(network.checkNetwork('8.8.8.8'),{code:'SECURITY_PROXY_UNCONFIGURED'});
 }
 process.env.STORE_TRUSTED_PROXY_CIDRS='10.0.0.0/8,127.0.0.1/32';assert.deepEqual(network.trustedProxySetting(),['10.0.0.0/8','127.0.0.1/32']);
});
test('IPv4-mapped IPv6 catch-all proxy ranges are rejected too',()=>{
 for(const range of ['::ffff:0.0.0.0/96','::ffff:8.8.8.8/95']) {process.env.STORE_TRUSTED_PROXY_CIDRS=range;assert.equal(network.trustedProxySetting(),false);}
 process.env.STORE_TRUSTED_PROXY_CIDRS='10.0.0.0/8';
});
test('Express ignores spoofed forwarding from an untrusted socket and stops at the nearest untrusted hop',async()=>{
 const express=require('express'),app=express();app.get('/',(req,res)=>res.json({ip:req.ip,ips:req.ips}));
 const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
 const url='http://127.0.0.1:'+server.address().port;
 try {
  process.env.STORE_TRUSTED_PROXY_CIDRS='10.0.0.0/8';app.set('trust proxy',network.trustedProxySetting());
  const direct=await(await fetch(url,{headers:{'x-forwarded-for':'1.1.1.1'}})).json();assert.equal(direct.ip,'127.0.0.1');assert.deepEqual(direct.ips,[]);
  process.env.STORE_TRUSTED_PROXY_CIDRS='127.0.0.1/32,10.0.0.0/8';app.set('trust proxy',network.trustedProxySetting());
  const proxied=await(await fetch(url,{headers:{'x-forwarded-for':'1.1.1.1, 8.8.8.8, 10.9.9.9'}})).json();assert.equal(proxied.ip,'8.8.8.8');assert.deepEqual(proxied.ips,['8.8.8.8','10.9.9.9']);
 } finally {await new Promise(resolve=>server.close(resolve));process.env.STORE_TRUSTED_PROXY_CIDRS='10.0.0.0/8';}
});
