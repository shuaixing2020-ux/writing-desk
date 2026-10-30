/**
 * 回收站路由。
 *
 * GET    /api/projects/:pid/trash              → TrashItem[]
 * POST   /api/projects/:pid/trash/:id/restore  → 恢复
 * POST   /api/projects/:pid/trash/restore-batch → 批量恢复（撤销用）
 * DELETE /api/projects/:pid/trash/:id          → 彻底删除（不可恢复，前端必须二次确认）
 *
 * 回收站条目 id 就是 .studio/trash/ 下的目录名，参与路径拼接，必须先挡穿越。
 */

import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { BatchRestoreResponse, DocNode, TrashItem } from '../../shared/types.ts';
import type { AppContextImpl } from '../app-context.ts';
import { badRequest, notFound, projectOf, syncTreeToIndex, withTreeLock } from './shared.ts';

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

  /**
   * 批量恢复（前端「撤销」用）。
   *
   * 顺序：先全部预检存在性 —— 任何一项不存在就 404，一个都不恢复。
   * 这样「撤销」不会出现「恢复了一半」的中间态。
   *
   * 关于同一父目录下的原顺序：顺序由文件名前缀承载（`s0003-标题.md`），
   * 整目录移走再原样移回，相对位置天然保持，与恢复的先后无关（D0 的 Q7 结论）。
   */
  app.post('/api/projects/:pid/trash/restore-batch', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    const body = (request.body ?? {}) as Record<string, unknown>;

    if (!Array.isArray(body.ids)) throw badRequest('ids 必须是数组');
    const ids = (body.ids as unknown[])
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map((x) => x.trim());
    if (ids.length === 0) throw badRequest('ids 不能为空');
    if (ids.length > 200) throw badRequest('一次最多恢复 200 项');
    for (const id of ids) assertTrashId(id);

    const restored = await withTreeLock(ctx, async () => {
      // 预检：全部存在才开始恢复
      const existing = new Set((await ctx.store.listTrash()).map((e) => e.id));
      const missing = ids.filter((id) => !existing.has(id));
      if (missing.length > 0) {
        throw notFound(`回收站条目不存在：${missing.join('、')}`, 'trash_not_found');
      }

      let count = 0;
      const done: string[] = [];
      for (const id of ids) {
        try {
          await ctx.store.restoreFromTrash(id);
          count++;
          done.push(id);
        } catch (err) {
          // 部分失败：明确说出已恢复哪些，剩下去回收站手动处理
          throw new Error(
            `批量恢复失败：已恢复 ${done.length} 项，` +
              `「${id}」失败（${(err as Error).message}）。` +
              (done.length > 0 ? `已恢复：${done.join('、')}` : ''),
          );
        }
      }

      try {
        await syncTreeToIndex(ctx); // 会顺带重建被恢复场景的出场索引
      } catch (err) {
        console.error('[trash] 批量恢复后索引同步失败（可重建）:', err);
      }
      return count;
    });

    // 只广播一次
    appCtx.broadcast({ type: 'tree_changed', project_id: ctx.id });
    const response: BatchRestoreResponse = { ok: true, restored };
    return response;
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
    throw badRequest('回收站条目标识不合法');
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
