/**
 * 写作台 · 应用入口。
 *
 * 这一层负责「把所有人接起来」：引导 → 三栏布局 → 面板注册 → 保存管线 → 快捷键 → 实时事件。
 * 各模块只做自己的事：shell 管布局、tree 管稿件树、editor 管输入、overlays 管弹层、
 * panels 管右侧内容。app.ts 是唯一知道全局状态怎么流动的地方。
 *
 * 最高优先级：稿件永不丢（架构 7.1）。保存管线的每一步都围绕这条设计：
 *   1. 每次输入先写 localStorage 草稿（防崩溃/断电）
 *   2. 2 秒去抖后写服务端（防频繁 IO）
 *   3. 服务端确认后才清草稿
 *   4. 失败不静默：状态栏红字 + toast + 自动重试 + 本地草稿兜底
 *   5. 关页面前用 sendBeacon 兜底最后一次保存
 */

import type {
  DocNode,
  DocStatus,
  ExportFormat,
  Job,
  ProjectMeta,
  ProjectSummary,
  SceneContent,
  WsEvent,
} from '../../shared/types.ts';
import { COUNT_MODE_LABELS, NODE_KIND_LABELS, WORK_MODE_LABELS } from '../../shared/types.ts';
import { createEditor } from './components/editor.ts';
import { createOverlays, type CommandItem, type Overlays } from './components/overlays.ts';
import { panels } from './components/panels/index.ts';
import { applyEditorSettings, createShell, ICONS, type ShellHandle } from './components/shell.ts';
import {
  clampInspectorWidth,
  loadPrefs,
  savePrefs,
  type UiPrefs,
} from './lib/ui-prefs.ts';
import { buildMobileNav, isMobileViewport, MobileShell } from './components/mobile.ts';
import { createTree, type TreeHandle } from './components/tree.ts';
import { GraphView } from './components/graph/graph-view.ts';
import { api, ApiClientError, connectEvents, draftCache, setActiveProject } from './lib/api.ts';
import type { AppActions, PanelContext, PanelInstance, ToastAction } from './lib/contracts.ts';
import {
  dedupeNested,
  describeDeleteSummary,
  needsConfirm,
  nextSelectionAfterDelete,
  type DeleteTarget,
} from './lib/delete-policy.ts';
import { fmtNum, h, mount, rafThrottle } from './lib/dom.ts';
import type { AppState, EditorSettings, RightPanelKind, SaveState, Store as StoreType } from './lib/store.ts';
import { childrenOf, DEFAULT_EDITOR_SETTINGS, nodeById, pathText, Store, visibleNodes} from './lib/store.ts';
import { countWords } from './lib/words.ts';

// ─────────────────────── 本地存储键 ───────────────────────

const LS_PROJECT = 'writingdesk:lastProject';
const LS_SETTINGS = 'writingdesk:settings';
const LS_COLLAPSED = 'writingdesk:collapsed';
const LS_PANEL = 'writingdesk:rightPanel';

/** 自动保存去抖：2 秒。太短会频繁写盘，太长崩溃时丢字太多。 */
const SAVE_DEBOUNCE_MS = 2000;
/** 草稿落 localStorage 的去抖：比自动保存更激进，几乎实时。 */
const DRAFT_DEBOUNCE_MS = 350;
/** 保存失败后的自动重试间隔（指数退避，封顶 30 秒） */
const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 30_000;

// ─────────────────────── 初始状态 ───────────────────────

function loadSettings(): EditorSettings {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (!raw) return { ...DEFAULT_EDITOR_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<EditorSettings>;
    return { ...DEFAULT_EDITOR_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_EDITOR_SETTINGS };
  }
}

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_COLLAPSED);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function loadPanel(): RightPanelKind {
  try {
    const raw = localStorage.getItem(LS_PANEL) as RightPanelKind | null;
    if (raw && raw !== 'none' && panels.some((p) => p.id === raw)) return raw;
  } catch {
    /* ignore */
  }
  return 'outline';
}

/** 界面偏好：模块级单例，读写都经由 savePrefs 落本地存储 */
let uiPrefs: UiPrefs = loadPrefs();

function persistUiPrefs(patch: Partial<UiPrefs>): void {
  uiPrefs = { ...uiPrefs, ...patch };
  savePrefs(uiPrefs);
}

function initialState(): AppState {
  const settings = loadSettings();
  return {
    projectId: null,
    project: null,
    projects: [],
    goal: null,
    nodes: [],
    currentDocId: null,
    scene: null,
    collapsed: loadCollapsed(),
    saveState: 'saved',
    saveError: null,
    lastSavedAt: null,
    rightPanel: loadPanel(),
    sidebarOpen: true,
    inspectorOpen: uiPrefs.inspectorOpen,
    settings,
    entities: [],
    rules: [],
    lint: null,
    snapshots: [],
    trash: [],
    backups: [],
    jobs: [],
    search: null,
    overlay: null,
    loading: true,
    bootError: null,
  };
}

// ─────────────────────── 入口 ───────────────────────

void main().catch((err: unknown) => {
  console.error('[app] 启动失败', err);
  renderFatalError(err instanceof Error ? err.message : String(err));
});

