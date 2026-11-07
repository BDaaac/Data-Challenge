// Run against tests/browser_server.py only; it blocks paid AI.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 const base=process.env.TEST_BASE_URL||'http://127.0.0.1:18001';
 const errors=[];
 try {
  for(const role of ['qa','op','lead','adm']){
   const context=await browser.newContext({viewport:{width:1365,height:900}});
   const page=await context.newPage();
   page.on('pageerror',e=>errors.push(role+': '+e.message));
   await page.goto(base);
   await page.locator('#dr').waitFor();
   const options=await page.locator('#dr option').evaluateAll(xs=>xs.map(x=>({role:x.dataset.role,value:x.value})));
   assert.deepEqual(new Set(options.map(x=>x.role)),new Set(['qa','op','lead','adm']));
   await page.selectOption('#dr',options.find(x=>x.role===role).value);
   await page.click('#dgo');
   await page.locator('#nav').waitFor();
   const routes=await page.locator('#nav a').evaluateAll(xs=>xs.map(x=>x.getAttribute('href')));
   for(const route of routes){
    await page.goto(base+'/'+route);
    await page.locator('#view').waitFor();
    await page.waitForFunction(()=>!document.querySelector('#view .loading'));
    assert.equal(await page.locator('#view > .note.bad').count(),0,role+' '+route+': '+await page.locator('#view').innerText());
   }
   await page.setViewportSize({width:390,height:844});
   await page.goto(base+'/#/'+({qa:'queue',op:'my',lead:'development',adm:'integrations'}[role]));
   await page.waitForFunction(()=>document.querySelector('#view')&&!document.querySelector('#view .loading'));
   await page.screenshot({path:'/tmp/freedom-'+role+'.png',fullPage:true});
   console.log('PASS browser role',role,routes.length,'routes, mobile render');
   await context.close();
  }
  assert.deepEqual(errors,[]);
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
