import test from 'node:test';
import { request as httpRequest } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { createApplication } from '../server/index.mjs';
import { scanDirectories } from '../server/scanner.mjs';
import { launchSpec } from '../server/system.mjs';

const artifacts = path.resolve('artifacts');
await mkdir(artifacts, { recursive: true });
const root = await mkdtemp(path.join(artifacts, 'integration-'));
const fixtures = path.join(root, 'projects');
const frontend = path.join(fixtures, 'web & 中文 (demo)');
const backend = path.join(fixtures, 'group', 'api');
const manual = path.join(root, 'manual folder');
await Promise.all([mkdir(frontend, { recursive: true }), mkdir(backend, { recursive: true }), mkdir(manual, { recursive: true })]);
await writeFile(path.join(frontend, 'package.json'), JSON.stringify({ description: 'A real test project', devDependencies: { typescript: '*', vite: '*' }, dependencies: { react: '*' } }));
await mkdir(path.join(frontend, 'node_modules', 'ignored'), { recursive: true });
await writeFile(path.join(frontend, 'node_modules', 'ignored', 'package.json'), '{}');
await writeFile(path.join(backend, 'go.mod'), 'module example.local/api\n');
await mkdir(path.join(fixtures, '.hidden'), { recursive: true });
await writeFile(path.join(fixtures, '.hidden', 'package.json'), '{}');
await mkdir(path.join(frontend, '.git'), { recursive: true });
await writeFile(path.join(frontend, '.git', 'HEAD'), 'ref: refs/heads/feature/local\n');
try { await symlink(frontend, path.join(fixtures, 'linked-project'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* Some systems disallow links. */ }

await test('scanner recognizes projects, preserves repository boundaries and ignores dependencies/links', async () => {
  const result = await scanDirectories([fixtures], { maxDepth: 3 });
  assert.equal(result.projects.length, 2);
  const web = result.projects.find((project) => project.name.startsWith('web'));
  assert.equal(web.categoryId, 'frontend');
  assert.equal(web.language, 'TypeScript');
  assert.equal(web.branch, 'feature/local');
  assert.ok(web.tags.includes('React'));
  assert.equal(result.projects.find((project) => project.name === 'api').language, 'Go');
  assert.equal((await scanDirectories([fixtures], { maxDepth: 1 })).projects.length, 1);
  assert.equal((await scanDirectories([fixtures, fixtures], { maxDepth: 3 })).projects.length, 2);
});
await test('scanner rejects nonexistent roots and reports bounded scans', async () => {
  await assert.rejects(scanDirectories([path.join(root, 'missing')]), /无法访问目录/);
  const result = await scanDirectories([fixtures], { limit: 1 });
  assert.equal(result.projects.length, 1);
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.length);
});
await test('Windows shell arguments keep Chinese and metacharacter paths out of command syntax', () => {
  const directory = 'E:\\项目 & data\\$(not-a-command) (demo)';
  const cmd = launchSpec(directory, 'cmd', 'win32');
  assert.equal(cmd.options.cwd, directory);
  assert.deepEqual(cmd.args, ['/D', '/K']);
  const power = launchSpec(directory, 'powershell', 'win32');
  const script = Buffer.from(power.args.at(-1), 'base64').toString('utf16le');
  assert.ok(!script.includes(directory));
  const base64 = script.match(/FromBase64String\('([^']+)'\)/)[1];
  assert.equal(Buffer.from(base64, 'base64').toString('utf8'), directory);
  assert.deepEqual(launchSpec(directory, 'folder', 'win32').args, [directory]);
  assert.throws(() => launchSpec(directory, 'arbitrary', 'win32'), /不支持/);
});

await test('PowerShell actually enters a Chinese and metacharacter directory', { skip: process.platform !== 'win32' }, async () => {
  const spec = launchSpec(frontend, 'powershell', 'win32');
  const locationScript = Buffer.from(spec.args.at(-1), 'base64').toString('utf16le');
  const script = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); ${locationScript}; [Console]::Write((Get-Location).ProviderPath)`;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10_000, encoding: 'utf8' });
  assert.equal(stdout.trim(), frontend);
});

await test('HTTP workflows, concurrency, state persistence and local request isolation', async (t) => {
  const launched = [];
  const dataDirectory = path.join(root, 'data');
  const { server } = await createApplication({ dataDirectory, defaultRoot: fixtures, launch: async (...args) => { launched.push(args); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = '';
  async function api(route, method = 'GET', payload, headers = {}) {
    const response = await fetch(`${base}/api${route}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-LocalSpace-Token': token } : {}), ...headers }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  try {
    const initial = await api('/state'); token = initial.data.token;
    assert.equal(initial.data.projects.length, 0);
    assert.equal(initial.data.settings.ai, undefined);
    await t.test('rejects CSRF, foreign origins, DNS rebinding and malformed JSON', async () => {
      assert.equal((await api('/projects', 'POST', { path: manual }, { 'X-LocalSpace-Token': '' })).status, 403);
      assert.equal((await api('/state', 'GET', undefined, { Origin: 'https://example.com' })).status, 403);
      const hostStatus = await new Promise((resolve, reject) => {
        const request = httpRequest(`${base}/api/state`, { headers: { Host: 'evil.example:4318' } }, (response) => { response.resume(); resolve(response.statusCode); });
        request.on('error', reject); request.end();
      });
      assert.equal(hostStatus, 403);
      const response = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'X-LocalSpace-Token': token }, body: '{' });
      assert.equal(response.status, 400);
    });
    let scan;
    await t.test('scans and imports preview selections with duplicate protection', async () => {
      const result = await api('/scan', 'POST', { roots: [fixtures], maxDepth: 3 });
      assert.equal(result.status, 200); scan = result.data;
      assert.equal(scan.projects.length, 2);
      const ids = scan.projects.map((project) => project.id);
      assert.equal((await api('/import', 'POST', { scanId: scan.scanId, ids })).data.added, 2);
      assert.equal((await api('/import', 'POST', { scanId: scan.scanId, ids })).data.added, 0);
      assert.equal((await api('/import', 'POST', { scanId: 'expired', ids })).status, 410);
      assert.equal((await api('/scan', 'POST', { roots: [fixtures], maxDepth: 3 })).data.projects.every((project) => project.imported), true);
    });
    let project;
    let category;
    await t.test('external AI can create a category and register an existing directory concurrently', async () => {
      category = (await api('/categories', 'POST', { name: '测试分类', color: 'coral' })).data.category;
      const results = await Promise.all([api('/projects', 'POST', { path: manual, category: category.name, source: 'agent', tags: ['Node.js'] }), api('/projects', 'POST', { path: manual })]);
      assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
      project = results.find((result) => result.status === 201).data.project;
      assert.equal(project.path, manual);
      assert.equal(project.source, 'agent');
      assert.equal((await api('/categories', 'POST', { name: '测试分类' })).status, 409);
    });
    await t.test('editing, starring, archive and opening use only a registered project', async () => {
      assert.equal((await api(`/projects/${project.id}`, 'PATCH', { starred: 'true' })).status, 400);
      const result = await api(`/projects/${project.id}`, 'PATCH', { name: '中文项目 <safe>', starred: true, archived: true, categoryId: category.id });
      assert.equal(result.status, 200);
      assert.equal(result.data.state.projects.find((entry) => entry.id === project.id).starred, true);
      for (const action of ['folder', 'cmd', 'powershell']) assert.equal((await api(`/projects/${project.id}/open`, 'POST', { action })).status, 200);
      assert.equal(launched.length, 3);
      assert.deepEqual(launched[0], [manual, 'folder']);
      assert.equal((await api(`/projects/${project.id}/open`, 'POST', { action: 'malicious' })).status, 400);
      assert.equal((await api('/projects/nonexistent/open', 'POST', { action: 'folder' })).status, 404);
    });
    await t.test('deleting categories or records preserves the actual project files', async () => {
      const deleted = await api(`/categories/${category.id}`, 'DELETE');
      assert.equal(deleted.data.state.projects.find((entry) => entry.id === project.id).categoryId, 'other');
      assert.equal((await api('/categories/other', 'DELETE')).status, 400);
      assert.equal((await api(`/projects/${project.id}`, 'DELETE')).status, 200);
      assert.equal(JSON.parse(await readFile(path.join(frontend, 'package.json'), 'utf8')).description, 'A real test project');
      const persisted = JSON.parse(await readFile(path.join(dataDirectory, 'workspace.json'), 'utf8'));
      assert.equal(persisted.projects.length, 2);
      const reopened = await createApplication({ dataDirectory, defaultRoot: fixtures });
      assert.equal(reopened.store.read().projects.length, 2);
      reopened.server.close();
    });
    await t.test('production serves local files with a restrictive content policy', async () => {
      const response = await fetch(base);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      assert.match(await response.text(), /LocalSpace/);
    });
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
