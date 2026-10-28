/**
 * AppContext 实现 —— 作品上下文的生命周期管理。
 *
 * 设计取舍：
 *   - 作品按需打开（懒加载）。打开 = 建 store + 开索引库 + 装配服务 + 校验索引新鲜度。
 *   - 打开后常驻内存，不做 LRU 自动关闭。理由：本地单作者、作品数有限，
 *     而「在后台作业跑到一半时把它的 SQLite 关掉」是真正的数据风险。
 *     需要回收时由 main.ts 显式调用 closeAll()。
 *   - 索引库缺失/损坏一律走 ensureFresh() 静默重建，绝不因此拒绝打开作品。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ProjectContext, AppContext } from './context.ts';
import type { ProjectMeta, ProjectSummary, TypesetPreset } from '../shared/types.ts';
import { DEFAULT_AI_CONFIG, DEFAULT_TYPESET } from '../shared/types.ts';
import { readJsonSafe } from './util/atomic.ts';
import { JobQueue } from './util/job-queue.ts';
import { ProjectStore } from './store/project.ts';
import { IndexDb } from './db/index.ts';
import { IndexerService } from './services/indexer.ts';
import { BackupScheduler } from './services/backup-scheduler.ts';
import { journalDirOf, recoverPending } from './graph/journal.ts';
import { SnapshotService } from './services/snapshot.ts';
import { BackupService } from './services/backup.ts';
import { LintService } from './services/lint.ts';
import { MentionService } from './services/mention.ts';
import { ImportService } from './services/importer.ts';
import { ExportService } from './services/exporter.ts';
import { RuleStore } from './rules/store.ts';

export interface AppContextImpl extends AppContext {
  /** 由 main.ts 注入 WebSocket 广播器；不注入时广播是空操作（便于测试） */
  setBroadcast(fn: ((event: unknown) => void) | null): void;
  /** 记录一次访问时间（供将来做 LRU 回收） */
  touch(id: string): void;
  /** 关闭全部作品（进程退出前调用） */
  closeAll(): Promise<void>;
}

