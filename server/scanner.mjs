import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, pathKey } from './store.mjs';

const ignored = new Set([
  'node_modules', 'vendor', 'target', 'dist', 'build', 'coverage', '__pycache__',
  '.git', '.svn', '.hg', '.idea', '.vscode', '.next', '.nuxt', '.cache', '.venv',
  'venv', 'env', '.agents', '.codex', '.localspace', '.pnpm-store', '.npm',
  '$recycle.bin', 'system volume information', 'windows', 'program files', 'program files (x86)',
]);
const markers = ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile', 'project.godot', 'pubspec.yaml', 'Package.swift', 'CMakeLists.txt', 'Makefile', '.git'];
const descriptions = {
  frontend: '本地前端应用，专注于界面与交互。', backend: '本地服务项目，承载业务逻辑与接口。',
  tools: '自动化工具与脚本，让日常开发更高效。', game: '游戏开发项目，探索更多玩法与可能。',
  mobile: '移动端应用，连接灵感与日常体验。', other: '本地开发项目，随时继续你的创作。',
};
async function smallFile(file, max = 128_000) {
  try { if ((await stat(file)).size <= max) return await readFile(file, 'utf8'); } catch { /* Optional metadata. */ }
  return '';
}
export async function inspectProject(directory, allowUnknown = false) {
  const resolved = await realpath(directory);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new AppError('请选择一个文件夹。');
  const entries = await readdir(resolved, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  const found = markers.filter((marker) => names.has(marker));
  for (const entry of entries) if (/\.(sln|csproj|fsproj|uproject|xcodeproj)$/i.test(entry.name)) found.push(entry.name);
  if (!found.length && !allowUnknown) return null;
  let name = path.basename(resolved) || resolved;
  let description = '';
  let tags = [];
  let categoryId = 'other';
  let language = '项目';
  if (names.has('package.json')) {
    let pkg = {};
    try { pkg = JSON.parse(await smallFile(path.join(resolved, 'package.json'))); } catch { /* Recognize even with malformed metadata. */ }
    description = typeof pkg.description === 'string' ? pkg.description.replace(/\s+/g, ' ').slice(0, 150) : '';
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [dependency, label] of [['next', 'Next.js'], ['react', 'React'], ['vue', 'Vue'], ['nuxt', 'Nuxt'], ['svelte', 'Svelte'], ['@angular/core', 'Angular'], ['electron', 'Electron'], ['express', 'Express'], ['fastify', 'Fastify'], ['typescript', 'TypeScript'], ['vite', 'Vite']]) {
      if (deps[dependency]) tags.push(label);
    }
    language = deps.typescript || names.has('tsconfig.json') ? 'TypeScript' : 'JavaScript';
    if (!tags.length) tags.push('Node.js');
    categoryId = tags.some((tag) => ['React', 'Vue', 'Next.js', 'Nuxt', 'Svelte', 'Angular', 'Vite'].includes(tag)) ? 'frontend' : 'backend';
  } else if (names.has('pom.xml') || names.has('build.gradle') || names.has('build.gradle.kts')) {
    language = 'Java'; tags = [names.has('pom.xml') ? 'Maven' : 'Gradle']; categoryId = 'backend';
    const build = await smallFile(path.join(resolved, names.has('pom.xml') ? 'pom.xml' : 'build.gradle'));
    if (/spigot|paper-api|bukkit|minecraft|fabric|forge/i.test(build)) { categoryId = 'game'; tags.push('Minecraft'); }
    else if (/spring/i.test(build)) tags.push('Spring');
  } else if (names.has('pyproject.toml') || names.has('requirements.txt')) {
    language = 'Python'; tags = ['Python']; categoryId = 'tools';
    const dependencies = await smallFile(path.join(resolved, names.has('pyproject.toml') ? 'pyproject.toml' : 'requirements.txt'));
    if (/fastapi/i.test(dependencies)) { tags.push('FastAPI'); categoryId = 'backend'; }
    else if (/django/i.test(dependencies)) { tags.push('Django'); categoryId = 'backend'; }
  } else if (names.has('Cargo.toml')) { language = 'Rust'; tags = ['Rust', 'Cargo']; categoryId = 'tools'; }
  else if (names.has('go.mod')) { language = 'Go'; tags = ['Go']; categoryId = 'backend'; }
  else if (names.has('pubspec.yaml')) { language = 'Dart'; tags = ['Flutter']; categoryId = 'mobile'; }
  else if (names.has('Package.swift') || found.some((marker) => marker.endsWith('.xcodeproj'))) { language = 'Swift'; tags = ['Swift']; categoryId = 'mobile'; }
  else if (names.has('project.godot') || found.some((marker) => marker.endsWith('.uproject'))) { language = '游戏'; tags = [names.has('project.godot') ? 'Godot' : 'Unreal']; categoryId = 'game'; }
  else if (found.some((marker) => /\.(sln|csproj|fsproj)$/.test(marker))) { language = 'C#'; tags = ['.NET']; categoryId = 'backend'; }
  else if (names.has('CMakeLists.txt')) { language = 'C++'; tags = ['CMake']; categoryId = 'tools'; }
  else if (names.has('composer.json')) { language = 'PHP'; tags = ['PHP']; categoryId = 'backend'; }
  else if (names.has('Gemfile')) { language = 'Ruby'; tags = ['Ruby']; categoryId = 'backend'; }
  if (/minecraft|skywars|bedwars|spigot|voxel/i.test(name)) categoryId = 'game';
  if (!tags.length) tags = [names.has('.git') ? 'Git' : '本地项目'];
  let branch = '';
  let gitDir = path.join(resolved, '.git');
  try {
    if ((await stat(gitDir)).isFile()) {
      const pointer = await smallFile(gitDir, 4096);
      if (pointer.startsWith('gitdir: ')) gitDir = path.resolve(resolved, pointer.slice(8).trim());
    }
    const head = (await smallFile(path.join(gitDir, 'HEAD'), 4096)).trim();
    branch = head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 7);
  } catch { /* Git metadata is optional. */ }
  const times = await Promise.all(found.filter((marker) => marker !== '.git').slice(0, 4).map((marker) => stat(path.join(resolved, marker)).then((item) => item.mtimeMs).catch(() => 0)));
  return {
    id: randomUUID(), name, path: resolved, description: description || descriptions[categoryId],
    categoryId, tags: tags.slice(0, 4), language, branch, markers: found,
    updatedAt: new Date(Math.max(info.mtimeMs, ...times)).toISOString(),
    addedAt: new Date().toISOString(), lastOpenedAt: null, starred: false, archived: false, source: 'local',
  };
}

