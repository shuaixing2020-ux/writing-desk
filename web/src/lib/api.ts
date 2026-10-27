/**
 * 前端 API 客户端 —— 前后端唯一的 HTTP 契约。
 *
 * 服务端路由必须与此处一一对应。改这里就要改 server/routes/。
 * 所有方法失败时抛 ApiClientError（含中文可读信息）。
 */

import type {
  AiConfig,
  AiResponse,
  AiStatus,
  BackupTarget,
  DailyStat,
  DocNode,
  DocTree,
  Entity,
  EntityDetail,
  ExportRequest,
  ExportResult,
  GoalProgress,
  ImportPreview,
  Job,
  LintResult,
  Note,
  ProjectMeta,
  ProjectSummary,
  RuleDef,
  SaveSceneResponse,
  SceneContent,
  SearchResult,
  SnapshotContent,
  SnapshotMeta,
  TrashItem,
  TypesetPreset,
  WsEvent,
} from '../../../shared/types.ts';

export class ApiClientError extends Error {
  code: string;
  status: number;
  payload: unknown;

  constructor(message: string, status: number, code = 'error', payload: unknown = null) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

/** 当前打开的项目 id（多作品支持） */
let activeProjectId: string | null = null;

export function setActiveProject(id: string | null): void {
  activeProjectId = id;
}

export function getActiveProject(): string | null {
  return activeProjectId;
}

function projectPrefix(): string {
  if (!activeProjectId) throw new ApiClientError('尚未打开作品', 0, 'no_project');
  return `/api/projects/${encodeURIComponent(activeProjectId)}`;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new ApiClientError(
      `无法连接本地服务（${(err as Error).message}）。请确认写作台服务仍在运行。`,
      0,
      'network',
    );
  }

  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!res.ok) {
    const errObj = payload as { error?: string; code?: string } | null;
    throw new ApiClientError(
      errObj?.error || `请求失败（HTTP ${res.status}）`,
      res.status,
      errObj?.code ?? 'error',
      payload,
    );
  }
  return payload as T;
}

const get = <T>(url: string) => request<T>('GET', url);
const post = <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {});
const patch = <T>(url: string, body: unknown) => request<T>('PATCH', url, body);
const del = <T>(url: string) => request<T>('DELETE', url);