export function createAppContext(dataDir: string): AppContextImpl {
  /** 已打开作品（对路由可见的活引用，不要替换这个 Map 实例） */
  const projects = new Map<string, ProjectContext>();
  /** 每个打开的作品一个备份调度器，关闭作品时要一起停掉 */
  const backupSchedulers = new Map<string, BackupScheduler>();
  /** 打开中的作品：并发请求同一作品时只真正打开一次 */
  const opening = new Map<string, Promise<ProjectContext>>();
  const jobs = new JobQueue();

  let broadcaster: ((event: unknown) => void) | null = null;

  function touch(id: string): void {
    const ctx = projects.get(id);
    if (!ctx) return;
    ctx.last_used = Date.now();
  }

  function broadcast(event: unknown): void {
    broadcaster?.(event);
  }

  /**
   * 装配一个作品的全部服务。
   *
   * 服务构造函数只接收 ctx 且不在构造期访问其成员（与服务层约定），
   * 所以可以先造一个「骨架 ctx」再把服务挂上去 —— 这是打破
   * 「服务需要 ctx / ctx 需要服务」循环依赖的最小做法。
   */
  function buildProjectContext(
    root: string,
    id: string,
    store: ProjectStore,
    index: IndexDb,
  ): ProjectContext {
    const ctx = {
      root,
      id,
      store,
      index,
      last_used: Date.now(),
    } as unknown as ProjectContext;

    Object.assign(ctx, {
      rules: new RuleStore(ctx),
      snapshots: new SnapshotService(ctx),
      backup: new BackupService(ctx),
      lint: new LintService(ctx),
      mentions: new MentionService(ctx),
      importer: new ImportService(ctx),
      exporter: new ExportService(ctx),
      indexer: new IndexerService(ctx),
    });

    return ctx;
  }

  async function openProject(id: string): Promise<ProjectContext> {
    const existing = projects.get(id);
    if (existing) {
      touch(id);
      return existing;
    }

    const inflight = opening.get(id);
    if (inflight) return inflight;

    const task = (async (): Promise<ProjectContext> => {
      const root = path.join(dataDir, id);
      const meta = await readJsonSafe<Partial<ProjectMeta> | null>(
        path.join(root, 'project.json'),
        null,
      );
      if (!meta) throw new Error(`作品不存在或 project.json 损坏：${id}`);

      const store = new ProjectStore(root);
      const index = await IndexDb.open(store.paths.indexDb);
      const ctx = buildProjectContext(root, id, store, index);

      // 先补齐上次没走完的多文件事务（关系方向反转、端点接续等）。
      // 必须在建索引之前做 —— 否则索引会基于"半边关系"的文件建立。
      try {
        const { recovered, failed } = await recoverPending(
          root,
          journalDirOf(store.paths.studio),
        );
        if (recovered.length > 0) {
          console.log(`[app-context] ${id} 补齐了 ${recovered.length} 个未完成的多文件操作`);
        }
        for (const f of failed) {
          console.error(`[app-context] ${id} 未完成操作 ${f.id} 恢复失败：${f.error}`);
        }
      } catch (err) {
        // 恢复失败不能阻塞作品打开：文件仍在，作者至少能读到内容
        console.error(`[app-context] ${id} 事务日志恢复出错：`, err);
      }

      try {
        // 索引可重建：首次打开或索引丢失时这里会静默全量重建
        await ctx.indexer.ensureFresh();
      } catch (err) {
        // 索引坏了不能连累作品打开 —— 关掉坏库、清空后重建一次
        console.error(`[app-context] ${id} 索引校验失败，尝试重建:`, err);
        try {
          index.close();
        } catch {
          /* 已关闭 */
        }
        const fresh = await IndexDb.open(store.paths.indexDb);
        const rebuilt = buildProjectContext(root, id, store, fresh);
        try {
          fresh.clear();
        } catch {
          /* 清不动就让 ensureFresh 自己判断 */
        }
        await rebuilt.indexer.ensureFresh();
        projects.set(id, rebuilt);
        return rebuilt;
      }

      projects.set(id, ctx);
      return ctx;
    })();

    opening.set(id, task);
    try {
      const ctx = await task;
      // 定时备份：按每个目标的 interval_min 自动运行。
      // 放在 openProject 成功后启动，保证 ctx 已完全装配。
      const scheduler = new BackupScheduler(ctx, jobs);
      scheduler.start();
      backupSchedulers.set(id, scheduler);
      return ctx;
    } finally {
      opening.delete(id);
    }
  }

  async function closeProject(id: string): Promise<void> {
    const ctx = projects.get(id);
    if (!ctx) return;
    projects.delete(id);
    // 先停调度器，避免关闭过程中又提交新的备份作业
    backupSchedulers.get(id)?.stop();
    backupSchedulers.delete(id);
    try {
      // SQLite 的 WAL 在 close 时落盘；不 close 会留下 -wal 文件
      ctx.index.close();
    } catch (err) {
      console.error(`[app-context] 关闭 ${id} 索引失败:`, err);
    }
  }

  async function closeAll(): Promise<void> {
    for (const id of [...projects.keys()]) await closeProject(id);
  }

  return {
    dataDir,
    projects,
    jobs,
    broadcast,
    openProject,
    closeProject,
    listOpen: () => [...projects.values()],
    setBroadcast: (fn) => {
      broadcaster = fn;
    },
    touch,
    closeAll,
  };
}

// ─────────────────────── 作品扫描 ───────────────────────

/**
 * 扫描数据目录，列出全部作品。
 *
 * 字数来源优先级：已打开作品的索引 → 磁盘上的 index.sqlite → 直接扫 manuscript。
 * 前两者是 O(1)，最后一条只在「作品从没打开过」时发生一次，
 * 换来的是作品选择器里不出现「0 字」的假数据。
 */
/**
 * 启动时扫描所有作品，补齐上次没走完的多文件事务。
 *
 * 为什么要在启动时做，而不是只依赖「打开作品时恢复」：
 *   崩溃发生在写关系的中途时，文件处于「半边」状态。如果作者重启服务后
 *   没点开那个作品，不一致状态就会一直留在磁盘上 —— 用户用任何编辑器
 *   或 git 看到的都是错的。启动时统一扫一遍，代价只是读几个目录。
 *
 * 只处理日志，不打开作品、不建索引（那些等真正访问时再做）。
 */
