'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const {applicationFixture}=require('./helpers/application-fixture.cjs');
const firebaseSdk=require('./helpers/browser-firebase.cjs');
const output=path.resolve(process.env.ADMIN_BROWSER_OUTPUT||'test-results/admin');
async function main(){
 fs.mkdirSync(output,{recursive:true});let app,browser;const errors=[],cases=[],contexts=[],pages=[];
 try{
  app=await applicationFixture();
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{channel:'chrome'}),args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'],env:{...process.env,...(process.env.CHROMIUM_LIBRARY_PATH?{LD_LIBRARY_PATH:process.env.CHROMIUM_LIBRARY_PATH}:{})}});
  async function context(uid,mobile=false){
   const {publicLimiter,apiLimiter}=require('../server/core/security');await publicLimiter.resetKey('127.0.0.1');await apiLimiter.resetKey('127.0.0.1');
   const ctx=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1050},reducedMotion:'reduce',...(mobile?{isMobile:true,hasTouch:true,deviceScaleFactor:2}:{})});
   await ctx.route('https://www.gstatic.com/firebasejs/**',route=>route.fulfill({contentType:'text/javascript',headers:{'access-control-allow-origin':'*'},body:firebaseSdk}));
   await ctx.addInitScript(value=>{globalThis.__qaIdentity=value.identity;globalThis.__qaPassword=value.password;},{identity:{uid,email:app.users.get(uid).email,token:app.idToken(uid)},password:app.password});
   ctx.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));contexts.push(ctx);const page=await ctx.newPage();page.setDefaultTimeout(15000);pages.push(page);return {ctx,page};
  }
  async function gate(page,name){
   await page.goto(app.origin+'/admin/index.html',{waitUntil:'domcontentloaded'});await page.locator('.gate-step[data-step="3"]').waitFor({state:'visible'});
   assert.equal(await page.locator('#stepTrack span').count(),6);
   await page.locator('#firebasePassword').fill(app.password);await page.locator('#firebasePasswordForm button[type=submit]').click();
   await page.locator('#fourthFactor').fill(app.four);await page.locator('#fourthFactorForm button[type=submit]').click();
   await page.locator('#fifthFactor').fill(app.five);await page.locator('#fifthFactorForm button[type=submit]').click();
   await page.locator('.gate-step[data-step="6"]').waitFor({state:'visible'});assert.equal(await page.locator('#adminTotpCode').isVisible(),true);assert.equal(await page.locator('#fifthFactor').isVisible(),false);assert.equal(await page.locator('#adminDashboardRoot').count(),0);
   const layout=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth}));assert(layout.width<=layout.viewport+1);
   await page.screenshot({path:path.join(output,name+'-google-step.png'),fullPage:true});
   await page.locator('#adminTotpCode').fill(app.totp());await page.locator('#sixthFactorForm button[type=submit]').click();await page.locator('[data-panel="products"]').first().waitFor({state:'visible'});
   cases.push({name:name+'-six-step-gate',separateTOTP:true,noAccessBeforeSixth:true,layout});
  }
  async function approve(page){await page.locator('#reauthLayer').waitFor({state:'visible'});await page.locator('#reauthPassword').fill(app.password);await page.locator('#reauthForm button[type=submit]').click();}
  async function panel(page,name){await page.locator(`[data-panel="${name}"]`).first().click();await page.locator(`[data-admin-panel="${name}"]`).waitFor({state:'visible'});}
  async function role(page,uid,value){
   await panel(page,'staff');await page.locator('#staffUid').fill(uid);await page.locator('#staffEmail').fill(app.users.get(uid).email);await page.locator('#staffRole').selectOption(value);
   const r=page.waitForResponse(r=>r.url().endsWith('/api/admin/store/staff/'+uid)&&r.request().method()==='PUT');
   await page.locator('#staffForm button[type=submit]').click();await approve(page);assert.equal((await r).status(),200);
   await page.waitForFunction(({uid,value})=>document.querySelector(`[data-edit-staff="${uid}"]`)?.parentElement.textContent.includes(value==='admin'?'TAM YETKİLİ':value.toLocaleUpperCase('tr-TR')),{uid,value});
  }
  async function product(page,id,expected,mobile=false){
   await panel(page,'products');await page.locator('#openProductCreate').click();const form=page.locator('#productCreateForm');await form.waitFor({state:'visible'});
   await form.locator('[name="id"]').fill(id);await form.locator('[name="name"]').fill('MAGİC');await form.locator('[name="categoryPreset"]').selectOption('oxide-android');await form.locator('[name="description"]').fill('Oxide Android ürünü için test açıklaması.');
   await form.locator('[name="key"]').fill('GÜNLÜK');await form.locator('[name="label"]').fill('Günlük');await form.locator('[name="duration"]').fill('24 Saat');await form.locator('[name="price"]').fill('250');
   await form.locator('[name="id"]').blur();assert.equal(await form.locator('[name="id"]').inputValue(),expected);assert.equal(await form.locator('[name="id"]').evaluate(n=>n.validity.patternMismatch),false);
   await form.locator('[name="id"]').fill('bad/id');let sent=0;const count=r=>{if(r.method()==='POST'&&r.url().endsWith('/api/admin/store/products'))sent++;};page.on('request',count);
   await page.locator('#productCreateSubmit').click();await form.locator('[name="id"][aria-invalid="true"]').waitFor();assert.equal(sent,0);
   await form.locator('[name="id"]').fill(expected);await form.locator('[name="description"]').click();
   const clear=await form.evaluate(n=>({field:n.querySelector('[name="description"]').getBoundingClientRect().bottom,actions:n.querySelector('.reauth-actions').getBoundingClientRect().top}));assert(clear.field<=clear.actions+1,'Focused field must stay clear of submit actions');
   await form.locator('.product-create-body').evaluate(n=>{n.scrollTop=0;});await form.screenshot({path:path.join(output,(mobile?'mobile':'desktop')+'-product-form.png')});
   const r=page.waitForResponse(r=>r.url().endsWith('/api/admin/store/products')&&r.request().method()==='POST');await page.locator('#productCreateSubmit').click();await approve(page);
   const saved=await r,data=await saved.json();assert.equal(saved.status(),201,JSON.stringify(data));assert.equal(data.product.id,expected);assert.equal(data.product.name,'MAGİC');assert.equal(data.product.platform,'android');assert.equal(data.product.plans[0].key,'gunluk');
   await form.waitFor({state:'hidden'});assert.equal(app.db.records.get('storefrontSettings/main').catalog.customProducts[expected].id,expected);assert.equal(sent,1);page.off('request',count);
   const layout=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth}));assert(layout.width<=layout.viewport+1);
   cases.push({name:(mobile?'mobile':'desktop')+'-product-creation',exactScreenshotKey:!mobile,TurkishKeyCanonicalized:mobile,invalidKeyBlockedBeforePOST:true,persisted:true,focusedFieldClearOfActions:true,normalizedPlanKey:true,layout});
  }
  const owner=await context('owneruid');await gate(owner.page,'desktop');await product(owner.page,'oxide-android-magic-yeni','oxide-android-magic-yeni');
  await role(owner.page,'member','admin');assert.equal(app.db.records.get('adminUsers/member').role,'admin');assert.equal(await owner.page.locator('[data-edit-staff="owneruid"]').count(),0);cases.push({name:'owner-role-grant',fullAdminOption:true,passwordProofRequired:true,ownerImmutable:true});
  const delegated=await context('member',true);await gate(delegated.page,'mobile');for(const name of ['orders','inventory','products','users','wallet','content','links','coupons','staff','audit','security'])assert.equal(await delegated.page.locator(`[data-panel="${name}"]`).first().isVisible(),true,name);
  await product(delegated.page,'OXİDE–ANDROİD–MAGİC–MOBİL','oxide-android-magic-mobil',true);await role(delegated.page,'viewer','support');
  await delegated.page.locator('[data-edit-staff="viewer"]').click();assert.equal(await delegated.page.locator('#staffUid').inputValue(),'viewer');assert.equal(await delegated.page.locator('#staffRole').inputValue(),'support');await delegated.page.screenshot({path:path.join(output,'mobile-full-authority-staff.png'),fullPage:true});cases.push({name:'delegated-full-authority',allAdminPanels:true,canManageStaff:true,existingRoleEditable:true});
  await role(owner.page,'member','viewer');await delegated.page.reload({waitUntil:'domcontentloaded'});await delegated.page.waitForFunction(()=>!document.querySelector('[data-panel="staff"]')||document.querySelector('[data-panel="staff"]').hidden);cases.push({name:'role-revocation',existingBrowserSessionRejected:true});
  assert.deepEqual(errors,[]);const results={passed:cases.length,failed:0,pageErrors:errors,livePayments:0,liveRefunds:0,cases};fs.writeFileSync(path.join(output,'browser-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
 }catch(error){for(let i=0;i<pages.length;i++)await pages[i].screenshot({path:path.join(output,`failure-${i}.png`),fullPage:true}).catch(()=>{});throw error;}
 finally{for(const ctx of contexts)await ctx.close().catch(()=>{});if(browser)await browser.close();if(app)await app.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
