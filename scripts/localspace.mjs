#!/usr/bin/env node
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const command = args.shift() || 'help';
const options = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const name = args[i].slice(2);
    if (name === 'import') options[name] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) { console.error(JSON.stringify({ error: `--${name} 需要一个值。` })); process.exit(2); }
      options[name] = args[++i];
    }
  } else positional.push(args[i]);
}
if (['help', '--help', '-h'].includes(command)) {
  console.log(`LocalSpace — 向本地工作台添加已有项目，无 AI SDK 或云服务依赖。

  node scripts/localspace.mjs list
  node scripts/localspace.mjs categories
  node scripts/localspace.mjs category "分类名称" --color blue
  node scripts/localspace.mjs add "E:\\Projects\\demo" --category frontend
  node scripts/localspace.mjs add "E:\\Projects\\demo" --name "Demo" --description "项目简介" --tags "React,TypeScript"
  node scripts/localspace.mjs scan "E:\\Projects" --depth 3
  node scripts/localspace.mjs scan "E:\\Projects" --depth 3 --import

可选：--url http://127.0.0.1:4318
输出为 JSON。add 仅登记已存在的文件夹，不创建或修改项目文件。
先运行 npm start 或 npm run dev，保持本地服务运行。`);
  process.exit(0);
}
try {
  let defaultUrl = 'http://127.0.0.1:4318';
  if (!options.url && !process.env.LOCALSPACE_URL && process.env.LOCALAPPDATA) {
    try {
      const session = JSON.parse(await readFile(path.join(process.env.LOCALAPPDATA, 'LocalSpace', 'session.json'), 'utf8'));
      const candidate = new URL(session.url);
      if (candidate.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(candidate.hostname)) {
        const health = await (await fetch(new URL('/api/health', candidate), { signal: AbortSignal.timeout(1000) })).json();
        if (health.name === 'LocalSpace' && health.desktop) defaultUrl = candidate.origin;
      }
    } catch { /* The web development service remains the fallback. */ }
  }
  const base = new URL(options.url || process.env.LOCALSPACE_URL || defaultUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.protocol !== 'http:') throw new Error('仅支持本机 HTTP 地址。');
  let session;
  async function request(route, method = 'GET', payload) {
    let response;
    try {
      response = await fetch(new URL(route, base), {
        method,
        headers: { 'Content-Type': 'application/json', ...(session ? { 'X-LocalSpace-Token': session.token } : {}) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
    } catch { throw new Error(`无法连接 ${base.origin}，请先打开 LocalSpace.exe，或运行 npm start。`); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `请求失败：${response.status}`);
    return result;
  }
  if (!['list', 'categories', 'category', 'add', 'scan'].includes(command)) throw new Error('未知命令，请运行 node scripts/localspace.mjs help。');
  session = await request('/api/state');
  let result;
  if (command === 'list') result = { projects: session.projects };
  if (command === 'categories') result = { categories: session.categories };
  if (command === 'category') {
    if (!positional[0] && !options.name) throw new Error('请填写分类名称。');
    const created = await request('/api/categories', 'POST', { name: positional[0] || options.name, color: options.color || 'blue' });
    result = { category: created.category };
  }
  if (command === 'add') {
    const projectPath = positional[0] || options.path;
    if (!projectPath) throw new Error('请填写已有项目的绝对路径。');
    const created = await request('/api/projects', 'POST', {
      path: projectPath, source: 'agent',
      ...(options.name ? { name: options.name } : {}),
      ...(options.description ? { description: options.description } : {}),
      ...(options.category ? { category: options.category } : {}),
      ...(options.tags ? { tags: options.tags.split(',').map((tag) => tag.trim()).filter(Boolean) } : {}),
    });
    result = { project: created.project };
  }
  if (command === 'scan') {
    const depth = Number(options.depth || 3);
    const scan = await request('/api/scan', 'POST', { ...(positional[0] || options.root ? { roots: [positional[0] || options.root] } : {}), maxDepth: depth });
    if (options.import) {
      const ids = scan.projects.filter((project) => !project.imported).map((project) => project.id);
      const imported = ids.length ? await request('/api/import', 'POST', { scanId: scan.scanId, ids }) : { added: 0, skipped: scan.projects.length };
      result = { added: imported.added, skipped: imported.skipped, warnings: scan.warnings };
    } else result = { ...scan, hint: '确认结果后，添加 --import 再次扫描并导入；或通过 /api/import 提交 scanId 和 ids。' };
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
