import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function text(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
export function pathKey(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
export const defaultCategories = [
  { id: 'frontend', name: '前端应用', color: 'blue' },
  { id: 'backend', name: '后端服务', color: 'green' },
  { id: 'tools', name: '工具与脚本', color: 'amber' },
  { id: 'game', name: '游戏开发', color: 'purple' },
  { id: 'mobile', name: '移动应用', color: 'pink' },
  { id: 'other', name: '其他项目', color: 'slate' },
];
export const categoryColors = ['blue', 'green', 'amber', 'purple', 'pink', 'slate', 'coral'];

export async function createStore(directory, defaultRoot) {
  const file = path.join(directory, 'workspace.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let state;
  try {
    state = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
    if (!Array.isArray(state.projects) || !Array.isArray(state.categories) || !state.settings) {
      throw new Error('Invalid workspace data');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new AppError('本地工作台数据无法读取，请检查 workspace.json，原文件已保留。', 500);
    state = {
      version: 1,
      projects: [],
      categories: structuredClone(defaultCategories),
      settings: { roots: [defaultRoot], maxDepth: 3, terminal: 'powershell' },
    };
  }
  let queue = Promise.resolve();
  const save = async (next) => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(temporary, file);
  };
  return {
    read: () => structuredClone(state),
    async update(change) {
      const operation = queue.then(async () => {
        const next = structuredClone(state);
        const result = await change(next);
        await save(next);
        state = next;
        return result;
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
}
