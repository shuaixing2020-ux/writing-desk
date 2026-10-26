/**
 * 回收站路由。
 *
 * GET    /api/projects/:pid/trash              → TrashItem[]
 * POST   /api/projects/:pid/trash/:id/restore  → 恢复
 * DELETE /api/projects/:pid/trash/:id          → 彻底删除（不可恢复，前端必须二次确认）
 *
 * 回收站条目 id 就是 .studio/trash/ 下的目录名，参与路径拼接，必须先挡穿越。
 */

import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DocNode, TrashItem } from '../../shared/types.ts';
import type { AppContextImpl } from '../app-context.ts';
import { projectOf, syncTreeToIndex } from './shared.ts';

/** 回收站保留期：30 天。到期不自动删（自动删稿是不可接受的），只在前端标红提示 */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function registerTrashRoutes(app: FastifyInstance, appCtx: AppContextImpl): void {
  app.get('/api/projects/:pid/trash', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);

    const raw = await ctx.store.listTrash();
    const items: TrashItem[] = raw.map((entry) => {
      const nodes: DocNode[] = entry.nodes ?? [];
      const root = nodes[0];
      const isContainer = nodes.length > 1 || (root ? root.kind !== 'scene' : false);
      return {
        id: entry.id,
        doc_id: root?.id ?? entry.id,
        title: root?.title ?? entry.name,
        kind: root?.kind ?? 'scene',
        path: trashPathText(ctx, root),
        deleted_at: entry.deleted_at,
        expires_at: entry.deleted_at + RETENTION_MS,
        is_container: isContainer,
        child_count: Math.max(0, nodes.length - 1),
      };
    });
    return items;
  });

  app.post('/api/projects/:pid/trash/:id/restore', async (request) => {
    const { pid, id } = request.params as { pid: string; id: string };
    const ctx = await projectOf(appCtx, pid);
    assertTrashId(id);

    await ctx.store.restoreFromTrash(id);

    try {
      await syncTreeToIndex(ctx);
    } catch (err) {
      console.error(`[trash] 恢复后索引同步失败（可重建）:`, err);
    }

    appCtx.broadcast({ type: 'tree_changed', project_id: ctx.id });
    return { ok: true };
  });

  app.delete('/api/projects/:pid/trash/:id', async (request) => {
    const { pid, id } = request.params as { pid: string; id: string };
    const ctx = await projectOf(appCtx, pid);
    assertTrashId(id);

    await ctx.store.purgeTrash(id);
    return { ok: true };
  });
}

/** 回收站目录名形如 1729999999999-01JXXXX；只允许字母数字连字符 */
function assertTrashId(id: string): void {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(id) || id === '.' || id === '..') {
    throw new Error('回收站条目标识不合法');
  }
}

/** 原始父节点路径描述：从被删节点的 parent 链在索引里还原 */
function trashPathText(
  ctx: import('../context.ts').ProjectContext,
  root: DocNode | undefined,
): string {
  if (!root) return '回收站';
  const parts: string[] = [];
  let parentId = root.parent_id;
  const guard = new Set<string>();
  while (parentId && !guard.has(parentId)) {
    guard.add(parentId);
    const parent = ctx.index.getDoc(parentId);
    if (!parent) break;
    parts.unshift(parent.title);
    parentId = parent.parent_id;
  }
  parts.push(root.title);
  return parts.join(' / ');
}

/** 供 e2e/维护脚本使用：回收站真实目录 */
export function trashDirOf(root: string): string {
  return path.join(root, '.studio', 'trash');
}
