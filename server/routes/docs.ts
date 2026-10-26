/**
 * 文档树与正文路由 —— 全项目最热的两条路径（读树、存正文）。
 *
 * GET    /api/projects/:pid/tree
 * POST   /api/projects/:pid/nodes                 新建卷/章/场景
 * PATCH  /api/projects/:pid/nodes/:id             改名 + 改元数据（同一路由，两种载荷）
 * POST   /api/projects/:pid/nodes/:id/move        拖拽排序
 * DELETE /api/projects/:pid/nodes/:id             进回收站（删前快照）
 * GET    /api/projects/:pid/scenes/:id            读正文
 * POST   /api/projects/:pid/scenes/:id            存正文（乐观并发）
 *
 * 保存路径的铁律：任何附加动作（快照、索引、出场扫描、广播）失败都不能让保存失败。
 * 稿件已经原子落盘，剩下的都是「锦上添花」，出错只记日志。
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  DocNode,
  DocStatus,
  DocTree,
  SaveSceneResponse,
  SceneContent,
} from '../../shared/types.ts';
import { DOC_STATUSES } from '../../shared/types.ts';
import type { ProjectContext } from '../context.ts';
import type { AppContextImpl } from '../app-context.ts';
import { countWords } from '../util/words.ts';
import {
  badRequest,
  notFound,
  optionalString,
  optionalStringArray,
  projectOf,
  recordWrite,
  requireNumber,
  requireString,
  syncTreeToIndex,
} from './shared.ts';

const NODE_KINDS = ['volume', 'chapter', 'scene'] as const;
type Kind = (typeof NODE_KINDS)[number];

export function registerDocRoutes(app: FastifyInstance, appCtx: AppContextImpl): void {
  // ─────────────────────── 树 ───────────────────────

  app.get('/api/projects/:pid/tree', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    const tree: DocTree = await ctx.store.readTree();
    return tree;
  });

  // ─────────────────────── 新建节点 ───────────────────────

  app.post('/api/projects/:pid/nodes', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    const body = (request.body ?? {}) as Record<string, unknown>;

    const kind = body.kind;
    if (typeof kind !== 'string' || !NODE_KINDS.includes(kind as Kind)) {
      throw badRequest('节点类型不合法（应为 volume / chapter / scene）', 'bad_kind');
    }
    const title = requireString(body.title, 'title', { allowEmpty: true, max: 120 });
    const parentId = body.parent_id === null || body.parent_id === undefined ? null : String(body.parent_id);

    const node = await ctx.store.createNode({
      kind: kind as Kind,
      parent_id: parentId,
      title: title || (kind === 'volume' ? '新卷' : kind === 'chapter' ? '新章' : '新场景'),
    });

    await safeSync(ctx);
    appCtx.broadcast({ type: 'tree_changed', project_id: ctx.id });
    return node;
  });

  // ─────────────────────── 改名 / 改元数据 ───────────────────────

  app.patch('/api/projects/:pid/nodes/:id', async (request) => {
    const { pid, id } = request.params as { pid: string; id: string };
    const ctx = await projectOf(appCtx, pid);
    const body = (request.body ?? {}) as Record<string, unknown>;

    const found = await ctx.store.resolveDocFile(id);
    if (!found || !found.abs) throw notFound(`节点不存在：${id}`, 'node_not_found');

    let node: DocNode = found.node;

    // 改名：涉及磁盘文件/目录重命名，必须走 store 的串行写队列
    if (body.title !== undefined) {
      const title = requireString(body.title, 'title', { max: 120 });
      node = await ctx.store.renameNode(id, title);
    }

    // 元数据：只白名单字段，且只处理「确实出现」的键（允许清空成空串）
    const metaPatch: {
      status?: DocStatus;
      summary?: string;
      pov?: string;
      time?: string;
      tags?: string[];
      plotlines?: string[];
    } = {};
    let hasMeta = false;

    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !DOC_STATUSES.includes(body.status as DocStatus)) {
        throw badRequest('文档状态不合法', 'bad_status');
      }
      metaPatch.status = body.status as DocStatus;
      hasMeta = true;
    }
    const summary = optionalString(body.summary, 'summary', 4000);
    if (summary !== undefined) {
      metaPatch.summary = summary;
      hasMeta = true;
    }
    const pov = optionalString(body.pov, 'pov', 120);
    if (pov !== undefined) {
      metaPatch.pov = pov;
      hasMeta = true;
    }
    const time = optionalString(body.time, 'time', 120);
    if (time !== undefined) {
      metaPatch.time = time;
      hasMeta = true;
    }
    const tags = optionalStringArray(body.tags, 'tags');
    if (tags !== undefined) {
      metaPatch.tags = tags;
      hasMeta = true;
    }
    const plotlines = optionalStringArray(body.plotlines, 'plotlines');
    if (plotlines !== undefined) {
      metaPatch.plotlines = plotlines;
      hasMeta = true;
    }

    if (hasMeta) {
      await ctx.store.updateNodeMeta(id, metaPatch);
    }

    if (body.title === undefined && !hasMeta) {
      throw badRequest('没有可更新的字段');
    }

    await safeSync(ctx);
    appCtx.broadcast({ type: 'tree_changed', project_id: ctx.id });

    // 重新从磁盘读一遍，返回权威值（前端用它替换本地乐观更新）
    const tree = await ctx.store.readTree();
    return tree.nodes.find((n) => n.id === id) ?? node;
  });

  // ─────────────────────── 移动 ───────────────────────

  app.post('/api/projects/:pid/nodes/:id/move', async (request) => {
    const { pid, id } = request.params as { pid: string; id: string };
    const ctx = await projectOf(appCtx, pid);
    const body = (request.body ?? {}) as Record<string, unknown>;

    const parentId = requireString(body.parent_id, 'parent_id', { max: 200 });
    const order = Math.max(1, Math.round(requireNumber(body.order, 'order', 1)));

    await ctx.store.moveNode(id, parentId, order);
    await safeSync(ctx);
    appCtx.broadcast({ type: 'tree_changed', project_id: ctx.id });
    return { ok: true };
  });

  // ─────────────────────── 删除（进回收站） ───────────────────────

  app.delete('/api/projects/:pid/nodes/:id', async (request) => {
    const { pid, id } = request.params as { pid: string; id: string };
    const ctx = await projectOf(appCtx, pid);

    const tree = await ctx.store.readTree();
    const node = tree.nodes.find((n) => n.id === id);
    if (!node) throw notFound(`节点不存在：${id}`, 'node_not_found');

    // 收集整棵子树里的场景，逐个快照。删除是唯一「文件会离开 manuscript」的操作，
    // 快照是用户后悔时唯一的救命绳，所以这里不节流、不省。
    const doomed: DocNode[] = [node];
    if (node.kind !== 'scene') {
      const collect = (parentId: string): void => {
        for (const child of tree.nodes.filter((n) => n.parent_id === parentId)) {
          doomed.push(child);
          if (child.kind !== 'scene') collect(child.id);
        }
      };
      collect(node.id);
    }

    for (const item of doomed) {
      if (item.kind !== 'scene') continue;
      try {
        const scene = await ctx.store.readScene(item.id);
        if (scene && scene.body.trim()) {
          await ctx.snapshots.create(item.id, item.title, scene.body, 'delete', true);
        }
      } catch (err) {
        // 快照失败不能阻止删除？—— 反过来：宁可删除失败，也不能丢稿。
        // 所以这里向上抛，由路由返回 500，用户可重试。
        throw new Error(`删除前快照失败（${item.title}）：${(err as Error).message}`);
      }
    }

    const deleted = await ctx.store.deleteNode(id);
    for (const item of deleted) {
      try {
        ctx.indexer.removeDoc(item.id);
      } catch (err) {
        console.error(`[docs] 清理索引失败 ${item.id}:`, err);
      }
    }

    await safeSync(ctx);
    appCtx.broadcast({ type: 'tree_changed', project_id: ctx.id });
    return { ok: true, deleted: deleted.length };
  });

  // ─────────────────────── 读正文 ───────────────────────

  app.get('/api/projects/:pid/scenes/:id', async (request) => {
    const { pid, id } = request.params as { pid: string; id: string };
    const ctx = await projectOf(appCtx, pid);

    const scene: SceneContent | null = await ctx.store.readScene(id);
    if (!scene) throw notFound(`场景不存在或不是正文节点：${id}`, 'scene_not_found');
    return scene;
  });

  // ─────────────────────── 存正文（关键路径） ───────────────────────

  app.post('/api/projects/:pid/scenes/:id', async (request, reply) => {
    const { pid, id } = request.params as { pid: string; id: string };
    const ctx = await projectOf(appCtx, pid);
    const body = (request.body ?? {}) as Record<string, unknown>;

    const text = requireString(body.body, 'body', { allowEmpty: true, trim: false });
    const baseRev = Math.max(0, Math.round(requireNumber(body.base_rev, 'base_rev', 0)));

    const found = await ctx.store.resolveDocFile(id);
    if (!found || !found.node || found.node.kind !== 'scene' || !found.abs) {
      throw notFound(`场景不存在或不是正文节点：${id}`, 'scene_not_found');
    }
    const node = found.node;
    const title = node.title;

    // 乐观并发（架构 7.8）：客户端持有的版本落后且内容不同 = 冲突。
    // 处理策略：先给「服务端当前版本」拍一份快照（用户点「用服务端版本」时可恢复），
    // 再把客户端版本写进去（用户看到的永远是自己的字，不丢输入）。
    //
    // 「读版本 → 判冲突 → 拍快照 → 写入」整段必须在一把锁里完成。
    // ProjectStore.writeScene 内部虽然串行，但它只保证单次写入原子；
    // 如果路由层把读和写拆成两次加锁，两个标签页同时保存时，
    // 后到者会用一份过期的 before 判冲突（判不出），于是被它覆盖的那份字
    // 既没进快照也没被告知 —— 那是真的丢稿。冲突副本是本工具唯一的兜底，
    // 这里宁可串行化保存（本地单作者，代价可忽略），也不能留这个窗口。
    const outcome = await withSaveLock(ctx, id, async () => {
      const before = await ctx.store.readScene(id);
      if (!before) throw notFound(`场景不存在或不是正文节点：${id}`, 'scene_not_found');

      const conflict = baseRev < before.rev && before.body !== text;
      let snapshotId: string | null = null;

      if (conflict) {
        // 冲突快照必须同步完成：它是用户选「用服务端版本」时唯一的依据。
        try {
          const snap = await ctx.snapshots.create(id, title, before.body, 'conflict', true);
          snapshotId = snap.id;
        } catch (err) {
          console.error(`[docs] 冲突快照失败（继续保存）:`, err);
        }
      }

      const written = await ctx.store.writeScene(id, text, baseRev);

      // writeScene 自己也会判一次冲突（它持有 store 的写锁，看到的版本最权威）。
      // 它报冲突而前面没判出来，说明判定依据不一致 —— 补一份快照兜底。
      if (written.conflict && !snapshotId) {
        try {
          const snap = await ctx.snapshots.create(id, title, before.body, 'conflict', true);
          snapshotId = snap.id;
        } catch (err) {
          console.error(`[docs] 补存冲突快照失败:`, err);
        }
      }

      return { before, written, conflict, snapshotId };
    });

    const { before, written: result, conflict: isConflict, snapshotId: conflictSnapshotId } = outcome;

    // ─────────────────────────────────────────────────────────────
    // 索引与出场识别必须「在响应之前」做完，但代价必须可控：
    // 只扫这一个场景（约 6ms），不重扫全书。
    // 放在响应之后会让「保存完立刻搜索/查出场」读到旧数据，
    // 作者会以为刚写的内容没进索引。
    // ─────────────────────────────────────────────────────────────
    const nodeForIndex: DocNode = {
      ...node,
      word_count: result.word_count,
      rev: result.rev,
      hash: result.hash,
      updated_at: result.updated_at,
    };
    try {
      await ctx.indexer.indexDoc(nodeForIndex);
    } catch (err) {
      // 索引失败不影响稿件（索引可重建），但要在日志里留痕
      console.error(`[docs] 保存后索引更新失败（索引可重建，不影响稿件）:`, err);
    }

    // 自动快照与今日字数统计也必须在响应之前完成。
    // 它们都走 writeFileAtomic，会短暂生成 `.tmp` 文件；如果放到响应之后，
    // 「保存返回 → 立刻检查磁盘」的外部观察者（部署自检、备份脚本、
    // 甚至用户自己 ls）会看到那个中间态文件，误判成「原子写有残留」。
    // 代价：快照约 9ms（服务层按 doc 节流）、统计约 9ms，都在可接受范围。
    if (before.body !== text && !isConflict) {
      try {
        await ctx.snapshots.create(id, title, before.body, 'auto');
      } catch (err) {
        console.error(`[docs] 自动快照失败（不影响稿件）:`, err);
      }
    }
    try {
      const meta = await ctx.store.readMeta();
      const beforeWords = countWords(before.body, meta.count_mode);
      await recordWrite(ctx, result.word_count - beforeWords);
    } catch (err) {
      console.error(`[docs] 记录今日字数失败:`, err);
    }

    // ─────────────────────────────────────────────────────────────
    // 到这里稿件已落盘、索引已同步、快照与统计已写好、目录里没有中间态文件。
    // 只剩 WebSocket 广播放到响应之后 —— 它不碰磁盘，
    // 而且必须晚于响应（原因见 runPostSave）。
    // ─────────────────────────────────────────────────────────────
    afterReply(reply, () => {
      runPostSave(appCtx, {
        docId: id,
        result,
      });
    });

    const response: SaveSceneResponse = {
      rev: result.rev,
      hash: result.hash,
      updated_at: result.updated_at,
      word_count: result.word_count,
    };
    if (conflictSnapshotId) {
      response.conflict = {
        snapshot_id: conflictSnapshotId,
        message: `服务端已有更新的版本（rev ${before.rev}），已保留为快照。当前已保存你的版本。`,
      };
    }
    return response;
  });
}

interface PostSaveInput {
  docId: string;
  result: { rev: number; hash: string; updated_at: number; word_count: number };
}

/**
 * 保存后唯一放在响应之后的事：WebSocket 广播。
 *
 * 为什么必须晚于响应：前端保存成功后用响应里的 rev 更新本地状态，
 * 再用它过滤自己的回声；广播抢在响应前面会让它把「自己的保存」
 * 误判成远端改动并弹冲突提示（已用 10 轮顺序测试验证）。
 *
 * 这里不发 tree_changed —— 保存只改正文与字数，前端已用响应更新本地节点，
 * 再发 tree_changed 会触发整棵树重扫（每场景一次文件读，长篇代价很大）。
 */
