import './styles.css';
import { applyLocale, categoryName, getLocale, localizeMessage, setLocale, t, type Locale } from './i18n';
import type { Category, CategoryColor, Project, ScanResult, Workspace } from './types';
import { loadWorkspace, request } from './api';
import { escape as e, icon } from './ui';
import { filteredProjects, mainView, navName, projectResults, sidebar, topbar, type ViewState } from './views';

const app = document.querySelector<HTMLDivElement>('#root')!;
const colors: CategoryColor[] = ['blue', 'green', 'amber', 'purple', 'pink', 'slate', 'coral'];
const colorNames = ['海蓝', '松绿', '暖金', '紫罗兰', '玫瑰', '岩灰', '陶橙'] as const;
applyLocale();
let workspace: Workspace;
let dark = localStorage.getItem('localspace-theme') === 'dark';
document.documentElement.dataset.theme = dark ? 'dark' : 'light';
const ui: ViewState = { nav: decodeURIComponent(location.hash.slice(2)) || 'all', query: '', filter: '', view: 'list', sort: 'updated', page: 1 };
let lastSnapshot = '';
let refreshing = false;
let scanAbort: AbortController | null = null;
let scanTimer: ReturnType<typeof setInterval> | undefined;
let currentScan: ScanResult | null = null;
let modalId = '';
let returnFocus: HTMLElement | null = null;
let mobileOpen = false;

document.body.insertAdjacentHTML('beforeend', '<dialog id="app-dialog" aria-labelledby="dialog-title"></dialog><div id="toasts" class="toasts" role="status" aria-live="polite" aria-atomic="false"></div>');
const dialog = document.querySelector<HTMLDialogElement>('#app-dialog')!;
const toasts = document.querySelector<HTMLDivElement>('#toasts')!;

