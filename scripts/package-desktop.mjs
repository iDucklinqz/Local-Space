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
await writeFile(path.join(release,'README.txt'),`栖点 LocalSpace 1.1.0 · Windows x64\n\n双击 LocalSpace.exe 打开工作台，关闭窗口即退出。\n无需安装 Node.js，无需浏览器窗口。界面和本地功能已包含在单个 exe 中。\n需要系统已有 Microsoft Edge WebView2 Runtime（当前电脑已验证可用）。\n\n项目记录保存在 %LOCALAPPDATA%\\LocalSpace\\workspace.json。\n首次从原工作台目录启动时，会自动复制原有 .localspace\\workspace.json；原文件保留。\n扫描、归档和移除登记记录不会删除或改写项目文件。\n\n外部 AI 可以直接执行：\nLocalSpace.exe categories\nLocalSpace.exe list\nLocalSpace.exe add "E:\\Projects\\demo" --category frontend --description "项目简介"\n\n执行添加命令时保持栖点窗口运行。命令返回 JSON；也支持本机 HTTP 接口。\n详细说明可在界面的「AI 接入」中复制。\n\nLanguage: English / 简体中文. Use the language button in the top bar or Settings.\nLicense: GNU GPL v3.0 only. See LICENSE.txt.\nSource: https://github.com/iDucklinqz/Local-Space\n`, 'utf8');
const command="Compress-Archive -LiteralPath (Join-Path $env:LOCALSPACE_PACKAGE_ROOT 'LocalSpace.exe'),(Join-Path $env:LOCALSPACE_PACKAGE_ROOT 'README.txt'),(Join-Path $env:LOCALSPACE_PACKAGE_ROOT 'LICENSE.txt') -DestinationPath (Join-Path $env:LOCALSPACE_PACKAGE_ROOT 'LocalSpace-1.1.0-windows-x64.zip') -Force";
const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{cwd:root,stdio:'inherit',windowsHide:true,env:{...process.env,LOCALSPACE_PACKAGE_ROOT:release}});
if(result.error||result.status!==0)throw result.error||new Error('ZIP creation failed.');
console.log(JSON.stringify({executable:path.join(release,'LocalSpace.exe'),exeBytes:(await stat(path.join(release,'LocalSpace.exe'))).size,zipBytes:(await stat(path.join(release,'LocalSpace-1.1.0-windows-x64.zip'))).size},null,2));
