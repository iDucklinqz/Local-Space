import { chromium, expect } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createApplication } from '../server/index.mjs';
import { defaultCategories } from '../server/store.mjs';

await mkdir('artifacts', { recursive: true });
const dataDirectory = await mkdtemp(path.resolve('artifacts/readme-demo-'));
const examples = [
  ['Orbit Web', 'orbit-web', 'frontend', ['React', 'TypeScript'], true],
  ['Canvas Studio', 'canvas-studio', 'frontend', ['Vue', 'Vite'], true],
  ['Harbor API', 'harbor-api', 'backend', ['Go', 'PostgreSQL'], false],
  ['Workspace CLI', 'workspace-cli', 'tools', ['Rust'], true],
  ['Pocket Notes', 'pocket-notes', 'mobile', ['Flutter', 'Dart'], false],
  ['Pixel Garden', 'pixel-garden', 'game', ['Godot'], false],
  ['Design Tokens', 'design-tokens', 'tools', ['TypeScript'], false],
];
const now = Date.now();
const projects = examples.map(([name, folder, categoryId, tags, starred], index) => ({
  id: `demo-${index}`, name, path: `D:\\Projects\\${folder}`,
  description: 'Fictional example project for documentation.', categoryId, tags,
  language: tags[0], branch: 'main', updatedAt: new Date(now - index * 86400000).toISOString(),
  addedAt: new Date(now - 12 * 86400000).toISOString(),
  lastOpenedAt: index < 3 ? new Date(now - index * 3600000).toISOString() : null,
  starred, archived: false, source: 'manual',
}));
await writeFile(path.join(dataDirectory, 'workspace.json'), JSON.stringify({
  version: 1, projects, categories: defaultCategories,
  settings: { roots: ['D:\\Projects'], maxDepth: 3, terminal: 'powershell' },
}));
const { server } = await createApplication({ dataDirectory, defaultRoot: 'D:\\Projects', launch: async () => {} });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.LOCALSPACE_CHROMIUM || undefined });
  await mkdir('docs/assets', { recursive: true });
  for (const [locale, prefix, title] of [['en-US', 'overview', 'All projects'], ['zh-CN', 'overview-zh-CN', '全部项目']]) {
    const context = await browser.newContext({ locale, viewport: { width: 1440, height: 820 }, deviceScaleFactor: 1.5, reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await expect(page.locator('h1')).toHaveText(title);
      await expect(page.locator('.project-row')).toHaveCount(7);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: `docs/assets/${prefix}-light.png` });
      await page.locator('[data-action="theme"]').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.screenshot({ path: `docs/assets/${prefix}-dark.png` });
      console.log(`${locale}: light and dark screenshots captured with fictional demo data.`);
    } finally { await context.close(); }
  }
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