function toast(message: string, error = false) {
  const item = document.createElement('div');
  item.className = `toast ${error ? 'toast-error' : ''}`;
  item.innerHTML = `${icon(error ? 'help' : 'check', 18)}<span>${e(message)}</span><button aria-label="${t('关闭提示')}">${icon('x', 15)}</button>`;
  item.querySelector('button')!.onclick = () => item.remove();
  toasts.append(item);
  while (toasts.children.length > 3) toasts.firstElementChild?.remove();
  setTimeout(() => item.remove(), error ? 6500 : 4000);
}
function render() {
  const focus = document.activeElement as HTMLElement | null;
  const focusId = focus?.id;
  const focusAction = focus?.dataset.action;
  const focusProject = focus?.dataset.id;
  const selection = focus instanceof HTMLInputElement && focus.type === 'search' ? [focus.selectionStart, focus.selectionEnd] : null;
  if (!app.querySelector('.app-layout')) app.innerHTML = `<a class="skip-link" href="#main-content">${t('跳转到项目内容')}</a><div class="app-layout"><aside id="sidebar" class="sidebar" aria-label="${t('工作空间侧边栏')}"></aside><button class="sidebar-backdrop" data-action="close-sidebar" aria-label="${t('关闭导航')}"></button><div class="app-main"><header id="topbar" class="topbar"></header><main id="main-content" class="main-content" tabindex="-1"></main></div></div>`;
  app.querySelector('#sidebar')!.innerHTML = sidebar(workspace, ui);
  app.querySelector('#topbar')!.innerHTML = topbar(workspace, ui, dark);
  app.querySelector('#main-content')!.innerHTML = mainView(workspace, ui);
  app.querySelector('.app-layout')!.classList.toggle('sidebar-is-open', mobileOpen);
  document.title = `${navName(workspace, ui.nav)} · ${t('栖点 LocalSpace')}`;
  app.querySelector('.skip-link')!.textContent = t('跳转到项目内容');
  app.querySelector('#sidebar')!.setAttribute('aria-label', t('工作空间侧边栏'));
  app.querySelector('.sidebar-backdrop')!.setAttribute('aria-label', t('关闭导航'));
  const restore = focusId ? document.getElementById(focusId) : focusAction && focusProject ? app.querySelector<HTMLElement>(`[data-action="${CSS.escape(focusAction)}"][data-id="${CSS.escape(focusProject)}"]`) : null;
  setMobileState();
  restore?.focus({ preventScroll: true });
  if (selection && restore instanceof HTMLInputElement) restore.setSelectionRange(selection[0], selection[1]);
}
function changeLanguage(locale: Locale) {
  setLocale(locale);
  toasts.replaceChildren();
  if (workspace) render();
}
function renderResults() {
  app.querySelector('#project-results')!.innerHTML = projectResults(workspace, ui);
  app.querySelector('#project-count')!.textContent = String(filteredProjects(workspace, ui).length);
}
function setWorkspace(next: Workspace) {
  workspace = next;
  lastSnapshot = JSON.stringify(next);
  if (!['all', 'starred', 'recent', 'archive'].includes(ui.nav) && !workspace.categories.some((category) => category.id === ui.nav)) ui.nav = 'all';
  render();
}
async function refresh() {
  if (refreshing || document.hidden || dialog.open) return;
  refreshing = true;
  try {
    const next = await loadWorkspace();
    if (JSON.stringify(next) !== lastSnapshot) setWorkspace(next);
    const status = document.getElementById('connection-label');
    if (status) { status.textContent = t('已连接'); status.closest('.connection-state')?.classList.remove('disconnected'); }
  } catch {
    const status = document.getElementById('connection-label');
    if (status) { status.textContent = t('本地服务已断开'); status.closest('.connection-state')?.classList.add('disconnected'); }
  } finally { refreshing = false; }
}
function navigate(value: string) {
  ui.nav = value; ui.filter = ''; ui.query = ''; ui.page = 1; mobileOpen = false;
  location.hash = `/${encodeURIComponent(value)}`;
  render();
  document.querySelector<HTMLElement>('#main-content')?.focus({ preventScroll: true });
}
function closeModal() { dialog.close(); returnFocus?.focus({ preventScroll: true }); }
function showModal(type: string, title: string, subtitle: string, content: string, footer = '', wide = false) {
  if (!dialog.open) returnFocus = document.activeElement as HTMLElement;
  dialog.dataset.type = type;
  dialog.className = wide ? 'wide-dialog' : '';
  dialog.innerHTML = `<form id="modal-form"><header class="dialog-header"><div><h2 id="dialog-title">${e(title)}</h2><p>${e(subtitle)}</p></div><button type="button" class="icon-button" data-action="close-modal" aria-label="${t('关闭弹窗')}">${icon('x', 21)}</button></header><div class="dialog-body">${content}<p class="form-error" role="alert" tabindex="-1" hidden></p></div>${footer ? `<footer class="dialog-footer">${footer}</footer>` : ''}</form>`;
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => dialog.querySelector<HTMLElement>('[autofocus]')?.focus());
}
const cancelButton = () => `<button type="button" class="button secondary" data-action="close-modal">${t('取消')}</button>`;
const submitButton = (label: string, glyph = 'check') => `<button type="submit" class="button primary">${icon(glyph, 17)}${e(label)}</button>`;
function categoryOptions(selected?: string) {
  return workspace.categories.map((category) => `<option value="${e(category.id)}" ${selected === category.id ? 'selected' : ''}>${e(categoryName(category))}</option>`).join('');
}
function projectModal(project?: Project) {
  modalId = project?.id || '';
  showModal(project ? 'edit-project' : 'add-project', project ? t('编辑项目') : t('添加项目'), project ? t('修改项目的基本信息。') : t('选择已有的项目文件夹。'), `
    <label class="field-label" for="project-path-input">${t('项目文件夹')} <span>*</span></label><div class="input-with-action"><input id="project-path-input" name="path" value="${e(project?.path || '')}" placeholder="${t('例如 E:\\Projects\\my-project')}" required autofocus/><button type="button" class="button secondary" data-action="choose-directory" data-target="project-path-input">${icon('folderOpen', 17)}${t('浏览')}</button></div><p class="field-hint">${t('使用完整的本地路径，添加过程不会改动项目文件。')}</p>
    <label class="field-label" for="project-name-input">${t('项目名称')}${project ? ' <span>*</span>' : ''}</label><input id="project-name-input" name="name" maxlength="100" value="${e(project?.name || '')}" placeholder="${t('留空则使用文件夹名称')}" ${project ? 'required' : ''}/>
    <div class="form-row"><div><label class="field-label" for="project-category-input">${t('项目分类')}</label><select id="project-category-input" name="categoryId">${!project ? `<option value="" selected>${t('自动识别')}</option>` : ''}${categoryOptions(project?.categoryId)}</select></div><div><label class="field-label" for="project-tags-input">${t('技术标签')}</label><input id="project-tags-input" name="tags" value="${e(project?.tags.join(', ') || '')}" placeholder="React, TypeScript"/></div></div>
    <label class="field-label" for="project-description-input">${t('项目简介')}</label><textarea id="project-description-input" name="description" rows="3" maxlength="300" placeholder="${t('用一句话介绍这个项目…')}">${e(project?.description || '')}</textarea>${project?.branch ? `<p class="field-hint branch-hint">${icon('branch', 14)} ${e(t('当前分支：{branch}', {branch: project.branch}))}</p>` : ''}`, `${cancelButton()}${submitButton(project ? t('保存修改') : t('添加项目'), project ? 'check' : 'plus')}`);
}
function scanModal() {
  currentScan = null;
  showModal('scan', t('扫描目录'), t('识别本地项目，预览后选择添加。'), `
    <div class="info-note">${icon('shield', 19)}<span>${t('全部在本地完成，只读取项目标识与基本信息。')}</span></div><label class="field-label" for="scan-roots">${t('扫描目录')} <span>*</span></label><div class="textarea-action"><textarea id="scan-roots" name="roots" rows="3" spellcheck="false" placeholder="${t('每行一个完整目录，如 E:\\Projects')}" required autofocus>${e(workspace.settings.roots.join('\n'))}</textarea><button type="button" class="button text-button" data-action="choose-directory" data-target="scan-roots">${icon('folderOpen', 16)}${t('选择文件夹')}</button></div><p class="field-hint">${t('支持多个目录，每行一个。项目内的依赖与构建目录会自动跳过。')}</p>
    <label class="field-label" for="scan-depth">${t('扫描深度')}</label><select id="scan-depth" name="maxDepth">${Array.from({ length: 7 }, (_, index) => `<option value="${index}" ${workspace.settings.maxDepth === index ? 'selected' : ''}>${index === 0 ? t('仅当前目录') : t('向下 {count} 层', {count: index})}${index === 3 ? t('（推荐）') : ''}</option>`).join('')}</select><div class="scan-markers"><span>${t('识别标识')}</span><code>.git</code><code>package.json</code><code>pom.xml</code><code>pyproject.toml</code><span>${t('等')}</span></div>`, `${cancelButton()}${submitButton(t('开始扫描'), 'scan')}`);
}
function scanResultsModal(scan: ScanResult) {
  currentScan = scan;
  const fresh = scan.projects.filter((project) => !project.imported);
  const existing = scan.projects.length - fresh.length;
  const summary = t('检查了 {directories} 个目录，发现 {count} 个新项目。', {directories: scan.directoryCount, count: fresh.length});
  showModal('import', t('扫描结果'), summary + (existing ? ` ${t('另有 {count} 个已添加。', {count: existing})}` : ''), `
    ${scan.warnings.length ? `<div class="warning-note">${icon('help', 18)}<div>${scan.warnings.map((warning) => `<p>${e(localizeMessage(warning))}</p>`).join('')}</div></div>` : ''}
    ${scan.projects.length ? `<div class="scan-selection-bar"><label class="checkbox-label"><input type="checkbox" id="select-all" ${fresh.length ? 'checked' : 'disabled'}/>${t('全选新项目')}</label><span id="selected-count">${t('已选择 {count} 个项目', {count: fresh.length})}</span></div><div class="scan-results">${scan.projects.map((project) => {
      const category = workspace.categories.find((item) => item.id === project.categoryId);
      return `<label class="scan-result ${project.imported ? 'already-imported' : ''}"><input type="checkbox" name="candidate" value="${e(project.id)}" ${project.imported ? 'disabled' : 'checked'}/><span class="scan-project-icon ${e(category?.color || 'slate')}">${icon('folder', 19)}</span><span class="scan-result-info"><strong>${e(project.name)}</strong><span title="${e(project.path)}">${e(project.path)}</span></span>${project.imported ? `<span class="imported-label">${t('已添加')}</span>` : `<span class="category-badge ${e(category?.color || 'slate')}">${e(categoryName(category))}</span>`}</label>`;
    }).join('')}</div>` : `<div class="compact-empty">${icon('folder', 32)}<h3>${t('这个目录里还没有识别到项目')}</h3><p>${t('试试增大扫描深度，或直接手动添加文件夹。')}</p></div>`}`, `<button type="button" class="button secondary" data-action="scan">${t('重新扫描')}</button>${fresh.length ? submitButton(t('导入 {count} 个项目', {count: fresh.length}), 'plus') : `<button type="button" class="button primary" data-action="close-modal">${t('完成')}</button>`}`, true);
}
function categoryModal(category?: Category) {
  modalId = category?.id || '';
  showModal(category ? 'edit-category' : 'add-category', category ? t('编辑分类') : t('给项目一个新分类'), t('按用途、技术栈，或者你喜欢的方式来整理。'), `<label class="field-label" for="category-name">${t('分类名称')} <span>*</span></label><input id="category-name" name="name" maxlength="30" value="${e(category?.name || '')}" placeholder="${t('例如：个人实验、客户项目…')}" required autofocus/><span class="field-label">${t('标记颜色')}</span><div class="color-options">${colors.map((color, index) => `<label class="color-option ${color}" title="${t(colorNames[index])}"><input type="radio" name="color" value="${color}" ${color === (category?.color || 'blue') ? 'checked' : ''} aria-label="${t(colorNames[index])}"/><span>${icon('check', 17)}</span></label>`).join('')}</div>`, `${cancelButton()}${submitButton(category ? t('保存分类') : t('创建分类'), category ? 'check' : 'plus')}`);
}
function manageCategoriesModal() {
  showModal('manage-categories', t('管理项目分类'), t('每个项目都有自己的位置。删除分类后，项目会移入「其他项目」。'), `<div class="category-management">${workspace.categories.map((category) => `<div class="category-management-row"><span class="category-dot ${e(category.color)}"></span><strong>${e(categoryName(category))}</strong><span>${t('共 {count} 个项目', {count: workspace.projects.filter((project) => project.categoryId === category.id).length})}</span><button type="button" class="icon-button" data-action="edit-category" data-id="${e(category.id)}" aria-label="${e(t('编辑 {name}', {name: categoryName(category)}))}">${icon('edit', 17)}</button>${category.id !== 'other' ? `<button type="button" class="icon-button danger-text" data-action="delete-category" data-id="${e(category.id)}" aria-label="${e(t('删除 {name}', {name: categoryName(category)}))}">${icon('trash', 17)}</button>` : '<span class="reserved-icon-space"></span>'}</div>`).join('')}</div>`, `<button type="button" class="button secondary" data-action="close-modal">${t('完成')}</button><button type="button" class="button primary" data-action="add-category">${t('新建分类')}</button>`);
}
function settingsModal() {
  showModal('settings', t('偏好设置'), t('让工作台更贴合你的习惯。'), `<label class="field-label" for="interface-language">${t('界面语言')}</label><select id="interface-language" name="locale"><option value="en" lang="en" ${getLocale() === 'en' ? 'selected' : ''}>English</option><option value="zh-CN" lang="zh-CN" ${getLocale() === 'zh-CN' ? 'selected' : ''}>简体中文</option></select><p class="field-hint">${t('语言仅影响界面，不会修改你的项目资料。')}</p><label class="field-label" for="default-terminal">${t('默认终端')}</label><select id="default-terminal" name="terminal"><option value="powershell" ${workspace.settings.terminal === 'powershell' ? 'selected' : ''}>PowerShell</option><option value="cmd" ${workspace.settings.terminal === 'cmd' ? 'selected' : ''}>${t('CMD 命令提示符')}</option></select><p class="field-hint">${t('项目列表的「终端」按钮会使用这个选项，也可从旁边菜单随时切换。')}</p><label class="field-label" for="settings-roots">${t('常用扫描目录')}</label><textarea id="settings-roots" name="roots" rows="4" spellcheck="false" required>${e(workspace.settings.roots.join('\n'))}</textarea><p class="field-hint">${t('每行一个完整目录，最多 12 个。扫描时会自动填入。')}</p><div class="settings-local-note">${icon('shield', 20)}<div><strong>${t('数据留在你的电脑')}</strong><p>${e(t('项目记录保存在 {path}。', {path: workspace.dataDirectory || `${workspace.workspaceRoot}\\.localspace`}))}</p></div></div>`, `${cancelButton()}${submitButton(t('保存偏好'))}`);
}
function agentCommand() {
  return workspace.desktop && workspace.executablePath
    ? `& "${workspace.executablePath}"`
    : `node "${workspace.workspaceRoot}\\scripts\\localspace.mjs"`;
}
function integrationInstruction() {
  const command = agentCommand();
  if (getLocale() === 'en') return `Add existing projects from the directories I specify to LocalSpace.\nFirst run ${command} categories to inspect categories, then ${command} list to avoid duplicates.\nTo add a project:\n${command} add "absolute project path" --category "category ID or name" --description "short description" --tags "React,TypeScript"\nRegister existing projects only. Do not create, modify, or delete project files. Keep LocalSpace open while running commands.`;
  return `请将我指定目录中的已有项目添加到栖点工作台。\n先执行 ${command} categories 查看分类，执行 ${command} list 避免重复。\n添加命令：\n${command} add "项目绝对路径" --category "分类ID或名称" --description "简短简介" --tags "技术栈1,技术栈2"\n只登记已有项目，不创建、修改或删除项目文件。执行时保持栖点窗口打开。`;
}
function integrationModal() {
  showModal('integration', t('AI 接入'), t('让能执行本机命令的 AI 助手添加已有项目。'), `<p class="integration-description">${t('不内置模型，不需要 API Key。复制下面的说明，告诉 AI 要整理的目录。')}</p><div class="code-panel"><div><span>${t('给 AI 助手的说明')}</span><button type="button" class="copy-code" data-action="copy-instruction">${icon('copy', 14)}${t('复制')}</button></div><pre>${e(integrationInstruction())}</pre></div><p class="field-hint">${t('保持工作台打开。添加成功后，列表会自动刷新。')}</p>`, `<button type="button" class="button secondary" data-action="close-modal">${t('关闭')}</button><button type="button" class="button primary" data-action="copy-instruction">${t('复制说明')}</button>`, true);
}
function helpModal() {
  showModal('help', t('一点帮助，马上上手'), t('让找项目这件事，简单一点。'), `<div class="help-items"><div>${icon('scan', 23)}<span><strong>${t('扫描已有项目')}</strong><p>${t('选择常用目录，预览并勾选需要添加的项目。一个仓库作为一个项目导入。')}</p></span></div><div>${icon('folderOpen', 23)}<span><strong>${t('一键继续工作')}</strong><p>${t('列表中的「文件夹」打开资源管理器，「终端」打开项目目录的 PowerShell 或 CMD。')}</p></span></div><div>${icon('link', 23)}<span><strong>${t('让外部 AI 帮你添加')}</strong><p>${t('在侧边栏打开 AI 助手接入，复制本地命令说明给你常用的 AI 工具。')}</p></span></div></div><div class="shortcut-list"><div><span>${t('搜索项目')}</span><span><kbd>Ctrl</kbd> + <kbd>K</kbd> ${t('或')} <kbd>/</kbd></span></div><div><span>${t('关闭弹窗')}</span><kbd>Esc</kbd></div><div><span>${t('打开使用帮助')}</span><kbd>?</kbd></div></div>`, `<button type="button" class="button primary" data-action="close-modal">${t('开始整理')}</button>`);
}
function confirmRemove(project: Project) {
  modalId = project.id;
  showModal('remove-project', t('从工作台移除项目？'), t('即将移除「{name}」的登记记录。', {name: project.name}), `<div class="info-note">${icon('shield', 21)}<span>${t('项目文件夹和其中的文件会完整保留。之后可以随时重新添加。')}</span></div><p class="confirm-path">${e(project.path)}</p>`, `${cancelButton()}<button type="submit" class="button danger">${icon('trash', 17)}${t('移除记录')}</button>`);
}
async function withButton(button: HTMLElement, action: () => Promise<void>) {
  const control = button as HTMLButtonElement;
  if (control.disabled) return;
  const previous = control.innerHTML;
  control.disabled = true;
  control.innerHTML = '<span class="spinner small-spinner"></span>';
  try { await action(); }
  finally { if (control.isConnected) { control.disabled = false; control.innerHTML = previous; } }
}
function projectById(id?: string) { return workspace.projects.find((project) => project.id === id); }
async function copy(value: string, message = t('已复制')) {
  try { await navigator.clipboard.writeText(value); toast(message); }
  catch { throw new Error(t('浏览器未允许剪贴板访问，请手动选择并复制文字。')); }
}
function updateSelection() {
  const boxes = [...dialog.querySelectorAll<HTMLInputElement>('input[name="candidate"]:not(:disabled)')];
  const count = boxes.filter((box) => box.checked).length;
  const selectAll = dialog.querySelector<HTMLInputElement>('#select-all');
  if (selectAll) { selectAll.checked = !!boxes.length && count === boxes.length; selectAll.indeterminate = count > 0 && count < boxes.length; }
  const label = dialog.querySelector('#selected-count');
  if (label) label.textContent = t('已选择 {count} 个项目', {count});
  const submit = dialog.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) { submit.disabled = count === 0; submit.innerHTML = `${icon('plus', 17)}${t('导入 {count} 个项目', {count})}`; }
}
function setMobileState() {
  const narrow = matchMedia('(max-width: 760px)').matches;
  const side = document.querySelector<HTMLElement>('#sidebar');
  const main = document.querySelector<HTMLElement>('.app-main');
  if (side) side.inert = narrow && !mobileOpen;
  if (main) main.inert = narrow && mobileOpen;
  app.querySelector('.app-layout')?.classList.toggle('sidebar-is-open', mobileOpen);
  app.querySelector('[data-action="mobile-menu"]')?.setAttribute('aria-expanded', String(mobileOpen));
}
document.addEventListener('click', async (event) => {
  const target = event.target as HTMLElement;
  const trigger = target.closest<HTMLElement>('[data-action]');
  if (!trigger) {
    document.querySelectorAll<HTMLDetailsElement>('.dropdown[open]').forEach((details) => { if (!details.contains(target)) details.open = false; });
    return;
  }
  if ((trigger as HTMLButtonElement).disabled) return;
  event.preventDefault();
  const action = trigger.dataset.action;
  const id = trigger.dataset.id;
  const value = trigger.dataset.value || '';
  const project = projectById(id);
  document.querySelectorAll<HTMLDetailsElement>('.dropdown[open]').forEach((details) => { details.open = false; });
  try {
    if (action === 'nav') navigate(value || 'all');
    if (action === 'mobile-menu') { mobileOpen = !mobileOpen; setMobileState(); }
    if (action === 'close-sidebar') { mobileOpen = false; setMobileState(); document.querySelector<HTMLElement>('[data-action="mobile-menu"]')?.focus(); }
    if (action === 'close-modal') closeModal();
    if (action === 'add-project') projectModal();
    if (action === 'edit-project' && project) projectModal(project);
    if (action === 'scan') scanModal();
    if (action === 'add-category') categoryModal();
    if (action === 'manage-categories') manageCategoriesModal();
    if (action === 'edit-category') categoryModal(workspace.categories.find((category) => category.id === id));
    if (action === 'delete-category') {
      const category = workspace.categories.find((item) => item.id === id);
      if (category) { modalId = category.id; showModal('delete-category', t('删除这个分类？'), t('「{name}」中的项目会移到「其他项目」。', {name: categoryName(category)}), `<p class="confirmation-copy">${t('项目记录和项目文件都将保留。')}</p>`, `${cancelButton()}<button type="submit" class="button danger">${t('删除分类')}</button>`); }
    }
    if (action === 'settings') settingsModal();
    if (action === 'integration') integrationModal();
    if (action === 'help') helpModal();
    if (action === 'copy-instruction') await copy(integrationInstruction(), t('说明已复制，可以发给你的 AI 助手了'));
    if (action === 'copy-path' && project) await copy(project.path, t('项目路径已复制'));
    if (action === 'language') { changeLanguage(getLocale() === 'en' ? 'zh-CN' : 'en'); app.querySelector<HTMLElement>('[data-action="language"]')?.focus(); }
    if (action === 'theme') {
      dark = !dark; localStorage.setItem('localspace-theme', dark ? 'dark' : 'light'); document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      app.querySelector('#topbar')!.innerHTML = topbar(workspace, ui, dark); setMobileState();
      app.querySelector<HTMLElement>('[data-action="theme"]')?.focus();
    }
    if (action === 'view') {
      ui.view = value === 'list' ? 'list' : 'grid'; localStorage.setItem('localspace-view', ui.view);
      render(); setMobileState();
    }
    if (action === 'filter') { ui.filter = value; ui.page = 1; render(); setMobileState(); }
    if (action === 'clear-search') { ui.query = ''; ui.filter = ''; ui.page = 1; render(); setMobileState(); document.getElementById('project-search')?.focus(); }
    if (action === 'page') { ui.page = Math.max(1, Number(value)); renderResults(); document.getElementById('project-results')?.scrollIntoView({ block: 'start' }); }
    if (action === 'star' && project) await withButton(trigger, async () => {
      const result = await request<{ state: Workspace }>(`/projects/${encodeURIComponent(project.id)}`, 'PATCH', { starred: !project.starred });
      setWorkspace(result.state); setMobileState();
      toast(project.starred ? t('已取消星标') : t('已添加到星标项目'));
    });
    if (action === 'archive-project' && project) await withButton(trigger, async () => {
      const result = await request<{ state: Workspace }>(`/projects/${encodeURIComponent(project.id)}`, 'PATCH', { archived: !project.archived });
      setWorkspace(result.state); setMobileState(); toast(project.archived ? t('项目已恢复到项目库') : t('项目已归档，可在「已归档」中恢复'));
    });
    if (action === 'remove-project' && project) confirmRemove(project);
    if (action === 'open' && project) await withButton(trigger, async () => {
      const result = await request<{ state: Workspace }>(`/projects/${encodeURIComponent(project.id)}/open`, 'POST', { action: value });
      setWorkspace(result.state); setMobileState(); toast(value === 'folder' ? t('已打开项目文件夹') : t('已在项目目录打开 {terminal}', {terminal: value === 'cmd' ? 'CMD' : 'PowerShell'}));
    });
    if (action === 'choose-directory') await withButton(trigger, async () => {
      const result = await request<{ path: string }>('/dialog/directory', 'POST', {locale: getLocale()});
      const field = document.getElementById(trigger.dataset.target!) as HTMLInputElement | HTMLTextAreaElement | null;
      if (result.path && field) { field.value = result.path; field.focus(); }
    });
    if (action === 'retry') await initialize();
  } catch (error) { toast(error instanceof Error ? localizeMessage(error.message) : t('操作未完成，请重试。'), true); }
});
document.addEventListener('input', (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id === 'project-search') { ui.query = input.value; ui.page = 1; renderResults(); }
});
document.addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id === 'project-sort') { ui.sort = input.value; ui.page = 1; renderResults(); }
  if (input.id === 'select-all') {
    dialog.querySelectorAll<HTMLInputElement>('input[name="candidate"]:not(:disabled)').forEach((box) => { box.checked = input.checked; }); updateSelection();
  }
  if (input.name === 'candidate') updateSelection();
});
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) {
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeModal();
  }
});
dialog.addEventListener('close', () => { scanAbort?.abort(); scanAbort = null; clearInterval(scanTimer); returnFocus?.focus({ preventScroll: true }); void refresh(); });
dialog.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = dialog.querySelector<HTMLFormElement>('form')!;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const type = dialog.dataset.type;
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!button || button.disabled) return;
  const previous = button.innerHTML;
  button.disabled = true; button.innerHTML = `<span class="spinner small-spinner"></span>${t('请稍候…')}`;
  const errorBox = form.querySelector<HTMLElement>('.form-error')!;
  errorBox.hidden = true;
  try {
    if (type === 'add-project' || type === 'edit-project') {
      const payload: Record<string, unknown> = { path: String(data.get('path')).trim() };
      for (const key of ['name', 'description', 'categoryId']) if (data.get(key) || type === 'edit-project') payload[key] = String(data.get(key) || '').trim();
      if (data.get('tags') || type === 'edit-project') payload.tags = String(data.get('tags') || '').split(',').map((tag) => tag.trim()).filter(Boolean);
      const result = await request<{ state: Workspace }>(type === 'add-project' ? '/projects' : `/projects/${encodeURIComponent(modalId)}`, type === 'add-project' ? 'POST' : 'PATCH', payload);
      closeModal(); setWorkspace(result.state); toast(type === 'add-project' ? t('项目已添加，欢迎来到工作空间') : t('项目信息已更新'));
    }
    if (type === 'scan') {
      const roots = String(data.get('roots') || '').split('\n').map((root) => root.trim()).filter(Boolean);
      const maxDepth = Number(data.get('maxDepth'));
      const abort = new AbortController(); scanAbort = abort;
      const started = Date.now();
      dialog.dataset.type = 'scan-loading';
      form.querySelector('.dialog-body')!.innerHTML = `<div class="scan-progress"><span class="scan-loader">${icon('scan', 36)}</span><h3>${t('正在扫描…')}</h3><p>${t('正在读取本地目录并识别项目，请稍候。')}</p><span id="scan-elapsed">${t('扫描耗时 {count} 秒', {count: 0})}</span><code>${e(roots.join(' · '))}</code></div><p class="form-error" role="alert" tabindex="-1" hidden></p>`;
      scanTimer = setInterval(() => { const elapsed = document.getElementById('scan-elapsed'); if (elapsed) elapsed.textContent = t('扫描耗时 {count} 秒', {count: Math.floor((Date.now() - started) / 1000)}); }, 1000);
      try {
        const scan = await request<ScanResult>('/scan', 'POST', { roots, maxDepth }, abort.signal);
        if (abort.signal.aborted) return;
        scanAbort = null; clearInterval(scanTimer);
        setWorkspace(await loadWorkspace());
        if (dialog.open) scanResultsModal(scan);
      } catch (error) {
        if (abort.signal.aborted) return;
        scanAbort = null; clearInterval(scanTimer); scanModal();
        (document.getElementById('scan-roots') as HTMLTextAreaElement).value = roots.join('\n');
        (document.getElementById('scan-depth') as HTMLSelectElement).value = String(maxDepth);
        throw error;
      }
    }
    if (type === 'import' && currentScan) {
      const ids = data.getAll('candidate').map(String);
      const result = await request<{ state: Workspace; added: number; skipped: number }>('/import', 'POST', { scanId: currentScan.scanId, ids });
      closeModal(); setWorkspace(result.state); toast(t('已添加 {count} 个项目', {count: result.added}) + (result.skipped ? ` · ${t('跳过 {count} 个重复或已移动项目', {count: result.skipped})}` : ''));
    }
    if (type === 'add-category' || type === 'edit-category') {
      const result = await request<{ state: Workspace }>(type === 'add-category' ? '/categories' : `/categories/${encodeURIComponent(modalId)}`, type === 'add-category' ? 'POST' : 'PATCH', { name: data.get('name'), color: data.get('color') });
      closeModal(); setWorkspace(result.state); toast(type === 'add-category' ? t('新分类已创建') : t('分类已更新'));
    }
    if (type === 'delete-category') {
      const result = await request<{ state: Workspace }>(`/categories/${encodeURIComponent(modalId)}`, 'DELETE');
      closeModal(); setWorkspace(result.state); toast(t('分类已移除，项目已移入「其他项目」'));
    }
    if (type === 'settings') {
      const roots = String(data.get('roots') || '').split('\n').map((root) => root.trim()).filter(Boolean);
      const result = await request<{ state: Workspace }>('/settings', 'PATCH', { roots, terminal: data.get('terminal') });
      closeModal(); changeLanguage(data.get('locale') === 'en' ? 'en' : 'zh-CN'); setWorkspace(result.state); toast(t('偏好设置已保存'));
    }
    if (type === 'remove-project') {
      const result = await request<{ state: Workspace }>(`/projects/${encodeURIComponent(modalId)}`, 'DELETE');
      closeModal(); setWorkspace(result.state); toast(t('已移除登记记录，项目文件保持原样'));
    }
  } catch (error) {
    const errorElement = dialog.querySelector<HTMLElement>('.form-error');
    if (errorElement) { errorElement.textContent = error instanceof Error ? localizeMessage(error.message) : t('操作未完成，请重试。'); errorElement.hidden = false; errorElement.focus(); }
  } finally {
    if (button.isConnected) { button.disabled = false; button.innerHTML = previous; }
    setMobileState();
  }
});
document.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement;
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !dialog.open) { event.preventDefault(); document.getElementById('project-search')?.focus(); }
  if (!typing && !dialog.open && event.key === '/') { event.preventDefault(); document.getElementById('project-search')?.focus(); }
  if (!typing && !dialog.open && event.key === '?') { event.preventDefault(); helpModal(); }
  if (event.key === 'Escape' && mobileOpen) { mobileOpen = false; setMobileState(); document.querySelector<HTMLElement>('[data-action="mobile-menu"]')?.focus(); }
});
window.addEventListener('hashchange', () => {
  const nav = decodeURIComponent(location.hash.slice(2)) || 'all';
  if (nav !== ui.nav) navigate(nav);
});
window.addEventListener('focus', () => void refresh());
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
window.addEventListener('resize', setMobileState);
async function initialize() {
  app.innerHTML = `<div class="initial-state"><span class="initial-brand">${icon('folder', 32)}</span><strong>${t('栖点 LocalSpace')}</strong><p>${t('正在打开你的本地工作空间…')}</p><span class="spinner"></span></div>`;
  try { setWorkspace(await loadWorkspace()); setMobileState(); }
  catch {
    app.innerHTML = `<div class="initial-state"><span class="initial-brand">${icon('desktop', 32)}</span><h1>${t('工作台还没连接上')}</h1><p>${t('请保持本地服务运行，然后重新连接。')}</p><code>npm run dev</code><button class="button primary" data-action="retry">${icon('refresh', 17)}${t('重新连接')}</button></div>`;
  }
}
void initialize();
setInterval(() => void refresh(), 8000);
