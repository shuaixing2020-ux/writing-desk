/**
 * 搜索路由。
 *
 * GET /api/projects/:pid/search?q=&kind=&limit=  → SearchResult
 *
 * 中文搜索走逐字索引（IndexDb.search），2 字人名也能命中。
 * kind 未指定时同时搜正文与设定库，正文结果在前 —— 作者找「林远」时
 * 更可能想跳到章节，而不是设定卡。
 *
 * 注意：IndexDb 返回的 hit.path 是文件相对路径（manuscript/v01-.../s0001-x.md），
 * 而 SearchHit.path 的契约是「第一卷 / 第一章」这种人可读路径。
 * 前者直接显示给作者没有意义，所以这里统一用索引里的 parent 链重算。
 */

import type { FastifyInstance } from 'fastify';
import type { SearchHit, SearchResult } from '../../shared/types.ts';
import { ENTITY_TYPE_LABELS } from '../../shared/types.ts';
import type { ProjectContext } from '../context.ts';
import type { AppContextImpl } from '../app-context.ts';
import { projectOf, requireString } from './shared.ts';

const MAX_LIMIT = 200;

export function registerSearchRoutes(app: FastifyInstance, appCtx: AppContextImpl): void {
  app.get('/api/projects/:pid/search', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    const query = request.query as Record<string, unknown>;

    const q = requireString(query.q, 'q', { max: 120 });
    const kindRaw = typeof query.kind === 'string' ? query.kind : '';
    if (kindRaw && kindRaw !== 'scene' && kindRaw !== 'entity') {
      throw new Error('搜索范围不合法（应为 scene 或 entity）');
    }
    const limitRaw = Number(query.limit);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(MAX_LIMIT, Math.round(limitRaw)) : 50;

    const t0 = Date.now();
    const hits: SearchHit[] = [];

    if (!kindRaw || kindRaw === 'scene') {
      for (const hit of ctx.index.search(q, { limit })) {
        hits.push({
          doc_id: hit.doc_id,
          doc_title: hit.title,
          path: readablePath(ctx, hit.doc_id),
          snippet: hit.snippet,
          count: hit.count,
          kind: 'scene',
        });
      }
    }

    if (!kindRaw || kindRaw === 'entity') {
      for (const hit of ctx.index.searchEntities(q, Math.max(10, Math.floor(limit / 2)))) {
        hits.push({
          doc_id: hit.doc_id,
          doc_title: hit.title,
          path: entityPath(ctx, hit.doc_id),
          snippet: hit.snippet,
          count: hit.count,
          kind: 'entity',
        });
      }
    }

    const result: SearchResult = {
      query: q,
      hits: hits.slice(0, limit),
      total: hits.length,
      took_ms: Date.now() - t0,
    };
    return result;
  });
}

/** 「第一卷 / 第一章」——卷/章标题链，不含场景自身（标题已在 doc_title 里） */
function readablePath(ctx: ProjectContext, docId: string): string {
  const parts: string[] = [];
  const guard = new Set<string>();
  let parentId = ctx.index.getDoc(docId)?.parent_id ?? null;
  while (parentId && !guard.has(parentId)) {
    guard.add(parentId);
    const parent = ctx.index.getDoc(parentId);
    if (!parent) break;
    parts.unshift(parent.title);
    parentId = parent.parent_id;
  }
  return parts.join(' / ');
}

/** 「设定库 / 角色」——索引里存的是英文 type，界面必须显示中文标签 */
function entityPath(ctx: ProjectContext, entityId: string): string {
  const type = ctx.index.listEntities().find((e) => e.id === entityId)?.type ?? '';
  return `设定库 / ${ENTITY_TYPE_LABELS[type] ?? (type || '条目')}`;
}
