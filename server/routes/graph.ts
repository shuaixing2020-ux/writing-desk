/**
 * 关系图谱路由（G1-2）。
 *
 * GET    /api/projects/:pid/entities/:id/relations   → { out, in }
 * POST   /api/projects/:pid/entities/:id/relations   → Relation（?dry_run=1 只校验）
 * PATCH  /api/projects/:pid/relations/:rid           → Relation（?dry_run=1 只校验）
 * DELETE /api/projects/:pid/relations/:rid
 * GET    /api/projects/:pid/relation-types           → { types, warnings }
 * GET    /api/projects/:pid/relations/lint           → GraphLintIssue[]
 *
 * 所有写操作只改**起点条目那一个文件**（见 server/graph/service.ts 的范围说明）。
 */

import type { FastifyInstance } from 'fastify';
import type { RelationInput, RelationPatch } from '../../shared/types.ts';
import type { AppContextImpl } from '../app-context.ts';
import { badRequest, projectOf, requireString } from './shared.ts';
import { GraphService, RelationError } from '../graph/service.ts';

/** 统一把 RelationError 映射成 HTTP 状态码 */
function rethrow(err: unknown): never {
  if (err instanceof RelationError) throw err;
  throw err;
}

function parseDryRun(query: Record<string, unknown>): boolean {
  const raw = query.dry_run;
  return raw === '1' || raw === 'true' || raw === true;
}

export function registerGraphRoutes(app: FastifyInstance, appCtx: AppContextImpl): void {
  // ── 关系类型注册表 ──
  app.get('/api/projects/:pid/relation-types', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    return new GraphService(ctx).listTypes();
  });

  // ── 全书关系检查 ──
  app.get('/api/projects/:pid/relations/lint', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    return new GraphService(ctx).lint();
  });

  // ── 某条目的出向 / 入向关系 ──
  app.get('/api/projects/:pid/entities/:id/relations', async (request) => {
    const { pid, id } = request.params as { pid: string; id: string };
    const ctx = await projectOf(appCtx, pid);
    try {
      return await new GraphService(ctx).list(id);
    } catch (err) {
      rethrow(err);
    }
  });

  // ── 新增关系 ──
  app.post('/api/projects/:pid/entities/:id/relations', async (request) => {
    const { pid, id } = request.params as { pid: string; id: string };
    const ctx = await projectOf(appCtx, pid);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const query = (request.query ?? {}) as Record<string, unknown>;

    const type = requireString(body.type, 'type', { max: 60 });
    const to = requireString(body.to, 'to', { max: 120 });

    const input: RelationInput = { type, to };
    if (typedString(body.since)) input.since = typedString(body.since)!;
    if (typedString(body.until)) input.until = typedString(body.until)!;
    if (typedString(body.reveal)) input.reveal = typedString(body.reveal)!;
    if (typeof body.weight === 'number' && Number.isFinite(body.weight)) input.weight = body.weight;
    if (typeof body.note === 'string') input.note = body.note.slice(0, 2000);

    try {
      const rel = await new GraphService(ctx).create(id, input, { dryRun: parseDryRun(query) });
      if (!parseDryRun(query)) {
        appCtx.broadcast({ type: 'tree_changed', project_id: ctx.id });
      }
      return rel;
    } catch (err) {
      rethrow(err);
    }
  });

  // ── 修改关系 ──
  app.patch('/api/projects/:pid/relations/:rid', async (request) => {
    const { pid, rid } = request.params as { pid: string; rid: string };
    const ctx = await projectOf(appCtx, pid);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const query = (request.query ?? {}) as Record<string, unknown>;

    const patch: RelationPatch = {};
    if (body.type !== undefined) patch.type = requireString(body.type, 'type', { max: 60 });
    // 锚点允许显式设成 null 表示"清除"
    if ('since' in body) patch.since = body.since === null ? null : typedString(body.since) ?? null;
    if ('until' in body) patch.until = body.until === null ? null : typedString(body.until) ?? null;
    if ('reveal' in body) patch.reveal = body.reveal === null ? null : typedString(body.reveal) ?? null;
    if ('weight' in body) {
      patch.weight =
        body.weight === null ? null : typeof body.weight === 'number' ? body.weight : null;
    }
    if (typeof body.note === 'string') patch.note = body.note.slice(0, 2000);

    if (Object.keys(patch).length === 0) {
      throw badRequest('没有要修改的字段', 'empty_patch');
    }

    try {
      const rel = await new GraphService(ctx).update(rid, patch, { dryRun: parseDryRun(query) });
      if (!parseDryRun(query)) {
        appCtx.broadcast({ type: 'tree_changed', project_id: ctx.id });
      }
      return rel;
    } catch (err) {
      rethrow(err);
    }
  });

  // ── 删除关系 ──
  app.delete('/api/projects/:pid/relations/:rid', async (request) => {
    const { pid, rid } = request.params as { pid: string; rid: string };
    const ctx = await projectOf(appCtx, pid);
    try {
      await new GraphService(ctx).remove(rid);
      appCtx.broadcast({ type: 'tree_changed', project_id: ctx.id });
      return { ok: true };
    } catch (err) {
      rethrow(err);
    }
  });
}

/** 取可选字符串（空串视为未提供） */
function typedString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t : undefined;
}
