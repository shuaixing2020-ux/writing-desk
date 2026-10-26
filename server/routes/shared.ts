/**
 * 路由层公共设施：错误、项目定位、作业归属、写作统计、索引修补。
 *
 * 这些函数不属于任何单个路由文件，但每个路由都依赖它们。
 * 单独抽出来是为了让「作业归属」和「每日字数」这类有状态的东西只有一份实现，
 * 避免各路由各写一套导致数字对不上。
 */

import path from 'node:path';
import type { AppContext, ProjectContext } from '../context.ts';
import type { DailyStat, GoalProgress, Job, JobKind } from '../../shared/types.ts';
import type { JobRunner } from '../util/job-queue.ts';
import { exists, readJsonSafe, writeJsonAtomic } from '../util/atomic.ts';

// ─────────────────────── 错误 ───────────────────────

/**
 * 路由层统一错误。Fastify 的错误处理会读 statusCode / code，
 * 前端 api.ts 读 { error, code }，所以两者在这里对齐。
 */
export class HttpError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, message: string, code = 'error') {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function badRequest(message: string, code = 'bad_request'): HttpError {
  return new HttpError(400, message, code);
}

export function notFound(message: string, code = 'not_found'): HttpError {
  return new HttpError(404, message, code);
}

// ─────────────────────── 参数校验 ───────────────────────

export function requireString(
  value: unknown,
  field: string,
  opts: { max?: number; allowEmpty?: boolean; trim?: boolean } = {},
): string {
  if (typeof value !== 'string') throw badRequest(`字段 ${field} 必须是字符串`);
  const text = opts.trim === false ? value : value.trim();
  if (!opts.allowEmpty && text.length === 0) throw badRequest(`字段 ${field} 不能为空`);
  if (opts.max && text.length > opts.max) throw badRequest(`字段 ${field} 超过长度上限（${opts.max}）`);
  return text;
}

export function optionalString(value: unknown, field: string, max = 4000): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field, { allowEmpty: true, max });
}

export function requireNumber(value: unknown, field: string, fallback?: number): number {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw badRequest(`字段 ${field} 必须是数字`);
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw badRequest(`字段 ${field} 必须是数字`);
  return n;
}

export function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw badRequest(`字段 ${field} 必须是字符串数组`);
  return value.map((v, i) => requireString(v, `${field}[${i}]`, { allowEmpty: true, max: 200 }));
}

/** 只取白名单里的键，避免客户端 patch 里塞进 id/created_at 之类的字段 */
export function pickDefined<T extends Record<string, unknown>>(source: unknown, keys: string[]): T {
  const out: Record<string, unknown> = {};
  if (!source || typeof source !== 'object') return out as T;
  const rec = source as Record<string, unknown>;
  for (const key of keys) {
    if (rec[key] !== undefined) out[key] = rec[key];
  }
  return out as T;
}

// ─────────────────────── 项目定位 ───────────────────────

/**
 * 从 URL 里的 pid 拿到项目上下文。
 * pid 直接参与磁盘路径拼接，必须先挡住路径穿越再交给 openProject。
 */
export async function projectOf(appCtx: AppContext, pid: string): Promise<ProjectContext> {
  if (
    typeof pid !== 'string' ||
    pid.length === 0 ||
    pid.includes('/') ||
    pid.includes('\\') ||
    pid === '.' ||
    pid === '..'
  ) {
    throw badRequest('作品标识不合法', 'bad_project_id');
  }
  const root = path.join(appCtx.dataDir, pid);
  if (!(await exists(path.join(root, 'project.json')))) {
    throw notFound(`作品不存在：${pid}`, 'project_not_found');
  }
  return appCtx.openProject(pid);
}

// ─────────────────────── 作业归属 ───────────────────────

/**
 * JobQueue 是全局的，但前端接口挂在 /api/projects/:pid 下。
 * 这里记录每个作业属于哪个作品，列表与详情都按此过滤，
 * 避免 A 作品的导出作业出现在 B 作品的作业面板里。
 */
const jobProjects = new Map<string, string>();

export function submitJob(
  appCtx: AppContext,
  pid: string,
  kind: JobKind,
  runner: JobRunner,
): Job {
  const job = appCtx.jobs.submit(kind, runner);
  jobProjects.set(job.id, pid);
  return job;
}

export function jobsFor(appCtx: AppContext, pid: string): Job[] {
  return appCtx.jobs.list().filter((job) => jobProjects.get(job.id) === pid);
}

export function jobFor(appCtx: AppContext, pid: string, jobId: string): Job | null {
  const job = appCtx.jobs.get(jobId);
  if (!job) return null;
  return jobProjects.get(jobId) === pid ? job : null;
}

// ─────────────────────── 每日写作统计 ───────────────────────

/**
 * 每日字数记录在 .studio/stats.json。
 * 它不在稿件文件里（不能污染正文），也不在 SQLite 里（索引可重建，但打卡记录重建不了）。
 * .studio 整体可丢弃，代价只是丢打卡历史，不影响任何稿件。
 */
interface DayStat {
  words: number;
  seconds: number;
}

interface StatsFile {
  days: Record<string, DayStat>;
  /** 上次保存时间，用于估算写作时长（两次保存间隔） */
  last_write_at: number;
}

const EMPTY_STATS: StatsFile = { days: {}, last_write_at: 0 };
const STATS_KEEP_DAYS = 400;

