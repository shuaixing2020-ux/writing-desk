/**
 * 批量删除与批量恢复（C1）。
 *
 * 这些测试的重点不是「接口能返回 200」，而是**失败时的状态**：
 * 快照失败、移动中途失败、并发保存 —— 每一种都可能留下
 * 「用户以为删了、实际只删了一半」的状态，那是这个工具最不能犯的错。
 *
 * 走 app.inject()，不启端口：跑的是真实路由 + 真实 store + 真实磁盘。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { buildServer } from '../../server/main.ts';
import type { AppContextImpl } from '../../server/app-context.ts';
import type { FastifyInstance } from 'fastify';
import type { BatchDeleteResponse, BatchRestoreResponse } from '../../shared/types.ts';
import {
  collectSubtree,
  orderForDeletion,
  pickOutermostIds,
} from '../../server/util/node-select.ts';

interface Harness {
  dir: string;
  app: FastifyInstance;
  appCtx: AppContextImpl;
  pid: string;
  url: (p: string) => string;
  close: () => Promise<void>;
}

async function setup(): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-batch-'));
  const { app, appCtx } = await buildServer(dir);

  const created = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { title: '批量删除测试' },
  });
  assert.equal(created.statusCode, 200, created.body);
  const project = created.json() as { id: string };

  return {
    dir,
    app,
    appCtx,
    pid: project.id,
    url: (p) => `/api/projects/${encodeURIComponent(project.id)}${p}`,
    close: async () => {
      await app.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

async function post<T>(h: Harness, url: string, payload: Record<string, unknown>): Promise<{ status: number; body: T }> {
  const res = await h.app.inject({ method: 'POST', url: h.url(url), payload });
  return { status: res.statusCode, body: res.json() as T };
}

async function getTree(h: Harness): Promise<{ nodes: Array<Record<string, unknown>> }> {
  const res = await h.app.inject({ method: 'GET', url: h.url('/tree') });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { nodes: Array<Record<string, unknown>> };
}

async function listTrash(h: Harness): Promise<Array<{ id: string; title: string }>> {
  const res = await h.app.inject({ method: 'GET', url: h.url('/trash') });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as Array<{ id: string; title: string }>;
}

async function createNode(
  h: Harness,
  kind: 'volume' | 'chapter' | 'scene',
  parentId: string | null,
  title: string,
): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: h.url('/nodes'),
    payload: { kind, parent_id: parentId, title },
  });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { id: string }).id;
}

async function writeScene(h: Harness, sceneId: string, body: string): Promise<void> {
  const res = await h.app.inject({
    method: 'POST',
    url: h.url(`/scenes/${encodeURIComponent(sceneId)}`),
    payload: { body },
  });
  assert.equal(res.statusCode, 200, res.body);
}

/** 树的可比较快照：只取与「结构/顺序/标题」相关的字段 */
function treeShape(tree: { nodes: Array<Record<string, unknown>> }) {
  return tree.nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    title: n.title,
    parent_id: n.parent_id,
    order: n.order,
  }));
}

async function fileSha1(abs: string): Promise<string> {
  const buf = await fs.readFile(abs);
  return createHash('sha1').update(buf).digest('hex');
}

/** 在项目目录里找某个场景文件（按 id 前缀匹配 frontmatter） */
async function findSceneFile(h: Harness, sceneId: string): Promise<string> {
  const root = path.join(h.dir, h.pid, 'manuscript');
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop() as string;
    for (const entry of await fs.readdir(cur, { withFileTypes: true })) {
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      const raw = await fs.readFile(abs, 'utf8');
      if (raw.includes(`id: ${sceneId}`)) return abs;
    }
  }
  throw new Error(`找不到场景文件：${sceneId}`);
}

