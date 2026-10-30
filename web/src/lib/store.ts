/**
 * 前端应用状态与事件总线。
 *
 * 极简实现：一个可变 state + 订阅者集合。没有虚拟 DOM，没有框架。
 * 面板通过 subscribe 拿到变更，自己决定重绘哪一块。
 *
 * 设计约束（架构 5.2「无复杂构建链优先」）：
 *   - 不用框架，但也不手写 diff；面板各自持有自己的 DOM，按需局部更新
 *   - 编辑器（Tiptap/ProseMirror）完全独立于这套状态，避免输入被打断
 */

import type {
  BackupTarget,
  DocNode,
  DocStatus,
  Entity,
  GoalProgress,
  Job,
  LintResult,
  ProjectMeta,
  ProjectSummary,
  RuleDef,
  SceneContent,
  SearchResult,
  SnapshotMeta,
  TrashItem,
} from '../../../shared/types.ts';

export type RightPanelKind =
  | 'outline'
  | 'bible'
  | 'search'
  | 'lint'
  | 'snapshots'
  | 'stats'
  | 'graph'
  | 'inbox'
  | 'settings'
  | 'none';

export type ThemeName = 'light' | 'dark' | 'sepia';

export interface EditorSettings {
  fontSize: number;
  lineHeight: number;
  measure: number;
  paragraphGap: number;
  indent: number;
  font: 'serif' | 'sans';
  theme: ThemeName;
  /** 专注模式：隐藏所有面板 */
  focus: boolean;
  /** 打字机模式：光标行固定在垂直中央 */
  typewriter: boolean;
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  fontSize: 17,
  lineHeight: 1.9,
  measure: 34,
  paragraphGap: 0.85,
  indent: 0,
  font: 'serif',
  theme: 'light',
  focus: false,
  typewriter: false,
};

/** 保存状态，状态栏常显 */
export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

export interface AppState {
  // ── 作品 ──
  projectId: string | null;
  project: ProjectMeta | null;
  projects: ProjectSummary[];
  goal: GoalProgress | null;

  // ── 文档树 ──
  nodes: DocNode[];
  /** 当前选中的节点 id */
  currentDocId: string | null;
  /** 当前场景正文 */
  scene: SceneContent | null;
  /** 折叠的容器 id */
  collapsed: Set<string>;

  // ── 保存 ──
  saveState: SaveState;
  saveError: string | null;
  /** 上次成功保存时间 */
  lastSavedAt: number | null;

  // ── 面板 ──
  rightPanel: RightPanelKind;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  settings: EditorSettings;

  // ── 数据缓存 ──
  entities: Entity[];
  rules: RuleDef[];
  lint: LintResult | null;
  snapshots: SnapshotMeta[];
  trash: TrashItem[];
  backups: BackupTarget[];
  jobs: Job[];
  search: SearchResult | null;

  // ── UI ──
  /** 命令面板 / 弹窗 */
  overlay: { kind: string; payload?: unknown } | null;
  loading: boolean;
  bootError: string | null;
}

export type Listener = (state: AppState, changed: Set<keyof AppState>) => void;

export class Store {
  state: AppState;
  private listeners = new Set<Listener>();

  constructor(initial: AppState) {
    this.state = initial;
  }

  get<K extends keyof AppState>(key: K): AppState[K] {
    return this.state[key];
  }

  /** 批量更新，只通知一次 */
  set(patch: Partial<AppState>): void {
    const changed = new Set<keyof AppState>();
    for (const key of Object.keys(patch) as Array<keyof AppState>) {
      const next = patch[key];
      if (next !== this.state[key]) {
        (this.state as unknown as Record<string, unknown>)[key as string] = next;
        changed.add(key);
      }
    }
    if (changed.size === 0) return;
    for (const fn of this.listeners) {
      try {
        fn(this.state, changed);
      } catch (err) {
        console.error('[store] 监听器异常:', err);
      }
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** 只关心部分 key 的订阅（更精确的重绘） */
  watch(keys: Array<keyof AppState>, fn: (state: AppState) => void): () => void {
    const set = new Set(keys);
    return this.subscribe((state, changed) => {
      for (const k of changed) {
        if (set.has(k)) {
          fn(state);
          return;
        }
      }
    });
  }
}

// ─────────────────────── 派生查询 ───────────────────────

/** 按 id 取节点 */
export function nodeById(state: AppState, id: string | null): DocNode | null {
  if (!id) return null;
  return state.nodes.find((n) => n.id === id) ?? null;
}

/** 取子节点（按 order 排序） */
export function childrenOf(state: AppState, parentId: string | null): DocNode[] {
  return state.nodes
    .filter((n) => n.parent_id === parentId)
    .sort((a, b) => a.order - b.order);
}

/** 从根到该节点的路径 */
export function pathOf(state: AppState, id: string): DocNode[] {
  const out: DocNode[] = [];
  let cur = nodeById(state, id);
  let guard = 0;
  while (cur && guard++ < 50) {
    out.unshift(cur);
    cur = nodeById(state, cur.parent_id);
  }
  return out;
}

/** 路径文本，如「第一卷 / 第一章」 */
export function pathText(state: AppState, id: string): string {
  return pathOf(state, id)
    .map((n) => n.title)
    .join(' / ');
}

/** 当前场景所在的章与卷 */
export function currentChapter(state: AppState): DocNode | null {
  const cur = nodeById(state, state.currentDocId);
  if (!cur) return null;
  if (cur.kind === 'chapter') return cur;
  if (cur.kind === 'scene') return nodeById(state, cur.parent_id);
  return null;
}

export function currentVolume(state: AppState): DocNode | null {
  const chap = currentChapter(state);
  return chap ? nodeById(state, chap.parent_id) : null;
}

/** 全书字数 */
export function totalWords(state: AppState): number {
  return state.nodes
    .filter((n) => n.kind === 'scene')
    .reduce((sum, n) => sum + n.word_count, 0);
}

/** 各状态场景数 */
export function statusCounts(state: AppState): Record<DocStatus, number> {
  const out = { idea: 0, draft: 0, revising: 0, final: 0, published: 0 } as Record<DocStatus, number>;
  for (const n of state.nodes) {
    if (n.kind === 'scene' && n.status in out) out[n.status]++;
  }
  return out;
}

/** 深度优先展开的可见节点（考虑折叠） */
export function visibleNodes(state: AppState): Array<{ node: DocNode; depth: number }> {
  const out: Array<{ node: DocNode; depth: number }> = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const child of childrenOf(state, parentId)) {
      out.push({ node: child, depth });
      if (child.kind !== 'scene' && !state.collapsed.has(child.id)) {
        walk(child.id, depth + 1);
      }
    }
  };
  walk(null, 0);
  return out;
}
