/**
 * 版本快照路由。
 *
 * GET  /api/projects/:pid/snapshots                    → SnapshotMeta[]（可按 doc_id 过滤）
 * GET  /api/projects/:pid/snapshots/:id                → SnapshotContent
 * POST /api/projects/:pid/snapshots                    → SnapshotMeta（手动创建）
 * POST /api/projects/:pid/snapshots/:id/restore        → { ok: true, rev }
 * GET  /api/projects/:pid/snapshots/:id/diff           → { snapshot, current, diff }
 * POST /api/projects/:pid/snapshots/prune              → { removed, kept }（前端暂无入口，供维护用）
 *
 * 恢复是危险操作：服务层内部会先给当前版本再拍一份 restore 快照，
 * 所以「恢复错了」还能再恢复回来。
 */

import type { FastifyInstance } from 'fastify';
import type {
  DiffResult,
  SceneContent,
  SnapshotContent,
  SnapshotMeta,
  SnapshotReason,
} from '../../shared/types.ts';
import type { AppContextImpl } from '../app-context.ts';
import { notFound, projectOf, requireString } from './shared.ts';

const REASONS: SnapshotReason[] = ['auto', 'manual', 'import', 'delete', 'restore', 'conflict', 'close'];

export function registerSnapshotRoutes(app: FastifyInstance, appCtx: AppContextImpl): void {
  app.get('/api/projects/:pid/snapshots', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    const query = request.query as Record<string, unknown>;
    const docId = typeof query.doc_id === 'string' && query.doc_id ? query.doc_id : undefined;
    return ctx.snapshots.list(docId);
  });

  app.get('/api/projects/:pid/snapshots/:id', async (request) => {
    const { pid, id } = request.params as { pid: string; id: string };
    const ctx = await projectOf(appCtx, pid);
    const snap: SnapshotContent | null = await ctx.snapshots.get(id);
    if (!snap) throw notFound(`快照不存在：${id}`, 'snapshot_not_found');
    return snap;
  });

  app.post('/api/projects/:pid/snapshots', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    const body = (request.body ?? {}) as Record<string, unknown>;

    const docId = requireString(body.doc_id, 'doc_id', { max: 200 });
    const reasonRaw = typeof body.reason === 'string' ? body.reason : 'manual';
    const reason = (REASONS.includes(reasonRaw as SnapshotReason) ? reasonRaw : 'manual') as SnapshotReason;

    const scene = await ctx.store.readScene(docId);
    if (!scene) throw notFound(`场景不存在：${docId}`, 'scene_not_found');
    const found = await ctx.store.resolveDocFile(docId);
    if (!found?.node) throw notFound(`场景不存在：${docId}`, 'scene_not_found');

    const meta: SnapshotMeta = await ctx.snapshots.create(
      docId,
      found.node.title,
      scene.body,
      reason,
      // 手动快照永久保留，不参与 prune 的稀疏化
      reason === 'manual',
    );
    return meta;
  });

  app.post('/api/projects/:pid/snapshots/:id/restore', async (request) => {
    const { pid, id } = request.params as { pid: string; id: string };
    const ctx = await projectOf(appCtx, pid);

    const snap = await ctx.snapshots.get(id);
    if (!snap) throw notFound(`快照不存在：${id}`, 'snapshot_not_found');

    const result = await ctx.snapshots.restore(id);

    // 恢复后重新索引该文档，并通知前端刷新正文
    try {
      const found = await ctx.store.resolveDocFile(snap.meta.doc_id);
      if (found?.node) await ctx.indexer.indexDoc(found.node);
    } catch (err) {
      console.error(`[snapshots] 恢复后索引更新失败（可重建）:`, err);
    }

    appCtx.broadcast({ type: 'doc_changed', doc_id: snap.meta.doc_id, rev: result.rev });
    appCtx.broadcast({ type: 'tree_changed', project_id: ctx.id });
    return { ok: true as const, rev: result.rev };
  });

  app.get('/api/projects/:pid/snapshots/:id/diff', async (request) => {
    const { pid, id } = request.params as { pid: string; id: string };
    const ctx = await projectOf(appCtx, pid);

    const snap = await ctx.snapshots.get(id);
    if (!snap) throw notFound(`快照不存在：${id}`, 'snapshot_not_found');

    const current: SceneContent | null = await ctx.store.readScene(snap.meta.doc_id);
    if (!current) {
      throw notFound(`快照对应的场景已不存在：${snap.meta.doc_id}`, 'scene_not_found');
    }

    const diff: DiffResult = await ctx.snapshots.diff(id);
    return { snapshot: snap.meta, current, diff };
  });

  app.post('/api/projects/:pid/snapshots/prune', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    return ctx.snapshots.prune();
  });
}
