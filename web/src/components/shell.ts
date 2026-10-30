/**
 * 应用外壳：三栏布局骨架 + 顶栏 + 状态栏。
 *
 * 这一层只负责「位置」和「状态显示」，不碰业务：所有交互通过 handlers 回传 app.ts。
 * 这样做的好处是 app.ts 可以整体替换模块而不影响布局，布局改动也只影响本文件。
 */

import type { Job } from '../../../shared/types.ts';
import { COUNT_MODE_LABELS, WORK_MODE_LABELS } from '../../../shared/types.ts';
import type { PanelDef } from '../lib/contracts.ts';
import { formatTime, fmtNum, h } from '../lib/dom.ts';
import type { AppState, EditorSettings, RightPanelKind } from '../lib/store.ts';
import { totalWords } from '../lib/store.ts';
import {
  PRESET_NARROW,
  PRESET_WIDE,
  clampInspectorWidth,
  stepInspectorWidth,
} from '../lib/ui-prefs.ts';

// ─────────────────────── 图标 ───────────────────────
// 统一 16×16、stroke 1.7、currentColor。不用 emoji：跨平台渲染不一致，且压不住纸感。

const svg = (paths: string): string =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const ICONS: Record<string, string> = {
  chevronRight: svg('<path d="M6 3.5 10.5 8 6 12.5"/>'),
  chevronDown: svg('<path d="M3.5 6 8 10.5 12.5 6"/>'),
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  minus: svg('<path d="M3 8h10"/>'),
  x: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  check: svg('<path d="M3 8.5l3.2 3.2L13 4.8"/>'),
  dots: svg('<circle cx="3.2" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12.8" cy="8" r="1.1"/>'),
  sidebar: svg('<rect x="2" y="3" width="12" height="10" rx="1.6"/><path d="M6.5 3v10"/>'),
  inspector: svg('<rect x="2" y="3" width="12" height="10" rx="1.6"/><path d="M9.5 3v10"/>'),
  focus: svg('<path d="M6 2H3.5A1.5 1.5 0 0 0 2 3.5V6M10 2h2.5A1.5 1.5 0 0 1 14 3.5V6M6 14H3.5A1.5 1.5 0 0 1 2 12.5V10M10 14h2.5a1.5 1.5 0 0 0 1.5-1.5V10"/>'),
  search: svg('<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 14 14"/>'),
  command: svg('<path d="M6 3.2a1.6 1.6 0 1 0-1.6 1.6H6m0-1.6V6m0 0v4m0-4h4m0 0h1.6A1.6 1.6 0 1 1 10 6v0"/><path d="M10 10h1.6a1.6 1.6 0 1 1-1.6 1.6V10zM6 10H4.4A1.6 1.6 0 1 0 6 11.6V10z"/>'),
  alert: svg('<path d="M8 2.6 14.2 13.4H1.8z"/><path d="M8 6.4v3.1"/><path d="M8 11.5v.2"/>'),
  info: svg('<circle cx="8" cy="8" r="6"/><path d="M8 7.2v3.6"/><path d="M8 5.2v.2"/>'),
  checkCircle: svg('<circle cx="8" cy="8" r="6"/><path d="M5.4 8.2l1.8 1.8 3.4-3.6"/>'),
  save: svg('<path d="M3.2 2.8h7l2.8 2.8v7.6H3.2z"/><path d="M5.6 2.8v3.4h4.2V2.8"/><path d="M5.6 9.6h4.8v3.6H5.6z"/>'),
  pencil: svg('<path d="M11.4 2.6 13.4 4.6 5.6 12.4H3.6v-2z"/>'),
  trash: svg('<path d="M2.8 4.6h10.4M6 4.6V3.2h4v1.4"/><path d="M4.4 4.6l.6 8.1A1.4 1.4 0 0 0 6.4 14h3.2a1.4 1.4 0 0 0 1.4-1.3l.6-8.1"/>'),
  folder: svg('<path d="M2 4.6A1.6 1.6 0 0 1 3.6 3h2.6l1.6 2h4.6A1.6 1.6 0 0 1 14 6.6v5.8A1.6 1.6 0 0 1 12.4 14H3.6A1.6 1.6 0 0 1 2 12.4z"/>'),
  file: svg('<path d="M4 2h4.6L12 5.4V14H4z"/><path d="M8.4 2v3.6H12"/>'),
  book: svg('<path d="M2.4 3.4A1.4 1.4 0 0 1 3.8 2H13v11.2H3.8A1.4 1.4 0 0 0 2.4 14.6z"/><path d="M13 13.2H3.8"/>'),
  bookOpen: svg('<path d="M2 3.2h4.2A1.8 1.8 0 0 1 8 5v7.2a1.4 1.4 0 0 0-1.4-1.2H2z"/><path d="M14 3.2H9.8A1.8 1.8 0 0 0 8 5v7.2a1.4 1.4 0 0 1 1.4-1.2H14z"/>'),
  outline: svg('<path d="M2.6 4h1.2M2.6 8h1.2M2.6 12h1.2M6.2 4h7.2M6.2 8h7.2M6.2 12h4.6"/>'),
  history: svg('<path d="M8 4.6V8l2.6 1.6"/><path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.9"/><path d="M2.4 2.6v2.8H5.2"/>'),
  chart: svg('<path d="M2.6 13.4V9.2M6.6 13.4V5.6M10.6 13.4V7.4M14 13.4H2"/>'),
  inbox: svg('<path d="M2 9.2h3.2l1 1.9h3.6l1-1.9H14"/><path d="M2 9.2 3.8 3h8.4L14 9.2v3.4A1.4 1.4 0 0 1 12.6 14H3.4A1.4 1.4 0 0 1 2 12.6z"/>'),
  sliders: svg('<path d="M2 5h7.4M12.2 5H14M2 11h1.8M6.6 11H14"/><path d="M10.2 3.2v3.6M5 9.2v3.6"/>'),
  gear: svg('<circle cx="8" cy="8" r="2.1"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1"/>'),
  shield: svg('<path d="M8 2 13 3.8v3.8c0 2.8-2 4.4-5 6-3-1.6-5-3.2-5-6V3.8z"/><path d="M5.8 7.8 7.4 9.4l3-3.2"/>'),
  refresh: svg('<path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.8"/><path d="M13.2 2.4v2.8h-2.8"/>'),
  download: svg('<path d="M8 2v8"/><path d="M4.6 6.8 8 10.2l3.4-3.4"/><path d="M2.6 13.4h10.8"/>'),
  upload: svg('<path d="M8 14V6"/><path d="M4.6 9.2 8 5.8l3.4 3.4"/><path d="M2.6 2.6h10.8"/>'),
  arrowRight: svg('<path d="M2.6 8h10.8M9.6 4.2 13.4 8l-3.8 3.8"/>'),
  arrowLeft: svg('<path d="M13.4 8H2.6M6.4 4.2 2.6 8l3.8 3.8"/>'),
  target: svg('<circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="2.4"/>'),
  typewriter: svg('<path d="M2.6 3.6h10.8M2.6 7.6h7M2.6 11.6h9.4"/>'),
  keyboard: svg('<rect x="1.8" y="4" width="12.4" height="8" rx="1.4"/><path d="M4.4 6.4h.2M7 6.4h.2M9.6 6.4h.2M5.2 9.4h5.6"/>'),
  link: svg('<path d="M6.4 9.6 9.6 6.4"/><path d="M6.8 4.4l1-1a2.6 2.6 0 0 1 3.7 3.7l-1 1"/><path d="M9.2 11.6l-1 1a2.6 2.6 0 0 1-3.7-3.7l1-1"/>'),
  // 关系图谱：三个节点 + 连线
  graph: svg('<circle cx="3.6" cy="11.8" r="1.8"/><circle cx="8" cy="3.8" r="1.8"/><circle cx="12.4" cy="11.8" r="1.8"/><path d="M5 10.2 7 5.6M9 5.6l2 4.6M5.4 11.8h5.2"/>'),
  clock: svg('<circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.4 1.6"/>'),
  wifi: svg('<path d="M2 6.2a8.4 8.4 0 0 1 12 0M4.4 8.8a5 5 0 0 1 7.2 0"/><path d="M7 11.4l1 1 1-1"/>'),
  wifiOff: svg('<path d="M2 6.2a8.4 8.4 0 0 1 4-2.2M10 4.3a8.4 8.4 0 0 1 4 1.9M4.4 8.8a5 5 0 0 1 2.6-1.3M11.2 8.9l.4-.1"/><path d="M2.6 2.6l10.8 10.8"/><path d="M7 11.4l1 1 1-1"/>'),
  external: svg('<path d="M9.4 2.6H13.4V6.6"/><path d="M13.4 2.6 7.6 8.4"/><path d="M12 9.8v2.6A1.4 1.4 0 0 1 10.6 14H3.4A1.4 1.4 0 0 1 2 12.6V5.4A1.4 1.4 0 0 1 3.4 4h2.6"/>'),
  drag: svg('<circle cx="6" cy="4" r=".9"/><circle cx="10" cy="4" r=".9"/><circle cx="6" cy="8" r=".9"/><circle cx="10" cy="8" r=".9"/><circle cx="6" cy="12" r=".9"/><circle cx="10" cy="12" r=".9"/>'),
  fileText: svg('<path d="M3.6 2h5l3.4 3.4V14H3.6z"/><path d="M5.8 7h4.4M5.8 9.4h4.4M5.8 11.8h2.8"/>'),
  layers: svg('<path d="M8 2.2 13.4 5 8 7.8 2.6 5z"/><path d="M2.6 8 8 10.8 13.4 8"/><path d="M2.6 11 8 13.8 13.4 11"/>'),
  feather: svg('<path d="M12.6 3.4a3.4 3.4 0 0 0-4.8 0L3 8.2V13h4.8l4.8-4.8a3.4 3.4 0 0 0 0-4.8z"/><path d="M9.6 6.4 3.4 12.6"/>'),
};