async function main(): Promise<void> {
  const appEl = document.getElementById('app');
  const toastsEl = document.getElementById('toasts');
  const modalRoot = document.getElementById('modal-root');
  if (!appEl || !toastsEl || !modalRoot) {
    throw new Error('页面结构缺失：找不到 #app / #toasts / #modal-root');
  }
  // 收窄后的引用：闭包里要用，TS 不会跨函数边界保留守卫收窄
  const appRoot: HTMLElement = appEl;

  // 面板样式单独注入：web/index.html 由基座维护，不在这里改
  if (panels.length > 0) ensureStylesheet('/styles/panels.css');
  ensureFavicon();

  const store = new Store(initialState());
  applyEditorSettings(store.state.settings);
  document.documentElement.dataset.theme = store.state.settings.theme;

  const overlays: Overlays = createOverlays({ modalRoot, toastWrap: toastsEl });

  // ── 运行期可变状态 ──

  /** 当前文档「服务端已确认」的正文，判断脏与干净的基准 */
  let savedBody = '';
  let dirtyBody: string | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  let saving = false;
  let saveAgain = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryCount = 0;
  let lastGoalRefresh = 0;
  let openViewKind: RightPanelKind | null = null;
  /** 最近一次在右栏里打开的面板：关掉全屏设置后要回到它，而不是回到空白 */
  let lastInspectorPanel: RightPanelKind = panels.find((p) => p.inInspector)?.id ?? 'outline';
  let mountedPanel: { id: RightPanelKind; instance: PanelInstance; host: HTMLElement } | null = null;
  let currentPanelHost: HTMLElement | null = null;
  let tree: TreeHandle | null = null;
  let shell: ShellHandle | null = null;
  let mobile: MobileShell | null = null;
  let graphView: GraphView | null = null;
  let unsubscribe: (() => void) | null = null;
  const timers: Array<ReturnType<typeof setInterval>> = [];

  // ── 编辑器（先建，shell 需要读它的实时统计） ──

  const editor = createEditor(document.createElement('div'), {
    onChange: () => {
      markDirty();
      syncShellSoon();
    },
    onBlur: () => {
      void saveNow();
    },
    onTitleChange: (title) => {
      const docId = store.state.currentDocId;
      if (docId) void actions.renameNode(docId, title);
    },
    onStatusChange: (status) => {
      const docId = store.state.currentDocId;
      if (docId) void actions.updateNodeMeta(docId, { status });
    },
    toast: (message, kind) => toast(message, kind),
  });

  // ── 外壳 ──

  shell = createShell(appRoot, {
    panels,
    getLiveStats: () => editor.getStats(),
    handlers: {
      onToggleSidebar: () => actions.toggleSidebar(),
      onToggleInspector: () => toggleInspector(),
      onInspectorWidth: (width) => persistUiPrefs({ inspectorWidth: width }),
      onOpenGraph: () => openGraphView(),
      onToggleFocus: () => actions.toggleFocus(),
      onProjectMenu: () => openProjectSwitcher(),
      onOpenCommandPalette: () => openCommandPalette(),
      onSelectPanel: (kind) => actions.setRightPanel(kind),
      onRetrySave: () => {
        if (store.state.saveState === 'error') {
          retryCount = 0;
          void saveNow();
        } else if (store.state.saveState === 'conflict') {
          void saveNow();
        } else {
          toast('当前内容已保存', 'ok');
        }
      },
      onExitFocus: () => actions.setSettings({ focus: false }),
      onCloseView: () => closeView(),
      onOpenSettings: () => actions.setRightPanel('settings'),
      onOpenTrash: () => openTrash(),
    },
  });

  // 恢复上次的检查器宽度（≤960px 时 shell 内部会忽略）
  shell.setInspectorWidth(uiPrefs.inspectorWidth);

  // 窗口变小导致放不下时自动收窄，不能让检查器把正文挤没
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const onWindowResize = (): void => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const next = clampInspectorWidth(uiPrefs.inspectorWidth, window.innerWidth);
      if (next !== uiPrefs.inspectorWidth) persistUiPrefs({ inspectorWidth: next });
      shell?.setInspectorWidth(next);
    }, 120);
  };
  window.addEventListener('resize', onWindowResize);

  shell.editorMount.textContent = '';
  shell.editorMount.appendChild(editor.el);
  editor.setTypewriter(store.state.settings.typewriter);

  // ── 文档树 ──

  tree = createTree(shell.sidebarBody, {
    selectDoc: (id) => void actions.selectDoc(id),
    createNode: (kind, parentId, title) => void actions.createNode(kind, parentId, title),
    renameNode: (id, title) => void actions.renameNode(id, title),
    deleteNode: (id) => void actions.deleteNode(id),
    deleteNodes: (ids) => void actions.deleteNodes(ids),
    moveNode: (id, parentId, order) => void actions.moveNode(id, parentId, order),
    updateNodeMeta: (id, patch) => void actions.updateNodeMeta(id, patch),
    toggleCollapse: (id) => {
      const collapsed = new Set(store.state.collapsed);
      if (collapsed.has(id)) collapsed.delete(id);
      else collapsed.add(id);
      store.set({ collapsed });
      persistCollapsed(collapsed);
      tree?.update(store.state);
    },
    toast: (message, kind) => toast(message, kind),
  });
  tree.mountHeadActions(shell.sidebarHead);

  // ── 移动端形态（抽屉 + 底部导航） ──
  //
  // 只在窄屏生效；桌面端 DOM 上也会挂载，但 CSS 隐藏且交互全部由
  // matchMedia 守门，不产生额外开销。
  mobile = new MobileShell(store, {
    onDrawerClose: () => mobile?.closeDrawer(),
    onToggleSidebar: () => mobile?.toggleDrawer('sidebar'),
    onToggleInspector: () => mobile?.toggleDrawer('inspector'),
    onOpenSearch: () => {
      mobile?.closeDrawer();
      actions.setRightPanel('search');
      openCommandPalette();
    },
    onOpenInbox: () => {
      mobile?.closeDrawer();
      actions.setRightPanel('inbox');
    },
    onOpenSettings: () => {
      mobile?.closeDrawer();
      actions.setRightPanel('settings');
    },
    onSave: () => {
      void saveNow();
    },
    onToggleFocus: () => actions.toggleFocus(),
  });
  mobile.mount(shell.el, buildMobileNav(
    {
      onDrawerClose: () => mobile?.closeDrawer(),
      onToggleSidebar: () => mobile?.toggleDrawer('sidebar'),
      onToggleInspector: () => mobile?.toggleDrawer('inspector'),
      onOpenSearch: () => {
        mobile?.closeDrawer();
        actions.setRightPanel('search');
        openCommandPalette();
      },
      onOpenInbox: () => {
        mobile?.closeDrawer();
        actions.setRightPanel('inbox');
      },
      onOpenSettings: () => {
        mobile?.closeDrawer();
        actions.setRightPanel('settings');
      },
      onSave: () => void saveNow(),
      onToggleFocus: () => actions.toggleFocus(),
    },
    {
      openOutline: () => mobile?.toggleDrawer('sidebar'),
      openPanel: () => {
        // 手机上面板按钮：如果面板本来没开，先开一个默认面板再展开抽屉
        if (!store.state.inspectorOpen || store.state.rightPanel === 'none') {
          actions.setRightPanel('outline');
        }
        mobile?.toggleDrawer('inspector');
      },
    },
  ));

  // ── 状态订阅 ──

  const syncShell = (): void => {
    shell?.update(store.state);
  };
  const syncShellSoon = rafThrottle(syncShell);

  unsubscribe = store.subscribe((state, changed) => {
    syncShell();
    mobile?.update(state, changed);
    if (changed.has('settings')) {
      applyEditorSettings(state.settings);
      editor.setTypewriter(state.settings.typewriter);
      try {
        localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings));
      } catch {
        /* ignore */
      }
    }
    if (changed.has('rightPanel')) persistPanel(state.rightPanel);
    if (changed.has('nodes') || changed.has('currentDocId') || changed.has('collapsed')) {
      tree?.update(state);
    }
    if (changed.has('rightPanel')) syncPanel();
    if (changed.has('projectId')) syncPanel();
    mountedPanel?.instance.update?.(state, changed);
  });

  // ─────────────────────── 保存管线 ───────────────────────

  const currentScene = (): DocNode | null => {
    const node = nodeById(store.state, store.state.currentDocId);
    return node && node.kind === 'scene' ? node : null;
  };

  const setSaveState = (saveState: SaveState, saveError: string | null = null): void => {
    if (store.state.saveState === saveState && store.state.saveError === saveError) return;
    store.set({ saveState, saveError });
  };

  /** 把正文写进 localStorage（崩溃恢复的唯一依据） */
  const persistDraft = (): void => {
    const doc = currentScene();
    const projectId = store.state.projectId;
    if (!doc || !projectId || dirtyBody === null) return;
    draftCache.save(projectId, doc.id, dirtyBody, store.state.scene?.rev ?? doc.rev ?? 0);
  };

  const scheduleDraft = (): void => {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      draftTimer = null;
      persistDraft();
    }, DRAFT_DEBOUNCE_MS);
  };

  const scheduleSave = (ms = SAVE_DEBOUNCE_MS): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void saveNow();
    }, ms);
  };

  const clearRetry = (): void => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };

  const scheduleRetry = (): void => {
    clearRetry();
    retryCount = Math.min(retryCount + 1, 6);
    const delay = Math.min(RETRY_BASE_MS * 2 ** (retryCount - 1), RETRY_MAX_MS);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (dirtyBody !== null) void saveNow();
    }, delay);
  };

  /** 编辑器输入入口 */
  function markDirty(): void {
    if (!currentScene()) return;
    const body = editor.getValue();
    if (body === savedBody && dirtyBody === null) return;
    dirtyBody = body;
    if (store.state.saveState !== 'dirty') setSaveState('dirty');
    scheduleDraft();
    scheduleSave();
  }

  /** 立即保存。切换文档、失焦、⌘S、页面隐藏都会调用。 */
  async function saveNow(): Promise<void> {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const doc = currentScene();
    const projectId = store.state.projectId;
    if (!doc || !projectId) return;

    const body = editor.getValue();
    if (body === savedBody && dirtyBody === null) {
      if (store.state.saveState !== 'saved') setSaveState('saved');
      return;
    }
    dirtyBody = body;

    // 服务端已经在保存：记下「还要再存一次」，避免并发写同一份稿件
    if (saving) {
      saveAgain = true;
      return;
    }
    saving = true;
    setSaveState('saving');
    // 关键顺序：先本地草稿，再网络。任何时刻断电都能从这里恢复。
    persistDraft();
    const rev = store.state.scene?.rev ?? doc.rev ?? 0;

    try {
      const res = await api.saveScene(doc.id, body, rev);

      // 服务端可能应用了标点规整（项目开启 auto_punct 时）。
      // 必须把规整结果同步回编辑器，否则作者看到的是规整前的文本，
      // 下次保存又会把它覆盖回去，形成「改了又没改」的循环。
      let finalBody = body;
      if (res.body && res.body !== body) {
        finalBody = res.body;
        // 仅当作者在这段时间内没有继续输入时才覆盖，避免打断正在写的人
        if (editor.getValue() === body) {
          editor.setValue(finalBody);
          toast('已按项目设置规整标点', 'ok', 1600);
        }
      }

      savedBody = finalBody;
      dirtyBody = editor.getValue() === finalBody ? null : editor.getValue();
      editor.markSaved(finalBody);
      draftCache.clear(projectId, doc.id);
      clearRetry();
      retryCount = 0;

      // 更新场景与树节点上的字数，避免为了一次保存去重拉整棵树
      const wordCount = countWords(finalBody, store.state.project?.count_mode ?? 'hanzi');
      const scene: SceneContent | null = store.state.scene
        ? { ...store.state.scene, rev: res.rev, hash: res.hash, updated_at: res.updated_at, body: finalBody }
        : null;
      const nodes = store.state.nodes.map((n) =>
        n.id === doc.id ? { ...n, word_count: wordCount, rev: res.rev, hash: res.hash, updated_at: res.updated_at } : n,
      );
      store.set({
        scene,
        nodes,
        saveState: dirtyBody === null ? 'saved' : 'dirty',
        saveError: null,
        lastSavedAt: Date.now(),
      });
      if (res.conflict) {
        toast('检测到版本冲突：当前内容已另存为冲突副本，可在版本面板查看', 'warn');
      }
      if (dirtyBody === null) {
        // 成功保存且期间没有新输入：稍后刷新今日目标，不打断输入
        if (Date.now() - lastGoalRefresh > 20_000) {
          lastGoalRefresh = Date.now();
          void actions.refreshGoal().catch(() => {});
        }
      } else {
        scheduleSave(600);
      }
    } catch (err) {
      const conflictCurrent = extractConflict(err);
      if (conflictCurrent) {
        handleConflict(doc.id, body, conflictCurrent);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      setSaveState('error', message);
      toast(`保存失败：${message}（草稿已保存在本机，会自动重试）`, 'error', 5200);
      scheduleRetry();
    } finally {
      saving = false;
      if (saveAgain) {
        saveAgain = false;
        if (dirtyBody !== null) scheduleSave(120);
      }
    }
  }

  /** 从错误里取冲突的服务端版本 */
  function extractConflict(err: unknown): SceneContent | null {
    if (!(err instanceof ApiClientError)) return null;
    const payload = err.payload as { current?: SceneContent; code?: string } | null;
    if (payload?.current) return payload.current;
    if (err.status === 409 || err.code === 'conflict') {
      return { id: store.state.currentDocId ?? '', body: '', rev: 0, hash: '', updated_at: 0 };
    }
    return null;
  }

  /** 冲突：给作者三条路，默认不覆盖任何东西 */
  function handleConflict(docId: string, localBody: string, server: SceneContent): void {
    setSaveState('conflict', '服务端版本比本地新');
    toast('版本冲突：请选择保留哪个版本', 'warn', 5000);
    openConflictDialog(docId, localBody, server);
  }

  function openConflictDialog(docId: string, localBody: string, server: SceneContent): void {
    overlays.open(
      'conflict',
      (body, close) => {
        const serverBody = server.body;
        const localPre = h('pre', { class: 'diff-pane' }, localBody || '（空）');
        const serverPre = h('pre', { class: 'diff-pane' }, serverBody || '（空）');
        const localWords = countWords(localBody, store.state.project?.count_mode ?? 'hanzi');
        const serverWords = countWords(serverBody, store.state.project?.count_mode ?? 'hanzi');

        body.append(
          h(
            'div',
            { class: 'conflict-note' },
            h('span', { class: 'ci', html: ICONS.alert }),
            h(
              'div',
              null,
              h('p', null, '这份稿件在别处也被修改过。请确认要保留哪一版，另一版会另存为冲突副本，不会丢。'),
              h(
                'p',
                { class: 'muted tiny' },
                `我的版本 ${fmtNum(localWords)} 字 · 服务端版本 ${fmtNum(serverWords)} 字（修订 ${server.rev}）`,
              ),
            ),
          ),
          h(
            'div',
            { class: 'diff-grid' },
            h('div', { class: 'diff-col' }, h('div', { class: 'diff-head' }, '我的版本（本机）'), localPre),
            h('div', { class: 'diff-col' }, h('div', { class: 'diff-head' }, '服务端版本'), serverPre),
          ),
          h(
            'div',
            { class: 'modal-footer' },
            h(
              'button',
              {
                class: 'btn',
                onclick: () => {
                  close();
                  void useServerVersion(docId, serverBody);
                },
              },
              '用服务端版本',
            ),
            h(
              'button',
              {
                class: 'btn',
                onclick: () => {
                  close();
                  // 再看一次差异（弹层已关，重新打开同一份对比）
                  openConflictDialog(docId, localBody, server);
                },
              },
              '稍后决定',
            ),
            h(
              'button',
              {
                class: 'btn primary',
                onclick: () => {
                  close();
                  void forceSave(docId, localBody, server.rev);
                },
              },
              '保留我的版本',
            ),
          ),
        );
      },
      { title: '版本冲突', width: 860 },
    );
  }

  /** 强制以本地版本覆盖（base_rev 用服务端最新） */
  async function forceSave(docId: string, body: string, serverRev: number): Promise<void> {
    try {
      const res = await api.saveScene(docId, body, serverRev);
      savedBody = body;
      dirtyBody = null;
      editor.markSaved(body);
      draftCache.clear(store.state.projectId ?? '', docId);
      store.set({
        scene: store.state.scene ? { ...store.state.scene, rev: res.rev, hash: res.hash, body } : null,
        saveState: 'saved',
        saveError: null,
        lastSavedAt: Date.now(),
      });
      toast('已保留你的版本', 'ok');
    } catch (err) {
      setSaveState('error', err instanceof Error ? err.message : String(err));
      toast('覆盖保存失败，内容仍在本地草稿中', 'error');
    }
  }

  /** 采用服务端版本（本地编辑被丢弃前已写入冲突副本，由服务端负责） */
  async function useServerVersion(docId: string, serverBody: string): Promise<void> {
    try {
      const scene = await api.getScene(docId);
      savedBody = scene.body;
      dirtyBody = null;
      draftCache.clear(store.state.projectId ?? '', docId);
      editor.setContext({
        projectId: store.state.projectId ?? '',
        doc: nodeById(store.state, docId),
        path: pathText(store.state, docId),
        countMode: store.state.project?.count_mode ?? 'hanzi',
        body: scene.body,
      });
      store.set({ scene, saveState: 'saved', saveError: null });
      toast('已切换到服务端版本', 'ok');
    } catch (err) {
      toast(`读取服务端版本失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      void serverBody;
    }
  }

  // ─────────────────────── 文档切换 ───────────────────────

  let selecting: Promise<void> | null = null;

  async function selectDoc(docId: string): Promise<void> {
    if (selecting) await selecting.catch(() => {});
    selecting = (async () => {
      const node = nodeById(store.state, docId);
      if (!node) return;

      // 切文档前必须先落盘并记住光标，否则上一份的未保存内容/位置会丢
      if (docId !== store.state.currentDocId) {
        editor.saveCaret();
        await saveNow();
      }

      if (node.kind !== 'scene') {
        store.set({ currentDocId: docId, scene: null });
        editor.setContext({
          projectId: store.state.projectId ?? '',
          doc: node,
          path: pathText(store.state, docId),
          countMode: store.state.project?.count_mode ?? 'hanzi',
          body: '',
        });
        savedBody = '';
        dirtyBody = null;
        return;
      }

      try {
        const scene = await api.getScene(docId);
        store.set({ currentDocId: docId, scene });
        savedBody = scene.body;
        dirtyBody = null;
        editor.setContext({
          projectId: store.state.projectId ?? '',
          doc: node,
          path: pathText(store.state, docId),
          countMode: store.state.project?.count_mode ?? 'hanzi',
          body: scene.body,
        });
        setSaveState('saved');
        syncShellSoon();
      } catch (err) {
        // 读取失败也要把文档切过去：至少标题和树是可见的，正文给错误提示
        store.set({ currentDocId: docId, scene: null });
        editor.setContext({
          projectId: store.state.projectId ?? '',
          doc: node,
          path: pathText(store.state, docId),
          countMode: store.state.project?.count_mode ?? 'hanzi',
          body: '',
        });
        savedBody = '';
        dirtyBody = null;
        toast(`读取正文失败：${err instanceof Error ? err.message : String(err)}`, 'error', 5000);
      }
    })();
    try {
      await selecting;
    } finally {
      selecting = null;
    }
  }

  // ─────────────────────── 面板 ───────────────────────

  const panelCtx = (): PanelContext => ({
    store: store as StoreType,
    api,
    actions,
    toast: (message, kind) => toast(message, kind),
    openOverlay: (kind, payload) => openOverlay(kind, payload),
    closeOverlay: () => overlays.close(),
    refresh: () => remountPanel(),
  });

  function destroyPanel(): void {
    if (!mountedPanel) return;
    try {
      mountedPanel.instance.destroy?.();
    } catch (err) {
      console.error('[panel] destroy 异常', err);
    }
    mountedPanel.host.textContent = '';
    mountedPanel = null;
    currentPanelHost = null;
  }

  function mountPanel(kind: RightPanelKind): void {
    const def = panels.find((p) => p.id === kind);
    if (!def) {
      destroyPanel();
      return;
    }
    const host = def.inInspector ? shell!.inspectorBody : shell!.viewBody;
    if (mountedPanel && mountedPanel.id === kind && mountedPanel.host === host) return;
    destroyPanel();
    host.textContent = '';
    try {
      const instance = def.mount(host, panelCtx());
      mountedPanel = { id: kind, instance, host };
      currentPanelHost = host;
      if (def.inInspector) shell!.setInspectorHead(def.icon, def.title);
      else shell!.setView(def.icon, def.title);
    } catch (err) {
      console.error('[panel] mount 异常', err);
      mount(
        host,
        h(
          'div',
          { class: 'empty panel-error' },
          h('span', { html: ICONS.alert }),
          h('div', { class: 'empty-title' }, '面板加载失败'),
          h('div', { class: 'empty-hint' }, err instanceof Error ? err.message : String(err)),
          h('button', { class: 'btn sm', onclick: () => remountPanel() }, '重试'),
        ),
      );
    }
  }

  function remountPanel(): void {
    const kind = mountedPanel?.id ?? null;
    destroyPanel();
    if (kind) mountPanel(kind);
  }

  /** 让「右栏面板」与「全屏视图」跟随 store 状态 */
  function syncPanel(): void {
    const kind = store.state.rightPanel;
    const def = panels.find((p) => p.id === kind);
    if (openViewKind) {
      shell!.showView(true);
      if (!mountedPanel || mountedPanel.id !== openViewKind) mountPanel(openViewKind);
      return;
    }
    shell!.showView(false);
    if (!def || kind === 'none') {
      destroyPanel();
      return;
    }
    if (def.inInspector) {
      lastInspectorPanel = kind;
      mountPanel(kind);
    } else {
      // inInspector=false 的面板（设置）走全屏视图
      openViewKind = kind;
      shell!.showView(true);
      mountPanel(kind);
    }
  }

  /**
   * 打开关系图谱。
   *
   * 走全屏视图容器（与设置页同一个），不占 inspector 的 300px ——
   * 那个宽度画不下有意义的图。
   */
  function openGraphView(): void {
    if (graphView) {
      graphView.destroy();
      graphView = null;
    }

    const sh = shell;
    if (!sh) return;
    const body = sh.viewBody;

    sh.setView(ICONS.bible, '关系图谱');
    body.textContent = '';

    graphView = new GraphView({
      ctx: {
        store,
        api,
        actions,
        toast,
        openOverlay,
        closeOverlay: () => overlays.close(),
        refresh: () => {},
      },
      onClose: () => closeGraphView(),
    });
    body.appendChild(graphView.el);
    sh.showView(true);

    void graphView.load();
  }

  function closeGraphView(): void {
    if (!graphView) return;
    graphView.destroy();
    graphView = null;
    shell?.showView(false);
    // 全屏视图可能原本是设置页打开的，关闭后统一回到右栏面板
    shell?.setView(ICONS.bible, '');
    const body = shell?.viewBody;
    if (body) body.textContent = '';
    syncPanel();
  }

  function closeView(): void {
    if (graphView) {
      closeGraphView();
      return;
    }
    if (!openViewKind) return;
    openViewKind = null;
    destroyPanel();
    shell!.showView(false);
    // 关键：必须把 rightPanel 从全屏面板改回右栏面板，否则 syncPanel 会立刻再打开它
    store.set({ rightPanel: lastInspectorPanel, inspectorOpen: true });
    syncPanel();
    editor.focus();
  }

  function toggleInspector(): void {
    const open = store.state.inspectorOpen && store.state.rightPanel !== 'none';
    if (open) {
      store.set({ inspectorOpen: false });
      persistUiPrefs({ inspectorOpen: false });
    } else {
      store.set({ inspectorOpen: true, rightPanel: store.state.rightPanel === 'none' ? 'outline' : store.state.rightPanel });
      persistUiPrefs({ inspectorOpen: true });
    }
  }

  function openOverlay(kind: string, payload?: unknown): void {
    switch (kind) {
      case 'confirm': {
        const p = (payload ?? {}) as {
          title?: string;
          message?: string;
          confirmText?: string;
          cancelText?: string;
          danger?: boolean;
          onConfirm?: () => void | Promise<void>;
          onCancel?: () => void;
        };
        void overlays.confirm({
          title: p.title ?? '请确认',
          message: p.message,
          confirmText: p.confirmText,
          cancelText: p.cancelText,
          danger: p.danger,
          onConfirm: p.onConfirm,
          onCancel: p.onCancel,
        });
        return;
      }
      case 'prompt': {
        const p = (payload ?? {}) as {
          title?: string;
          label?: string;
          value?: string;
          placeholder?: string;
          confirmText?: string;
          onSubmit?: (value: string) => void | boolean | Promise<void | boolean>;
        };
        void overlays.prompt({
          title: p.title ?? '输入',
          label: p.label,
          value: p.value,
          placeholder: p.placeholder,
          confirmText: p.confirmText,
          onSubmit: p.onSubmit,
        });
        return;
      }
      case 'trash':
        openTrash();
        return;
      case 'command':
        openCommandPalette();
        return;
      case 'projects':
        openProjectSwitcher();
        return;
      default: {
        // 未知 kind：给一个可读的兜底，不白屏
        const p = (payload ?? {}) as { title?: string; message?: string };
        void overlays.confirm({
          title: p.title ?? '提示',
          message: p.message ?? '此操作暂未实现。',
          confirmText: '知道了',
          cancelText: '关闭',
        });
      }
    }
  }

  let lastToast = { message: '', at: 0 };

  function toast(
    message: string,
    kind: 'ok' | 'warn' | 'error' | 'info' = 'info',
    ms?: number,
    action?: ToastAction,
  ): void {
    // 同一条提示 3 秒内只弹一次：保存重试失败时不该刷屏盖住正文。
    // 带动作按钮的（撤销）不去重 —— 连删两次要能看到两个撤销入口。
    if (!action) {
      const now = Date.now();
      if (message === lastToast.message && now - lastToast.at < 3000) return;
      lastToast = { message, at: now };
    }
    overlays.toast(message, kind, ms, action);
  }

  // ─────────────────────── 作品 ───────────────────────

  async function refreshProjects(): Promise<ProjectSummary[]> {
    const projects = await api.listProjects();
    store.set({ projects });
    return projects;
  }

  async function openProject(projectId: string): Promise<void> {
    setActiveProject(projectId);
    try {
      localStorage.setItem(LS_PROJECT, projectId);
    } catch {
      /* ignore */
    }
    store.set({ projectId, loading: true, bootError: null });

    // meta 与 goal 失败不该拖垮整个应用：能拿到树就能写作
    const meta: ProjectMeta | null = await api.getProject().catch(() => null);
    const goal = await api.getGoal().catch(() => null);
    const treeData = await api.getTree();
    store.set({
      project: meta,
      goal,
      nodes: treeData.nodes,
      collapsed: pruneCollapsed(store.state.collapsed, treeData.nodes),
      loading: false,
      projectId,
    });

    // 选一个默认文档：优先第一个场景，其次第一个节点
    const current = store.state.currentDocId;
    const stillThere = current && treeData.nodes.some((n) => n.id === current);
    if (!stillThere) {
      const firstScene = firstSceneId(treeData.nodes);
      const fallback = treeData.nodes[0]?.id ?? null;
      const target = firstScene ?? fallback;
      if (target) await selectDoc(target);
      else {
        store.set({ currentDocId: null, scene: null });
        editor.setContext({
          projectId,
          doc: null,
          path: '',
          countMode: meta?.count_mode ?? 'hanzi',
          body: '',
        });
      }
    }

    // 数据面板的首次加载：失败就让它显示自己的错误态，不阻塞写作
    void actions.refreshJobs().catch(() => {});
    void actions.refreshEntities().catch(() => {});
    void actions.refreshSnapshots().catch(() => {});
    void actions.refreshTrash().catch(() => {});
    void actions.refreshRules().catch(() => {});

    // 未保存草稿恢复：启动时检查，是「稿件永不丢」的最后一道防线
    await recoverDrafts(projectId);
    syncPanel();
    syncShell();
    setTimeout(() => editor.focus(), 60);
  }

  function pruneCollapsed(collapsed: Set<string>, nodes: DocNode[]): Set<string> {
    const ids = new Set(nodes.map((n) => n.id));
    const next = new Set<string>();
    for (const id of collapsed) if (ids.has(id)) next.add(id);
    return next;
  }

  function firstSceneId(nodes: DocNode[]): string | null {
    const byParent = new Map<string | null, DocNode[]>();
    for (const n of nodes) {
      const list = byParent.get(n.parent_id) ?? [];
      list.push(n);
      byParent.set(n.parent_id, list);
    }
    for (const list of byParent.values()) list.sort((a, b) => a.order - b.order);
    const walk = (parentId: string | null): string | null => {
      for (const n of byParent.get(parentId) ?? []) {
        if (n.kind === 'scene') return n.id;
        const found = walk(n.id);
        if (found) return found;
      }
      return null;
    };
    return walk(null);
  }

  async function recoverDrafts(projectId: string): Promise<void> {
    const drafts = draftCache.listDrafts(projectId);
    if (drafts.length === 0) return;

    const pending: Array<{ docId: string; title: string; body: string; rev: number; at: number }> = [];
    for (const d of drafts) {
      const node = store.state.nodes.find((n) => n.id === d.docId);
      try {
        const scene = await api.getScene(d.docId);
        if (scene.body === d.body) {
          // 其实已经存上了，只是清草稿失败：静默清理
          draftCache.clear(projectId, d.docId);
          continue;
        }
        pending.push({ docId: d.docId, title: node?.title ?? d.docId, body: d.body, rev: scene.rev, at: d.at });
      } catch {
        // 服务端读不到（文件被删/服务未就绪）：仍然提示，让作者自己决定
        pending.push({ docId: d.docId, title: node?.title ?? d.docId, body: d.body, rev: d.rev, at: d.at });
      }
    }
    if (pending.length === 0) return;

    const names = pending.map((p) => `《${p.title}》`).join('、');
    const ok = await overlays.confirm({
      title: '发现未保存的草稿',
      message:
        `${names} 有 ${pending.length} 份未确认保存的本地草稿。\n` +
        '恢复会把草稿内容写回稿件文件；丢弃则删除本地草稿，服务端现有版本保持不变。\n' +
        '建议先恢复，再在编辑器里核对。',
      confirmText: '恢复并保存',
      cancelText: '丢弃草稿',
      danger: false,
    });

    if (!ok) {
      for (const p of pending) draftCache.clear(projectId, p.docId);
      toast('已丢弃本地草稿', 'info');
      return;
    }

    let restored = 0;
    for (const p of pending) {
      try {
        const res = await api.saveScene(p.docId, p.body, p.rev);
        draftCache.clear(projectId, p.docId);
        restored++;
        void res;
      } catch (err) {
        toast(`恢复《${p.title}》失败：${err instanceof Error ? err.message : String(err)}`, 'error', 5000);
      }
    }
    if (restored > 0) {
      toast(`已恢复 ${restored} 份草稿`, 'ok');
      await actions.refreshTree();
      const cur = store.state.currentDocId;
      if (cur && pending.some((p) => p.docId === cur)) await selectDoc(cur);
    }
  }

  function openProjectSwitcher(): void {
    overlays.projectSwitcher({
      projects: store.state.projects,
      currentId: store.state.projectId,
      onPick: (id) => {
        if (id === store.state.projectId) return;
        void (async () => {
          await saveNow();
          await openProject(id);
          toast('已切换作品', 'ok');
        })();
      },
      onCreate: () => {
        void createProjectFlow();
      },
    });
  }

  async function createProjectFlow(): Promise<void> {
    const title = await overlays.prompt({
      title: '新建作品',
      label: '作品名',
      placeholder: '例如：长夜将明',
      confirmText: '创建',
      onSubmit: (value) => {
        if (!value.trim()) return false;
        return true;
      },
    });
    if (title === null) return;
    try {
      const summary = await api.createProject({ title: title.trim() || '未命名作品' });
      await refreshProjects();
      await openProject(summary.id);
      toast('作品已创建', 'ok');
    } catch (err) {
      toast(`创建失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  /** 空目录首次启动：给一个能立刻写字的示例作品，而不是空白 */
  async function createStarterProject(): Promise<ProjectSummary> {
    const summary = await api.createProject({ title: '我的第一部小说' });
    setActiveProject(summary.id);
    const volume = await api.createNode({ kind: 'volume', parent_id: null, title: '第一卷 起点' });
    const chapter = await api.createNode({ kind: 'chapter', parent_id: volume.id, title: '第一章 雨夜' });
    const scene = await api.createNode({ kind: 'scene', parent_id: chapter.id, title: '雨夜来客' });
    const sample =
      '雨下了整夜。\n\n' +
      '林远站在檐下，看着街对面的灯一盏一盏熄掉。他数到第七盏时，那扇门终于开了。\n\n' +
      '“你迟到了。”他说。\n\n' +
      '来人没有回答，只是把伞收起来，抖落一地水声。\n\n' +
      '——把这段替换成你的开头。左侧可以新建卷、章、场景，右键可以改名和调整状态。';
    await api.saveScene(scene.id, sample, scene.rev ?? 1).catch(() => null);
    return summary;
  }

  // ─────────────────────── 快捷键 & 命令面板 ───────────────────────

  function openCommandPalette(): void {
    overlays.commandPalette({
      items: buildCommands(),
      // 命令面板同时承担「搜全书」：输入正文关键词能直接跳到场景
      onSearch: async (query) => {
        try {
          const res = await api.search(query, { limit: 20 });
          // 只保留可跳转的两类：场景与设定条目（note 暂不可跳）
          return res.hits
            .filter((h) => h.kind === 'scene' || h.kind === 'entity')
            .map((h) => ({
              doc_id: h.doc_id,
              doc_title: h.doc_title,
              kind: h.kind as 'scene' | 'entity',
              path: h.path,
              snippet: h.snippet,
              count: h.count,
            }));
        } catch {
          // 搜索失败不该让命令面板报错：当作没有命中
          return [];
        }
      },
      onPickHit: async (hit, query) => {
        if (hit.kind === 'entity') {
          actions.jumpToEntity(hit.doc_id);
          return;
        }
        await selectDoc(hit.doc_id);
        // 跳到该场景后定位到第一个命中处
        const body = editor.getValue();
        const idx = query ? body.indexOf(query) : -1;
        if (idx >= 0) editor.revealRange(idx, idx + query.length);
      },
    });
  }

  function buildCommands(): CommandItem[] {
    const items: CommandItem[] = [];
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    const mod = isMac ? '⌘' : 'Ctrl';

    items.push(
      { id: 'save', title: '保存当前场景', group: '写作', hint: `${mod}S`, icon: ICONS.save, run: () => saveNow() },
      {
        id: 'new-scene',
        title: '新建场景',
        group: '写作',
        icon: ICONS.file,
        keywords: '新建 场景 章节',
        run: () => {
          const node = nodeById(store.state, store.state.currentDocId);
          const parent =
            node?.kind === 'scene' ? node.parent_id : node?.kind === 'chapter' ? node.id : null;
          const chapterId = parent ?? lastChapterId();
          if (!chapterId) {
            toast('请先新建一章', 'warn');
            return;
          }
          void actions.createNode('scene', chapterId);
        },
      },
      {
        id: 'new-chapter',
        title: '新建章',
        group: '写作',
        icon: ICONS.folder,
        run: () => {
          const node = nodeById(store.state, store.state.currentDocId);
          const volumeId =
            node?.kind === 'volume'
              ? node.id
              : node?.kind === 'chapter'
                ? node.parent_id
                : node?.parent_id
                  ? (nodeById(store.state, node.parent_id)?.parent_id ?? null)
                  : null;
          const target = volumeId ?? lastVolumeId();
          if (!target) {
            toast('请先新建一卷', 'warn');
            return;
          }
          void actions.createNode('chapter', target);
        },
      },
      {
        id: 'new-volume',
        title: '新建卷',
        group: '写作',
        icon: ICONS.layers,
        run: () => actions.createNode('volume', null),
      },
      {
        id: 'snapshot',
        title: '创建版本快照',
        group: '写作',
        icon: ICONS.history,
        run: () => actions.createSnapshot('manual'),
      },
      {
        id: 'lint-current',
        title: '检查当前场景',
        group: '检查',
        icon: ICONS.shield,
        run: () => actions.lintCurrent(),
      },
      {
        id: 'lint-book',
        title: '检查全书',
        group: '检查',
        icon: ICONS.shield,
        run: () => actions.lintBook(),
      },
    );

    for (const def of panels) {
      items.push({
        id: `panel-${def.id}`,
        title: `打开${def.title}面板`,
        group: '面板',
        icon: def.icon,
        keywords: def.id,
        run: () => actions.setRightPanel(def.id),
      });
    }

    items.push(
      {
        id: 'graph',
        title: '打开关系图谱',
        group: '视图',
        keywords: '图谱 关系 网络 人物关系',
        icon: ICONS.graph,
        run: () => openGraphView(),
      },
      {
        id: 'focus',
        title: '切换专注模式',
        group: '视图',
        hint: `${mod}⇧F`,
        icon: ICONS.focus,
        run: () => actions.toggleFocus(),
      },
      {
        id: 'typewriter',
        title: '切换打字机模式',
        group: '视图',
        icon: ICONS.typewriter,
        run: () => actions.setSettings({ typewriter: !store.state.settings.typewriter }),
      },
      {
        id: 'sidebar',
        title: '切换侧栏',
        group: '视图',
        hint: `${mod}B`,
        icon: ICONS.sidebar,
        run: () => actions.toggleSidebar(),
      },
      {
        id: 'inspector',
        title: '切换右侧面板',
        group: '视图',
        hint: `${mod}J`,
        icon: ICONS.inspector,
        run: () => toggleInspector(),
      },
      {
        id: 'theme',
        title: '切换主题（浅色 / 护眼 / 深色）',
        group: '视图',
        icon: ICONS.sliders,
        run: () => {
          const order: EditorSettings['theme'][] = ['light', 'sepia', 'dark'];
          const idx = order.indexOf(store.state.settings.theme);
          actions.setSettings({ theme: order[(idx + 1) % order.length] });
        },
      },
      {
        id: 'search',
        title: '搜索全书',
        group: '导航',
        hint: `${mod}F`,
        icon: ICONS.search,
        run: () => focusSearch(),
      },
      {
        id: 'projects',
        title: '切换作品',
        group: '导航',
        icon: ICONS.bookOpen,
        run: () => openProjectSwitcher(),
      },
      {
        id: 'trash',
        title: '打开回收站',
        group: '维护',
        icon: ICONS.trash,
        run: () => openTrash(),
      },
      {
        id: 'rebuild-index',
        title: '重建索引',
        group: '维护',
        icon: ICONS.refresh,
        run: () => actions.rebuildIndex(),
      },
      {
        id: 'backup',
        title: '立即备份',
        group: '维护',
        icon: ICONS.shield,
        run: () => actions.runBackup(),
      },
      {
        id: 'export-txt',
        title: '导出 TXT',
        group: '导出',
        icon: ICONS.download,
        run: () => actions.exportBook('txt'),
      },
      {
        id: 'export-md',
        title: '导出 Markdown',
        group: '导出',
        icon: ICONS.download,
        run: () => actions.exportBook('md'),
      },
      {
        id: 'export-docx',
        title: '导出 Word',
        group: '导出',
        icon: ICONS.download,
        run: () => actions.exportBook('docx'),
      },
      {
        id: 'settings',
        title: '打开设置',
        group: '维护',
        icon: ICONS.gear,
        run: () => actions.setRightPanel('settings'),
      },
    );

    return items;
  }

  function lastVolumeId(): string | null {
    const volumes = childrenOf(store.state, null).filter((n) => n.kind === 'volume');
    return volumes[volumes.length - 1]?.id ?? null;
  }

  function lastChapterId(): string | null {
    const volumes = childrenOf(store.state, null).filter((n) => n.kind === 'volume');
    for (let i = volumes.length - 1; i >= 0; i--) {
      const chapters = childrenOf(store.state, volumes[i].id).filter((n) => n.kind === 'chapter');
      if (chapters.length) return chapters[chapters.length - 1].id;
    }
    return null;
  }

  function focusSearch(): void {
    actions.setRightPanel('search');
    setTimeout(() => {
      const input = shell!.inspectorBody.querySelector<HTMLInputElement>('.panel-body input[type="text"], .panel-body input');
      input?.focus();
      input?.select();
    }, 40);
  }

  function openTrash(): void {
    overlays.open(
      'trash',
      (body, close) => {
        const list = h('div', { class: 'trash-list' });
        const render = (): void => {
          list.textContent = '';
          const items = store.state.trash;
          if (items.length === 0) {
            list.append(
              h(
                'div',
                { class: 'empty' },
                h('span', { html: ICONS.trash }),
                h('div', { class: 'empty-title' }, '回收站是空的'),
                h('div', { class: 'empty-hint' }, '删除的卷、章、场景会先放在这里，30 天后才真正清理。'),
              ),
            );
            return;
          }
          for (const item of items) {
            list.append(
              h(
                'div',
                { class: 'trash-row' },
                h('span', { class: 'tr-dot', html: ICONS.fileText }),
                h(
                  'span',
                  { class: 'tr-main' },
                  h('span', { class: 'tr-title truncate' }, item.title),
                  h(
                    'span',
                    { class: 'tr-sub' },
                    `${NODE_KIND_LABELS[item.kind]} · ${item.path || '—'} · 删除于 ${new Date(item.deleted_at).toLocaleString('zh-CN')}${item.is_container ? ` · 含 ${item.child_count} 项` : ''}`,
                  ),
                ),
                h(
                  'button',
                  {
                    class: 'btn sm',
                    onclick: () => {
                      void (async () => {
                        try {
                          await api.restoreTrash(item.id);
                          await actions.refreshTrash();
                          await actions.refreshTree();
                          toast('已恢复', 'ok');
                          render();
                        } catch (err) {
                          toast(`恢复失败：${err instanceof Error ? err.message : String(err)}`, 'error');
                        }
                      })();
                    },
                  },
                  '恢复',
                ),
                h(
                  'button',
                  {
                    class: 'btn sm danger',
                    onclick: () => {
                      void overlays
                        .confirm({
                          title: '彻底删除？',
                          message: `《${item.title}》将从磁盘永久删除，无法恢复。`,
                          confirmText: '彻底删除',
                          danger: true,
                          onConfirm: async () => {
                            await api.purgeTrash(item.id);
                            await actions.refreshTrash();
                            toast('已彻底删除', 'ok');
                            render();
                          },
                        })
                        .catch(() => {});
                    },
                  },
                  '彻底删除',
                ),
              ),
            );
          }
        };
        render();
        body.append(
          h('div', { class: 'trash-head' }, '删除的内容保留 30 天，恢复后会回到原来的位置。'),
          list,
          h('div', { class: 'modal-footer' }, h('button', { class: 'btn', onclick: close }, '关闭')),
        );
        void actions.refreshTrash().then(render).catch(() => {});
      },
      { title: '回收站', width: 680 },
    );
  }

  // ─────────────────────── 全局键盘 ───────────────────────

  const onKeydown = (ev: KeyboardEvent): void => {
    const mod = ev.metaKey || ev.ctrlKey;
    if (ev.isComposing) return;

    if (mod && !ev.shiftKey && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      void saveNow().then(() => {
        if (store.state.saveState === 'saved') toast('已保存', 'ok', 1200);
      });
      return;
    }
    if (mod && !ev.shiftKey && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      openCommandPalette();
      return;
    }
    if (mod && !ev.shiftKey && ev.key.toLowerCase() === 'f') {
      ev.preventDefault();
      focusSearch();
      return;
    }
    if (mod && ev.shiftKey && ev.key.toLowerCase() === 'f') {
      ev.preventDefault();
      actions.toggleFocus();
      return;
    }
    if (mod && !ev.shiftKey && ev.key.toLowerCase() === 'b') {
      ev.preventDefault();
      actions.toggleSidebar();
      return;
    }
    if (mod && !ev.shiftKey && ev.key.toLowerCase() === 'j') {
      ev.preventDefault();
      toggleInspector();
      return;
    }
    if (mod && ev.shiftKey && ev.key.toLowerCase() === 'e') {
      ev.preventDefault();
      void actions.exportBook('txt');
      return;
    }
    if (ev.key === 'Escape') {
      if (overlays.isOpen()) return; // 弹层自己处理
      if (openViewKind) {
        closeView();
        return;
      }
      if (store.state.settings.focus) {
        actions.setSettings({ focus: false });
        return;
      }
    }
  };
  window.addEventListener('keydown', onKeydown);

  // ─────────────────────── 页面生命周期（防丢稿） ───────────────────────

  const onBeforeUnload = (ev: BeforeUnloadEvent): void => {
    if (dirtyBody === null && editor.getValue() === savedBody) return;
    // 同步写草稿：这一步不依赖网络，必然完成
    const doc = currentScene();
    const projectId = store.state.projectId;
    if (doc && projectId) {
      draftCache.save(projectId, doc.id, editor.getValue(), store.state.scene?.rev ?? doc.rev ?? 0);
      // sendBeacon 是页面卸载阶段唯一可靠能发出去的请求
      try {
        const url = `/api/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(doc.id)}`;
        const payload = new Blob(
          [JSON.stringify({ body: editor.getValue(), base_rev: store.state.scene?.rev ?? doc.rev ?? 0 })],
          { type: 'application/json' },
        );
        navigator.sendBeacon?.(url, payload);
      } catch {
        /* 服务不可用时草稿已经落 localStorage */
      }
    }
    ev.preventDefault();
    ev.returnValue = '有未保存的内容，确定离开吗？';
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      const doc = currentScene();
      if (doc && dirtyBody !== null) persistDraft();
      void saveNow();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  const onOnline = (): void => {
    if (dirtyBody !== null) {
      retryCount = 0;
      void saveNow();
    }
  };
  window.addEventListener('online', onOnline);

  // ─────────────────────── WebSocket ───────────────────────

  let ws: { close: () => void; status: () => 'connecting' | 'open' | 'closed' } | null = null;

  function startEvents(): void {
    ws = connectEvents((ev) => onWsEvent(ev));
    shell?.setConnection(ws.status());
    let lastStatus = ws.status();
    // 连接状态轮询：1 秒一次很便宜。断线恢复的瞬间把没存上的内容补发一次，
    // 之后交给正常的去抖/重试逻辑，不在这里反复重试（否则会刷一堆 toast）。
    const tick = setInterval(() => {
      if (!ws) return;
      const status = ws.status();
      if (status !== lastStatus) {
        lastStatus = status;
        shell?.setConnection(status);
        if (status === 'open' && dirtyBody !== null) {
          retryCount = 0;
          clearRetry();
          void saveNow();
        }
      }
    }, 1000);
    timers.push(tick);
  }

  function onWsEvent(ev: WsEvent): void {
    switch (ev.type) {
      case 'job': {
        upsertJob(ev.job);
        if (ev.job.status === 'done') {
          onJobDone(ev.job);
        } else if (ev.job.status === 'failed') {
          toast(`任务失败：${ev.job.error ?? ev.job.message}`, 'error', 5000);
        }
        return;
      }
      case 'tree_changed': {
        if (ev.project_id && ev.project_id !== store.state.projectId) return;
        void actions.refreshTree().catch(() => {});
        return;
      }
      case 'doc_changed': {
        void onDocChanged(ev.doc_id, ev.rev);
        return;
      }
      case 'index_rebuilt': {
        toast('索引已重建', 'ok');
        return;
      }
      default:
        return;
    }
  }

  function upsertJob(job: Job): void {
    const jobs = store.state.jobs.slice();
    const idx = jobs.findIndex((j) => j.id === job.id);
    if (idx >= 0) jobs[idx] = job;
    else jobs.unshift(job);
    store.set({ jobs: jobs.slice(0, 40) });
  }

  function onJobDone(job: Job): void {
    const result = job.result as { file?: string; size?: number; chapters?: number; words?: number } | null;
    switch (job.kind) {
      case 'export': {
        if (result?.file) {
          toast('导出完成，开始下载', 'ok');
          const a = document.createElement('a');
          a.href = api.downloadUrl(result.file);
          a.download = result.file.split('/').pop() ?? 'export';
          document.body.appendChild(a);
          a.click();
          a.remove();
        } else {
          toast('导出完成', 'ok');
        }
        return;
      }
      case 'backup': {
        toast(result?.file ? `备份完成：${result.file}` : '备份完成', 'ok');
        return;
      }
      case 'import': {
        toast('导入完成', 'ok');
        void actions.refreshTree().catch(() => {});
        return;
      }
      case 'book_lint': {
        toast('全书检查完成，结果见检查面板', 'ok');
        void actions.refreshJobs().catch(() => {});
        return;
      }
      case 'rebuild_index': {
        toast('索引重建完成', 'ok');
        return;
      }
      default:
        return;
    }
  }

  async function onDocChanged(docId: string, rev: number): Promise<void> {
    // 自己保存引起的广播：忽略（否则会把自己刚写的内容重新灌回编辑器）
    const scene = store.state.scene;
    if (docId === store.state.currentDocId && scene) {
      if (rev <= scene.rev) return;
      if (dirtyBody !== null) {
        // 本地有未保存内容：不覆盖，标记冲突提示，让作者决定
        if (store.state.saveState !== 'conflict') {
          setSaveState('conflict', '服务端有新版本');
          toast('服务端有更新的版本，你的未保存内容仍在本地', 'warn', 5000);
        }
        return;
      }
      try {
        const fresh = await api.getScene(docId);
        savedBody = fresh.body;
        store.set({ scene: fresh });
        editor.setContext({
          projectId: store.state.projectId ?? '',
          doc: nodeById(store.state, docId),
          path: pathText(store.state, docId),
          countMode: store.state.project?.count_mode ?? 'hanzi',
          body: fresh.body,
        });
      } catch {
        /* 忽略：下次切换会重读 */
      }
      return;
    }
    // 非当前文档：只刷新树的字数
    void actions.refreshTree().catch(() => {});
  }

  // ─────────────────────── AppActions 实现 ───────────────────────

  const actions: AppActions = {
    async selectDoc(docId: string): Promise<void> {
      await selectDoc(docId);
      // 手机上选完文档应收起抽屉，直接看到正文
      if (isMobileViewport()) mobile?.closeDrawer();
    },

    async createNode(kind, parentId, title): Promise<void> {
      try {
        if (kind !== 'volume' && !parentId) {
          toast(`${NODE_KIND_LABELS[kind]}必须放在上级节点里`, 'warn');
          return;
        }
        const defaultTitle =
          kind === 'volume'
            ? `第${childrenOf(store.state, null).filter((n) => n.kind === 'volume').length + 1}卷`
            : kind === 'chapter'
              ? `第${childrenOf(store.state, parentId).filter((n) => n.kind === 'chapter').length + 1}章`
              : '新场景';
        const node = await api.createNode({ kind, parent_id: parentId, title: title ?? defaultTitle });
        await actions.refreshTree();
        if (node.kind === 'scene') await selectDoc(node.id);
        toast(`已新建${NODE_KIND_LABELS[kind]}`, 'ok', 1400);
      } catch (err) {
        toast(`新建失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },

    async renameNode(docId, title): Promise<void> {
      try {
        await api.renameNode(docId, title);
        await actions.refreshTree();
        if (docId === store.state.currentDocId) {
          const node = nodeById(store.state, docId);
          if (node) {
            editor.setContext({
              projectId: store.state.projectId ?? '',
              doc: node,
              path: pathText(store.state, docId),
              countMode: store.state.project?.count_mode ?? 'hanzi',
            });
          }
        }
      } catch (err) {
        toast(`重命名失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },

    async deleteNode(docId): Promise<void> {
      const node = nodeById(store.state, docId);
      if (!node) return;
      const childCount = store.state.nodes.filter((n) => n.parent_id === docId).length;
      const ok = await overlays.confirm({
        title: `删除${NODE_KIND_LABELS[node.kind]}？`,
        message:
          `《${node.title}》${childCount > 0 ? `及其下 ${childCount} 个子项` : ''}会移入回收站，30 天内可以恢复。` +
          '\n删除前会自动创建一个版本快照。',
        confirmText: '移入回收站',
        danger: true,
      });
      if (!ok) return;
      try {
        await saveNow();
        await api.deleteNode(docId);
        await actions.refreshTree();
        void actions.refreshTrash().catch(() => {});
        if (docId === store.state.currentDocId) {
          const next = firstSceneId(store.state.nodes) ?? store.state.nodes[0]?.id ?? null;
          if (next) await selectDoc(next);
          else {
            store.set({ currentDocId: null, scene: null });
            editor.setContext({ projectId: store.state.projectId ?? '', doc: null, path: '', countMode: 'hanzi' });
          }
        }
        toast('已移入回收站', 'ok');
      } catch (err) {
        toast(`删除失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },

    /**
     * 批量删除（C2 的编排点）。
     *
     * 顺序有讲究：
     *   1. 先算「要不要确认」——空章节不打扰作者
     *   2. 冲刷未保存正文，失败就中止（不能把没存的新内容连同文件一起移走）
     *   3. 调接口，成功后给 8 秒撤销入口
     *   4. 选中项与编辑器跟随到相邻文档
     */
    async deleteNodes(ids): Promise<void> {
      const nodes = store.state.nodes;
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const existing = ids.filter((id) => byId.has(id));
      if (existing.length === 0) return;

      const outermost = dedupeNested(existing, (id) => byId.get(id)?.parent_id ?? null);

      // 收集每个目标的统计（含后代）
      const collectDescendants = (rootId: string): typeof nodes => {
        const out: typeof nodes = [];
        const walk = (id: string): void => {
          for (const n of nodes.filter((x) => x.parent_id === id)) {
            out.push(n);
            walk(n.id);
          }
        };
        walk(rootId);
        return out;
      };

      const targets: DeleteTarget[] = outermost.map((id) => {
        const node = byId.get(id)!;
        const desc = collectDescendants(id);
        return {
          id,
          kind: node.kind,
          status: node.status,
          words: node.kind === 'scene' ? node.word_count : 0,
          descendants: desc.length,
          descendantWords: desc.reduce((n, d) => n + (d.kind === 'scene' ? d.word_count : 0), 0),
        };
      });

      if (needsConfirm(targets)) {
        const summary = describeDeleteSummary(targets);
        const ok = await overlays.confirm({
          title: summary.count > 1 ? `删除选中的 ${summary.count} 项？` : '删除这一项？',
          message:
            (summary.descendants > 0 ? `含 ${summary.descendants} 个下级，` : '') +
            `共 ${fmtNum(summary.words)} 字。将移入回收站，30 天内可恢复。`,
          confirmText: '移入回收站',
          danger: true,
        });
        if (!ok) return;
      }

      // 冲刷未保存正文：删一个正被编辑的场景时，先把作者刚打的字落盘
      try {
        await saveNow();
      } catch (err) {
        toast(`保存失败，已取消删除：${err instanceof Error ? err.message : String(err)}`, 'error');
        return;
      }

      // 记录删除前状态，用于删后选中与编辑器跟随
      const orderBefore = visibleNodes(store.state).map((r) => r.node.id);
      const currentBefore = store.state.currentDocId;
      const deletedSet = new Set<string>();
      for (const id of outermost) {
        deletedSet.add(id);
        for (const d of collectDescendants(id)) deletedSet.add(d.id);
      }

      try {
        const res = await api.deleteNodes(outermost);
        await actions.refreshTree();
        void actions.refreshTrash().catch(() => {});

        // 选中与编辑器跟随到相邻文档
        const next = nextSelectionAfterDelete(orderBefore, deletedSet, currentBefore);
        if (currentBefore && deletedSet.has(currentBefore)) {
          if (next) {
            await selectDoc(next);
          } else {
            store.set({ currentDocId: null, scene: null });
            editor.setContext({
              projectId: store.state.projectId ?? '',
              doc: null,
              path: '',
              countMode: 'hanzi',
            });
          }
        }
        if (next) tree?.focusRow(next);

        // 8 秒撤销入口（U4：任何删除都必须可恢复）
        toast(`已删除 ${res.deleted} 项`, 'ok', 8000, {
          label: '撤销',
          onClick: () => {
            void (async () => {
              try {
                await api.restoreTrashBatch(res.items.map((i) => i.trash_id));
                await actions.refreshTree();
                void actions.refreshTrash().catch(() => {});
                toast('已恢复', 'ok');
              } catch (err) {
                toast(
                  `撤销失败：${err instanceof Error ? err.message : String(err)}，可到回收站手动恢复`,
                  'error',
                );
              }
            })();
          },
        });
      } catch (err) {
        toast(`删除失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },

    async moveNode(docId, parentId, order): Promise<void> {
      try {
        await api.moveNode(docId, { parent_id: parentId, order });
        await actions.refreshTree();
      } catch (err) {
        toast(`移动失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },

    async updateNodeMeta(docId, patch): Promise<void> {
      // 先本地更新：状态点必须立刻变色，不能等网络往返
      const nodes = store.state.nodes.map((n) => (n.id === docId ? { ...n, ...patch } : n));
      store.set({ nodes });
      try {
        await api.updateNodeMeta(docId, patch);
        if (docId === store.state.currentDocId) {
          const node = nodeById(store.state, docId);
          if (node) {
            editor.setContext({
              projectId: store.state.projectId ?? '',
              doc: node,
              path: pathText(store.state, docId),
              countMode: store.state.project?.count_mode ?? 'hanzi',
            });
          }
        }
      } catch (err) {
        toast(`更新失败：${err instanceof Error ? err.message : String(err)}`, 'error');
        await actions.refreshTree().catch(() => {});
      }
    },

    async refreshTree(): Promise<void> {
      if (!store.state.projectId) return;
      try {
        const treeData = await api.getTree();
        store.set({ nodes: treeData.nodes });
      } catch (err) {
        // 刷新失败不弹 toast（可能只是服务端重启中），状态栏会体现连接状态
        console.warn('[app] 刷新稿件树失败', err);
      }
    },

    async saveNow(): Promise<void> {
      await saveNow();
    },

    markDirty(): void {
      markDirty();
    },

    hasUnsaved(): boolean {
      return dirtyBody !== null || editor.getValue() !== savedBody;
    },

    setRightPanel(kind): void {
      const def = panels.find((p) => p.id === kind);
      if (def && !def.inInspector) {
        // 全屏面板：右栏保持原样，视图层接管
        openViewKind = kind;
        store.set({ rightPanel: kind, inspectorOpen: true });
        return;
      }
      if (openViewKind) {
        openViewKind = null;
        shell?.showView(false);
        destroyPanel();
      }
      if (kind === 'none') {
        store.set({ rightPanel: kind, inspectorOpen: false });
        return;
      }
      lastInspectorPanel = kind;
      store.set({ rightPanel: kind, inspectorOpen: true });
    },

    toggleSidebar(): void {
      store.set({ sidebarOpen: !store.state.sidebarOpen });
    },

    toggleFocus(): void {
      actions.setSettings({ focus: !store.state.settings.focus });
    },

    setSettings(patch): void {
      store.set({ settings: { ...store.state.settings, ...patch } });
    },

    async refreshEntities(): Promise<void> {
      try {
        store.set({ entities: await api.listEntities() });
      } catch (err) {
        console.warn('[app] 设定库加载失败', err);
      }
    },

    async refreshSnapshots(): Promise<void> {
      try {
        const docId = currentScene()?.id;
        store.set({ snapshots: await api.listSnapshots(docId) });
      } catch (err) {
        console.warn('[app] 快照加载失败', err);
      }
    },

    async refreshTrash(): Promise<void> {
      try {
        store.set({ trash: await api.listTrash() });
      } catch (err) {
        console.warn('[app] 回收站加载失败', err);
      }
    },

    async refreshJobs(): Promise<void> {
      try {
        store.set({ jobs: await api.listJobs() });
      } catch (err) {
        console.warn('[app] 作业列表加载失败', err);
      }
    },

    async refreshGoal(): Promise<void> {
      try {
        store.set({ goal: await api.getGoal() });
      } catch (err) {
        console.warn('[app] 目标数据加载失败', err);
      }
    },

    async refreshRules(): Promise<void> {
      try {
        store.set({ rules: await api.listRules() });
      } catch (err) {
        console.warn('[app] 规则加载失败', err);
      }
    },

    async lintCurrent(): Promise<void> {
      const doc = currentScene();
      if (!doc) {
        toast('先选一个场景再检查', 'warn');
        return;
      }
      try {
        await saveNow();
        const result = await api.lintScene(doc.id);
        store.set({ lint: result });
        actions.setRightPanel('lint');
        toast(result.issues.length === 0 ? '没有发现问题' : `发现 ${result.issues.length} 处问题`, result.issues.length ? 'warn' : 'ok');
      } catch (err) {
        toast(`检查失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },

    async lintBook(): Promise<void> {
      try {
        const job = await api.lintBook();
        upsertJob(job);
        toast('全书检查已开始，可继续写作', 'info');
      } catch (err) {
        toast(`启动检查失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },

    async rebuildIndex(): Promise<void> {
      const ok = await overlays.confirm({
        title: '重建索引？',
        message: '会重新扫描全部稿件并重建搜索索引。稿件文件不受影响，但作品很大时会占用几分钟。',
        confirmText: '开始重建',
        danger: false,
      });
      if (!ok) return;
      try {
        const job = await api.rebuildIndex();
        upsertJob(job);
        toast('索引重建已开始', 'info');
      } catch (err) {
        toast(`重建失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },

    async runBackup(): Promise<void> {
      try {
        const job = await api.runBackup();
        upsertJob(job);
        toast('备份已开始', 'info');
      } catch (err) {
        toast(`备份失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },

    async createSnapshot(reason): Promise<void> {
      const doc = currentScene();
      if (!doc) {
        toast('先选一个场景', 'warn');
        return;
      }
      try {
        await saveNow();
        await api.createSnapshot(doc.id, reason ?? 'manual');
        toast('快照已创建', 'ok');
        void actions.refreshSnapshots().catch(() => {});
      } catch (err) {
        toast(`创建快照失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },

    async restoreSnapshot(id): Promise<void> {
      const ok = await overlays.confirm({
        title: '恢复到这个版本？',
        message: '当前内容会先自动存成一份「恢复前」快照，然后被替换。恢复后可以继续编辑。',
        confirmText: '恢复',
        danger: true,
      });
      if (!ok) return;
      try {
        await saveNow();
        await api.restoreSnapshot(id);
        const doc = currentScene();
        if (doc) await selectDoc(doc.id);
        void actions.refreshSnapshots().catch(() => {});
        toast('已恢复到该版本', 'ok');
      } catch (err) {
        toast(`恢复失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },

    async search(query): Promise<void> {
      const q = query.trim();
      if (!q) {
        store.set({ search: null });
        return;
      }
      try {
        store.set({ search: await api.search(q, { limit: 50 }) });
      } catch (err) {
        toast(`搜索失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },

    async addInbox(text): Promise<void> {
      const value = text.trim();
      if (!value) return;
      try {
        await api.addInbox(value);
        toast('已存入灵感箱', 'ok', 1400);
      } catch (err) {
        toast(`保存失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },

    async exportBook(format): Promise<void> {
      try {
        const job = await api.exportBook({ format: format as ExportFormat, scope: 'book', typeset: true });
        upsertJob(job);
        toast(`正在导出 ${format.toUpperCase()}，完成后自动下载`, 'info');
      } catch (err) {
        toast(`导出失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },

    async importFile(file): Promise<void> {
      try {
        const content = await file.text();
        const preview = await api.previewImport({ filename: file.name, content });
        const ok = await overlays.confirm({
          title: '导入预览',
          message:
            `文件：${file.name}\n编码：${preview.encoding}${preview.garbled ? '（疑似乱码，请检查）' : ''}\n` +
            `切分规则：${preview.rule}\n识别到 ${preview.chapters.length} 章，共 ${fmtNum(preview.total_words)} 字。\n` +
            '导入会新建一个卷存放这些章节，原有稿件不受影响。',
          confirmText: '开始导入',
          danger: false,
        });
        if (!ok) return;
        const job = await api.runImport({ filename: file.name, content, volume_title: file.name.replace(/\.[^.]+$/, '') });
        upsertJob(job);
        toast('导入已开始，完成后会自动刷新稿件树', 'info');
      } catch (err) {
        toast(`导入失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },

    async saveEntity(entity): Promise<void> {
      try {
        await api.saveEntity(entity);
        await actions.refreshEntities();
        toast('已保存', 'ok', 1400);
      } catch (err) {
        toast(`保存失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },

    async deleteEntity(id): Promise<void> {
      const ent = store.state.entities.find((e) => e.id === id);
      const ok = await overlays.confirm({
        title: '删除条目？',
        message: `《${ent?.name ?? id}》会从设定库移除。正文里出现过的名字不受影响。`,
        confirmText: '删除',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.deleteEntity(id);
        await actions.refreshEntities();
        toast('已删除', 'ok', 1400);
      } catch (err) {
        toast(`删除失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },

    async jumpToDoc(docId): Promise<void> {
      await selectDoc(docId);
    },

    jumpToEntity(entityId): void {
      actions.setRightPanel('bible');
      // 面板可以监听这个事件做精确选中；没监听也不影响，至少打开了设定库
      window.dispatchEvent(new CustomEvent('writingdesk:focus-entity', { detail: { id: entityId } }));
    },

    async revealInEditor(docId, from, to): Promise<void> {
      if (docId && docId !== store.state.currentDocId) await selectDoc(docId);
      // 等一帧让编辑器完成装载，再定位
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      editor.revealRange(from, to);
      editor.focus();
    },

    openOverlay(kind, payload): void {
      openOverlay(kind, payload);
    },

    closeOverlay(): void {
      overlays.close();
    },

    toast(message, kind): void {
      toast(message, kind);
    },
  };

  // ─────────────────────── 引导 ───────────────────────

  /** 引导失败时把错误画在编辑区里：外壳还在，作者看得懂发生了什么，也能重试 */
  function showBootFailure(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    shell!.editorMount.textContent = '';
    mount(
      shell!.editorMount,
      h(
        'div',
        { class: 'boot-error-wrap' },
        h(
          'div',
          { class: 'boot-error' },
          h('div', { class: 'be-icon', html: ICONS.alert }),
          h('h1', null, '连不上本地写作服务'),
          h('p', { class: 'be-msg' }, message),
          h(
            'p',
            { class: 'be-hint' },
            '写作台是只在你电脑上运行的本地程序，需要后台服务在跑。请确认已用 npm start 启动服务，并且这个页面是从它的地址打开的（默认 http://127.0.0.1:7788）。',
          ),
          h(
            'div',
            { class: 'be-actions' },
            h(
              'button',
              {
                class: 'btn primary',
                onclick: () => {
                  shell!.editorMount.textContent = '';
                  shell!.editorMount.appendChild(editor.el);
                  void boot();
                },
              },
              h('span', { class: 'btn-icon', html: ICONS.refresh }),
              '重试',
            ),
            h('button', { class: 'btn', onclick: () => location.reload() }, '刷新页面'),
          ),
          h(
            'p',
            { class: 'be-hint tiny' },
            '你写过的内容不会因为连不上服务而消失：未确认保存的改动都留在本机浏览器草稿里，服务恢复后会自动提示恢复。',
          ),
        ),
      ),
    );
  }

  async function boot(): Promise<void> {
    appRoot.removeAttribute('aria-busy');
    syncShell();
    syncPanel();
    try {
      const projects = await refreshProjects();
      let projectId: string | null = null;
      try {
        projectId = localStorage.getItem(LS_PROJECT);
      } catch {
        projectId = null;
      }
      if (!projectId || !projects.some((p) => p.id === projectId)) {
        projectId = projects[0]?.id ?? null;
      }

      if (!projectId) {
        // 全新安装：建一个带示例段落的本地作品，作者打开就能写，而不是面对空白
        const starter = await createStarterProject();
        await refreshProjects();
        projectId = starter.id;
      }

      await openProject(projectId);
      startEvents();
    } catch (err) {
      console.error('[app] 引导失败', err);
      showBootFailure(err);
    }
  }

  await boot();
}

/** 最外层的兜底：连 main() 都没跑起来时的可读错误页 */
function renderFatalError(message: string): void {
  const appEl = document.getElementById('app');
  if (!appEl) {
    document.body.textContent = `写作台启动失败：${message}`;
    return;
  }
  appEl.removeAttribute('aria-busy');
  mount(
    appEl,
    h(
      'div',
      { class: 'boot-error-wrap' },
      h(
        'div',
        { class: 'boot-error' },
        h('div', { class: 'be-icon', html: ICONS.alert }),
        h('h1', null, '写作台启动失败'),
        h('p', { class: 'be-msg' }, message),
        h('p', { class: 'be-hint' }, '这通常意味着页面资源没有完整加载。请刷新页面；如果反复出现，检查浏览器控制台的报错。'),
        h(
          'div',
          { class: 'be-actions' },
          h('button', { class: 'btn primary', onclick: () => location.reload() }, '刷新页面'),
        ),
      ),
    ),
  );
}

/** 内联 SVG favicon：避免 /favicon.ico 404 在控制台刷噪音，也不额外发请求 */
function ensureFavicon(): void {
  if (document.querySelector('link[rel="icon"]')) return;
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>" +
    "<rect width='32' height='32' rx='7' fill='%23f8f6f2'/>" +
    "<path d='M9 23V9h9.5a4.5 4.5 0 0 1 0 9H12.5' fill='none' stroke='%23a8481f' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/>" +
    '</svg>';
  const link = document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/svg+xml';
  link.href = `data:image/svg+xml,${svg}`;
  document.head.appendChild(link);
}

function ensureStylesheet(href: string): void {
  if (document.querySelector(`link[rel="stylesheet"][href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

function persistCollapsed(collapsed: Set<string>): void {
  try {
    localStorage.setItem(LS_COLLAPSED, JSON.stringify([...collapsed]));
  } catch {
    /* ignore */
  }
}

function persistPanel(kind: RightPanelKind): void {
  try {
    localStorage.setItem(LS_PANEL, kind);
  } catch {
    /* ignore */
  }
  // 同时记进统一偏好：面板与外层布局是同一件事，放一处更方便排查
  persistUiPrefs({ lastPanel: kind });
}

/** 让类型检查知道这些导出被用到（保持模块边界清晰） */
export { COUNT_MODE_LABELS, WORK_MODE_LABELS };
