import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function run(executable,args){const result=spawnSync(executable,args,{cwd:root,stdio:'inherit',windowsHide:true});if(result.error)throw result.error;if(result.status!==0)throw new Error(`Build failed: ${executable}`)}
if(process.platform!=='win32')throw new Error('Build the Windows desktop package on Windows.');
if(!process.argv.includes('--skip-build')){
  run(process.execPath,['node_modules/typescript/bin/tsc','-b']);
  run(process.execPath,['node_modules/vite/bin/vite.js','build']);
  run('cargo',['+stable-x86_64-pc-windows-msvc','build','--release','--manifest-path','desktop/Cargo.toml']);
}
const release=path.join(root,'release');await mkdir(release,{recursive:true});
await copyFile(path.join(root,'desktop/target/release/LocalSpace.exe'),path.join(release,'LocalSpace.exe'));
await copyFile(path.join(root,'LICENSE'),path.join(release,'LICENSE.txt'));
await writeFile(path.join(release,'README.txt'),"LocalSpace 1.1.0 - Windows x64\n\nQuick start\nExtract the portable ZIP and double-click LocalSpace.exe.\nClose the window to exit. Node.js and Rust are not required.\nMicrosoft Edge WebView2 Runtime must be installed on Windows.\n\nLanguage\nThe interface follows your system language on first launch.\nUse the language button in the top bar or Settings > Interface language\nfor English or Simplified Chinese. Your selection is remembered.\n\nYour data\nWorkspace records: %LOCALAPPDATA%\\LocalSpace\\workspace.json\nBack up this file to preserve your project records, categories, and settings.\nScanning, archiving, and removing records leave project files untouched.\nAn existing .localspace\\workspace.json is copied on first desktop launch\nwhen found in the working directory or nearby executable directories.\nThe original file is preserved.\n\nExternal AI assistants\nKeep LocalSpace open while running local commands:\n.\\LocalSpace.exe categories\n.\\LocalSpace.exe list\n.\\LocalSpace.exe add \"D:\\Projects\\demo\" --category frontend\nCommands return JSON. Open AI integration in the sidebar for instructions.\n\nLicense: GNU General Public License v3.0 only (GPL-3.0-only).\nSee LICENSE.txt for the complete terms.\nSource and documentation: https://github.com/iDucklinqz/Local-Space\n\n---\n\n栖点 LocalSpace 1.1.0 - Windows x64\n\n解压便携包，双击 LocalSpace.exe 启动，关闭窗口即退出。\n需要 Microsoft Edge WebView2 Runtime，无需安装 Node.js 或 Rust。\n\n首次启动跟随系统语言；可通过顶部语言按钮或“设置 > 界面语言”\n切换 English / 简体中文，选择会自动保存。\n\n项目记录保存在 %LOCALAPPDATA%\\LocalSpace\\workspace.json，可直接备份。\n扫描、归档和移除登记不会删除或改写项目文件。\n首次启动时，若在工作目录或 exe 附近找到已有 .localspace\\workspace.json，\n会复制到桌面数据目录，原文件保留。\n\n外部 AI 可调用上方命令添加已有项目。调用时保持栖点窗口打开。\n详细说明可在侧边栏“AI 接入”中复制。\n\n本项目采用 GPL v3 协议（仅限 v3），完整条款见 LICENSE.txt。\n源码与文档：https://github.com/iDucklinqz/Local-Space\n", 'utf8');
const command="Compress-Archive -LiteralPath (Join-Path $env:LOCALSPACE_PACKAGE_ROOT 'LocalSpace.exe'),(Join-Path $env:LOCALSPACE_PACKAGE_ROOT 'README.txt'),(Join-Path $env:LOCALSPACE_PACKAGE_ROOT 'LICENSE.txt') -DestinationPath (Join-Path $env:LOCALSPACE_PACKAGE_ROOT 'LocalSpace-1.1.0-windows-x64.zip') -Force";
const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{cwd:root,stdio:'inherit',windowsHide:true,env:{...process.env,LOCALSPACE_PACKAGE_ROOT:release}});
if(result.error||result.status!==0)throw result.error||new Error('ZIP creation failed.');
console.log(JSON.stringify({executable:path.join(release,'LocalSpace.exe'),exeBytes:(await stat(path.join(release,'LocalSpace.exe'))).size,zipBytes:(await stat(path.join(release,'LocalSpace-1.1.0-windows-x64.zip'))).size},null,2));
