import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createApplication } from '../server/index.mjs';

await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.resolve('artifacts/i18n-'));
const projects = path.join(root, 'projects');
const first = path.join(projects, 'demo');
const second = path.join(projects, 'api');
for (const directory of [first, second]) await mkdir(directory, { recursive: true });
await writeFile(path.join(first, 'package.json'), JSON.stringify({ dependencies: { react: '*' } }));
await writeFile(path.join(second, 'go.mod'), 'module demo-api\n');
const { server, store, token } = await createApplication({ dataDirectory: path.join(root, 'state'), defaultRoot: projects, launch: async () => {} });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const errors = [];
const checks = [];
async function api(route, payload) {
  const response = await fetch(`${base}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LocalSpace-Token': token }, body: JSON.stringify(payload) });
  assert.equal(response.ok, true);
  return response.json();
}
async function accessible(page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  assert.deepEqual(result.violations.map(violation => ({ id: violation.id, nodes: violation.nodes.map(node => node.target) })), []);
}
try {
  await api('/projects', { path: first, name: 'Demo <safe>', description: '原始简介 <safe>', category: 'frontend', tags: ['TypeScript'] });
  const custom = (await api('/categories', { name: '研究 & <Team>', color: 'purple' })).category;
  const original = store.read();
  browser = await chromium.launch({ headless: true, executablePath: process.env.LOCALSPACE_CHROMIUM || undefined });
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await expect(page.locator('h1')).toHaveText('All projects');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page).toHaveTitle('All projects · LocalSpace');
  await expect(page.locator('.row-category')).toHaveText('Frontend');
  await expect(page.locator('.results-footer')).toContainText('1 project');
  await expect(page.locator('.project-time')).toHaveText('Just now');
  await expect(page.locator(`[data-action="nav"][data-value="${custom.id}"]`)).toHaveText('研究 & <Team>');
  assert.equal(await page.locator('.card-info img, .categories img').count(), 0);
  await page.getByRole('button', { name: 'Demo <safe>', exact: true }).click();
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue('原始简介 <safe>');
  await expect(page.locator('#app-dialog').getByLabel('Category', { exact: true })).toHaveValue('frontend');
  await expect(page.locator('#project-category-input option:checked')).toHaveText('Frontend');
  await page.keyboard.press('Escape');
  checks.push('English browser defaults, document language, built-in categories, time, and singular counts');

  await page.locator('[data-action="settings"]').click();
  await expect(page.getByLabel('Interface language')).toHaveValue('en');
  await page.getByLabel('Interface language').selectOption('zh-CN');
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(page.locator('h1')).toHaveText('全部项目');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await page.reload();
  await expect(page.locator('h1')).toHaveText('全部项目');
  await page.locator('#project-search').fill('Demo');
  await page.locator('#project-sort').selectOption('name');
  await page.locator('[data-action="language"]').click();
  await expect(page.locator('h1')).toHaveText('All projects');
  await expect(page.locator('#project-search')).toHaveValue('Demo');
  await expect(page.locator('#project-sort')).toHaveValue('name');
  await page.locator(`[data-action="nav"][data-value="${custom.id}"]`).click();
  await expect(page.locator('h1')).toHaveText('研究 & <Team>');
  await page.locator('[data-action="language"]').click();
  await expect(page.locator('h1')).toHaveText('研究 & <Team>');
  await page.locator('[data-action="language"]').click();
  assert.deepEqual(store.read(), original, 'Changing language must not rewrite workspace records');
  await page.locator('[data-action="nav"][data-value="all"]').first().click();
  await page.reload();
  await expect(page.locator('h1')).toHaveText('All projects');
  checks.push('Settings and top-bar switching persist, preserve navigation/search/sort, and never rewrite user data');

  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  await page.getByLabel('Project folder').fill(first);
  await page.getByRole('button', { name: 'Add project', exact: true }).last().click();
  await expect(page.locator('.form-error')).toHaveText('This folder is already registered as “Demo <safe>”.');
  assert.equal(await page.locator('.form-error img').count(), 0);
  await page.getByLabel('Project folder').fill(path.join(root, 'missing'));
  await page.getByRole('button', { name: 'Add project', exact: true }).last().click();
  await expect(page.locator('.form-error')).toContainText('Cannot access the project folder.');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Scan folders', exact: true }).click();
  await expect(page.getByLabel('Scan depth')).toHaveValue('3');
  await page.getByRole('button', { name: 'Start scan', exact: true }).click();
  await expect(page.locator('#dialog-title')).toHaveText('Scan results');
  await expect(page.locator('.dialog-header p')).toContainText('found 1 new project.');
  await expect(page.locator('#selected-count')).toHaveText('1 project selected');
  await page.getByRole('button', { name: 'Import 1 project', exact: true }).click();
  await expect(page.locator('.project-row')).toHaveCount(2);
  await expect(page.locator('.results-footer')).toContainText('2 projects');
  checks.push('English forms, escaped dynamic server errors, scan preview, import, and plural counts');

  await page.locator('[data-action="add-category"]').first().click();
  await page.getByLabel('Category name').fill('Client <work>');
  await page.getByRole('radio', { name: 'Terracotta' }).check();
  await page.getByRole('button', { name: 'Create category', exact: true }).click();
  await expect(page.locator('#sidebar')).toContainText('Client <work>');
  await page.locator('[data-action="integration"]').click();
  await expect(page.locator('#dialog-title')).toHaveText('AI integration');
  await expect(page.locator('#app-dialog pre')).toContainText('Add existing projects');
  assert.doesNotMatch(await page.locator('#app-dialog pre').innerText(), /[\u3400-\u9fff]/);
  await page.keyboard.press('Escape');
  await page.locator('[data-action="help"]').click();
  await expect(page.locator('#dialog-title')).toHaveText('A little help to get started');
  assert.doesNotMatch(await page.locator('#app-dialog').innerText(), /[\u3400-\u9fff]/);
  await page.keyboard.press('Escape');
  const projectId = original.projects[0].id;
  await page.locator(`[data-project="${projectId}"] .project-menu summary`).click();
  await page.getByRole('button', { name: 'Remove from workspace', exact: true }).click();
  await expect(page.locator('#dialog-title')).toHaveText('Remove this project?');
  await expect(page.locator('.dialog-header p')).toContainText('Demo <safe>');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await accessible(page);
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.locator('#sidebar')).toBeVisible();
  await page.keyboard.press('Escape');
  await accessible(page);
  await page.locator('[data-action="theme"]').click();
  await accessible(page);
  await page.screenshot({ path: 'artifacts/i18n-english-mobile.png', fullPage: true });
  checks.push('English category, AI, help, and confirmation dialogs; mobile navigation; light/dark accessibility');

  for (const [browserLocale, expectedTitle, expectedLang] of [['zh-CN', '全部项目', 'zh-CN'], ['fr-FR', 'All projects', 'en']]) {
    const other = await browser.newContext({ locale: browserLocale });
    const otherPage = await other.newPage();
    await otherPage.goto(base);
    await expect(otherPage.locator('h1')).toHaveText(expectedTitle);
    await expect(otherPage.locator('html')).toHaveAttribute('lang', expectedLang);
    if (browserLocale === 'zh-CN') {
      await otherPage.locator('[data-action="language"]').click();
      await otherPage.reload();
      await expect(otherPage.locator('h1')).toHaveText('All projects');
    }
    await other.close();
  }
  assert.deepEqual(errors, []);
  checks.push('Chinese browser defaults, manual override persistence, and English fallback for other languages');
  await writeFile('artifacts/i18n-verification.json', JSON.stringify({ ok: true, checks, pageErrors: errors }, null, 2));
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
