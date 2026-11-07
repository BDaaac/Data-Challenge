const {chromium} = require(process.env.PLAYWRIGHT_MODULE);
const assert = require('node:assert/strict');
const path = require('node:path');

(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.UX_CHROMIUM});
 try {
  const ctx=await browser.newContext({viewport:{width:1440,height:1000}}),base=process.env.CQA_BASE_URL||'http://127.0.0.1:8000';
  const users=(await ctx.request.get(base+'/api/auth/demo').then(r=>r.json())).users;
  await ctx.request.post(base+'/api/auth/demo/'+users.find(u=>u.role==='lead').id);
  const data=await ctx.request.get(base+'/api/lead/workspace').then(r=>r.json());
  assert(data.rows&&data.members);
  const p=await ctx.newPage();p.setDefaultTimeout(15000);
  const errors=[];p.on('pageerror',e=>errors.push(e.message));
  await ctx.route('**/api/**',r=>['GET','HEAD'].includes(r.request().method())?r.continue():r.abort());
  const name=data.members[0].name;
  const routes=['home','group','team','employee/'+encodeURIComponent(name),'dialogs','appeals','qa-control','coaching/'+encodeURIComponent(new URLSearchParams({kind:'feedback',operator:name}).toString())];
  if(data.rows.length)routes.push('dialog/'+encodeURIComponent(data.rows[0].id));
  for(const route of routes){
   await p.goto(base+'/#/'+route);
   await p.waitForFunction(()=>document.querySelector('#view')?.textContent.trim()&&!document.querySelector('#view>.loading'));
   assert.equal(await p.locator('#view>.note.bad').count(),0,route+' API failure');
   for(const width of [1440,390]){
    await p.setViewportSize({width,height:1000});
    assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),route+' overflow '+width);
    if(['home','group','team','qa-control'].includes(route)||route.startsWith('employee/')||route.startsWith('coaching/'))await p.screenshot({path:path.join(process.env.TEMP,`lead-${route.split('/')[0]}-${width}.png`),fullPage:true});
   }
  }
  await p.goto(base+'/#/dialogs');await p.waitForSelector('#lead-language');
  await p.selectOption('#op-period','all');
  await p.selectOption('#lead-language','KZ');
  assert((await p.locator('tbody tr .sub').allTextContents()).every(t=>t.includes('KZ')));
  await p.goto(base+'/#/team');await p.waitForSelector('#lead-search');await p.fill('#lead-search',name);
  assert((await p.locator('.lead-team tbody tr').allTextContents()).every(t=>t.includes(name)));
  await p.locator('.lead-team tbody .btn').first().click();await p.waitForSelector('.lead-employee-head');
  await p.getByRole('link',{name:'Добавить обратную связь'}).click();await p.waitForSelector('#lead-plan-form');
  let saved=null;
  await ctx.route('**/api/lead/plans',r=>{saved=r.request().postDataJSON();return r.fulfill({json:{id:999,...saved}});});
  await p.fill('[name=title]','Уточнять цель обращения');await p.fill('[name=note]','Разобрать два примера');await p.fill('[name=expected_result]','В пяти диалогах уточняет цель');await p.selectOption('[name=priority]','high');await p.fill('[name=due]','2026-12-01');
  await p.click('#lead-plan-form [type=submit]');await p.waitForSelector('.lead-employee-head');
  assert.equal(saved.operator,name);assert.equal(saved.kind,'feedback');assert.equal(saved.due,'2026-12-01');assert.equal(saved.priority,'high');assert.equal(saved.expected_result,'В пяти диалогах уточняет цель');
  if(data.rows.length){
   const d=data.rows[0],appeal={id:800,dialog_id:d.id,operator_name:d.operator,status:'open',created_at:new Date().toISOString(),items:[{crit:'c2'}],text:'Клиент уточнил цель обращения в начале разговора',score_before:76,score_after:null,evaluation:{checklist:{criteria:[{id:'c2',name:'Выявление потребности'}]}}};
   await ctx.route('**/api/appeals',r=>r.fulfill({json:[appeal]}));
   await ctx.route('**/api/appeals/800',r=>r.fulfill({json:appeal}));
   await p.goto(base+'/#/appeals/800');await p.waitForSelector('.lead-case');
   assert((await p.locator('.lead-case').innerText()).includes(appeal.text));
   assert.equal(await p.getByRole('button',{name:/Принять|Отклонить/}).count(),0);
   await p.selectOption('#lead-ap-status','rejected');await p.waitForFunction(()=>!document.querySelector('.lead-case'));
   assert((await p.locator('.lead-appeals').innerText()).includes('Апелляций нет'));
  }
  assert.deepEqual(errors,[]);
  console.log('PASS nine lead screens at desktop/mobile, language/search filters, employee navigation, feedback payload and appeal detail/filter (mocked writes/appeals)');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
