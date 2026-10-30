/**
 * 新建节点时指定插入位置（O1 补的后端能力）。
 *
 * 大纲里按 Enter 要在「当前行之后」插入，统一追加到末尾会让连续新建的顺序反掉。
 * 这里验证：落点正确、序号连续、文件名前缀与 frontmatter 的 order 一致、
 * id 不因重排而改变（身份靠 id，不靠文件名）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildServer } from '../../server/main.ts';
import type { AppContextImpl } from '../../server/app-context.ts';
import type { FastifyInstance } from 'fastify';

interface Harness {
  dir: string;
  app: FastifyInstance;
  appCtx: AppContextImpl;
  pid: string;
  url: (p: string) => string;
  close: () => Promise<void>;
}

async function setup(): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-nodeindex-'));
  const { app, appCtx } = await buildServer(dir);
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { title: '插入位置测试' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const project = res.json() as { id: string };
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

async function createNode(
  h: Harness,
  kind: 'volume' | 'chapter' | 'scene',
  parentId: string | null,
  title: string,
  index?: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await h.app.inject({
    method: 'POST',
    url: h.url('/nodes'),
    payload: { kind, parent_id: parentId, title, ...(index === undefined ? {} : { index }) },
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function treeOf(h: Harness): Promise<Array<Record<string, unknown>>> {
  const res = await h.app.inject({ method: 'GET', url: h.url('/tree') });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { nodes: Array<Record<string, unknown>> }).nodes;
}

/** 某父节点下、指定类型的子节点标题（按顺序） */
async function titlesUnder(
  h: Harness,
  parentId: string | null,
  kind: string,
): Promise<string[]> {
  const nodes = await treeOf(h);
  return nodes
    .filter((n) => n.parent_id === parentId && n.kind === kind)
    .sort((a, b) => Number(a.order) - Number(b.order))
    .map((n) => String(n.title));
}

const sceneDir = (h: Harness): string => path.join(h.dir, h.pid, 'manuscript');

/**
 * 找某个 id 的「磁盘名字」。
 * 场景是文件（s0001-标题.md）；章/卷是目录，名字即目录名，元数据在目录内的 _chapter.md。
 */
async function fileNameOf(h: Harness, id: string): Promise<string> {
  const stack = [sceneDir(h)];
  while (stack.length) {
    const cur = stack.pop() as string;
    for (const entry of await fs.readdir(cur, { withFileTypes: true })) {
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        // 先看目录里有没有属于该 id 的元数据
        for (const inner of await fs.readdir(abs).catch(() => [] as string[])) {
          if (!inner.endsWith('.md')) continue;
          const raw = await fs.readFile(path.join(abs, inner), 'utf8').catch(() => '');
          if (raw.includes(`id: ${id}`)) return entry.name;
        }
        stack.push(abs);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      const raw = await fs.readFile(abs, 'utf8');
      if (raw.includes(`id: ${id}`)) return entry.name;
    }
  }
  throw new Error(`找不到 id 为 ${id} 的文件`);
}

