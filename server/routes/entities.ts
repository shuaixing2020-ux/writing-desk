/**
 * 设定库路由。
 *
 * GET    /api/projects/:pid/entities             → Entity[]
 * GET    /api/projects/:pid/entities/:id         → EntityDetail（含反向引用）
 * POST   /api/projects/:pid/entities             → Entity（有 id 则更新，无则新建）
 * DELETE /api/projects/:pid/entities/:id         → 进回收站
 *
 * 反向引用（出场记录）从索引读，索引是可重建的；
 * 因此这里不把 mentions 落到 bible/*.md 里 —— 那是真相，不能被派生数据污染。
 */

import type { FastifyInstance } from 'fastify';
import type { Entity, EntityDetail, EntityType, Mention } from '../../shared/types.ts';
import type { AppContextImpl } from '../app-context.ts';
import { badRequest, notFound, optionalString, optionalStringArray, projectOf, requireString } from './shared.ts';

export function registerEntityRoutes(app: FastifyInstance, appCtx: AppContextImpl): void {
  app.get('/api/projects/:pid/entities', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    return ctx.store.listEntities();
  });

  app.get('/api/projects/:pid/entities/:id', async (request) => {
    const { pid, id } = request.params as { pid: string; id: string };
    const ctx = await projectOf(appCtx, pid);

    const all = await ctx.store.listEntities();
    const entity = all.find((e) => e.id === id);
    if (!entity) throw notFound(`设定条目不存在：${id}`, 'entity_not_found');

    const detail = await buildDetail(ctx, entity);
    return detail;
  });

  app.post('/api/projects/:pid/entities', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    const body = (request.body ?? {}) as Record<string, unknown>;

    const type = requireString(body.type, 'type', { max: 40 }) as EntityType;
    const name = requireString(body.name, 'name', { max: 120 });
    const id = body.id === undefined ? undefined : requireString(body.id, 'id', { max: 120 });
    const aliases = optionalStringArray(body.aliases, 'aliases') ?? [];
    const description = optionalString(body.description, 'description', 200_000) ?? '';
    const fields = normalizeFields(body.fields);

    const entity = await ctx.store.saveEntity({ id, type, name, aliases, fields, description });

    // 索引与出场：条目改名/加别名会改变全书命中，重扫该条目。
    // 必须先 invalidate 模式表缓存 —— MentionService 会把 name+aliases 编译成
    // 一张缓存表，不失效的话新加的别名永远不会被扫到。
    try {
      ctx.mentions.invalidate();
      ctx.index.upsertEntity({
        id: entity.id,
        type: entity.type,
        name: entity.name,
        aliases: entity.aliases,
      });
      await ctx.mentions.scanEntity(entity.id);
    } catch (err) {
      console.error(`[entities] 更新出场索引失败（可重建）:`, err);
    }

    appCtx.broadcast({ type: 'tree_changed', project_id: ctx.id });
    return entity;
  });

  app.delete('/api/projects/:pid/entities/:id', async (request) => {
    const { pid, id } = request.params as { pid: string; id: string };
    const ctx = await projectOf(appCtx, pid);

    const all = await ctx.store.listEntities();
    if (!all.some((e) => e.id === id)) throw notFound(`设定条目不存在：${id}`, 'entity_not_found');

    await ctx.store.deleteEntity(id);
    try {
      // 删条目同样要失效模式表，否则已删条目的别名还会被继续扫出来。
      // 再全量重扫一次：被删条目可能「遮蔽」过其它条目的短别名，
      // 它一走，那些条目的出场数就该涨回来。
      ctx.mentions.invalidate();
      ctx.index.deleteEntity(id);
      await ctx.mentions.scanEntity(id);
    } catch (err) {
      console.error(`[entities] 清理索引失败:`, err);
    }

    appCtx.broadcast({ type: 'tree_changed', project_id: ctx.id });
    return { ok: true };
  });
}

/** 组装详情：出场记录来自索引，再补上文档标题与首末文档 */
async function buildDetail(
  ctx: import('../context.ts').ProjectContext,
  entity: Entity,
): Promise<EntityDetail> {
  const rows = ctx.index.mentionsForEntity(entity.id);
  const mentions: Mention[] = [];
  let total = 0;

  for (const row of rows) {
    const doc = ctx.index.getDoc(row.doc_id);
    if (!doc) continue;
    mentions.push({
      entity_id: entity.id,
      entity_name: entity.name,
      doc_id: row.doc_id,
      doc_title: doc.title,
      count: row.count,
      first_pos: row.first_pos,
      last_pos: row.last_pos,
    });
    total += row.count;
  }

  // 按「在书里的位置」排序，而不是按次数 —— 作者关心的是出场顺序
  const orderOf = (docId: string): number => {
    const doc = ctx.index.getDoc(docId);
    if (!doc) return Number.MAX_SAFE_INTEGER;
    const parent = doc.parent_id ? ctx.index.getDoc(doc.parent_id) : null;
    const grand = parent?.parent_id ? ctx.index.getDoc(parent.parent_id) : null;
    const volOrder = grand?.order_no ?? 0;
    const chapOrder = parent?.order_no ?? 0;
    return volOrder * 1_000_000 + chapOrder * 1_000 + doc.order_no;
  };
  mentions.sort((a, b) => orderOf(a.doc_id) - orderOf(b.doc_id));

  const first = mentions[0];
  const last = mentions[mentions.length - 1];

  return {
    ...entity,
    mentions,
    total_count: total,
    first_doc: first ? { doc_id: first.doc_id, doc_title: first.doc_title } : null,
    last_doc: last ? { doc_id: last.doc_id, doc_title: last.doc_title } : null,
  };
}

/** 自定义字段：值一律转字符串，键过滤掉控制字符 */
function normalizeFields(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object') throw badRequest('字段 fields 必须是键值对象');
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const k = key.replace(/[\u0000-\u001f]/g, '').slice(0, 40).trim();
    if (!k) continue;
    if (value === null || value === undefined) continue;
    out[k] = String(value).slice(0, 4000);
  }
  return out;
}
