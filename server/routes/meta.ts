/**
 * 作品元数据与每日目标路由。
 *
 * GET   /api/projects/:pid/meta   → ProjectMeta
 * PATCH /api/projects/:pid/meta   → ProjectMeta（typeset 也要走这里）
 * GET   /api/projects/:pid/goal   → GoalProgress
 *
 * PATCH 只允许改「设置类」字段：id / created_at / schema_version 这类身份字段
 * 一旦被前端误改就会让作品打不开，所以白名单化。
 */

import type { FastifyInstance } from 'fastify';
import type {
  CountMode,
  ProjectMeta,
  TypesetPreset,
  WorkMode,
} from '../../shared/types.ts';
import type { AppContextImpl } from '../app-context.ts';
import { badRequest, goalProgress, projectOf, requireNumber } from './shared.ts';

const COUNT_MODES: CountMode[] = ['hanzi', 'hanzi_punct', 'platform'];
const WORK_MODES: WorkMode[] = ['webnovel', 'publish', 'script'];

export function registerMetaRoutes(app: FastifyInstance, appCtx: AppContextImpl): void {
  app.get('/api/projects/:pid/meta', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    return ctx.store.readMeta();
  });

  app.patch('/api/projects/:pid/meta', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    const body = (request.body ?? {}) as Record<string, unknown>;

    const patch: Partial<ProjectMeta> = {};

    if (body.title !== undefined) {
      const title = String(body.title).trim();
      if (!title) throw badRequest('作品标题不能为空');
      patch.title = title.slice(0, 120);
    }
    if (body.author !== undefined) patch.author = String(body.author).slice(0, 60);
    if (body.mode !== undefined) {
      if (!WORK_MODES.includes(body.mode as WorkMode)) throw badRequest('作品模式不合法', 'bad_mode');
      patch.mode = body.mode as WorkMode;
    }
    if (body.count_mode !== undefined) {
      if (!COUNT_MODES.includes(body.count_mode as CountMode)) {
        throw badRequest('字数口径不合法', 'bad_count_mode');
      }
      patch.count_mode = body.count_mode as CountMode;
    }
    if (body.daily_goal !== undefined) {
      const goal = requireNumber(body.daily_goal, 'daily_goal');
      if (goal < 0 || goal > 100_000) throw badRequest('每日目标需在 0–100000 之间');
      patch.daily_goal = Math.round(goal);
    }
    if (body.typeset !== undefined) {
      patch.typeset = validateTypeset(body.typeset);
    }
    if (body.lan !== undefined) {
      const lan = body.lan as { enabled?: unknown } | null;
      // 局域网开关实际由 main.ts 的监听地址决定，这里只记录用户意图
      patch.lan = { enabled: Boolean(lan?.enabled) };
    }
    if (body.auto_punct !== undefined) patch.auto_punct = Boolean(body.auto_punct);

    const meta = await ctx.store.updateMeta(patch);

    // 字数口径变了 → 全书字数口径也变了，索引里的 words 全部作废，后台重建
    if (patch.count_mode !== undefined) {
      appCtx.jobs.submit('rebuild_index', async (job) => {
        job.progress(0.05, '字数口径变更，重建索引');
        const stats = await ctx.indexer.rebuildAll(job);
        appCtx.broadcast({ type: 'index_rebuilt' });
        appCtx.broadcast({ type: 'tree_changed', project_id: ctx.id });
        return stats;
      });
    }

    return meta;
  });

  app.get('/api/projects/:pid/goal', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    return goalProgress(ctx);
  });
}

function validateTypeset(raw: unknown): TypesetPreset {
  if (!raw || typeof raw !== 'object') throw badRequest('排版预设格式不合法');
  const input = raw as Record<string, unknown>;
  const indent = input.indent === undefined ? 2 : requireNumber(input.indent, 'typeset.indent');
  if (indent < 0 || indent > 8) throw badRequest('段首缩进需在 0–8 之间');
  const chapterTitle =
    input.chapter_title === undefined ? '第{n}章 {title}' : String(input.chapter_title).slice(0, 80);
  return {
    indent: Math.round(indent),
    paragraph_gap: input.paragraph_gap === undefined ? true : Boolean(input.paragraph_gap),
    chapter_title: chapterTitle || '第{n}章 {title}',
  };
}
