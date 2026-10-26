/**
 * 灵感箱路由。
 *
 * GET    /api/projects/:pid/inbox       → 按时间倒序
 * POST   /api/projects/:pid/inbox       → 新建
 * DELETE /api/projects/:pid/inbox/:id   → 删除
 *
 * 灵感箱是「想到就记」的地方，写入必须快且不丢：走 store 的原子写，
 * 内容上限 500 条（由 store 保证），这里只做输入校验。
 */

import type { FastifyInstance } from 'fastify';
import type { AppContextImpl } from '../app-context.ts';
import { notFound, projectOf, requireString } from './shared.ts';

export function registerInboxRoutes(app: FastifyInstance, appCtx: AppContextImpl): void {
  app.get('/api/projects/:pid/inbox', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    return ctx.store.listInbox();
  });

  app.post('/api/projects/:pid/inbox', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    const body = (request.body ?? {}) as Record<string, unknown>;

    // 换行保留（灵感可能是一段），只 trim 首尾
    const text = requireString(body.text, 'text', { max: 4000, trim: true });
    return ctx.store.addInbox(text);
  });

  app.delete('/api/projects/:pid/inbox/:id', async (request) => {
    const { pid, id } = request.params as { pid: string; id: string };
    const ctx = await projectOf(appCtx, pid);

    const items = await ctx.store.listInbox();
    if (!items.some((i) => i.id === id)) throw notFound(`灵感条目不存在：${id}`, 'inbox_not_found');

    await ctx.store.deleteInbox(id);
    return { ok: true };
  });
}
