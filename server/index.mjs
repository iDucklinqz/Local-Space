import http from 'node:http';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError, categoryColors, createStore, pathKey, text } from './store.mjs';
import { inspectProject, scanDirectories } from './scanner.mjs';
import { chooseDirectory, openProject } from './system.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const isLoopback = (hostname) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

export async function createApplication({
  dataDirectory = process.env.LOCALSPACE_DATA_DIR || path.join(projectRoot, '.localspace'),
  defaultRoot = path.dirname(projectRoot),
  launch = openProject,
} = {}) {
  const store = await createStore(dataDirectory, defaultRoot);
  await store.update(() => {});
  const token = randomBytes(32).toString('hex');
  const scans = new Map();
  const compressed = new Map();
  let scanning = false;
  function state() {
    return { ...store.read(), token, platform: process.platform, workspaceRoot: projectRoot };
  }
  function send(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(payload));
  }
  function authorize(req) {
    const host = new URL(`http://${req.headers.host || 'invalid'}`).hostname;
    if (!isLoopback(host)) throw new AppError('仅允许通过本机地址访问。', 403);
    if (req.headers.origin) {
      let origin;
      try { origin = new URL(req.headers.origin); } catch { throw new AppError('无效的请求来源。', 403); }
      const same = origin.host === req.headers.host;
      const dev = isLoopback(origin.hostname) && origin.port === '5173';
      if (!isLoopback(origin.hostname) || (!same && !dev)) throw new AppError('不允许此来源访问本地工作台。', 403);
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      const supplied = Buffer.from(String(req.headers['x-localspace-token'] || ''));
      if (supplied.length !== Buffer.byteLength(token) || !timingSafeEqual(supplied, Buffer.from(token))) {
        throw new AppError('本地会话已更新，请刷新页面后重试。', 403);
      }
    }
  }
  async function body(req) {
    let length = 0;
    const chunks = [];
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 256_000) throw new AppError('请求内容过大。', 413);
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { throw new AppError('请求必须是有效的 JSON。'); }
  }
  function categoryId(value, current = store.read()) {
    if (!value) return 'other';
    const match = current.categories.find((category) => category.id === value || category.name === value);
    if (!match) throw new AppError('分类不存在，请先创建分类或选择已有分类。');
    return match.id;
  }
  function tags(value) {
    if (!Array.isArray(value)) throw new AppError('技术标签必须是数组。');
    return [...new Set(value.map((item) => text(item, 30)).filter(Boolean))].slice(0, 6);
  }
  async function route(req, res, url) {
    const pathname = url.pathname;
    authorize(req);
    if (req.method === 'GET' && pathname === '/api/state') return send(res, 200, state());
    if (req.method === 'GET' && pathname === '/api/health') return send(res, 200, { ok: true, name: 'LocalSpace', version: '1.0.0' });
    if (req.method === 'GET' && pathname === '/api/projects') return send(res, 200, { projects: store.read().projects });
    if (req.method === 'GET' && pathname === '/api/categories') return send(res, 200, { categories: store.read().categories });
    if (req.method === 'POST' && pathname === '/api/dialog/directory') return send(res, 200, { path: await chooseDirectory() });
    if (req.method === 'POST' && pathname === '/api/scan') {
      if (scanning) throw new AppError('已有扫描进行中，请稍后再试。', 409);
      const input = await body(req);
      const current = store.read();
      const depth = input.maxDepth ?? current.settings.maxDepth;
      if (!Number.isInteger(depth) || depth < 0 || depth > 6) throw new AppError('扫描深度需为 0–6 的整数。');
      const abort = new AbortController();
      res.once('close', () => { if (!res.writableEnded) abort.abort(); });
      scanning = true;
      try {
        const result = await scanDirectories(input.roots || current.settings.roots, { maxDepth: depth, signal: abort.signal });
        const known = new Set(store.read().projects.map((project) => pathKey(project.path)));
        const projects = result.projects.map((project) => ({ ...project, categoryId: current.categories.some((category) => category.id === project.categoryId) ? project.categoryId : 'other', imported: known.has(pathKey(project.path)) }));
        for (const [id, scan] of scans) if (Date.now() - scan.at > 30 * 60_000) scans.delete(id);
        while (scans.size >= 5) scans.delete(scans.keys().next().value);
        const scanId = randomUUID();
        scans.set(scanId, { at: Date.now(), projects });
        await store.update((next) => {
          next.settings.roots = [...new Set([...next.settings.roots, ...result.roots])].slice(-12);
          next.settings.maxDepth = depth;
          next.lastScan = { at: new Date().toISOString(), count: projects.length, directoryCount: result.directoryCount, roots: result.roots };
        });
        return send(res, 200, { ...result, projects, scanId });
      } finally { scanning = false; }
    }
    if (req.method === 'POST' && pathname === '/api/import') {
      const input = await body(req);
      const scan = scans.get(input.scanId);
      if (!scan || Date.now() - scan.at > 30 * 60_000) throw new AppError('扫描预览已过期，请重新扫描。', 410);
      if (!Array.isArray(input.ids) || !input.ids.length) throw new AppError('请至少选择一个项目。');
      const chosen = new Set(input.ids);
      const candidates = scan.projects.filter((project) => chosen.has(project.id));
      if (!candidates.length) throw new AppError('所选项目不在本次扫描结果中。');
      // Revalidate folders before import in case a directory was moved during preview.
      const present = [];
      for (const project of candidates) {
        try { if ((await stat(project.path)).isDirectory()) present.push(project); } catch { /* Return skipped count below. */ }
      }
      let added = 0;
      await store.update((next) => {
        const known = new Set(next.projects.map((project) => pathKey(project.path)));
        for (const candidate of present) {
          if (known.has(pathKey(candidate.path))) continue;
          const { imported, ...project } = candidate;
          void imported;
          if (!next.categories.some((category) => category.id === project.categoryId)) project.categoryId = 'other';
          next.projects.push(project);
          known.add(pathKey(project.path));
          added++;
        }
      });
      return send(res, 200, { added, skipped: candidates.length - added, state: state() });
    }
    if (req.method === 'POST' && pathname === '/api/projects') {
      const input = await body(req);
      if (typeof input.path !== 'string' || !path.isAbsolute(input.path)) throw new AppError('请填写项目文件夹的完整绝对路径。');
      let project;
      try { project = await inspectProject(input.path, true); }
      catch (error) { if (error instanceof AppError) throw error; throw new AppError('无法访问项目文件夹，请检查路径是否存在及访问权限。'); }
      if (input.name !== undefined) project.name = text(input.name, 100) || project.name;
      if (input.description !== undefined) project.description = text(input.description, 300);
      if (input.categoryId !== undefined || input.category !== undefined) project.categoryId = categoryId(input.categoryId ?? input.category);
      else if (!store.read().categories.some((category) => category.id === project.categoryId)) project.categoryId = 'other';
      if (input.tags !== undefined) project.tags = tags(input.tags);
      project.source = input.source === 'agent' ? 'agent' : 'manual';
      await store.update((next) => {
        const existing = next.projects.find((item) => pathKey(item.path) === pathKey(project.path));
        if (existing) throw new AppError(`这个文件夹已添加为「${existing.name}」。`, 409);
        next.projects.push(project);
      });
      return send(res, 201, { project, state: state() });
    }
    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)(?:\/(open))?$/);
    if (projectMatch) {
      const id = decodeURIComponent(projectMatch[1]);
      const project = store.read().projects.find((item) => item.id === id);
      if (!project) throw new AppError('项目不存在，可能已被移除。', 404);
      if (req.method === 'POST' && projectMatch[2] === 'open') {
        const input = await body(req);
        if (!['folder', 'powershell', 'cmd'].includes(input.action)) throw new AppError('请选择文件夹、PowerShell 或 CMD。');
        await launch(project.path, input.action);
        await store.update((next) => {
          const item = next.projects.find((entry) => entry.id === id);
          if (item) item.lastOpenedAt = new Date().toISOString();
        });
        return send(res, 200, { ok: true, state: state() });
      }
      if (req.method === 'PATCH' && !projectMatch[2]) {
        const input = await body(req);
        const updates = {};
        if ('name' in input) { updates.name = text(input.name, 100); if (!updates.name) throw new AppError('项目名称不能为空。'); }
        if ('description' in input) updates.description = text(input.description, 300);
        if ('categoryId' in input) updates.categoryId = categoryId(input.categoryId);
        if ('starred' in input) { if (typeof input.starred !== 'boolean') throw new AppError('收藏状态无效。'); updates.starred = input.starred; }
        if ('archived' in input) { if (typeof input.archived !== 'boolean') throw new AppError('归档状态无效。'); updates.archived = input.archived; }
        if ('tags' in input) updates.tags = tags(input.tags);
        if ('path' in input) {
          if (typeof input.path !== 'string' || !path.isAbsolute(input.path)) throw new AppError('请填写完整项目路径。');
          let inspected;
          try { inspected = await inspectProject(input.path, true); } catch { throw new AppError('新路径无法访问，请检查文件夹。'); }
          updates.path = inspected.path;
        }
        await store.update((next) => {
          if (updates.path && next.projects.some((item) => item.id !== id && pathKey(item.path) === pathKey(updates.path))) throw new AppError('该路径已被其他项目使用。', 409);
          Object.assign(next.projects.find((item) => item.id === id), updates);
        });
        return send(res, 200, { state: state() });
      }
      if (req.method === 'DELETE' && !projectMatch[2]) {
        await store.update((next) => { next.projects = next.projects.filter((item) => item.id !== id); });
        return send(res, 200, { state: state() });
      }
    }
    if (req.method === 'POST' && pathname === '/api/categories') {
      const input = await body(req);
      const name = text(input.name, 30);
      if (!name) throw new AppError('请填写分类名称。');
      const category = { id: randomUUID(), name, color: categoryColors.includes(input.color) ? input.color : 'blue' };
      await store.update((next) => {
        if (next.categories.some((item) => item.name.toLowerCase() === name.toLowerCase())) throw new AppError('已存在同名分类。', 409);
        next.categories.push(category);
      });
      return send(res, 201, { category, state: state() });
    }
    const categoryMatch = pathname.match(/^\/api\/categories\/([^/]+)$/);
    if (categoryMatch && ['PATCH', 'DELETE'].includes(req.method)) {
      const id = decodeURIComponent(categoryMatch[1]);
      const input = req.method === 'PATCH' ? await body(req) : {};
      await store.update((next) => {
        const category = next.categories.find((item) => item.id === id);
        if (!category) throw new AppError('分类不存在。', 404);
        if (req.method === 'DELETE') {
          if (id === 'other') throw new AppError('其他项目是默认分类，不能移除。');
          next.categories = next.categories.filter((item) => item.id !== id);
          next.projects.forEach((project) => { if (project.categoryId === id) project.categoryId = 'other'; });
        } else {
          const name = text(input.name, 30);
          if (!name) throw new AppError('分类名称不能为空。');
          if (next.categories.some((item) => item.id !== id && item.name.toLowerCase() === name.toLowerCase())) throw new AppError('已存在同名分类。', 409);
          category.name = name;
          if (categoryColors.includes(input.color)) category.color = input.color;
        }
      });
      return send(res, 200, { state: state() });
    }
    if (req.method === 'PATCH' && pathname === '/api/settings') {
      const input = await body(req);
      await store.update((next) => {
        if ('terminal' in input) {
          if (!['powershell', 'cmd'].includes(input.terminal)) throw new AppError('默认终端无效。');
          next.settings.terminal = input.terminal;
        }
        if ('maxDepth' in input) {
          if (!Number.isInteger(input.maxDepth) || input.maxDepth < 0 || input.maxDepth > 6) throw new AppError('扫描深度需为 0–6 的整数。');
          next.settings.maxDepth = input.maxDepth;
        }
        if ('roots' in input) {
          if (!Array.isArray(input.roots) || !input.roots.length || input.roots.length > 12 || input.roots.some((root) => typeof root !== 'string' || !path.isAbsolute(root))) throw new AppError('请填写 1–12 个完整扫描目录。');
          next.settings.roots = [...new Set(input.roots)];
        }
      });
      return send(res, 200, { state: state() });
    }
    throw new AppError('没有找到此接口。', 404);
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) return await route(req, res, url);
      authorize(req);
      if (!['GET', 'HEAD'].includes(req.method)) throw new AppError('不支持此请求。', 405);
      const dist = path.join(projectRoot, 'dist');
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      let file = path.resolve(dist, relative || 'index.html');
      if (file !== dist && !file.startsWith(`${dist}${path.sep}`)) throw new AppError('无效的文件路径。', 403);
      try { if (!(await stat(file)).isFile()) throw new Error(); }
      catch {
        if (path.extname(relative)) throw new AppError('文件不存在。', 404);
        file = path.join(dist, 'index.html');
      }
      let data;
      try { data = await readFile(file); }
      catch { throw new AppError('界面尚未构建，请先运行 npm run build，或使用 npm run dev。', 503); }
      const gzip = /(?:^|[,\s])gzip(?:[,;\s]|$)/.test(String(req.headers['accept-encoding'] || '')) && /\.(html|css|js|svg)$/.test(file);
      if (gzip) {
        const cached = compressed.get(file);
        if (cached?.original.equals(data)) data = cached.gzip;
        else { const zipped = gzipSync(data); compressed.set(file, { original: data, gzip: zipped }); data = zipped; }
      }
      res.writeHead(200, {
        ...(gzip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
        'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const status = error instanceof AppError ? error.status : 500;
      if (status === 500) console.error(error);
      send(res, status, { error: error instanceof AppError ? error.message : '本地服务暂时无法完成操作，请重试。' });
    }
  });
  server.requestTimeout = 240_000;
  return { server, store, token };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.LOCALSPACE_PORT || 4318);
  const { server } = await createApplication();
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请访问 http://127.0.0.1:${port} 或设置 LOCALSPACE_PORT。` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`\n  栖点 LocalSpace → http://127.0.0.1:${port}\n  数据保存在本机 · 无内置 AI · Ctrl+C 停止\n`));
  const shutdown = () => { server.close(); server.closeAllConnections(); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