function statsPath(ctx: ProjectContext): string {
  return path.join(ctx.root, '.studio', 'stats.json');
}

/** 本地时区的 YYYY-MM-DD（不能用 toISOString，那是 UTC，跨时区会错一天） */
export function localDateKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function readStats(ctx: ProjectContext): Promise<StatsFile> {
  const raw = await readJsonSafe<Partial<StatsFile>>(statsPath(ctx), EMPTY_STATS);
  return {
    days: raw.days && typeof raw.days === 'object' ? raw.days : {},
    last_write_at: typeof raw.last_write_at === 'number' ? raw.last_write_at : 0,
  };
}

/** 同一作品的统计写入串行化，避免两次保存并发读改写互相覆盖 */
const statsLocks = new Map<string, Promise<unknown>>();

function withStatsLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const prev = statsLocks.get(root) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  statsLocks.set(
    root,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * 记录一次保存带来的字数增量。
 * 只累计正向增量：删改导致的字数减少不计入「今日写了多少」，
 * 否则反复删写会让目标进度归零，激励意义就没了。
 */
export async function recordWrite(ctx: ProjectContext, deltaWords: number): Promise<void> {
  const delta = Math.max(0, Math.round(deltaWords));
  await withStatsLock(ctx.root, async () => {
    const stats = await readStats(ctx);
    const key = localDateKey();
    const day: DayStat = stats.days[key] ?? { words: 0, seconds: 0 };
    day.words += delta;

    const now = Date.now();
    if (delta > 0) {
      // 两次保存间隔即视为写作时长；上限 5 分钟，避免挂机一晚被算成写作时长
      if (stats.last_write_at > 0) {
        const gap = Math.round((now - stats.last_write_at) / 1000);
        day.seconds += Math.min(300, Math.max(0, gap));
      }
      stats.last_write_at = now;
    }

    stats.days[key] = day;
    const keys = Object.keys(stats.days).sort();
    while (keys.length > STATS_KEEP_DAYS) {
      const drop = keys.shift();
      if (drop) delete stats.days[drop];
    }
    await writeJsonAtomic(statsPath(ctx), stats);
  });
}

/** 组装今日目标进度（前端 stats 面板与状态栏共用） */
export async function goalProgress(ctx: ProjectContext): Promise<GoalProgress> {
  const meta = await ctx.store.readMeta();
  const stats = await readStats(ctx);
  const today = localDateKey();
  const goal = Math.max(0, Math.round(meta.daily_goal || 0));
  const written = Math.max(0, stats.days[today]?.words ?? 0);

  const recent: DailyStat[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = localDateKey(d);
    recent.push({
      date: key,
      words: Math.max(0, stats.days[key]?.words ?? 0),
      seconds: Math.max(0, stats.days[key]?.seconds ?? 0),
    });
  }

  // 连续打卡：今天有字就从今天数，今天还没写就从昨天数（当天还没开始写不该断签）
  let streak = 0;
  const cursor = new Date();
  if ((stats.days[today]?.words ?? 0) <= 0) cursor.setDate(cursor.getDate() - 1);
  for (let i = 0; i < 400; i++) {
    const key = localDateKey(cursor);
    if ((stats.days[key]?.words ?? 0) > 0) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }

  return {
    date: today,
    goal,
    written,
    ratio: goal > 0 ? written / goal : 0,
    streak,
    recent,
    total_words: ctx.index.totalWords(),
  };
}

// ─────────────────────── 索引修补 ───────────────────────

/**
 * 树结构变更后（新建/改名/移动/恢复）把 SQLite 索引对齐到磁盘。
 *
 * 只重扫「元数据变了」的场景，不重建全书 —— 改个卷名不该触发 300 万字重扫。
 * 索引本来就是可重建的，这里做的是便宜的增量修补。
 */
export async function syncTreeToIndex(ctx: ProjectContext): Promise<void> {
  const tree = await ctx.store.readTree();
  for (const node of tree.nodes) {
    if (node.kind === 'scene') {
      const indexed = ctx.index.getDoc(node.id);
      const stale =
        !indexed ||
        indexed.updated_at !== node.updated_at ||
        indexed.title !== node.title ||
        indexed.parent_id !== node.parent_id ||
        indexed.order_no !== node.order ||
        indexed.path !== (node.file ?? '') ||
        indexed.status !== node.status;
      if (stale) await ctx.indexer.indexDoc(node);
    } else {
      // 卷/章只是容器，正文位置放摘要，供搜索与路径展示使用
      ctx.index.upsertDoc({
        id: node.id,
        path: node.file ?? '',
        kind: node.kind,
        title: node.title,
        parent_id: node.parent_id,
        order_no: node.order,
        status: node.status,
        words: 0,
        hash: '',
        body: node.summary,
        updated_at: node.updated_at,
      });
    }
  }
}

/** 文档在树中的路径文本，如「第一卷 / 第一章」；不含文档自身 */
export function parentPathText(ctx: ProjectContext, docId: string): string {
  const parts: string[] = [];
  const guard = new Set<string>();
  let cur = ctx.index.getDoc(docId);
  let parentId = cur?.parent_id ?? null;
  while (parentId && !guard.has(parentId)) {
    guard.add(parentId);
    const parent = ctx.index.getDoc(parentId);
    if (!parent) break;
    parts.unshift(parent.title);
    parentId = parent.parent_id;
  }
  return parts.join(' / ');
}
