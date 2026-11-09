import type { Project, Workspace } from './types';
import { escape as e, icon, relativeTime } from './ui';

export interface ViewState {
  nav: string; query: string; filter: string; view: 'grid' | 'list'; sort: string; page: number;
}
export function navName(workspace: Workspace, nav: string): string {
  return ({ all: '全部项目', starred: '星标项目', recent: '最近打开', archive: '已归档' })[nav]
    || workspace.categories.find((category) => category.id === nav)?.name || '全部项目';
}
export function filteredProjects(workspace: Workspace, ui: ViewState): Project[] {
  const query = ui.query.trim().toLocaleLowerCase();
  return workspace.projects.filter((project) => {
    if (ui.nav === 'archive' ? !project.archived : project.archived) return false;
    if (ui.nav === 'starred' && !project.starred) return false;
    if (ui.nav === 'recent' && !project.lastOpenedAt) return false;
    if (!['all', 'starred', 'recent', 'archive'].includes(ui.nav) && project.categoryId !== ui.nav) return false;
    if (ui.filter && project.categoryId !== ui.filter) return false;
    return !query || [project.name, project.path, project.description, project.language, ...project.tags].join(' ').toLocaleLowerCase().includes(query);
  }).sort((a, b) => {
    if (ui.sort === 'name') return a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
    if (ui.nav === 'recent' || ui.sort === 'opened') return (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || '');
    if (ui.sort === 'added') return b.addedAt.localeCompare(a.addedAt);
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}
export function sidebar(workspace: Workspace, ui: ViewState): string {
  const active = workspace.projects.filter((project) => !project.archived);
  const navItem = (value: string, label: string, glyph: string, count?: number) => `<button class="nav-item ${ui.nav === value ? 'active' : ''}" data-action="nav" data-value="${e(value)}" ${ui.nav === value ? 'aria-current="page"' : ''}>${icon(glyph, 17)}<span>${label}</span>${count ? `<span class="nav-count">${count}</span>` : ''}</button>`;
  const categories = workspace.categories.filter(category => active.some(project => project.categoryId === category.id) || !['frontend','backend','tools','game','mobile','other'].includes(category.id));
  return `<a class="brand" href="#" aria-label="栖点首页" data-action="nav" data-value="all">${icon('folder', 23)}<strong>栖点</strong><span>LocalSpace</span></a>
    <nav aria-label="项目导航" class="nav-group">${navItem('all', '全部项目', 'grid', active.length)}${navItem('starred', '星标项目', 'star')}${navItem('recent', '最近打开', 'clock')}</nav>
    <div class="category-heading"><button data-action="manage-categories" title="管理分类">分类</button><button class="mini-icon" data-action="add-category" title="新建分类" aria-label="新建分类">${icon('plus', 16)}</button></div>
    <nav aria-label="项目分类" class="nav-group categories">${categories.map(category => `<button class="nav-item ${ui.nav === category.id ? 'active' : ''}" data-action="nav" data-value="${e(category.id)}" ${ui.nav === category.id ? 'aria-current="page"' : ''}><span class="category-dot ${e(category.color)}"></span><span>${e(category.name)}</span></button>`).join('')}</nav>
    <div class="sidebar-bottom">${navItem('archive','已归档','archive')}<button class="nav-item" data-action="integration">${icon('link',17)}<span>AI 接入</span></button><button class="nav-item settings-nav" data-action="settings">${icon('settings',17)}<span>设置</span></button><div class="local-note"><span class="status-dot"></span>保存在本机<button class="mini-icon" data-action="help" aria-label="使用帮助与快捷键" title="使用帮助">${icon('help',15)}</button></div></div>`;
}
export function topbar(_workspace: Workspace, _ui: ViewState, dark: boolean): string {
  return `<div class="breadcrumbs"><button class="icon-button mobile-menu" data-action="mobile-menu" aria-label="打开导航" aria-expanded="false">${icon('menu',20)}</button><span>本地工作空间</span></div><div class="topbar-actions"><span class="connection-state"><span class="status-dot"></span><span id="connection-label">已连接</span></span><button class="icon-button" data-action="theme" aria-label="${dark ? '切换浅色外观' : '切换深色外观'}" title="${dark ? '浅色外观' : '深色外观'}">${icon(dark ? 'sun' : 'moon',17)}</button></div>`;
}
export function mainView(workspace: Workspace, ui: ViewState): string {
  return `<div class="page-heading"><div class="page-title"><h1>${e(navName(workspace,ui.nav))}</h1><span class="count-pill" id="project-count">${filteredProjects(workspace,ui).length}</span></div><div class="heading-actions"><button class="button secondary" data-action="scan">${icon('scan',16)}扫描目录</button><button class="button primary" data-action="add-project">${icon('plus',16)}添加项目</button></div></div>
    <section class="project-section" aria-label="项目列表"><div class="project-toolbar"><div class="search-box">${icon('search',17)}<input id="project-search" type="search" autocomplete="off" placeholder="搜索项目…" aria-label="搜索项目" value="${e(ui.query)}"/><kbd>Ctrl K</kbd></div><label class="sort-control"><span class="sr-only">项目排序</span><select id="project-sort">${[['updated','最近更新'],['added','最近添加'],['name','名称排序'],['opened','最近打开']].map(([value,label])=>`<option value="${value}" ${ui.sort===value?'selected':''}>${label}</option>`).join('')}</select></label></div><div id="project-results">${projectResults(workspace,ui)}</div></section>`;
}
function projectRow(project: Project, workspace: Workspace): string {
  const category = workspace.categories.find(item => item.id === project.categoryId);
  const id = e(project.id);
  const terminal = workspace.settings.terminal;
  return `<article role="row" class="project-card project-row" data-project="${id}"><div role="cell" class="project-cell"><span class="row-folder">${icon('folder',21)}</span><div class="card-info"><h2><button data-action="edit-project" data-id="${id}" title="${e(project.name)}">${e(project.name)}</button></h2><span class="project-path" title="${e(project.path)}">${e(project.path)}</span></div><button class="icon-button star-button ${project.starred?'is-starred':''}" data-action="star" data-id="${id}" aria-label="${project.starred?'取消星标':'收藏'} ${e(project.name)}" aria-pressed="${project.starred}" title="${project.starred?'取消星标':'添加星标'}">${icon('star',15)}</button></div><div role="cell" class="row-category"><span class="category-dot ${e(category?.color||'slate')}"></span><span>${e(category?.name||'其他项目')}</span></div><div role="cell" class="project-time" title="更新于 ${e(new Date(project.updatedAt).toLocaleString('zh-CN'))}">${e(relativeTime(project.updatedAt))}</div><div role="cell" class="card-actions"><button class="row-action" data-action="open" data-id="${id}" data-value="folder" title="打开项目文件夹" aria-label="打开 ${e(project.name)} 的文件夹">${icon('folderOpen',16)}<span>文件夹</span></button><div class="terminal-actions"><button class="row-action" data-action="open" data-id="${id}" data-value="${terminal}" title="在项目目录打开 ${terminal==='cmd'?'CMD':'PowerShell'}" aria-label="在 ${e(project.name)} 打开 ${terminal==='cmd'?'CMD':'PowerShell'}">${icon('command',17)}<span>终端</span></button><details class="dropdown terminal-dropdown"><summary class="terminal-chevron" aria-label="选择 ${e(project.name)} 的终端">${icon('down',11)}</summary><div class="dropdown-menu"><button data-action="open" data-id="${id}" data-value="powershell">${icon('terminal',15)}PowerShell</button><button data-action="open" data-id="${id}" data-value="cmd">${icon('command',15)}CMD 命令提示符</button></div></details></div><details class="dropdown project-menu"><summary class="icon-button" aria-label="${e(project.name)} 的更多操作" title="更多操作">${icon('more',18)}</summary><div class="dropdown-menu"><button data-action="edit-project" data-id="${id}">${icon('edit',15)}编辑项目信息</button><button data-action="copy-path" data-id="${id}">${icon('copy',15)}复制项目路径</button><button data-action="archive-project" data-id="${id}">${icon(project.archived?'refresh':'archive',15)}${project.archived?'恢复到项目库':'归档项目'}</button><div class="menu-divider"></div><button class="danger-text" data-action="remove-project" data-id="${id}">${icon('trash',15)}从面板移除</button></div></details></div></article>`;
}
export function projectResults(workspace: Workspace, ui: ViewState): string {
  const projects=filteredProjects(workspace,ui);
  const size=24;
  const pages=Math.max(1,Math.ceil(projects.length/size));
  ui.page=Math.min(ui.page,pages);
  if(!projects.length){
    const searching=!!ui.query||!!ui.filter;
    const title=searching?'没有找到项目':ui.nav==='starred'?'还没有星标项目':ui.nav==='recent'?'还没有打开记录':ui.nav==='archive'?'暂无归档项目':'添加你的第一个项目';
    const description=searching?'换个关键词，或清除搜索后重试。':ui.nav==='starred'?'点击项目旁的星标，方便下次找到。':ui.nav==='recent'?'打开过的项目会出现在这里。':ui.nav==='archive'?'归档的项目会保留在这里。':'扫描一个本地目录，或添加已有的文件夹。';
    return `<div class="empty-state"><span>${icon(searching?'search':'folder',30)}</span><h2>${title}</h2><p>${description}</p>${searching?'<button class="button secondary" data-action="clear-search">清除搜索与筛选</button>':!['starred','recent','archive'].includes(ui.nav)?`<button class="button primary" data-action="scan">${icon('scan',16)}扫描目录</button>`:''}</div>`;
  }
  const start=(ui.page-1)*size;
  return `<div class="project-table" role="table" aria-label="本地项目"><div role="row" class="table-head"><span role="columnheader">项目</span><span role="columnheader" class="category-column">分类</span><span role="columnheader" class="time-column">最近更新</span><span role="columnheader" class="action-column">打开</span></div>${projects.slice(start,start+size).map(project=>projectRow(project,workspace)).join('')}</div><div class="results-footer"><span>共 ${projects.length} 个项目${pages>1?` · ${start+1}–${Math.min(start+size,projects.length)}`:''}</span>${pages>1?`<div class="pagination"><button class="icon-button" data-action="page" data-value="${ui.page-1}" ${ui.page===1?'disabled':''} aria-label="上一页">${icon('chevron',14,'rotate-180')}</button><span>${ui.page} / ${pages}</span><button class="icon-button" data-action="page" data-value="${ui.page+1}" ${ui.page===pages?'disabled':''} aria-label="下一页">${icon('chevron',14)}</button></div>`:''}</div>`;
}
