/**
 * 检查引擎路由。
 *
 * GET   /api/projects/:pid/lint/scene/:id      → LintResult（同步，单场景秒回）
 * GET   /api/projects/:pid/lint/rules          → RuleDef[]
 * PATCH /api/projects/:pid/lint/rules/:ruleId  → RuleDef
 * POST  /api/projects/:pid/lint/book           → Job（全书检查走后台）
 *
 * 单场景检查同步返回：作者改一段就想看结果，走作业反而慢。
 * 全书检查必须走作业：300 万字同步跑会把事件循环堵死，输入直接卡。
 */

import type { FastifyInstance } from 'fastify';
import type { Job, RuleDef } from '../../shared/types.ts';
import type { AppContextImpl } from '../app-context.ts';
import { badRequest, notFound, projectOf, submitJob } from './shared.ts';

export function registerLintRoutes(app: FastifyInstance, appCtx: AppContextImpl): void {
  app.get('/api/projects/:pid/lint/scene/:id', async (request) => {
    const { pid, id } = request.params as { pid: string; id: string };
    const ctx = await projectOf(appCtx, pid);

    const scene = await ctx.store.readScene(id);
    if (!scene) throw notFound(`场景不存在：${id}`, 'scene_not_found');

    return ctx.lint.lintScene(id, scene.body);
  });

  app.get('/api/projects/:pid/lint/rules', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    return ctx.lint.listRules();
  });

  app.patch('/api/projects/:pid/lint/rules/:ruleId', async (request) => {
    const { pid, ruleId } = request.params as { pid: string; ruleId: string };
    const ctx = await projectOf(appCtx, pid);
    const body = (request.body ?? {}) as Record<string, unknown>;

    const patch: Partial<RuleDef> = {};

    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
    if (body.severity !== undefined) {
      const sev = String(body.severity);
      if (sev !== 'info' && sev !== 'warn' && sev !== 'error') {
        throw badRequest('严重程度不合法（应为 info / warn / error）', 'bad_severity');
      }
      patch.severity = sev;
    }
    if (body.scope !== undefined) {
      const scope = String(body.scope);
      if (scope !== 'scene' && scope !== 'book') throw badRequest('作用范围不合法', 'bad_scope');
      patch.scope = scope;
    }
    if (body.fixable !== undefined) patch.fixable = Boolean(body.fixable);
    if (body.name !== undefined) patch.name = String(body.name).slice(0, 80);
    if (body.description !== undefined) patch.description = String(body.description).slice(0, 400);
    if (body.message !== undefined) patch.message = String(body.message).slice(0, 400);
    if (body.pattern !== undefined) patch.pattern = String(body.pattern).slice(0, 2000);
    if (body.flags !== undefined) patch.flags = String(body.flags).slice(0, 16);
    if (body.words !== undefined) {
      if (!Array.isArray(body.words)) throw badRequest('字段 words 必须是字符串数组');
      patch.words = body.words.map((w) => String(w).slice(0, 80)).slice(0, 2000);
    }

    if (Object.keys(patch).length === 0) throw badRequest('没有可更新的规则字段');

    // 规则改了就重算已缓存的结果没有意义（规则是即时生效的），直接返回新定义
    return ctx.lint.updateRule(ruleId, patch);
  });

  app.post('/api/projects/:pid/lint/book', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);

    const job: Job = submitJob(appCtx, pid, 'book_lint', async (jobCtx) => {
      const result = await ctx.lint.lintAll(jobCtx);
      appCtx.broadcast({ type: 'tree_changed', project_id: ctx.id });
      return result;
    });
    return job;
  });
}
