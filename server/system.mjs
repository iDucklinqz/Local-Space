import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import { AppError } from './store.mjs';

export function launchSpec(directory, action, platform = process.platform) {
  if (!['folder', 'powershell', 'cmd'].includes(action)) throw new AppError('不支持的打开方式。');
  if (platform === 'win32') {
    if (action === 'folder') return { executable: 'explorer.exe', args: [directory], options: { windowsHide: true } };
    if (action === 'cmd') return { executable: 'cmd.exe', args: ['/D', '/K'], options: { cwd: directory, windowsHide: false, detached: true } };
    const encodedPath = Buffer.from(directory, 'utf8').toString('base64');
    const script = `Set-Location -LiteralPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')))`;
    return { executable: 'powershell.exe', args: ['-NoLogo', '-NoExit', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], options: { cwd: directory, windowsHide: false, detached: true } };
  }
  if (action === 'folder') return { executable: platform === 'darwin' ? 'open' : 'xdg-open', args: [directory], options: {} };
  throw new AppError('CMD 和 PowerShell 快捷打开适用于 Windows。');
}
export async function openProject(directory, action) {
  let resolved;
  try {
    resolved = await realpath(directory);
    if (!(await stat(resolved)).isDirectory()) throw new Error();
  } catch { throw new AppError('项目文件夹已移动或无法访问，请在项目信息中更新路径。', 404); }
  const spec = launchSpec(resolved, action);
  await new Promise((resolve, reject) => {
    const child = spawn(spec.executable, spec.args, { ...spec.options, stdio: 'ignore', shell: false });
    child.once('error', () => reject(new AppError('无法打开，请确认资源管理器或终端程序可用。', 500)));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
export async function chooseDirectory() {
  if (process.platform !== 'win32') throw new AppError('当前系统请直接填写目录的完整路径。');
  const script = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); Add-Type -AssemblyName System.Windows.Forms; $dialog = [Windows.Forms.FolderBrowserDialog]::new(); $dialog.Description = '选择要扫描或添加的项目目录'; $dialog.ShowNewFolderButton = $false; $owner = [Windows.Forms.Form]::new(); $owner.TopMost = $true; $owner.StartPosition = 'CenterScreen'; if ($dialog.ShowDialog($owner) -eq [Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) }; $dialog.Dispose(); $owner.Dispose()`;
  try {
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 180_000, encoding: 'utf8', maxBuffer: 16_000 });
    return stdout.trim();
  } catch { throw new AppError('目录选择未完成，请直接输入完整路径。'); }
}
