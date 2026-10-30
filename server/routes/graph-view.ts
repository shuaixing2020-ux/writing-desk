/**
 * 整图读取（R3）：面板里的关系图谱用。
 *
 * 只读，不写任何文件。三种取法：
 *   - 不给参数：全部条目与全部关系
 *   - ?focus=<entityId>&depth=<n>：以该条目为中心的 n 层邻域
 *   - ?doc=<docId>：某个场景里出场过的条目，以及它们之间的关系
 *
 * 为什么单独一个路由文件：graph.ts 里都是「改关系」的写操作，
 * 这里纯读，混在一起会让红线（写操作必须走锁与原子写）不好审。
 */

import type { FastifyInstance } from 'fastify';
import type { Relation } from '../../shared/types.ts';
import type { AppContextImpl } from '../app-context.ts';
import { projectOf } from './shared.ts';
import { loadRelationTypes } from '../graph/types.ts';

interface GraphNode {
  id: string;
  type: string;
  name: string;
}

interface GraphEdge {
  id: string;
  type: string;
  from: string;
  to: string;
  note: string;
  /** 对称关系画线不画箭头 */
  symmetric: boolean;
}

export function registerGraphViewRoutes(app: FastifyInstance, appCtx: AppContextImpl): void {
  app.get('/api/projects/:pid/graph', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    const q = (request.query ?? {}) as Record<string, unknown>;
    const focus = typeof q.focus === 'string' && q.focus ? q.focus : null;
    const docId = typeof q.doc === 'string' && q.doc ? q.doc : null;
    const depthRaw = typeof q.depth === 'string' ? Number(q.depth) : 2;
    const depth = Number.isFinite(depthRaw) ? Math.max(1, Math.min(4, Math.round(depthRaw))) : 2;

    const table = await loadRelationTypes(ctx.root);
    const entities = await ctx.store.listEntities();
    const byId = new Map(entities.map((e) => [e.id, e]));

    // 悬空关系不返回：图上画一条指向不存在节点的线没有意义
    const allEdges: GraphEdge[] = ctx.index
      .allRelations()
      .filter((r) => byId.has(r.from_id) && byId.has(r.to_id))
      .map((r) => ({
        id: r.id,
        type: r.type,
        from: r.from_id,
        to: r.to_id,
        note: r.note ?? '',
        symmetric: !(table.byKey.get(r.type)?.directed ?? true),
      }));

    // 先决定要显示哪些节点
    let keep: Set<string> | null = null;

    if (docId) {
      keep = new Set(ctx.index.entityIdsMentionedIn(docId));
    } else if (focus && byId.has(focus)) {
      keep = new Set([focus]);
      let frontier = [focus];
      for (let d = 0; d < depth; d++) {
        const next: string[] = [];
        for (const edge of allEdges) {
          if (frontier.includes(edge.from) && !keep.has(edge.to)) {
            keep.add(edge.to);
            next.push(edge.to);
          } else if (frontier.includes(edge.to) && !keep.has(edge.from)) {
            keep.add(edge.from);
            next.push(edge.from);
          }
        }
        frontier = next;
        if (frontier.length === 0) break;
      }
    }

    const nodes: GraphNode[] = entities
      .filter((e) => (keep ? keep.has(e.id) : true))
      .map((e) => ({ id: e.id, type: e.type, name: e.name }));

    const visible = new Set(nodes.map((n) => n.id));
    const edges = allEdges.filter((e) => visible.has(e.from) && visible.has(e.to));

    return {
      nodes,
      edges: edges.map((e) => ({ ...e }) as GraphEdge & Partial<Relation>),
      total_entities: entities.length,
    };
  });
}
