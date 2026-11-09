import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, mkdtemp, writeFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createApplication } from '../server/index.mjs';

const artifacts = path.resolve('artifacts');
await mkdir(artifacts, { recursive: true });
const root = await mkdtemp(path.join(artifacts, 'browser-'));
const projects = path.join(root, 'projects');
const first = path.join(projects, '中文 & 项目 (demo)');
const second = path.join(projects, 'second-api');
const third = path.join(root, 'agent-project');
for (const directory of [first, second, third]) await mkdir(directory, { recursive: true });
await writeFile(path.join(first, 'package.json'), JSON.stringify({ dependencies: { react: '*' }, devDependencies: { typescript: '*' } }));
await writeFile(path.join(second, 'go.mod'), 'module second-api\n');
const launches = [];
const { server } = await createApplication({ dataDirectory: path.join(root, 'state'), defaultRoot: projects, launch: async (...args) => { launches.push(args); } });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.LOCALSPACE_CHROMIUM || undefined });
const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const notes = [];
async function a11y(label) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  if (results.violations.length) await writeFile(path.join(artifacts, `a11y-${label}.json`), JSON.stringify(results.violations, null, 2));
  assert.deepEqual(results.violations.map((violation) => ({ id: violation.id, count: violation.nodes.length, summary: violation.nodes[0]?.failureSummary })), [], `Accessibility: ${label}`);
}
try {
  await page.goto(base);
  await expect(page.locator('h1')).toHaveText('全部项目');
  await expect(page.locator('.empty-state')).toBeVisible();
  await a11y('empty');
  await page.getByRole('button', { name: '添加项目', exact: true }).click();
  await page.getByLabel('项目文件夹').fill(first);
  await page.getByLabel('项目名称', { exact: true }).fill('中文项目 <safe>');
  await page.getByRole('button', { name: '添加项目', exact: true }).last().click();
  await expect(page.locator('.project-card')).toHaveCount(1);
  await expect(page.locator('.card-info h2')).toHaveText('中文项目 <safe>');
  assert.equal(await page.locator('.card-info img').count(), 0);
  notes.push('通过界面添加中文及特殊字符路径；HTML 内容以文本显示');

  await page.getByRole('button', { name: '收藏 中文项目 <safe>', exact: true }).click();
  await expect(page.locator('.star-button')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-action="nav"][data-value="starred"]').click();
  await expect(page.locator('.project-card')).toHaveCount(1);
  await page.locator('[data-action="nav"][data-value="all"]').first().click();
  await page.keyboard.press('Control+k');
  await expect(page.locator('#project-search')).toBeFocused();
  await page.locator('#project-search').fill('does-not-exist');
  await expect(page.locator('.empty-state')).toBeVisible();
  await page.getByRole('button', { name: '清除搜索与筛选' }).click();
  await expect(page.locator('.project-card')).toHaveCount(1);
  notes.push('星标、导航、搜索及 Ctrl+K');

  await page.locator('[data-action="add-category"]').first().click();
  await page.getByLabel('分类名称').fill('实验项目');
  await page.getByRole('radio', { name: '陶橙' }).check();
  await page.getByRole('button', { name: '创建分类' }).click();
  await expect(page.locator('#sidebar')).toContainText('实验项目');
  await page.locator('.card-info h2 button').click();
  await page.locator('#app-dialog').getByLabel('项目分类').selectOption({ label: '实验项目' });
  await page.getByLabel('项目简介').fill('本地测试项目，用于验证项目分类。');
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect(page.locator('.row-category')).toContainText('实验项目');
  notes.push('创建分类、编辑项目信息及分类归属');

  await page.getByRole('button', { name: '扫描目录', exact: true }).click();
  await page.getByRole('button', { name: '开始扫描' }).click();
  await expect(page.getByText('扫描结果', { exact: true })).toBeVisible();
  await expect(page.locator('.scan-result')).toHaveCount(2);
  await expect(page.locator('.scan-result input:disabled')).toHaveCount(1);
  await a11y('scan-dialog');
  await page.getByRole('button', { name: '导入 1 个项目', exact: true }).click();
  await expect(page.locator('.project-card')).toHaveCount(2);
  notes.push('扫描预览、排除已添加项目及批量导入');

  const cli = await promisify(execFile)(process.execPath, ['scripts/localspace.mjs', 'add', third, '--name', '外部 AI 添加的项目', '--category', 'tools', '--url', base], { cwd: path.resolve('.'), windowsHide: true });
  assert.equal(JSON.parse(cli.stdout).project.source, 'agent');
  await expect(page.locator('.project-card')).toHaveCount(3, { timeout: 12_000 });
  notes.push('独立 AI 命令行添加项目并自动刷新到页面');

  const firstCard = page.locator('.project-card').filter({ hasText: '中文项目 <safe>' });
  await firstCard.locator('[data-action="open"][data-value="folder"]').click();
  await firstCard.locator('[data-action="open"][data-value="powershell"]').first().click();
  await firstCard.locator('.terminal-dropdown summary').click();
  await firstCard.getByRole('button', { name: 'CMD 命令提示符', exact: true }).click();
  assert.deepEqual(launches.map((item) => item[1]), ['folder', 'powershell', 'cmd']);
  notes.push('文件夹、PowerShell、CMD 三种打开入口（测试使用启动适配器）');

  await firstCard.locator('.project-menu summary').click();
  await firstCard.getByRole('button', { name: '归档项目', exact: true }).click();
  await expect(page.locator('.project-card')).toHaveCount(2);
  await page.locator('[data-action="nav"][data-value="archive"]').click();
  await expect(page.locator('.project-card')).toHaveCount(1);
  await page.locator('.project-menu summary').click();
  await page.getByRole('button', { name: '恢复到项目库', exact: true }).click();
  await page.locator('[data-action="nav"][data-value="all"]').first().click();
  await expect(page.locator('.project-card')).toHaveCount(3);
  await expect(page.locator('.project-table')).toBeVisible();
  await a11y('light');
  await page.screenshot({ path: path.join(artifacts, 'ui-test-desktop.png'), fullPage: true });

  await page.getByRole('button', { name: '切换深色外观' }).click();
  await a11y('dark');
  await page.screenshot({ path: path.join(artifacts, 'ui-test-dark.png'), fullPage: true });
  await page.getByRole('button', { name: '切换浅色外观' }).click();
  notes.push('归档恢复、极简项目列表、浅色与深色 WCAG AA 自动检查');

  await page.locator('[data-action="integration"]').click();
  await expect(page.locator('#app-dialog')).toContainText('不需要 API Key');
  await a11y('integration');
  await page.keyboard.press('Escape');
  await expect(page.locator('#app-dialog')).not.toBeVisible();
  await expect(page.locator('[data-action="integration"]')).toBeFocused();

  await page.setViewportSize({ width: 375, height: 812 });
  await page.evaluate(() => window.scrollTo(0, 0));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: '打开导航' }).click();
  await expect(page.locator('#sidebar')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#sidebar')).not.toBeVisible();
  await a11y('mobile');
  await page.screenshot({ path: path.join(artifacts, 'ui-test-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 844, height: 390 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  notes.push('375px 手机、844px 横屏无页面溢出；减少动态效果；弹窗 Escape 和焦点恢复');

  assert.deepEqual(errors, []);
  assert.equal((await stat(first)).isDirectory(), true);
  await writeFile(path.join(artifacts, 'ui-verification.json'), JSON.stringify({ ok: true, checks: notes, pageErrors: errors }, null, 2));
  console.log(JSON.stringify({ ok: true, checks: notes }, null, 2));
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