export async function scanDirectories(roots, { maxDepth = 3, limit = 600, maxDirectories = 10_000, signal } = {}) {
  if (!Array.isArray(roots) || !roots.length || roots.length > 12) throw new AppError('请填写 1–12 个扫描目录。');
  const normalized = [];
  for (const root of roots) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new AppError('扫描目录必须是完整的绝对路径。');
    try {
      const resolved = await realpath(root);
      if (!(await stat(resolved)).isDirectory()) throw new Error();
      if (!normalized.some((item) => pathKey(item) === pathKey(resolved))) normalized.push(resolved);
    } catch { throw new AppError(`无法访问目录：${root}，请检查路径和权限。`); }
  }
  const projects = [];
  const warnings = [];
  const visited = new Set();
  let directoryCount = 0;
  let truncated = false;
  async function visit(directory, depth) {
    signal?.throwIfAborted();
    if (projects.length >= limit || directoryCount >= maxDirectories) { truncated = true; return; }
    const key = pathKey(directory);
    if (visited.has(key)) return;
    visited.add(key);
    directoryCount++;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { warnings.push(`无法读取 ${directory}`); return; }
    const hasMarker = entries.some((entry) => markers.includes(entry.name) || /\.(sln|csproj|fsproj|uproject|xcodeproj)$/i.test(entry.name));
    if (hasMarker) {
      try { const project = await inspectProject(directory); if (project) projects.push(project); }
      catch { warnings.push(`无法识别 ${directory}`); }
    }
    if (depth >= maxDepth) return;
    // A recognized repository is one project; its dependencies and subpackages stay together.
    if (hasMarker) return;
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && !ignored.has(entry.name.toLowerCase())) {
        await visit(path.join(directory, entry.name), depth + 1);
        if (projects.length >= limit || directoryCount >= maxDirectories) { truncated = true; break; }
      }
    }
  }
  for (const root of normalized) await visit(root, 0);
  if (truncated) warnings.push(`已达到本次扫描上限（${limit} 个项目 / ${maxDirectories} 个目录），可缩小范围继续扫描。`);
  return { projects, roots: normalized, directoryCount, warnings, truncated };
}