describe('纯函数：选择与排序', () => {
  const nodes = [
    { id: 'v1', kind: 'volume', parent_id: null, order: 1, title: '卷', file: 'v1' },
    { id: 'c1', kind: 'chapter', parent_id: 'v1', order: 1, title: '章一', file: 'c1' },
    { id: 'c2', kind: 'chapter', parent_id: 'v1', order: 2, title: '章二', file: 'c2' },
    { id: 's1', kind: 'scene', parent_id: 'c1', order: 1, title: '场一', file: 's1' },
    { id: 's2', kind: 'scene', parent_id: 'c1', order: 2, title: '场二', file: 's2' },
  ] as never[];

  test('嵌套项只保留最外层', () => {
    const r = pickOutermostIds(nodes, ['v1', 'c1', 's1']);
    assert.deepEqual(r.keep, ['v1']);
    assert.deepEqual(r.dropped.sort(), ['c1', 's1']);
  });

  test('互不嵌套的兄弟全部保留', () => {
    const r = pickOutermostIds(nodes, ['c1', 'c2']);
    assert.deepEqual(r.keep, ['c1', 'c2']);
    assert.deepEqual(r.dropped, []);
  });

  test('重复传入的 id 只算一次', () => {
    const r = pickOutermostIds(nodes, ['c1', 'c1']);
    assert.deepEqual(r.keep, ['c1']);
  });

  test('未知 id 不被吞掉（交给调用方报 404）', () => {
    const r = pickOutermostIds(nodes, ['不存在的']);
    assert.deepEqual(r.keep, ['不存在的']);
  });

  test('同一父目录序号大的先删', () => {
    assert.deepEqual(orderForDeletion(nodes, ['s1', 's2']), ['s2', 's1']);
  });

  test('collectSubtree 收集整棵子树', () => {
    const sub = collectSubtree(nodes, ['c1']).map((n) => n.id);
    assert.deepEqual(sub.sort(), ['c1', 's1', 's2']);
  });
});