// ─────────────────────── 接口 ───────────────────────

export interface ShellHandlers {
  onToggleSidebar(): void;
  onToggleInspector(): void;
  /** 打开关系图谱（全屏视图） */
  onOpenGraph(): void;
  /** 检查器宽度变化（拖拽结束或按方向键/预设后） */
  onInspectorWidth(width: number): void;
  onToggleFocus(): void;
  onProjectMenu(anchor: HTMLElement): void;
  onOpenCommandPalette(): void;
  onSelectPanel(kind: RightPanelKind): void;
  onRetrySave(): void;
  onExitFocus(): void;
  onCloseView(): void;
  onOpenSettings(): void;
  onOpenTrash(): void;
}

export interface LiveStats {
  words: number;
  paragraphs: number;
  dialogue: number;
}

export interface ShellOptions {
  panels: PanelDef[];
  handlers: ShellHandlers;
  getLiveStats(): LiveStats;
}

export interface ShellHandle {
  el: HTMLElement;
  /** 文档树挂载点（滚动容器） */
  sidebarBody: HTMLElement;
  /** 侧栏头部（tree 在此注入新建按钮） */
  sidebarHead: HTMLElement;
  /** 侧栏底部操作区 */
  sidebarFoot: HTMLElement;
  /** 编辑器挂载点 */
  editorMount: HTMLElement;
  /** 右侧面板挂载点 */
  inspectorBody: HTMLElement;
  /** 全屏视图挂载点（设置等 inInspector=false 的面板） */
  viewBody: HTMLElement;
  update(state: AppState): void;
  setConnection(status: 'connecting' | 'open' | 'closed'): void;
  setInspectorHead(icon: string, title: string): void;
  /** 设置检查器宽度（桌面）；≤960px 时忽略，避免覆盖移动端布局 */
  setInspectorWidth(width: number): void;
  /** 当前生效的检查器宽度（px） */
  inspectorWidth(): number;
  setView(icon: string, title: string): void;
  showView(visible: boolean): void;
  destroy(): void;
}

