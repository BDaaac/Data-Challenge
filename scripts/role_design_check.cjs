const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.UX_CHROMIUM});
 const base=process.env.CQA_BASE_URL||'http://127.0.0.1:8000';
 const users=(await fetch(base+'/api/auth/demo').then(r=>r.json())).users;
 const routes={op:['home','my','appeals','rules','development'],lead:['home','group','team','dialogs','appeals','qa-control','development'],adm:['home','users','settings','upload','dialogs','audit','integrations'],qa:['home','dialogs','checklists','appeals','queue']};
 const results=[];
 try {for(const [role,pages] of Object.entries(routes)){
 if(process.env.ROLE_CHECK_ONLY&&!process.env.ROLE_CHECK_ONLY.split(',').includes(role))continue;
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}});
 await ctx.route('**/api/**',r=>{
  const q=r.request();
  if(!['GET','HEAD'].includes(q.method())&&!q.url().includes('/auth/demo/')) return r.abort('blockedbyclient');
  return r.continue();
 });
 const errors=[];const flows=[];const p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));
 await ctx.request.post(base+'/api/auth/demo/'+users.find(u=>u.role===role).id,{data:{}});
 await p.goto(base);
 for(const route of pages){
  await p.evaluate(r=>location.hash='#/'+r,route);
  await p.waitForFunction(r=>{const e=document.querySelector('#view');return e?.dataset.page===r&&!e.querySelector('.loading')&&e.textContent.trim().length>0},route);
  await p.waitForTimeout(100);
  assert.equal(await p.locator('#view>.note.bad').count(),0,role+'/'+route+' view failed');
  assert.equal(await p.locator('.side').isVisible(),false);
  for(const width of [1440,390]){
   await p.setViewportSize({width,height:1000});
   const excess=await p.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
   if(excess>1)errors.push(`${route}@${width}: document overflow ${excess}`);
  }
  await p.setViewportSize({width:1440,height:1000});
  if(role==='qa'&&route==='checklists'){
   await p.locator('.qa-checklist-label a').first().click();await p.waitForSelector('button[data-open]');await p.locator('button[data-open]').first().click();await p.waitForSelector('button[data-open][aria-expanded="true"]');flows.push('published checklist rule expands');
   await p.evaluate(()=>location.hash='#/checklists');await p.waitForSelector('.qa-checklist-label');
  }
  if(role==='adm'&&route==='users'){await p.click('#add');await p.waitForSelector('#uf');await p.fill('#un','Проверка формы');await p.click('#ucancel');await p.waitForSelector('#uf',{state:'detached'});assert.equal(await p.locator('#uf').count(),0);flows.push('user form opens and cancels');}
  if(role==='qa'&&route==='violations'&&await p.locator('[data-row]').count()){await p.locator('[data-row]').first().click();await p.waitForSelector('#vn');await p.fill('#vn','Проверка черновика');assert(await p.locator('[data-vs="closed"]').isVisible());flows.push('incident resolution draft');}
  if(role==='lead'&&route==='team'&&await p.locator('[data-coach-op]').count()){await p.locator('[data-coach-op]').first().click();await p.waitForFunction(()=>document.querySelector('#view')?.dataset.page==='dialogs'&&!document.querySelector('#view .loading'));flows.push('team coaching opens filtered dialogs');await p.evaluate(()=>location.hash='#/team');await p.waitForSelector('[data-op]');}
  if(['home','settings','my','dashboard','team','upload'].includes(route))await p.screenshot({path:path.join(process.env.TEMP,`role-${role}-${route}.png`)});
 }
 if(['op','lead','adm'].includes(role)){
  const rows=await ctx.request.get(base+'/api/dialogs').then(r=>r.json());
  if(rows.length){await p.evaluate(id=>location.hash='#/dialog/'+id,rows[0].id);await p.waitForSelector('.qa-dialog-title');assert(await p.locator('.qa-total').isVisible());await p.screenshot({path:path.join(process.env.TEMP,`role-${role}-dialog.png`)});
   if(role==='op'&&await p.locator('[data-start-appeal]').count()){
    assert.equal(await p.locator('#qa-nav [aria-current]').getAttribute('href'),'#/my');
    await p.click('[data-start-appeal]');await p.waitForSelector('#op-appeal-form');await p.fill('#op-reason','Проверка формы без отправки');
    await p.setViewportSize({width:390,height:1000});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    await p.screenshot({path:path.join(process.env.TEMP,'role-op-appeal-mobile.png')});flows.push('operator appeal form');
   }

}
 }
 results.push({role,pages:pages.length,flows,errors});await ctx.close();
 }}finally{await browser.close()}
 console.log(JSON.stringify(results,null,2));
 if(results.some(r=>r.errors.length))process.exitCode=1;
})();