export const api = {
  // ─────────── 作品 ───────────
  listProjects: () => get<ProjectSummary[]>('/api/projects'),

  createProject: (input: { title: string; author?: string; mode?: ProjectMeta['mode'] }) =>
    post<ProjectSummary>('/api/projects', input),

  getProject: () => get<ProjectMeta>(`${projectPrefix()}/meta`),

  updateProject: (patchBody: Partial<ProjectMeta>) =>
    patch<ProjectMeta>(`${projectPrefix()}/meta`, patchBody),

  getGoal: () => get<GoalProgress>(`${projectPrefix()}/goal`),

  // ─────────── 文档树 ───────────
  getTree: () => get<DocTree>(`${projectPrefix()}/tree`),

  createNode: (input: { kind: DocNode['kind']; parent_id: string | null; title: string }) =>
    post<DocNode>(`${projectPrefix()}/nodes`, input),

  renameNode: (id: string, title: string) =>
    patch<DocNode>(`${projectPrefix()}/nodes/${encodeURIComponent(id)}`, { title }),

  updateNodeMeta: (
    id: string,
    patchBody: Partial<Pick<DocNode, 'status' | 'summary' | 'pov' | 'time' | 'tags' | 'plotlines'>>,
  ) => patch<void>(`${projectPrefix()}/nodes/${encodeURIComponent(id)}`, patchBody),

  moveNode: (id: string, input: { parent_id: string; order: number }) =>
    post<void>(`${projectPrefix()}/nodes/${encodeURIComponent(id)}/move`, input),

  deleteNode: (id: string) => del<void>(`${projectPrefix()}/nodes/${encodeURIComponent(id)}`),

  // ─────────── 正文 ───────────
  getScene: (id: string) => get<SceneContent>(`${projectPrefix()}/scenes/${encodeURIComponent(id)}`),

  saveScene: (id: string, body: string, baseRev: number) =>
    post<SaveSceneResponse>(`${projectPrefix()}/scenes/${encodeURIComponent(id)}`, {
      body,
      base_rev: baseRev,
    }),

  // ─────────── 设定库 ───────────
  listEntities: () => get<Entity[]>(`${projectPrefix()}/entities`),

  getEntity: (id: string) => get<EntityDetail>(`${projectPrefix()}/entities/${encodeURIComponent(id)}`),

  saveEntity: (input: Partial<Entity> & { type: Entity['type']; name: string }) =>
    post<Entity>(`${projectPrefix()}/entities`, input),

  deleteEntity: (id: string) => del<void>(`${projectPrefix()}/entities/${encodeURIComponent(id)}`),

  // ─────────── 搜索 ───────────
  search: (q: string, opts: { kind?: 'scene' | 'entity'; limit?: number } = {}) => {
    const params = new URLSearchParams({ q });
    if (opts.kind) params.set('kind', opts.kind);
    if (opts.limit) params.set('limit', String(opts.limit));
    return get<SearchResult>(`${projectPrefix()}/search?${params}`);
  },

  // ─────────── 检查 ───────────
  lintScene: (id: string) => get<LintResult>(`${projectPrefix()}/lint/scene/${encodeURIComponent(id)}`),

  listRules: () => get<RuleDef[]>(`${projectPrefix()}/lint/rules`),

  updateRule: (ruleId: string, patchBody: Partial<RuleDef>) =>
    patch<RuleDef>(`${projectPrefix()}/lint/rules/${encodeURIComponent(ruleId)}`, patchBody),

  lintBook: () => post<Job>(`${projectPrefix()}/lint/book`),

  // ─────────── 快照 ───────────
  listSnapshots: (docId?: string) =>
    get<SnapshotMeta[]>(
      `${projectPrefix()}/snapshots${docId ? `?doc_id=${encodeURIComponent(docId)}` : ''}`,
    ),

  getSnapshot: (id: string) =>
    get<SnapshotContent>(`${projectPrefix()}/snapshots/${encodeURIComponent(id)}`),

  createSnapshot: (docId: string, reason: string) =>
    post<SnapshotMeta>(`${projectPrefix()}/snapshots`, { doc_id: docId, reason }),

  restoreSnapshot: (id: string) =>
    post<{ ok: true; rev: number }>(`${projectPrefix()}/snapshots/${encodeURIComponent(id)}/restore`),

  diffSnapshot: (id: string) =>
    get<{ snapshot: SnapshotMeta; current: SceneContent; diff: import('../../../shared/types.ts').DiffResult }>(
      `${projectPrefix()}/snapshots/${encodeURIComponent(id)}/diff`,
    ),

  // ─────────── 回收站 ───────────
  listTrash: () => get<TrashItem[]>(`${projectPrefix()}/trash`),

  restoreTrash: (id: string) => post<void>(`${projectPrefix()}/trash/${encodeURIComponent(id)}/restore`),

  purgeTrash: (id: string) => del<void>(`${projectPrefix()}/trash/${encodeURIComponent(id)}`),

  // ─────────── 灵感箱 / 笔记 ───────────
  listInbox: () => get<Array<{ id: string; text: string; created_at: number }>>(`${projectPrefix()}/inbox`),

  addInbox: (text: string) =>
    post<{ id: string; text: string; created_at: number }>(`${projectPrefix()}/inbox`, { text }),

  deleteInbox: (id: string) => del<void>(`${projectPrefix()}/inbox/${encodeURIComponent(id)}`),

  // ─────────── 导入导出 ───────────
  previewImport: (input: { filename: string; content: string }) =>
    post<ImportPreview>(`${projectPrefix()}/import/preview`, input),

  runImport: (input: { filename: string; content: string; volume_title?: string }) =>
    post<Job>(`${projectPrefix()}/import`, input),

  exportBook: (req: ExportRequest) => post<Job>(`${projectPrefix()}/export`, req),

  downloadUrl: (file: string) =>
    `${projectPrefix()}/download?file=${encodeURIComponent(file)}`,

  // ─────────── 备份 ───────────
  listBackups: () => get<BackupTarget[]>(`${projectPrefix()}/backup`),

  saveBackupTarget: (target: Partial<BackupTarget> & { dir: string }) =>
    post<BackupTarget>(`${projectPrefix()}/backup`, target),

  runBackup: (targetId?: string) =>
    post<Job>(`${projectPrefix()}/backup/run`, targetId ? { target_id: targetId } : {}),

  // ─────────── 索引 ───────────
  rebuildIndex: () => post<Job>(`${projectPrefix()}/index/rebuild`),

  // ─────────── 作业 ───────────
  listJobs: () => get<Job[]>(`${projectPrefix()}/jobs`),

  getJob: (id: string) => get<Job>(`${projectPrefix()}/jobs/${encodeURIComponent(id)}`),

  cancelJob: (id: string) => post<void>(`${projectPrefix()}/jobs/${encodeURIComponent(id)}/cancel`),

  // ─────────── 导出设置 ───────────
  saveTypeset: (typeset: TypesetPreset) =>
    patch<ProjectMeta>(`${projectPrefix()}/meta`, { typeset }),

  // ─────────── AI 接入（预留，默认关闭） ───────────
  getAi: () => get<{ config: AiConfig; status: AiStatus }>(`${projectPrefix()}/ai`),

  saveAi: (patchBody: Partial<AiConfig>) =>
    patch<{ config: AiConfig; status: AiStatus }>(`${projectPrefix()}/ai`, patchBody),

  aiGenerate: (req: { feature: string; prompt: string; context?: string; style?: string }) =>
    post<AiResponse>(`${projectPrefix()}/ai/generate`, req),
};