describe('批量删除', () => {
  test('删三个场景再恢复：结构、顺序、标题、内容都还原', async () => {
    const h = await setup();
    try {
      const v = await createNode(h, 'volume', null, '第一卷');
      const c = await createNode(h, 'chapter', v, '第一章');
      const s1 = await createNode(h, 'scene', c, '场景一');
      const s2 = await createNode(h, 'scene', c, '场景二');
      const s3 = await createNode(h, 'scene', c, '场景三');
      await writeScene(h, s1, '甲的内容');
      await writeScene(h, s2, '乙的内容');
      await writeScene(h, s3, '丙的内容');

      const before = treeShape(await getTree(h));
      const hashes = new Map<string, string>();
      for (const id of [s1, s2, s3]) hashes.set(id, await fileSha1(await findSceneFile(h, id)));

      const del = await post<BatchDeleteResponse>(h, '/nodes/delete', { ids: [s1, s2, s3] });
      assert.equal(del.status, 200, JSON.stringify(del.body));
      assert.equal(del.body.deleted, 3);
      assert.equal(del.body.items.length, 3, '每项都要带回 trash_id');
      for (const item of del.body.items) {
        assert.ok(item.trash_id, 'trash_id 不能为空');
        assert.ok(item.doc_id);
        assert.ok(item.title);
      }

      // 删完树里只剩卷和章
      const afterDelete = await getTree(h);
      assert.equal(afterDelete.nodes.length, 2, '三个场景应从树里消失');

      // 批量恢复
      const restore = await post<BatchRestoreResponse>(h, '/trash/restore-batch', {
        ids: del.body.items.map((i) => i.trash_id),
      });
      assert.equal(restore.status, 200, JSON.stringify(restore.body));
      assert.equal(restore.body.restored, 3);

      // 结构、顺序、标题完全一致
      assert.deepEqual(treeShape(await getTree(h)), before, '恢复后的树应与删除前一致');
      // 内容哈希一致
      for (const id of [s1, s2, s3]) {
        assert.equal(await fileSha1(await findSceneFile(h, id)), hashes.get(id), `场景 ${id} 内容变了`);
      }
    } finally {
      await h.close();
    }
  });

  test('嵌套 id：只处理最外层，后代不出现在回执里', async () => {
    const h = await setup();
    try {
      const v = await createNode(h, 'volume', null, '第一卷');
      const c = await createNode(h, 'chapter', v, '第一章');
      await createNode(h, 'scene', c, '场景一');

      const del = await post<BatchDeleteResponse>(h, '/nodes/delete', { ids: [v, c] });
      assert.equal(del.status, 200, JSON.stringify(del.body));
      assert.equal(del.body.deleted, 1, '只应删最外层的卷');
      assert.equal(del.body.items[0].doc_id, v);
      assert.ok(
        del.body.items.every((i) => i.doc_id !== c),
        '被嵌套的章不应出现在回执里',
      );

      const tree = await getTree(h);
      assert.equal(tree.nodes.length, 0, '整卷连子项都应消失');
    } finally {
      await h.close();
    }
  });

  test('未知 id：404，且树与回收站都没有变化', async () => {
    const h = await setup();
    try {
      const v = await createNode(h, 'volume', null, '第一卷');
      const before = treeShape(await getTree(h));
      const trashBefore = await listTrash(h);

      const del = await post(h, '/nodes/delete', { ids: [v, '不存在的节点'] });
      assert.equal(del.status, 404, JSON.stringify(del.body));

      assert.deepEqual(treeShape(await getTree(h)), before, '树不应变化');
      assert.deepEqual(await listTrash(h), trashBefore, '回收站不应变化');
    } finally {
      await h.close();
    }
  });

  test('快照失败：一个节点都不移动', async () => {
    const h = await setup();
    try {
      const v = await createNode(h, 'volume', null, '第一卷');
      const c = await createNode(h, 'chapter', v, '第一章');
      const s1 = await createNode(h, 'scene', c, '场景一');
      const s2 = await createNode(h, 'scene', c, '场景二');
      await writeScene(h, s1, '内容一');
      await writeScene(h, s2, '内容二');

      const ctx = await h.appCtx.openProject(h.pid);
      const before = treeShape(await getTree(h));
      const trashBefore = await listTrash(h);

      // 故障注入：第二个场景的快照抛错（真实路径见上面的正常用例）
      const realCreate = ctx.snapshots.create.bind(ctx.snapshots);
      let calls = 0;
      ctx.snapshots.create = (async (...args: Parameters<typeof realCreate>) => {
        calls++;
        if (calls === 2) throw new Error('注入的快照失败');
        return realCreate(...args);
      }) as typeof ctx.snapshots.create;

      try {
        const del = await post(h, '/nodes/delete', { ids: [s1, s2] });
        assert.equal(del.status, 500, `期望 500，实际 ${del.status}`);
        assert.match(String((del.body as { message?: string }).message ?? ''), /快照失败/);
      } finally {
        ctx.snapshots.create = realCreate;
      }

      assert.deepEqual(treeShape(await getTree(h)), before, '快照失败时不应移动任何节点');
      assert.deepEqual(await listTrash(h), trashBefore, '快照失败时回收站应为空');
    } finally {
      await h.close();
    }
  });

  test('移动中途失败：已移动的被回滚', async () => {
    const h = await setup();
    try {
      const v = await createNode(h, 'volume', null, '第一卷');
      const c = await createNode(h, 'chapter', v, '第一章');
      const s1 = await createNode(h, 'scene', c, '场景一');
      const s2 = await createNode(h, 'scene', c, '场景二');
      await writeScene(h, s1, '内容一');
      await writeScene(h, s2, '内容二');

      const ctx = await h.appCtx.openProject(h.pid);
      const before = treeShape(await getTree(h));

      // 故障注入：第二次移动抛错，用于验证回滚分支
      const realDelete = ctx.store.deleteNodeToTrash.bind(ctx.store);
      let calls = 0;
      ctx.store.deleteNodeToTrash = (async (docId: string) => {
        calls++;
        if (calls === 2) throw new Error('注入的移动失败');
        return realDelete(docId);
      }) as typeof ctx.store.deleteNodeToTrash;

      try {
        const del = await post(h, '/nodes/delete', { ids: [s1, s2] });
        assert.equal(del.status, 500, `期望 500，实际 ${del.status}`);
        assert.match(String((del.body as { message?: string }).message ?? ''), /已全部回滚/);
      } finally {
        ctx.store.deleteNodeToTrash = realDelete;
      }

      // 第一步移动过的那个应该被恢复回原位置
      assert.deepEqual(treeShape(await getTree(h)), before, '失败后树应回到删除前的状态');
      assert.deepEqual(await listTrash(h), [], '回收站应被清空（回滚移回）');
    } finally {
      await h.close();
    }
  });

  test('恢复时拒绝路径穿越的 trash_id', async () => {
    const h = await setup();
    try {
      for (const bad of ['../x', '..', 'a/b', '..\\win']) {
        const res = await post(h, '/trash/restore-batch', { ids: [bad] });
        assert.equal(res.status, 400, `「${bad}」应被拒绝，实际 ${res.status}`);
      }
    } finally {
      await h.close();
    }
  });

  test('恢复后出场统计与删除前一致', async () => {
    const h = await setup();
    try {
      const v = await createNode(h, 'volume', null, '第一卷');
      const c = await createNode(h, 'chapter', v, '第一章');
      const s = await createNode(h, 'scene', c, '初遇');
      await writeScene(h, s, '林远握住剑柄。林远没有回头。');

      // 建角色条目
      const ent = await h.app.inject({
        method: 'POST',
        url: h.url('/entities'),
        payload: { type: 'character', name: '林远' },
      });
      assert.equal(ent.statusCode, 200, ent.body);
      const entityId = (ent.json() as { id: string }).id;

      const mentionsOf = async (): Promise<number> => {
        const res = await h.app.inject({
          method: 'GET',
          url: h.url(`/entities/${encodeURIComponent(entityId)}`),
        });
        assert.equal(res.statusCode, 200, res.body);
        const data = res.json() as { mentions?: Array<{ count: number }>; entity?: { mentions?: unknown } };
        const list = (data.mentions ?? (data.entity as { mentions?: Array<{ count: number }> })?.mentions ?? []) as Array<{
          count: number;
        }>;
        return list.reduce((n, m) => n + m.count, 0);
      };

      const beforeCount = await mentionsOf();

      const del = await post<BatchDeleteResponse>(h, '/nodes/delete', { ids: [s] });
      assert.equal(del.status, 200, JSON.stringify(del.body));

      const restore = await post<BatchRestoreResponse>(h, '/trash/restore-batch', {
        ids: del.body.items.map((i) => i.trash_id),
      });
      assert.equal(restore.status, 200, JSON.stringify(restore.body));

      assert.equal(await mentionsOf(), beforeCount, '恢复后出场次数应与删除前一致');
      assert.ok(beforeCount > 0, '前置条件：删除前应有出场记录');
    } finally {
      await h.close();
    }
  });

  test('并发：删除与保存同一场景，文件不会被写回', async () => {
    const h = await setup();
    try {
      const v = await createNode(h, 'volume', null, '第一卷');
      const c = await createNode(h, 'chapter', v, '第一章');
      const s = await createNode(h, 'scene', c, '并发场景');
      await writeScene(h, s, '初始内容');

      // 删除与保存同时发起
      const [del] = await Promise.all([
        post<BatchDeleteResponse>(h, '/nodes/delete', { ids: [s] }),
        h.app.inject({
          method: 'POST',
          url: h.url(`/scenes/${encodeURIComponent(s)}`),
          payload: { body: '并发保存的内容' },
        }),
      ]);

      assert.equal(del.status, 200, JSON.stringify(del.body));

      // 关键断言：删除成功后，磁盘上不应再出现这个场景文件
      await assert.rejects(
        () => findSceneFile(h, s),
        /找不到场景文件/,
        '删除后文件被保存写回了 —— 这正是要防的「幽灵章节」',
      );

      const tree = await getTree(h);
      assert.equal(tree.nodes.filter((n) => n.kind === 'scene').length, 0, '树里不应有残留场景');
    } finally {
      await h.close();
    }
  });

  test('空 ids / 非法 body 被拒绝', async () => {
    const h = await setup();
    try {
      assert.equal((await post(h, '/nodes/delete', { ids: [] })).status, 400);
      assert.equal((await post(h, '/nodes/delete', {})).status, 400);
      assert.equal((await post(h, '/trash/restore-batch', { ids: 'x' })).status, 400);
    } finally {
      await h.close();
    }
  });
});