describe('新建节点指定位置', () => {
  test('index 0：插到最前面', async () => {
    const h = await setup();
    try {
      const v = await createNode(h, 'volume', null, '卷一');
      await createNode(h, 'chapter', v.body.id as string, '甲');
      await createNode(h, 'chapter', v.body.id as string, '乙');
      const third = await createNode(h, 'chapter', v.body.id as string, '丙', 0);
      assert.equal(third.status, 200, JSON.stringify(third.body));

      assert.deepEqual(await titlesUnder(h, v.body.id as string, 'chapter'), ['丙', '甲', '乙']);
    } finally {
      await h.close();
    }
  });

  test('index 1：插到中间', async () => {
    const h = await setup();
    try {
      const v = await createNode(h, 'volume', null, '卷一');
      const vid = v.body.id as string;
      await createNode(h, 'chapter', vid, '甲');
      await createNode(h, 'chapter', vid, '丙');
      await createNode(h, 'chapter', vid, '乙', 1);

      assert.deepEqual(await titlesUnder(h, vid, 'chapter'), ['甲', '乙', '丙']);
    } finally {
      await h.close();
    }
  });

  test('index 超出范围：追加到末尾', async () => {
    const h = await setup();
    try {
      const v = await createNode(h, 'volume', null, '卷一');
      const vid = v.body.id as string;
      await createNode(h, 'chapter', vid, '甲');
      await createNode(h, 'chapter', vid, '乙', 99);

      assert.deepEqual(await titlesUnder(h, vid, 'chapter'), ['甲', '乙']);
    } finally {
      await h.close();
    }
  });

  test('不传 index 时行为与以前一致（追加）', async () => {
    const h = await setup();
    try {
      const v = await createNode(h, 'volume', null, '卷一');
      const vid = v.body.id as string;
      await createNode(h, 'chapter', vid, '甲');
      await createNode(h, 'chapter', vid, '乙');
      assert.deepEqual(await titlesUnder(h, vid, 'chapter'), ['甲', '乙']);
    } finally {
      await h.close();
    }
  });

  test('连续在中间插入：顺序稳定、序号连续', async () => {
    const h = await setup();
    try {
      const v = await createNode(h, 'volume', null, '卷一');
      const vid = v.body.id as string;
      await createNode(h, 'chapter', vid, '底');
      // 依次插到 0：每次都顶到最前面，最终顺序应反转
      await createNode(h, 'chapter', vid, '二', 0);
      await createNode(h, 'chapter', vid, '一', 0);

      assert.deepEqual(await titlesUnder(h, vid, 'chapter'), ['一', '二', '底']);

      const orders = (await treeOf(h))
        .filter((n) => n.parent_id === vid)
        .map((n) => Number(n.order))
        .sort((a, b) => a - b);
      assert.deepEqual(orders, [1, 2, 3], '序号应连续');
    } finally {
      await h.close();
    }
  });

  test('重排后 id 不变（身份靠 frontmatter，不靠文件名）', async () => {
    const h = await setup();
    try {
      const v = await createNode(h, 'volume', null, '卷一');
      const vid = v.body.id as string;
      await createNode(h, 'chapter', vid, '甲');
      const inserted = await createNode(h, 'chapter', vid, '乙', 0);
      const id = inserted.body.id as string;

      const after = (await treeOf(h)).find((n) => n.id === id);
      assert.ok(after, '重排后应按 id 找到节点');
      assert.equal(after!.title, '乙');
      assert.equal(Number(after!.order), 1);
    } finally {
      await h.close();
    }
  });

  test('文件名前缀与 order 一致（重排真的改了文件名）', async () => {
    const h = await setup();
    try {
      const v = await createNode(h, 'volume', null, '卷一');
      const vid = v.body.id as string;
      await createNode(h, 'chapter', vid, '甲');
      const second = await createNode(h, 'chapter', vid, '乙');
      const secondId = second.body.id as string;

      // 起手是 c002-乙
      assert.match(await fileNameOf(h, secondId), /^c002-乙/);

      await createNode(h, 'chapter', vid, '零', 0);
      // 插到最前之后应变成 c003-乙，文件真的改名了
      assert.match(await fileNameOf(h, secondId), /^c003-乙/);
    } finally {
      await h.close();
    }
  });

  test('场景也能按位置插入', async () => {
    const h = await setup();
    try {
      const v = await createNode(h, 'volume', null, '卷一');
      const c = await createNode(h, 'chapter', v.body.id as string, '第一章');
      const cid = c.body.id as string;
      await createNode(h, 'scene', cid, '场景一');
      await createNode(h, 'scene', cid, '场景三');
      await createNode(h, 'scene', cid, '场景二', 1);

      assert.deepEqual(await titlesUnder(h, cid, 'scene'), ['场景一', '场景二', '场景三']);
    } finally {
      await h.close();
    }
  });

  test('非法 index 被拒绝（负数 / 非数字）', async () => {
    const h = await setup();
    try {
      const v = await createNode(h, 'volume', null, '卷一');
      const vid = v.body.id as string;

      const negative = await createNode(h, 'chapter', vid, '负', -1);
      assert.equal(negative.status, 400, `负数应 400，实际 ${negative.status}`);

      const res = await h.app.inject({
        method: 'POST',
        url: h.url('/nodes'),
        payload: { kind: 'chapter', parent_id: vid, title: '坏', index: 'x' },
      });
      assert.equal(res.statusCode, 400, `非数字应 400，实际 ${res.statusCode}`);
    } finally {
      await h.close();
    }
  });

  test('父类型约束仍然生效（场景不能直接挂到卷下）', async () => {
    const h = await setup();
    try {
      const v = await createNode(h, 'volume', null, '卷一');
      const bad = await createNode(h, 'scene', v.body.id as string, '错挂', 0);
      assert.ok(bad.status >= 400, `应失败，实际 ${bad.status}`);

      // 失败不应留下半成品
      const nodes = await treeOf(h);
      assert.equal(nodes.filter((n) => n.kind === 'scene').length, 0, '不应留下场景');
    } finally {
      await h.close();
    }
  });

  test('卷之间也能按位置插入', async () => {
    const h = await setup();
    try {
      await createNode(h, 'volume', null, '卷一');
      await createNode(h, 'volume', null, '卷三');
      await createNode(h, 'volume', null, '卷二', 1);

      const titles = (await treeOf(h))
        .filter((n) => n.kind === 'volume')
        .sort((a, b) => Number(a.order) - Number(b.order))
        .map((n) => n.title);
      assert.deepEqual(titles, ['卷一', '卷二', '卷三']);
    } finally {
      await h.close();
    }
  });
});
