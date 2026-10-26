/**
 * 作业路由。
 *
 * GET  /api/projects/:pid/jobs                  → Job[]（本作品的作业，新→旧）
 * GET  /api/projects/:pid/jobs/:id              → Job
 * POST /api/projects/:pid/jobs/:id/cancel       → 取消
 *
 * 作业按作品归属过滤：JobQueue 是全局的，但前端接口挂在作品下，
 * 不隔离的话 A 作品的导出作业会出现在 B 作品的面板里。
 */

import type { FastifyInstance } from 'fastify';
import type { AppContextImpl } from '../app-context.ts';
import { jobFor, jobsFor, notFound, projectOf } from './shared.ts';

export function registerJobRoutes(app: FastifyInstance, appCtx: AppContextImpl): void {
  app.get('/api/projects/:pid/jobs', async (request) => {
    const { pid } = request.params as { pid: string };
    await projectOf(appCtx, pid);
    return jobsFor(appCtx, pid);
  });

  app.get('/api/projects/:pid/jobs/:id', async (request) => {
    const { pid, id } = request.params as { pid: string; id: string };
    await projectOf(appCtx, pid);

    const job = jobFor(appCtx, pid, id);
    if (!job) throw notFound(`作业不存在：${id}`, 'job_not_found');
    return job;
  });

  app.post('/api/projects/:pid/jobs/:id/cancel', async (request) => {
    const { pid, id } = request.params as { pid: string; id: string };
    await projectOf(appCtx, pid);

    const job = jobFor(appCtx, pid, id);
    if (!job) throw notFound(`作业不存在：${id}`, 'job_not_found');

    // 已经结束的作业 cancel 返回 false：不算错误，前端不必弹错
    const ok = appCtx.jobs.cancel(id);
    return { ok, status: appCtx.jobs.get(id)?.status ?? job.status };
  });
}
