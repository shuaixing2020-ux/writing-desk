/**
 * 后台作业调度（架构 5.1「任务调度」）。
 *
 * 所有耗时操作（重建索引、全书检查、导出、备份）都走这里：
 * 立即返回 job 对象，进度通过 WebSocket 推送，可取消。
 * 输入延迟优先 —— 这些活永远不能在保存路径上同步执行。
 */

import type { Job, JobKind, JobStatus } from '../../shared/types.ts';
import { shortId } from '../util/id.ts';

export type JobRunner = (ctx: JobContext) => Promise<unknown>;

export interface JobContext {
  readonly id: string;
  /** 0..1 */
  progress(value: number, message?: string): void;
  /** 报告阶段信息，不改进度 */
  note(message: string): void;
  /** 检查是否已请求取消 */
  readonly cancelled: boolean;
  /** 在耗时循环里调用，已取消则抛出 CancelledError */
  throwIfCancelled(): void;
}

export class CancelledError extends Error {
  constructor() {
    super('作业已取消');
    this.name = 'CancelledError';
  }
}

interface JobRecord {
  job: Job;
  runner: JobRunner;
  cancelled: boolean;
}

export class JobQueue {
  private jobs = new Map<string, JobRecord>();
  private listeners = new Set<(job: Job) => void>();
  /** 待执行队列（FIFO，同时只跑一个重活，避免 IO 抢占导致输入卡顿） */
  private queue: string[] = [];
  private running = false;
  private maxKeep = 60;

  onUpdate(fn: (job: Job) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(job: Job): void {
    for (const fn of this.listeners) {
      try {
        fn(job);
      } catch {
        /* 监听者异常不影响调度 */
      }
    }
  }

  /** 提交作业，立即返回 job（queued） */
  submit(kind: JobKind, runner: JobRunner): Job {
    const id = shortId(16);
    const job: Job = {
      id,
      kind,
      status: 'queued',
      progress: 0,
      message: '排队中',
      created_at: Date.now(),
      finished_at: null,
      error: null,
      result: null,
    };
    this.jobs.set(id, { job, runner, cancelled: false });
    this.queue.push(id);
    this.emit(job);
    void this.drain();
    return job;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift()!;
        const record = this.jobs.get(id);
        if (!record) continue;

        if (record.cancelled) {
          this.finish(record, 'cancelled', null, null);
          continue;
        }

        record.job.status = 'running';
        record.job.message = '执行中';
        this.emit(record.job);

        const ctx: JobContext = {
          id,
          progress: (value, message) => {
            record.job.progress = Math.max(0, Math.min(1, value));
            if (message) record.job.message = message;
            this.emit(record.job);
          },
          note: (message) => {
            record.job.message = message;
            this.emit(record.job);
          },
          get cancelled() {
            return record.cancelled;
          },
          throwIfCancelled: () => {
            if (record.cancelled) throw new CancelledError();
          },
        };

        try {
          const result = await record.runner(ctx);
          this.finish(record, 'done', result, null);
        } catch (err) {
          if (err instanceof CancelledError) {
            this.finish(record, 'cancelled', null, null);
          } else {
            console.error(`[job ${id}] ${record.job.kind} 失败:`, err);
            this.finish(record, 'failed', null, (err as Error).message || '未知错误');
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  private finish(record: JobRecord, status: JobStatus, result: unknown, error: string | null): void {
    record.job.status = status;
    record.job.progress = status === 'done' ? 1 : record.job.progress;
    record.job.result = result;
    record.job.error = error;
    record.job.finished_at = Date.now();
    if (status === 'done') record.job.message = record.job.message || '完成';
    if (status === 'cancelled') record.job.message = '已取消';
    if (status === 'failed') record.job.message = error ?? '失败';
    this.emit(record.job);
    this.prune();
  }

  private prune(): void {
    if (this.jobs.size <= this.maxKeep) return;
    const finished = [...this.jobs.values()]
      .filter((r) => r.job.status !== 'running' && r.job.status !== 'queued')
      .sort((a, b) => a.job.created_at - b.job.created_at);
    const removeCount = this.jobs.size - this.maxKeep;
    for (let i = 0; i < removeCount && i < finished.length; i++) {
      this.jobs.delete(finished[i].job.id);
    }
  }

  get(id: string): Job | null {
    return this.jobs.get(id)?.job ?? null;
  }

  list(): Job[] {
    return [...this.jobs.values()]
      .map((r) => r.job)
      .sort((a, b) => b.created_at - a.created_at);
  }

  /** 取消作业。正在跑的会在下一个检查点停下（数据不会半写） */
  cancel(id: string): boolean {
    const record = this.jobs.get(id);
    if (!record) return false;
    const st = record.job.status;
    if (st === 'done' || st === 'failed' || st === 'cancelled') return false;

    record.cancelled = true;
    if (st === 'queued') {
      record.job.status = 'cancelled';
      record.job.message = '已取消';
      record.job.finished_at = Date.now();
      this.emit(record.job);
    }
    return true;
  }
}
