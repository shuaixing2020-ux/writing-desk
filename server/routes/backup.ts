/**
 * 备份路由。
 *
 * GET    /api/projects/:pid/backup      → BackupTarget[]
 * POST   /api/projects/:pid/backup      → BackupTarget（按 id upsert，无 id 新建）
 * DELETE /api/projects/:pid/backup/:id  → 删除目标配置
 * POST   /api/projects/:pid/backup/run  → Job
 *
 * 备份目标是「目录」，可能是外接盘或同步盘，写出去就离开项目了。
 * 因此这里只做参数校验与作业编排，真正的打包与轮转由 BackupService 负责。
 */

import path from 'node:path';
import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { BackupResult, BackupTarget, Job } from '../../shared/types.ts';
import type { AppContextImpl } from '../app-context.ts';
import { badRequest, notFound, projectOf, requireNumber, requireString, submitJob } from './shared.ts';

export function registerBackupRoutes(app: FastifyInstance, appCtx: AppContextImpl): void {
  app.get('/api/projects/:pid/backup', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    return ctx.backup.list();
  });

  app.post('/api/projects/:pid/backup', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    const body = (request.body ?? {}) as Record<string, unknown>;

    const dir = requireString(body.dir, 'dir', { max: 1000 });
    const target = validateTargetDir(dir);

    const patch: Partial<BackupTarget> & { dir: string } = { dir: target };
    if (body.id !== undefined && body.id !== null) {
      patch.id = String(body.id).slice(0, 80);
    }
    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
    if (body.keep !== undefined) {
      const keep = Math.round(requireNumber(body.keep, 'keep'));
      if (keep < 1 || keep > 200) throw badRequest('保留份数需在 1–200 之间');
      patch.keep = keep;
    }
    if (body.interval_min !== undefined) {
      const interval = Math.round(requireNumber(body.interval_min, 'interval_min'));
      if (interval < 0 || interval > 60 * 24 * 30) throw badRequest('备份间隔不合法');
      patch.interval_min = interval;
    }

    const saved = await ctx.backup.save(patch);
    return saved;
  });

  app.delete('/api/projects/:pid/backup/:id', async (request) => {
    const { pid, id } = request.params as { pid: string; id: string };
    const ctx = await projectOf(appCtx, pid);

    const targets = await ctx.backup.list();
    if (!targets.some((t: BackupTarget) => t.id === id)) throw notFound(`备份目标不存在：${id}`, 'target_not_found');

    await ctx.backup.remove(id);
    return { ok: true };
  });

  app.post('/api/projects/:pid/backup/run', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    const body = (request.body ?? {}) as Record<string, unknown>;

    const targetId =
      body.target_id === undefined || body.target_id === null || body.target_id === ''
        ? undefined
        : String(body.target_id).slice(0, 80);

    if (targetId) {
      const targets = await ctx.backup.list();
      if (!targets.some((t: BackupTarget) => t.id === targetId)) {
        throw notFound(`备份目标不存在：${targetId}`, 'target_not_found');
      }
    }

    const job: Job = submitJob(appCtx, pid, 'backup', async (jobCtx) => {
      const result: BackupResult | BackupResult[] = await ctx.backup.run(jobCtx, targetId);
      return result;
    });
    return job;
  });
}

/**
 * 备份目录校验：
 *   - 必须是绝对路径（相对路径在服务进程 cwd 下解析，用户根本不知道它去哪了）
 *   - 展开 ~ 为主目录
 *   - 不能是项目根自己或它的子目录（备份写进被备份的目录 = 备份无意义且会递归）
 */
function validateTargetDir(raw: string): string {
  let dir = raw.trim();
  if (!dir) throw badRequest('备份目录不能为空');

  if (dir === '~' || dir.startsWith('~/')) {
    dir = path.join(os.homedir(), dir.slice(1));
  }
  if (!path.isAbsolute(dir)) {
    throw badRequest('备份目录必须是绝对路径（例如 /Users/你/Backups/小说）', 'bad_backup_dir');
  }

  const normalized = path.normalize(dir);
  // 拒绝把数据目录本身或它的子目录当备份目标
  const dataDir = path.resolve(process.env.WD_DATA_DIR || path.join(process.cwd(), 'data', 'projects'));
  const prefix = dataDir.endsWith(path.sep) ? dataDir : dataDir + path.sep;
  if (normalized === dataDir || normalized.startsWith(prefix)) {
    throw badRequest('备份目录不能位于作品数据目录内', 'bad_backup_dir');
  }
  return normalized;
}
