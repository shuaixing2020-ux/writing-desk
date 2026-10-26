/**
 * 作品管理路由。
 *
 * GET  /api/projects   → ProjectSummary[]  扫描磁盘（不打开作品）
 * POST /api/projects   → ProjectSummary    新建作品目录 + project.json
 *
 * 列表必须「不打开作品」也能用：作品选择器在启动时就要显示全部作品，
 * 打开每个作品会为每个作品建 SQLite 连接，代价太高。
 */

import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ProjectMeta, ProjectSummary } from '../../shared/types.ts';
import type { AppContextImpl } from '../app-context.ts';
import { listProjectSummaries, uniqueProjectDir } from '../app-context.ts';
import { ProjectStore } from '../store/project.ts';
import { ensureDir } from '../util/atomic.ts';
import { badRequest, requireString } from './shared.ts';

export function registerProjectRoutes(app: FastifyInstance, appCtx: AppContextImpl): void {
  app.get('/api/projects', async () => {
    return listProjectSummaries(appCtx.dataDir, appCtx);
  });

  app.post('/api/projects', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const title = requireString(body.title, 'title', { max: 120 });
    const author = typeof body.author === 'string' ? body.author.trim().slice(0, 60) : '';
    const mode = body.mode;

    if (mode !== undefined && mode !== 'webnovel' && mode !== 'publish' && mode !== 'script') {
      throw badRequest('作品模式不合法', 'bad_mode');
    }

    await ensureDir(appCtx.dataDir);
    const id = await uniqueProjectDir(appCtx.dataDir, title);
    const root = path.join(appCtx.dataDir, id);

    const store = await ProjectStore.create(root, { title, author, mode });
    // 打开一次，让索引与出场索引立即就绪；失败不阻塞创建（文件已经写好了）
    try {
      await appCtx.openProject(id);
    } catch (err) {
      console.error(`[projects] 新建作品后预热索引失败（不影响稿件）:`, err);
    }

    const totals = await store.totals();
    const meta: ProjectMeta = await store.readMeta();
    const summary: ProjectSummary = {
      id,
      title: meta.title,
      author: meta.author,
      mode: meta.mode,
      count_mode: meta.count_mode,
      daily_goal: meta.daily_goal,
      updated_at: meta.updated_at,
      word_count: totals.word_count,
      scene_count: totals.scene_count,
      path: root,
    };
    return summary;
  });
}
