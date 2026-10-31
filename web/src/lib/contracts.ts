/**
 * 面板与动作契约 —— 前端各面板实现的唯一接口。
 *
 * 每个面板是一个独立模块，导出 `panel` 对象。
 * 面板不直接调用 api，而是通过 actions（由 app.ts 注入）完成跨面板操作。
 */

import type { AppState, RightPanelKind, Store } from './store.ts';
import type { api } from './api.ts';

export type ToastKind = 'ok' | 'warn' | 'error' | 'info';

/** toast 上的动作按钮（如「撤销」） */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface PanelContext {
  store: Store;
  api: typeof api;
  actions: AppActions;
  /** 弹提示 */
  toast(message: string, kind?: ToastKind, ms?: number, action?: ToastAction): void;
  /** 打开模态框 */
  openOverlay(kind: string, payload?: unknown): void;
  closeOverlay(): void;
  /** 请求重新渲染本面板（数据变化后） */
  refresh(): void;
}

export interface PanelInstance {
  /** 状态变化时调用；面板自行决定重绘 */
  update?(state: AppState, changed: Set<keyof AppState>): void;
  destroy?(): void;
}

export interface PanelDef {
  id: RightPanelKind;
  title: string;
  /** 内联 SVG（stroke 风格，16x16 viewBox） */
  icon: string;
  /** 是否在右侧栏显示（false = 全屏视图，如设置） */
  inInspector: boolean;
  /** 挂载面板内容到容器 */
  mount(container: HTMLElement, ctx: PanelContext): PanelInstance;
}

// ─────────────────────── 动作接口 ───────────────────────

export interface AppActions {
  // 文档
  selectDoc(docId: string): Promise<void>;
  createNode(kind: 'volume' | 'chapter' | 'scene', parentId: string | null, title?: string): Promise<void>;
  /** 在指定位置新建（0 起）；返回新节点 id，便于调用方聚焦 */
  createNodeAt(
    kind: 'volume' | 'chapter' | 'scene',
    parentId: string | null,
    title: string,
    index: number,
  ): Promise<string | null>;
  renameNode(docId: string, title: string): Promise<void>;
  deleteNode(docId: string): Promise<void>;
  /** 批量删除（含确认、冲刷保存、撤销提示） */
  deleteNodes(ids: string[]): Promise<void>;
  moveNode(docId: string, parentId: string | null, order: number): Promise<void>;
  updateNodeMeta(
    docId: string,
    patch: Partial<Pick<import('../../../shared/types.ts').DocNode, 'status' | 'summary' | 'pov' | 'time' | 'tags' | 'plotlines'>>,
  ): Promise<void>;
  refreshTree(): Promise<void>;

  // 保存
  saveNow(): Promise<void>;
  /** 编辑器内容变更时调用（去抖保存的入口） */
  markDirty(): void;
  /** 是否有未保存内容 */
  hasUnsaved(): boolean;

  // 面板
  setRightPanel(kind: RightPanelKind): void;
  toggleSidebar(): void;
  toggleFocus(): void;
  setSettings(patch: Partial<AppState['settings']>): void;

  // 数据刷新
  refreshEntities(): Promise<void>;
  refreshSnapshots(): Promise<void>;
  refreshTrash(): Promise<void>;
  refreshJobs(): Promise<void>;
  refreshGoal(): Promise<void>;
  refreshRules(): Promise<void>;

  // 操作
  lintCurrent(): Promise<void>;
  lintBook(): Promise<void>;
  rebuildIndex(): Promise<void>;
  runBackup(): Promise<void>;
  createSnapshot(reason?: string): Promise<void>;
  restoreSnapshot(id: string): Promise<void>;
  search(query: string): Promise<void>;
  addInbox(text: string): Promise<void>;
  exportBook(format: 'txt' | 'md' | 'docx' | 'epub'): Promise<void>;
  importFile(file: File): Promise<void>;
  saveEntity(entity: Partial<import('../../../shared/types.ts').Entity> & { type: string; name: string }): Promise<void>;
  deleteEntity(id: string): Promise<void>;

  // 导航
  jumpToDoc(docId: string): Promise<void>;
  jumpToEntity(entityId: string): void;
  /** 打开全屏关系图谱（与面板里的关系图同源） */
  openGraphView(): void;

  /** 跳到正文某个字符位置（用于检查结果、搜索命中） */
  revealInEditor(docId: string, from: number, to: number): Promise<void>;

  // 弹层
  openOverlay(kind: string, payload?: unknown): void;
  closeOverlay(): void;
  toast(message: string, kind?: ToastKind, ms?: number, action?: ToastAction): void;
}