/** WebSocket 事件订阅（作业进度、树变更） */
export function connectEvents(onEvent: (ev: WsEvent) => void): {
  close: () => void;
  status: () => 'connecting' | 'open' | 'closed';
} {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws: WebSocket | null = null;
  let state: 'connecting' | 'open' | 'closed' = 'connecting';
  let closedByUser = false;
  let retry = 0;

  const connect = () => {
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    state = 'connecting';
    ws.onopen = () => {
      state = 'open';
      retry = 0;
    };
    ws.onmessage = (e) => {
      try {
        const ev = JSON.parse(String(e.data)) as WsEvent;
        if (ev.type !== 'ping') onEvent(ev);
      } catch {
        /* 忽略坏消息 */
      }
    };
    ws.onclose = () => {
      state = 'closed';
      if (closedByUser) return;
      // 指数退避重连，最长 10 秒
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, Math.min(500 * 2 ** retry, 10_000));
    };
    ws.onerror = () => ws?.close();
  };

  connect();

  return {
    close: () => {
      closedByUser = true;
      ws?.close();
    },
    status: () => state,
  };
}

/** 本地缓存键（IndexedDB 不可用时的降级用 localStorage） */
export const CACHE_PREFIX = 'writingdesk:';

/**
 * 未确认保存的草稿本地暂存（架构 7.1 第 2 条）。
 * 服务端确认落盘后才清除，断网/崩溃/重启都能恢复。
 */
export const draftCache = {
  key(projectId: string, docId: string): string {
    return `${CACHE_PREFIX}draft:${projectId}:${docId}`;
  },

  save(projectId: string, docId: string, body: string, rev: number): void {
    try {
      localStorage.setItem(
        this.key(projectId, docId),
        JSON.stringify({ body, rev, at: Date.now() }),
      );
    } catch {
      /* 配额满：忽略，服务端仍是真相 */
    }
  },

  load(projectId: string, docId: string): { body: string; rev: number; at: number } | null {
    try {
      const raw = localStorage.getItem(this.key(projectId, docId));
      if (!raw) return null;
      return JSON.parse(raw) as { body: string; rev: number; at: number };
    } catch {
      return null;
    }
  },

  clear(projectId: string, docId: string): void {
    try {
      localStorage.removeItem(this.key(projectId, docId));
    } catch {
      /* ignore */
    }
  },

  listDrafts(projectId: string): Array<{ docId: string; body: string; rev: number; at: number }> {
    const out: Array<{ docId: string; body: string; rev: number; at: number }> = [];
    const prefix = `${CACHE_PREFIX}draft:${projectId}:`;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k?.startsWith(prefix)) continue;
        const raw = localStorage.getItem(k);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as { body: string; rev: number; at: number };
        out.push({ docId: k.slice(prefix.length), ...parsed });
      }
    } catch {
      /* ignore */
    }
    return out;
  },
};