/** 保存状态 → 文案与色点 */
function saveInfo(state: AppState): { text: string; cls: string } {
  switch (state.saveState) {
    case 'saved':
      return {
        text: state.lastSavedAt ? `已保存 ${formatTime(state.lastSavedAt)}` : '已保存',
        cls: 'ok',
      };
    case 'dirty':
      return { text: '未保存', cls: 'warn' };
    case 'saving':
      return { text: '保存中…', cls: 'busy' };
    case 'error':
      return { text: '保存失败 · 重试', cls: 'danger' };
    case 'conflict':
      return { text: '版本冲突', cls: 'danger' };
    default:
      return { text: '—', cls: '' };
  }
}

function runningJob(state: AppState): Job | null {
  return state.jobs.find((j) => j.status === 'running') ?? state.jobs.find((j) => j.status === 'queued') ?? null;
}

/** 把设置写进 CSS 变量与根属性：设置面板改一行，整个编辑器立刻跟着变 */
export function applyEditorSettings(settings: EditorSettings): void {
  const root = document.documentElement;
  root.style.setProperty('--editor-font-size', `${settings.fontSize}px`);
  root.style.setProperty('--editor-line-height', String(settings.lineHeight));
  root.style.setProperty('--editor-measure', `${settings.measure}em`);
  root.style.setProperty('--editor-paragraph-gap', `${settings.paragraphGap}em`);
  root.style.setProperty('--editor-indent', `${settings.indent}em`);
  root.style.setProperty('--editor-font', settings.font === 'serif' ? 'var(--font-read)' : 'var(--font-ui)');
  root.dataset.theme = settings.theme;
}

