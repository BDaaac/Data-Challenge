// Mutating UX checks: run ONLY against the disposable UX server, never the demo DB.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = process.env.UX_TEST_URL;
assert.match(base || '', /^http:\/\/127\.0\.0\.1:\d+$/, 'Use a local isolated UX server');

(async () => {
  const isolation = await fetch(base + '/api/ux-isolation').then(r => r.json());
  assert.equal(isolation.schema, 'cqa_ux_review_20261107');
  assert.equal(isolation.paidCallsBlocked, true);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UX_CHROMIUM });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], passed = [];
  page.on('pageerror', e => errors.push(e.message));
  const go = async route => {
    await page.evaluate(route => { location.hash = '#/' + route; }, route);
    await page.waitForFunction(v => {
      const e = document.querySelector('#view');
      return e?.dataset.page === v && !e.querySelector('.loading');
    }, route.split('/')[0]);
  };
  const get = path => page.evaluate(path => fetch('/api' + path).then(r => r.json()), path);
  try {
    await page.goto(base);
    await page.waitForSelector('[data-demo]');
    const users = (await get('/auth/demo')).users;
    await page.click('[data-demo="' + users.find(u => u.role === 'qa').id + '"]');
    await page.waitForSelector('.workspace');
    const role = async r => {
      await page.selectOption('#demo-role', String(users.find(u => u.role === r).id));
      await page.waitForFunction(r => document.querySelector('#view')?.dataset.role === r, r);
      await go('home');
      await page.waitForSelector('.workspace[data-role="' + r + '"]');
    };

    // QA: review -> saved correction -> publication -> explicit next step.
    await go('queue');
    await page.waitForSelector('[data-open]');
    const review = (await get('/queue')).find(d => d.wf_status === 'review');
    await page.locator('[data-open="' + review.id + '"]').click();
    await page.waitForSelector('[data-sel="c1"]');
    await page.click('[data-sel="c1"]');
    const before = await get('/dialogs/' + review.id);
    const next = before.evaluation.items.c1.answer === 'yes' ? 'no' : 'yes';
    await page.click('[data-set="c1"][data-o="' + next + '"]');
    await page.fill('[data-rs="c1"]', 'Тест UX: проверено объяснение и реплика.');
    await page.click('[data-apply="c1"]');
    await page.waitForSelector('.flow-result');
    assert.equal((await get('/dialogs/' + review.id)).evaluation.items.c1.answer, next);
    await page.click('[data-confirm]');
    await page.waitForFunction(() => document.querySelector('.flow-result')?.textContent.includes('Оценка опубликована'));
    assert.equal((await get('/dialogs/' + review.id)).dialog.wf_status, 'published');
    passed.push('QA: correction, publication, visible completion');

    // Operator: acknowledgement does not remove the right to appeal.
    await role('op');
    const own = (await get('/dialogs')).find(d => d.wf_status === 'published');
    assert.ok(own, 'Need a published operator fixture');
    await go('my');
    await page.locator('[data-open="' + own.id + '"]').click();
    await page.waitForSelector('[data-ack]');
    await page.click('[data-ack]');
    await page.waitForSelector('[data-start-appeal]');
    await page.click('[data-start-appeal]');
    await page.locator('.ox-q.sel [data-want]').first().click();
    await page.waitForSelector('#aptext');
    const reasonBox = await page.locator('#aptext').boundingBox();
    assert.ok(reasonBox.y >= 0 && reasonBox.y < 1000, 'Appeal reason must be brought into view');
    await page.fill('#aptext', 'Прошу пересмотреть пункт: в разговоре есть подтверждающая реплика. Тест UX.');
    const sent = page.waitForResponse(r => r.url().endsWith('/appeal') && r.request().method() === 'POST');
    await page.click('[data-apsend]');
    const appeal = await (await sent).json(); assert.ok(appeal.id);
    await page.waitForSelector('.flow-result a[href="#/appeals/' + appeal.id + '"]');
    await page.locator('.flow-result a').click();
    await page.waitForSelector('#view[data-page="appeals"] .ph');
    passed.push('Operator: acknowledgement, appeal, tracking');

    // QA resolves the actual appeal created by the operator.
    await role('qa'); await go('appeals/' + appeal.id);
    await page.waitForSelector('[data-d]');
    assert.ok(await page.locator('#dec').isDisabled(), 'Incomplete decision is disabled');
    await page.locator('[data-d][data-v="1"]').first().click();
    await page.fill('#cm', 'Довод принят после проверки контекста. Тест UX.');
    await page.click('#dec');
    await page.waitForFunction(() => !document.querySelector('#dec'));
    assert.equal((await get('/appeals/' + appeal.id)).status, 'accepted');
    passed.push('QA: appeal acceptance and final resolution');
    await role('op'); await go('appeals/' + appeal.id);
    assert.ok((await page.locator('#view').textContent()).includes('Принято'));
    passed.push('Operator: reads resolved appeal');

    // Team lead follows the actual coaching link, then returns to the team.
    await role('lead'); await go('team');
    await page.waitForSelector('[data-coach-op]');
    await page.locator('[data-coach-op]').first().click();
    await page.waitForSelector('.list-context');
    await page.locator('#view [data-open]').first().click();
    await page.waitForSelector('.dc-ws');
    assert.equal(await page.locator('[data-set]').count(), 0);
    await page.locator('.back-link').click(); await page.waitForSelector('#view[data-page="team"]');
    passed.push('Team lead: employee, examples, read-only review, return');

    // Compliance opens the exact incident, changes state, checks closure.
    await role('comp');
    const incident = (await get('/violations?status=open')).rows[0]; assert.ok(incident);
    await go('violations/' + incident.id); await page.waitForSelector('#vn');
    const inspect = page.locator('a[href="#/dialog/' + incident.id + '"]').first();
    await inspect.click(); await page.waitForSelector('.dc-ws');
    await page.locator('a[href="#/violations/' + incident.id + '"]').click();
    await page.waitForSelector('#vn');
    if (await page.locator('[data-vs="work"]').count()) {
      await page.click('[data-vs="work"]');
      await page.waitForFunction(() => !document.querySelector('#vn'));
      await page.locator('[data-row="' + incident.id + '"]').click();
    }
    await page.fill('#vn', 'Контекст проверен, решение и меры зафиксированы. Тест UX.');
    await page.click('[data-vs="closed"]');
    await page.waitForFunction(() => !document.querySelector('#vn'));
    assert.ok((await get('/violations?status=closed')).rows.some(d => d.id === incident.id));
    passed.push('Compliance: exact case, context, in progress, closure');

    // Head: draft -> weight-only change -> publication -> rescore without LLM.
    await role('head'); await go('checklists');
    await page.click('#nd'); await page.waitForSelector('[data-w="0"]');
    const w0 = Number(await page.locator('[data-w="0"]').inputValue());
    const w1 = Number(await page.locator('[data-w="1"]').inputValue());
    await page.fill('[data-w="0"]', String(w0 + 1));
    await page.fill('[data-w="1"]', String(w1 - 1));
    await page.click('#save'); await page.waitForSelector('#pub:not([disabled])');
    await page.fill('#note', 'Тест UX: перераспределены веса, смысл критериев не менялся.');
    await page.click('#pub'); await page.waitForSelector('#apply');
    await page.click('#apply'); await page.waitForSelector('#view[data-page="jobs"]');
    await page.waitForFunction(() => !document.querySelector('#view .pill.pulse'), null, {timeout:30000});
    const jobId = new URL(page.url()).hash.split('/').pop();
    const job = await get('/jobs/' + jobId);
    assert.ok(job.evaluations.every(e => e.calls === 0));
    passed.push('QA head: version draft, weight edit, publication, zero-call recalculation');

    await role('dir'); await go('dashboard');
    await page.waitForSelector('[data-l]'); await page.locator('[data-l]').first().click();
    const example = page.locator('#view a[href^="#/dialog/"]').first();
    if (await example.count()) { await example.click(); await page.waitForSelector('.dc-ws'); assert.equal(await page.locator('[data-set]').count(), 0); }
    await go('violations'); await page.waitForSelector('#view[data-page="violations"] .ph');
    passed.push('Director: analytics, evidence, read-only risks');

    // Admin creates a fixture user, saves settings, and imports without evaluating.
    await role('adm'); await go('users'); await page.click('#add');
    await page.fill('#ul', 'ux_review_' + Date.now()); await page.fill('#un', 'Тестовый сотрудник UX');
    await page.selectOption('#ur', 'op');
    await page.locator('#uf button[type="submit"]').click();
    await page.waitForSelector('.sc-strip.ok');
    await go('settings'); await page.waitForSelector('#save');
    await page.click('#save');
    await go('upload'); await page.waitForSelector('#fi', {state:'attached'});
    assert.equal(await page.locator('#ev').isChecked(), false);
    await page.locator('#fi').setInputFiles({name:'ux-fixture.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify([{conversation_id:'ux-review-'+Date.now(),channel:'agent chat',language:'RU',transcript:[{speaker:'client',timestamp:'10:00',text:'Здравствуйте, где посмотреть тарифы?'},{speaker:'operator',timestamp:'10:01',text:'Здравствуйте. Тарифы доступны на сайте.'}]}]))});
    await page.waitForSelector('.dc-ws'); assert.ok(await page.locator('[data-eval]').count());
    await go('audit'); await page.waitForSelector('#view[data-page="audit"] table');
    passed.push('Admin: user creation, settings, import without model call, audit');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({passed,jsErrors:errors}, null, 2));
  } catch (e) {
    console.log(JSON.stringify({passed,jsErrors:errors,failed:e.message}, null, 2));
    process.exitCode=1;
  } finally { await browser.close(); }
})();