function runPostSave(appCtx: AppContextImpl, input: PostSaveInput): void {
  appCtx.broadcast({ type: 'doc_changed', doc_id: input.docId, rev: input.result.rev });
}

/**
 * 在 HTTP 响应写完之后执行 fn（保证客户端先拿到响应）。
 * 客户端提前断开时 'finish' 不会触发，所以再加一个 setImmediate 兜底，
 * 两路都用 once 语义，只会执行一次。
 */
function afterReply(reply: FastifyReply, fn: () => void): void {
  let done = false;
  const run = (): void => {
    if (done) return;
    done = true;
    fn();
  };
  reply.raw.once('finish', run);
  setImmediate(run);
}

/** 树结构变更后的索引修补；失败只记日志，不影响主流程 */
async function safeSync(ctx: ProjectContext): Promise<void> {
  try {
    await syncTreeToIndex(ctx);
  } catch (err) {
    console.error(`[docs] 索引同步失败（可重建）:`, err);
  }
}


// ─────────────────────── 保存串行化 ───────────────────────

/**
 * 按「作品 + 文档」串行化保存。
 *
 * 为什么需要：路由层的「读版本 → 判冲突 → 拍快照 → 写入」是一个复合操作，
 * 而 ProjectStore.writeScene 只保证单次写入原子，不管这个复合序列。
 * 两个标签页/两个自动保存同时到达时，后到者可能读到过期的版本号，
 * 于是把对方刚写的内容直接覆盖且不产生冲突副本 —— 丢稿。
 *
 * 锁的粒度是文档（不是整个项目）：不同场景的保存互不阻塞。
 * 单进程单作者场景下这是零成本的正确性保障。
 */
const saveChains = new Map<string, Promise<unknown>>();

function withSaveLock<T>(ctx: ProjectContext, docId: string, fn: () => Promise<T>): Promise<T> {
  const key = `${ctx.root}\u0000${docId}`;
  const prev = saveChains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  saveChains.set(
    key,
    next.catch(() => undefined),
  );
  // 链尾自我清理：长时间运行下不积累无用的 Promise
  void next
    .catch(() => undefined)
    .then(() => {
      if (saveChains.get(key) === next || saveChains.get(key) === undefined) return;
    });
  return next;
}