// ─────────────────────── 构建 ───────────────────────

export function createShell(root: HTMLElement, opts: ShellOptions): ShellHandle {
  const { handlers, panels } = opts;
  const inspectorPanels = panels.filter((p) => p.inInspector);

  // ── 顶栏 ──
  const projectTitle = h('span', { class: 'proj-title' }, '未打开作品');
  const projectSub = h('span', { class: 'proj-sub' }, '');
  const projectChip = h(
    'button',
    {
      class: 'project-chip',
      title: '切换作品',
      onclick: (ev: MouseEvent) => handlers.onProjectMenu(ev.currentTarget as HTMLElement),
    },
    projectTitle,
    projectSub,
    h('span', { class: 'proj-caret', html: ICONS.chevronDown }),
  );

  const sidebarBtn = h('button', {
    class: 'icon-btn',
    title: '侧栏（⌘B）',
    'aria-label': '切换侧栏',
    html: ICONS.sidebar,
    onclick: () => handlers.onToggleSidebar(),
  });

  const searchBtn = h(
    'button',
    { class: 'topbar-search', onclick: () => handlers.onOpenCommandPalette(), title: '命令面板（⌘K）' },
    h('span', { class: 'ts-icon', html: ICONS.search }),
    h('span', { class: 'ts-label' }, '搜索或执行命令'),
    h('kbd', null, '⌘K'),
  );

  const goalTop = h('span', { class: 'gm-top' }, h('span', null, '今日'), h('span', { class: 'gm-num' }, '—'));
  const goalFill = h('span', { class: 'gm-fill' });
  const goalMini = h(
    'div',
    { class: 'goal-mini', title: '今日写作目标' },
    goalTop,
    h('div', { class: 'gm-bar' }, goalFill),
  );

  const saveInd = h(
    'button',
    { class: 'save-ind', title: '保存状态', onclick: () => handlers.onRetrySave() },
    h('span', { class: 'dot' }),
    h('span', { class: 'si-text' }, '已保存'),
  );

  const focusBtn = h('button', {
    class: 'icon-btn',
    title: '专注模式（⌘⇧F）',
    'aria-label': '切换专注模式',
    html: ICONS.focus,
    onclick: () => handlers.onToggleFocus(),
  });
  /**
   * 关系图谱的显眼入口。
   * 之前只能从命令面板找到，作者抱怨「太难找」——
   * 这是核心功能之一，值得常驻顶栏。
   */
  const graphBtn = h('button', {
    class: 'icon-btn',
    title: '关系图谱',
    'aria-label': '打开关系图谱',
    html: ICONS.graph,
    onclick: () => handlers.onOpenGraph(),
  });

  const inspectorBtn = h('button', {
    class: 'icon-btn',
    title: '面板（⌘J）',
    'aria-label': '切换面板',
    html: ICONS.inspector,
    onclick: () => handlers.onToggleInspector(),
  });

  const topbar = h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'topbar-left' }, sidebarBtn, projectChip),
    h('div', { class: 'topbar-center' }, searchBtn),
    h('div', { class: 'topbar-right' }, goalMini, saveInd, graphBtn, focusBtn, inspectorBtn),
  );

  // ── 侧栏 ──
  const treeScroll = h('div', { class: 'tree-scroll' });
  const sidebarFootActions = h('div', { class: 'sf-actions' });
  const sidebarFootMeta = h('div', { class: 'sf-meta' }, '');
  const sidebarFoot = h('div', { class: 'sidebar-foot' }, sidebarFootActions, sidebarFootMeta);
  const sidebar = h(
    'aside',
    { class: 'sidebar' },
    h(
      'div',
      { class: 'sidebar-inner' },
      h(
        'div',
        { class: 'sidebar-head' },
        h('span', { class: 'sh-title' }, '稿件'),
        h('span', { class: 'sh-grow' }),
        h('span', { class: 'sh-meta' }, ''),
      ),
      treeScroll,
      sidebarFoot,
    ),
  );

  // ── 编辑区 ──
  const editorMount = h('main', { class: 'editor-col' });

  // ── 右侧面板 ──
  const tabButtons = new Map<RightPanelKind, HTMLButtonElement>();
  const tabs = h('div', { class: 'inspector-tabs', role: 'tablist' });
  for (const def of inspectorPanels) {
    const btn = h('button', {
      class: 'icon-btn',
      title: def.title,
      'aria-label': def.title,
      role: 'tab',
      html: def.icon,
      dataset: { panel: def.id },
      onclick: () => handlers.onSelectPanel(def.id),
    });
    tabButtons.set(def.id, btn);
    tabs.append(btn);
  }
  const closeInspector = h('button', {
    class: 'icon-btn inspector-close',
    title: '收起面板（⌘J）',
    'aria-label': '收起面板',
    html: ICONS.x,
    onclick: () => handlers.onToggleInspector(),
  });
  tabs.append(h('span', { class: 'tabs-grow' }), closeInspector);

  const inspectorHeadIcon = h('span', { class: 'ih-icon' });
  const inspectorHeadTitle = h('span', { class: 'ih-title' }, '');

  // 两档预设：不想拖拽时一键切换
  const narrowBtn = h(
    'button',
    { class: 'inspector-preset', type: 'button', title: '窄栏（380px）', onclick: () => applyWidth(PRESET_NARROW, true) },
    '窄',
  );
  const wideBtn = h(
    'button',
    { class: 'inspector-preset', type: 'button', title: '宽栏（560px）', onclick: () => applyWidth(PRESET_WIDE, true) },
    '宽',
  );
  const presetGroup = h('div', { class: 'inspector-presets' }, narrowBtn, wideBtn);

  const inspectorBody = h('div', { class: 'inspector-body' });
  const inspector = h(
    'aside',
    { class: 'inspector' },
    h(
      'div',
      { class: 'inspector-inner' },
      tabs,
      h(
        'div',
        { class: 'inspector-head' },
        inspectorHeadIcon,
        inspectorHeadTitle,
        h('span', { class: 'grow' }),
        presetGroup,
      ),
      inspectorBody,
    ),
  );

  /**
   * 检查器左边缘的分隔条：鼠标拖拽手柄 + 键盘可达控件。
   */
  const resizer = h('div', {
    class: 'inspector-resizer',
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': '调整右侧面板宽度',
    tabIndex: 0,
    title: '拖动调整宽度（左右方向键微调）',
  });

  let currentWidth = PRESET_NARROW;
  const isNarrowViewport = (): boolean => window.matchMedia('(max-width: 960px)').matches;

  /** 应用宽度：桌面写内联变量；≤960px 直接忽略，移动端布局完全不变 */
  const applyWidth = (width: number, notify: boolean): void => {
    if (isNarrowViewport()) return;
    const next = clampInspectorWidth(width, window.innerWidth);
    currentWidth = next;
    el.style.setProperty('--inspector-w-cur', `${next}px`);
    narrowBtn.classList.toggle('active', next === PRESET_NARROW);
    wideBtn.classList.toggle('active', next === PRESET_WIDE);
    if (notify) handlers.onInspectorWidth(next);
  };

  let dragStartX = 0;
  let dragStartW = 0;
  let dragging = false;
  resizer.addEventListener('pointerdown', (ev: PointerEvent) => {
    if (ev.button !== 0) return;
    dragging = true;
    dragStartX = ev.clientX;
    dragStartW = currentWidth;
    resizer.setPointerCapture(ev.pointerId);
    resizer.classList.add('dragging');
    ev.preventDefault();
  });
  resizer.addEventListener('pointermove', (ev: PointerEvent) => {
    if (!dragging) return;
    // 分隔条在正文右侧：往左拖 → 检查器变宽
    const next = clampInspectorWidth(dragStartW + (dragStartX - ev.clientX), window.innerWidth);
    currentWidth = next;
    el.style.setProperty('--inspector-w-cur', `${next}px`);
    narrowBtn.classList.toggle('active', next === PRESET_NARROW);
    wideBtn.classList.toggle('active', next === PRESET_WIDE);
  });
  const endResize = (ev: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    try {
      resizer.releasePointerCapture(ev.pointerId);
    } catch {
      /* 已释放 */
    }
    if (!isNarrowViewport()) handlers.onInspectorWidth(currentWidth);
  };
  resizer.addEventListener('pointerup', endResize);
  resizer.addEventListener('pointercancel', endResize);

  resizer.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault();
    applyWidth(
      stepInspectorWidth(currentWidth, ev.key === 'ArrowLeft' ? 1 : -1, window.innerWidth),
      true,
    );
  });

  const workspace = h('div', { class: 'workspace' }, sidebar, editorMount, resizer, inspector);

  // ── 设置全屏视图（inInspector=false 的面板挂这里） ──
  const viewHeadIcon = h('span', { class: 'view-icon' });
  const viewHeadTitle = h('span', { class: 'view-title' }, '');
  const viewBody = h('div', { class: 'view-body' });
  const viewClose = h('button', {
    class: 'icon-btn',
    title: '关闭（Esc）',
    'aria-label': '关闭设置',
    html: ICONS.x,
    onclick: () => handlers.onCloseView(),
  });
  const view = h(
    'div',
    { class: 'fullview hidden', role: 'dialog', 'aria-label': '全屏视图' },
    h(
      'div',
      { class: 'fullview-inner' },
      h('div', { class: 'fullview-head' }, viewHeadIcon, viewHeadTitle, h('span', { class: 'grow' }), viewClose),
      viewBody,
    ),
  );

  // ── 状态栏 ──
  const stSave = h('button', { class: 'st-item st-save', title: '保存状态', onclick: () => handlers.onRetrySave() },
    h('span', { class: 'dot' }),
    h('span', { class: 'st-save-text' }, '已保存'),
  );
  const stConn = h('span', { class: 'st-item st-conn', title: '本地服务连接' },
    h('span', { class: 'dot' }),
    h('span', { class: 'st-conn-text' }, '连接中'),
  );
  const stFocus = h('button', {
    class: 'st-item st-focus hidden',
    title: '退出专注模式（Esc）',
    onclick: () => handlers.onExitFocus(),
  }, h('span', { class: 'st-focus-icon', html: ICONS.focus }), h('span', null, '专注模式 · 退出'));

  const stJobText = h('span', { class: 'st-job-text' }, '');
  const stJobFill = h('span', { class: 'st-job-fill' });
  const stJob = h('span', { class: 'st-item st-job hidden' },
    h('span', { class: 'spinner' }),
    stJobText,
    h('span', { class: 'st-job-bar' }, stJobFill),
  );

  const stMode = h('span', { class: 'st-item st-mode' }, '仅汉字');
  const stScene = h('span', { class: 'st-item st-scene' }, '本场景 0 字');
  const stTotal = h('span', { class: 'st-item st-total' }, '全书 0 字');
  const statusbar = h('footer', { class: 'statusbar' },
    h('div', { class: 'status-left' }, stSave, stConn, stFocus),
    h('div', { class: 'status-mid' }, stJob),
    h('div', { class: 'status-right' }, stMode, stScene, stTotal),
  );

  const el = h('div', { class: 'app-shell' }, topbar, workspace, view, statusbar);
  root.classList.remove('app');
  root.textContent = '';
  root.appendChild(el);
  root.removeAttribute('aria-busy');

  // 侧栏头部的新建按钮：由 tree 模块注入（那里掌握上下文），这里只留占位
  const headSlot = sidebar.querySelector('.sidebar-head') as HTMLElement;

  // 侧栏底部固定入口：设置与回收站。放在最下面，不抢写作用的空间。
  sidebarFootActions.append(
    h(
      'button',
      { class: 'foot-btn', title: '设置', onclick: () => handlers.onOpenSettings() },
      h('span', { class: 'fb-icon', html: ICONS.sliders }),
      h('span', null, '设置'),
    ),
    h(
      'button',
      { class: 'foot-btn', title: '回收站', onclick: () => handlers.onOpenTrash() },
      h('span', { class: 'fb-icon', html: ICONS.trash }),
      h('span', null, '回收站'),
    ),
  );

  const setConnection = (status: 'connecting' | 'open' | 'closed'): void => {
    const dot = stConn.querySelector('.dot') as HTMLElement;
    const text = stConn.querySelector('.st-conn-text') as HTMLElement;
    dot.className = `dot ${status === 'open' ? 'ok' : status === 'connecting' ? 'busy' : 'danger'}`;
    text.textContent = status === 'open' ? '已连接' : status === 'connecting' ? '连接中' : '离线';
    stConn.title = status === 'open'
      ? '本地服务已连接，改动会即时同步'
      : status === 'connecting'
        ? '正在连接本地服务'
        : '与本地服务断开：稿件仍会保存在本地草稿，恢复连接后自动重试';
  };

  const update = (state: AppState): void => {
    el.classList.toggle('sidebar-closed', !state.sidebarOpen);
    el.classList.toggle('inspector-closed', !state.inspectorOpen || state.rightPanel === 'none');
    el.classList.toggle('focus-mode', state.settings.focus);
    el.classList.toggle('typewriter-on', state.settings.typewriter);

    sidebarBtn.classList.toggle('active', state.sidebarOpen);
    inspectorBtn.classList.toggle('active', state.inspectorOpen && state.rightPanel !== 'none');
    focusBtn.classList.toggle('active', state.settings.focus);
    stFocus.classList.toggle('hidden', !state.settings.focus);

    // 作品
    const project = state.project;
    projectTitle.textContent = project?.title || '未打开作品';
    projectSub.textContent = project ? WORK_MODE_LABELS[project.mode] ?? '' : '';
    document.title = project ? `${project.title} · 写作台` : '写作台';

    // 今日目标
    const goal = state.goal;
    if (goal && goal.goal > 0) {
      goalMini.classList.remove('hidden');
      const pct = Math.min(100, Math.round((goal.written / goal.goal) * 100));
      (goalTop.querySelector('.gm-num') as HTMLElement).textContent =
        `${fmtNum(goal.written)} / ${fmtNum(goal.goal)}`;
      goalFill.style.width = `${pct}%`;
      goalFill.classList.toggle('done', goal.written >= goal.goal);
      goalMini.title = `今日 ${fmtNum(goal.written)} 字 / 目标 ${fmtNum(goal.goal)} 字${goal.streak > 1 ? ` · 连续 ${goal.streak} 天` : ''}`;
    } else {
      goalMini.classList.add('hidden');
    }

    // 保存状态（顶栏 + 状态栏）
    const info = saveInfo(state);
    saveInd.dataset.state = state.saveState;
    (saveInd.querySelector('.si-text') as HTMLElement).textContent = info.text;
    saveInd.title = state.saveState === 'error'
      ? `${state.saveError ?? '保存失败'}（点击重试）`
      : state.saveState === 'dirty'
        ? '正在编辑，2 秒后自动保存（⌘S 立即保存）'
        : info.text;
    stSave.dataset.state = state.saveState;
    (stSave.querySelector('.st-save-text') as HTMLElement).textContent = info.text;
    stSave.title = state.saveState === 'error' ? '点击重试保存' : '保存状态';

    // 作业
    const job = runningJob(state);
    if (job) {
      stJob.classList.remove('hidden');
      stJobText.textContent = `${job.message || '处理中'} ${Math.round(job.progress * 100)}%`;
      stJobFill.style.width = `${Math.round(job.progress * 100)}%`;
    } else {
      stJob.classList.add('hidden');
    }

    // 字数
    const live = opts.getLiveStats();
    stMode.textContent = COUNT_MODE_LABELS[state.project?.count_mode ?? 'hanzi'];
    stMode.title = '字数统计口径（在设置面板修改）';
    stScene.textContent = `本场景 ${fmtNum(live.words)} 字`;
    stScene.title = `${fmtNum(live.words)} 字 · ${live.paragraphs} 段 · 对白 ${live.words ? Math.round((live.dialogue / live.paragraphs) * 100) : 0}%`;
    stTotal.textContent = `全书 ${fmtNum(totalWords(state))} 字`;
    stTotal.title = `全书 ${fmtNum(totalWords(state))} 字 · ${state.nodes.filter((n) => n.kind === 'scene').length} 个场景`;

    // 侧栏底部摘要
    const scenes = state.nodes.filter((n) => n.kind === 'scene').length;
    const drafts = state.nodes.filter((n) => n.kind === 'scene' && n.status === 'draft').length;
    sidebarFootMeta.textContent = `${scenes} 个场景 · ${drafts} 个草稿 · ${fmtNum(totalWords(state))} 字`;

    // 侧栏头部统计
    const shMeta = headSlot.querySelector('.sh-meta') as HTMLElement;
    shMeta.textContent = `${scenes}`;

    // 面板 tab 高亮
    for (const [id, btn] of tabButtons) {
      btn.classList.toggle('active', state.rightPanel === id);
      btn.setAttribute('aria-selected', state.rightPanel === id ? 'true' : 'false');
    }
  };

  const setInspectorHead = (iconSvg: string, title: string): void => {
    inspectorHeadIcon.innerHTML = iconSvg;
    inspectorHeadTitle.textContent = title;
  };

  const setView = (iconSvg: string, title: string): void => {
    viewHeadIcon.innerHTML = iconSvg;
    viewHeadTitle.textContent = title;
  };

  const showView = (visible: boolean): void => {
    view.classList.toggle('hidden', !visible);
    el.classList.toggle('view-open', visible);
  };

  return {
    el,
    sidebarBody: treeScroll,
    sidebarHead: headSlot,
    sidebarFoot: sidebarFootActions,
    editorMount,
    inspectorBody,
    viewBody,
    update,
    setConnection,
    setInspectorWidth: (width: number) => applyWidth(width, false),
    inspectorWidth: () => currentWidth,
    setInspectorHead,
    setView,
    showView,
    destroy: () => {
      el.remove();
    },
  };
}