export async function recoverAllPending(
  dataDir: string,
): Promise<{ projects: number; recovered: number; failed: number }> {
  let projects = 0;
  let recovered = 0;
  let failed = 0;

  let names: string[];
  try {
    names = await fs.readdir(dataDir);
  } catch {
    return { projects, recovered, failed };
  }

  for (const name of names) {
    const root = path.join(dataDir, name);
    const studioDir = path.join(root, '.studio');
    const journalDir = journalDirOf(studioDir);

    // 只处理确实有日志目录的作品，避免为每个目录 stat 一遍
    const hasJournal = await fs
      .stat(journalDir)
      .then((st) => st.isDirectory())
      .catch(() => false);
    if (!hasJournal) continue;

    projects++;
    const result = await recoverPending(root, journalDir).catch((err) => {
      console.error(`[app-context] 恢复 ${name} 的未完成事务失败：`, err);
      return { recovered: [], failed: [{ id: name, error: String(err) }] };
    });

    recovered += result.recovered.length;
    failed += result.failed.length;

    if (result.recovered.length > 0) {
      console.log(
        `[app-context] ${name} 补齐了 ${result.recovered.length} 个未完成的多文件操作`,
      );
    }
    for (const f of result.failed) {
      console.error(`[app-context] ${name} 未完成操作 ${f.id} 恢复失败：${f.error}`);
    }
  }

  return { projects, recovered, failed };
}

export async function listProjectSummaries(
  dataDir: string,
  appCtx?: AppContext,
): Promise<ProjectSummary[]> {
  let dirs: string[];
  try {
    dirs = (await fs.readdir(dataDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const out: ProjectSummary[] = [];
  for (const id of dirs) {
    const root = path.join(dataDir, id);
    const raw = await readJsonSafe<Partial<ProjectMeta> | null>(
      path.join(root, 'project.json'),
      null,
    );
    // 没有 project.json 的目录不是作品（可能是用户的备份或手放的文件）
    if (!raw) continue;

    const meta = normalizeMeta(raw, id);
    const counts = await projectCounts(root, id, appCtx);
    out.push({
      id,
      title: meta.title,
      author: meta.author,
      mode: meta.mode,
      count_mode: meta.count_mode,
      daily_goal: meta.daily_goal,
      updated_at: meta.updated_at,
      word_count: counts.word_count,
      scene_count: counts.scene_count,
      path: root,
    });
  }

  out.sort((a, b) => b.updated_at - a.updated_at || a.title.localeCompare(b.title, 'zh'));
  return out;
}

/** 把磁盘上的半截 project.json 补齐成完整 ProjectMeta（迁移只增不破坏） */
export function normalizeMeta(raw: Partial<ProjectMeta>, id: string): ProjectMeta {
  const now = Date.now();
  const typeset: TypesetPreset = { ...DEFAULT_TYPESET, ...(raw.typeset ?? {}) };
  return {
    id: raw.id ?? id,
    schema_version: raw.schema_version ?? 1,
    title: raw.title ?? id,
    author: raw.author ?? '',
    mode: raw.mode ?? 'webnovel',
    count_mode: raw.count_mode ?? 'hanzi',
    daily_goal: typeof raw.daily_goal === 'number' ? raw.daily_goal : 3000,
    created_at: raw.created_at ?? now,
    updated_at: raw.updated_at ?? now,
    typeset,
    lan: { enabled: false, ...(raw.lan ?? {}) },
    auto_punct: raw.auto_punct ?? false,
    ai: {
      ...DEFAULT_AI_CONFIG,
      ...(raw.ai ?? {}),
      features: { ...DEFAULT_AI_CONFIG.features, ...(raw.ai?.features ?? {}) },
    },
  };
}

async function projectCounts(
  root: string,
  id: string,
  appCtx?: AppContext,
): Promise<{ word_count: number; scene_count: number }> {
  const open = appCtx?.projects.get(id);
  if (open) {
    try {
      return { word_count: open.index.totalWords(), scene_count: open.index.countDocs('scene') };
    } catch {
      /* 索引异常则走下面的兜底 */
    }
  }

  const dbFile = path.join(root, '.studio', 'index.sqlite');
  try {
    await fs.access(dbFile);
    const db = await IndexDb.open(dbFile);
    try {
      return { word_count: db.totalWords(), scene_count: db.countDocs('scene') };
    } finally {
      db.close();
    }
  } catch {
    // 索引不存在或打不开：退回扫磁盘，慢一次但数字是真的
    try {
      return await new ProjectStore(root).totals();
    } catch {
      return { word_count: 0, scene_count: 0 };
    }
  }
}

/** 由标题生成作品目录名：去掉路径分隔符与保留字符，保证目录唯一 */
export async function uniqueProjectDir(dataDir: string, title: string): Promise<string> {
  const base =
    String(title ?? '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || '未命名作品';

  let candidate = base;
  let n = 2;
  for (;;) {
    const root = path.join(dataDir, candidate);
    const dirExists = await fs
      .access(root)
      .then(() => true)
      .catch(() => false);
    if (!dirExists) return candidate;
    candidate = `${base} ${n++}`;
  }
}
