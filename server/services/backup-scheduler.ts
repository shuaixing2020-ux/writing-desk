/**
 * 定时备份调度器。
 *
 * 为什么单独成模块：
 *   BackupService 只负责「执行一次备份」，不该知道时间。调度是另一个职责，
 *   混在一起会让服务层持有定时器，测试时不好收尾（进程不退出）。
 *
 * 调度策略：
 *   - 单一低频 tick（默认每 60 秒），检查每个已启用的目标是否到期。
 *     不给每个目标各起一个 setInterval —— 目标增删时容易漏清定时器。
 *   - 到期判定用「上次运行时间 + interval_min」，而不是固定时刻，
 *     这样服务重启后不会因为错过某个整点而漏备份。
 *   - 同时只跑一个备份作业（走 JobQueue，天然串行），避免多个目标
 *     同时打包抢占磁盘 IO，影响作者打字。
 *   - 备份失败只记日志与 last_error，不抛、不重试轰炸；下一个 tick 会再判断。
 *
 * 边界：
 *   - interval_min <= 0 视为「不定时」（只手动备份）
 *   - 服务启动后不立刻备份，等第一个 tick（避免刚开机就抢 IO）
 *   - 关闭时清掉定时器，进程能正常退出
 */

import type { ProjectContext } from '../context.ts';
import type { JobQueue } from '../util/job-queue.ts';

/** 检查间隔：60 秒足够精确，且开销可忽略 */
const TICK_MS = 60_000;

export interface BackupSchedulerOptions {
  /** 检查间隔，测试时可注入更短的值 */
  tickMs?: number;
  /** 日志前缀 */
  logPrefix?: string;
}

export class BackupScheduler {
  private ctx: ProjectContext;
  private jobs: JobQueue;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = false;
  private readonly tickMs: number;
  private readonly logPrefix: string;
  /** 记录哪些目标本次已提交，避免 tick 期间重复提交同一个 */
  private inflight = new Set<string>();

  constructor(ctx: ProjectContext, jobs: JobQueue, opts: BackupSchedulerOptions = {}) {
    this.ctx = ctx;
    this.jobs = jobs;
    this.tickMs = opts.tickMs ?? TICK_MS;
    this.logPrefix = opts.logPrefix ?? `[backup:${ctx.id}]`;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    // 不要因为定时器把进程钉住（测试与 CLI 场景很重要）
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 立即检查一次（测试与「保存后顺手检查」用） */
  async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const targets = await this.ctx.backup.list();
      const now = Date.now();

      for (const target of targets) {
        if (!target.enabled) continue;
        if (target.interval_min <= 0) continue; // 只手动
        if (this.inflight.has(target.id)) continue;

        const last = target.last_run ?? 0;
        const dueAt = last + target.interval_min * 60_000;
        // 留 5 秒容差：避免 tick 恰好落在边界前一点点导致整体推迟一轮
        if (now + 5_000 < dueAt) continue;

        this.inflight.add(target.id);
        this.jobs.submit('backup', async (jobCtx) => {
          try {
            jobCtx.note(`定时备份：${target.dir}`);
            const result = await this.ctx.backup.run(jobCtx, target.id);
            const one = Array.isArray(result) ? result[0] : result;
            if (one) {
              console.log(`${this.logPrefix} 定时备份完成 → ${one.file}（${formatBytes(one.size)}）`);
            }
            return result;
          } catch (err) {
            console.error(`${this.logPrefix} 定时备份失败：`, err);
            throw err;
          } finally {
            this.inflight.delete(target.id);
          }
        });
      }
    } catch (err) {
      // 读配置失败不致命，下一个 tick 再试
      console.error(`${this.logPrefix} 检查备份计划失败：`, err);
    } finally {
      this.running = false;
    }
  }

  /**
   * 计算某个目标距离下次备份的毫秒数（用于界面提示）。
   * 返回 null 表示不定时。
   */
  static nextRunIn(target: { enabled: boolean; interval_min: number; last_run: number | null }): number | null {
    if (!target.enabled || target.interval_min <= 0) return null;
    const due = (target.last_run ?? 0) + target.interval_min * 60_000;
    return Math.max(0, due - Date.now());
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
