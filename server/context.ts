/**
 * 应用上下文 —— 服务端所有模块的依赖注入点。
 *
 * 每个已打开的作品对应一个 ProjectContext（独立 store、独立索引、独立备份设置）。
 * 路由通过 ctx 取用服务，不直接 new 任何东西。
 */

import type { ProjectStore } from './store/project.ts';
import type { IndexDb } from './db/index.ts';
import type { JobQueue } from './util/job-queue.ts';
import type { SnapshotService } from './services/snapshot.ts';
import type { BackupService } from './services/backup.ts';
import type { LintService } from './services/lint.ts';
import type { MentionService } from './services/mention.ts';
import type { IndexerService } from './services/indexer.ts';
import type { ImportService } from './services/importer.ts';
import type { ExportService } from './services/exporter.ts';
import type { RuleStore } from './rules/store.ts';

export interface ProjectContext {
  /** 作品根目录绝对路径 */
  readonly root: string;
  /** 用于 URL 的稳定标识（目录名 slug） */
  readonly id: string;
  readonly store: ProjectStore;
  readonly index: IndexDb;
  readonly snapshots: SnapshotService;
  readonly backup: BackupService;
  readonly lint: LintService;
  readonly mentions: MentionService;
  readonly indexer: IndexerService;
  readonly importer: ImportService;
  readonly exporter: ExportService;
  readonly rules: RuleStore;
  /** 最近活动时间，用于 LRU 关闭 */
  last_used: number;
}

export interface AppContext {
  /** 数据根目录（默认 <repo>/data/projects，可用 WD_DATA_DIR 覆盖） */
  readonly dataDir: string;
  /** 已打开的作品，key 为作品 id */
  readonly projects: Map<string, ProjectContext>;
  readonly jobs: JobQueue;
  /** 向所有 WebSocket 客户端广播 */
  broadcast(event: unknown): void;
  /** 打开（或复用）作品 */
  openProject(id: string): Promise<ProjectContext>;
  /** 关闭作品（刷盘、关库） */
  closeProject(id: string): Promise<void>;
  /** 已打开的作品 */
  listOpen(): ProjectContext[];
}
