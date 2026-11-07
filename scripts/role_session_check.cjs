const {chromium} = require(process.env.PLAYWRIGHT_MODULE);
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.UX_CHROMIUM});
  const base = process.env.CQA_BASE_URL || 'http://127.0.0.1:8000';
  try {
    for (const role of ['head', 'dir', 'comp', 'unknown', null, 'constructor']) {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/api/auth/me', r => r.fulfill({json:{role}}));
      await page.goto(base + '/#/dashboard');
      await page.waitForSelector('.entry-role');
      assert.equal(await page.locator('.entry-role').count(), 4);
      assert.equal(new URL(page.url()).hash, '#/');
      assert.deepEqual(errors, [], String(role));
      await context.close();
    }

    // A stale server response while switching roles must also return to login.
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const users = (await context.request.get(base + '/api/auth/demo').then(r => r.json())).users;
    await context.request.post(base + '/api/auth/demo/' + users.find(u => u.role === 'qa').id);
    await page.goto(base + '/#/home');
    await page.waitForSelector('#who');
    await page.route('**/api/auth/demo/*', r => r.fulfill({json:{ok:true}}));
    await page.route('**/api/auth/me', r => r.fulfill({json:{role:'head'}}));
    await page.click('#who');
    await page.locator('[data-sw]').first().click();
    await page.waitForSelector('.entry-role');
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS: six unsupported roles and stale role-switch response return to login without errors');
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
