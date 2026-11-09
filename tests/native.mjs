import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const executable=path.resolve(process.env.LOCALSPACE_EXE||'desktop/target/release/LocalSpace.exe');
const root=await mkdtemp(path.resolve('artifacts/native-'));
const fixtures=path.join(root,'projects');
const first=path.join(fixtures,'中文 & 项目 (原生测试)');
const second=path.join(fixtures,'backend');
await mkdir(first,{recursive:true});await mkdir(second,{recursive:true});
await writeFile(path.join(first,'package.json'),JSON.stringify({dependencies:{react:'*'},devDependencies:{typescript:'*'}}));
await writeFile(path.join(second,'go.mod'),'module native-backend\n');
const dataDirectory=path.join(root,'data');
const child=spawn(executable,['--serve','--data-dir',dataDirectory,'--port','0'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let output='';let stderr='';
child.stderr.on('data',chunk=>{stderr+=chunk});
const base=await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(new Error(`Native startup timeout: ${stderr}`)),15_000);
  child.stdout.on('data',chunk=>{output+=chunk;const line=output.split('\n').find(line=>line.includes('"ready":true'));if(line){clearTimeout(timeout);try{resolve(JSON.parse(line).url)}catch(error){reject(error)}}});
  child.once('error',reject);child.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Native exited ${code}: ${stderr}`))});
});
let token='';const notes=[];let browser;
async function api(route,method='GET',payload,headers={}){
  const response=await fetch(`${base}/api${route}`,{method,headers:{'Content-Type':'application/json',...(token?{'X-LocalSpace-Token':token}:{}),...headers},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
  return {status:response.status,data:await response.json()};
}
try{
  let state=(await api('/state')).data;token=state.token;
  assert.equal(state.desktop,true);assert.equal(state.projects.length,0);assert.equal(state.dataDirectory,dataDirectory);
  assert.equal((await api('/projects','POST',{path:first},{'X-LocalSpace-Token':''})).status,403);
  assert.equal((await api('/state','GET',undefined,{Origin:'https://example.com'})).status,403);
  assert.equal((await api('/projects','POST',{path:path.join(root,'missing')})).status,400);
  notes.push('独立 exe 启动原生本地服务，拒绝外站来源和缺少令牌的写操作');

  const scan=(await api('/scan','POST',{roots:[fixtures],maxDepth:3})).data;
  assert.equal(scan.projects.length,2);assert.equal(scan.projects.find(p=>p.name.startsWith('中文')).categoryId,'frontend');
  const ids=scan.projects.map(p=>p.id);
  const imported=await api('/import','POST',{scanId:scan.scanId,ids});
  assert.equal(imported.data.added,2);
  assert.equal((await api('/import','POST',{scanId:scan.scanId,ids})).data.added,0);
  assert.equal((await api('/import','POST',{scanId:'expired',ids})).status,410);
  const duplicate=await Promise.all([api('/projects','POST',{path:first}),api('/projects','POST',{path:first})]);
  assert.ok(duplicate.every(item=>item.status===409));
  notes.push('中文和特殊字符路径识别、扫描导入、并发重复登记和预览过期处理');

  const category=(await api('/categories','POST',{name:'原生分类',color:'blue'})).data.category;
  const project=imported.data.state.projects.find(p=>p.categoryId==='frontend');
  assert.equal((await api(`/projects/${project.id}`,'PATCH',{categoryId:category.id,starred:true,archived:true})).status,200);
  assert.equal((await api(`/projects/${project.id}/open`,'POST',{action:'arbitrary'})).status,400);
  assert.equal((await api(`/categories/${category.id}`,'DELETE')).status,200);
  assert.equal((await api('/categories/other','DELETE')).status,400);
  const updated=(await api('/state')).data.projects.find(p=>p.id===project.id);
  assert.equal(updated.categoryId,'other');assert.equal(updated.starred,true);assert.equal(updated.archived,true);
  await api(`/projects/${project.id}`,'PATCH',{archived:false});
  notes.push('分类创建与删除、星标归档、原生数据持久化');

  const third=path.join(root,'agent-added');await mkdir(third);
  const cli=await promisify(execFile)(executable,['add',third,'--name','AI 直接调用 exe','--category','tools','--url',base],{windowsHide:true});
  assert.equal(JSON.parse(cli.stdout).project.source,'agent');
  const list=await promisify(execFile)(executable,['list','--url',base],{windowsHide:true});
  assert.equal(JSON.parse(list.stdout).projects.length,3);
  notes.push('外部 AI 直接调用 exe 添加、列出项目，无需 Node.js');

  const saved=JSON.parse(await readFile(path.join(dataDirectory,'workspace.json'),'utf8'));
  assert.equal(saved.projects.length,3);
  assert.equal((await stat(path.join(first,'package.json'))).isFile(),true);
  const pageHtml=await (await fetch(base)).text();assert.match(pageHtml,/LocalSpace/);
  assert.ok(!pageHtml.includes('node_modules'));
  browser=await chromium.launch({headless:true,executablePath:process.env.LOCALSPACE_CHROMIUM||undefined});
  const context=await browser.newContext({locale:'en-US',viewport:{width:1140,height:760},reducedMotion:'reduce'});
  const page=await context.newPage();await page.goto(base);
  await expect(page.locator('.project-row')).toHaveCount(3);
  await expect(page.locator('h1')).toHaveText('All projects');
  await expect(page.locator('html')).toHaveAttribute('lang','en');
  const a11y=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  if(a11y.violations.length)await writeFile('artifacts/native-a11y.json',JSON.stringify(a11y.violations,null,2));
  assert.deepEqual(a11y.violations.map(item=>({id:item.id,nodes:item.nodes.map(node=>({target:node.target,summary:node.failureSummary}))})),[]);
  await page.locator('[data-action="integration"]').click();
  await expect(page.locator('#app-dialog pre')).toContainText('LocalSpace.exe');
  assert.ok(!(await page.locator('#app-dialog pre').innerText()).includes('node '));
  await expect(page.locator('#app-dialog pre')).toContainText('Add existing projects');
  await page.keyboard.press('Escape');
  await page.locator('[data-action="language"]').click();
  await expect(page.locator('h1')).toHaveText('全部项目');
  notes.push('exe 内嵌界面、原生 AI 命令说明和 WCAG AA 检查');
  await api(`/projects/${project.id}`,'DELETE');assert.equal((await stat(first)).isDirectory(),true);
  const result={ok:true,checks:notes,exeBytes:(await stat(executable)).size};
  await writeFile('artifacts/native-verification.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}finally{
  if(browser)await browser.close();
  child.kill();
  await new Promise(resolve=>child.once('exit',resolve));
}
