/**
 * 章节序号换算测试（G0-6）。
 *
 * 关系锚点存文档 id，显示时换算成「第 N 章」。
 * 关键性质：**序号跟随结构变化**，而 id 不变。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  chapterOrdinalOf,
  chapterTitleAt,
  describeAnchor,
  flattenChapters,
} from '../../server/graph/ordinal.ts';
import type { DocNode, DocTree } from '../../shared/types.ts';
import { ProjectStore } from '../../server/store/project.ts';

function node(id: string, kind: DocNode['kind'], parent: string | null, order: number, title = id): DocNode {
  return {
    id,
    kind,
    title,
    parent_id: parent,
    order,
    status: 'draft',
    summary: '',
    word_count: 0,
    updated_at: 0,
  };
}

/** 手工构造的树：卷1(章A, 章B) 卷2(章C) */
function sampleTree(): DocTree {
  return {
    nodes: [
      node('v1', 'volume', null, 1, '第一卷'),
      node('c1', 'chapter', 'v1', 1, '第一章'),
      node('s1', 'scene', 'c1', 1, '场景1-1'),
      node('s2', 'scene', 'c1', 2, '场景1-2'),
      node('c2', 'chapter', 'v1', 2, '第二章'),
      node('s3', 'scene', 'c2', 1, '场景2-1'),
      node('v2', 'volume', null, 2, '第二卷'),
      node('c3', 'chapter', 'v2', 1, '第三章'),
      node('s4', 'scene', 'c3', 1, '场景3-1'),
    ],
  };
}

describe('章节序号换算', () => {
  const tree = sampleTree();

  test('场景归属它所在的章', () => {
    assert.equal(chapterOrdinalOf(tree, 's1'), 1);
    assert.equal(chapterOrdinalOf(tree, 's2'), 1);
    assert.equal(chapterOrdinalOf(tree, 's3'), 2);
    assert.equal(chapterOrdinalOf(tree, 's4'), 3);
  });

  test('章本身返回自身序号', () => {
    assert.equal(chapterOrdinalOf(tree, 'c1'), 1);
    assert.equal(chapterOrdinalOf(tree, 'c2'), 2);
    assert.equal(chapterOrdinalOf(tree, 'c3'), 3);
  });

  test('卷不属于任何章，返回 null', () => {
    assert.equal(chapterOrdinalOf(tree, 'v1'), null);
    assert.equal(chapterOrdinalOf(tree, 'v2'), null);
  });

  test('不存在的 id 返回 null', () => {
    assert.equal(chapterOrdinalOf(tree, '不存在'), null);
  });

  test('序号跨卷连续（第二卷的第一章是第 3 章）', () => {
    assert.equal(chapterOrdinalOf(tree, 's4'), 3, '第二卷第一章应接在第一卷之后，而不是从 1 重新数');
  });

  test('chapterTitleAt 按序号取标题', () => {
    assert.equal(chapterTitleAt(tree, 1), '第一章');
    assert.equal(chapterTitleAt(tree, 3), '第三章');
    assert.equal(chapterTitleAt(tree, 99), null);
  });

  test('describeAnchor 生成可读文本', () => {
    assert.equal(describeAnchor(tree, 's1'), '第 1 章');
    assert.equal(describeAnchor(tree, 's4'), '第 3 章');
    assert.equal(describeAnchor(tree, 'v1'), null);
    assert.equal(describeAnchor(tree, undefined), null);
  });

  test('flattenChapters 返回全部章，按深度优先顺序', () => {
    const byId = new Map(tree.nodes.map((n) => [n.id, n]));
    const chapters = flattenChapters(byId);
    assert.deepEqual(chapters.map((c) => c.id), ['c1', 'c2', 'c3']);
  });
});

describe('结构变化后序号跟随更新', () => {
  test('在中间插入一章，后面章节序号顺延', () => {
    const tree = sampleTree();
    // 原第二章是第 2 章
    assert.equal(chapterOrdinalOf(tree, 'c2'), 2);

    // 在第一卷插入新章（order=2，原 c2 顺延到 3）
    tree.nodes.find((n) => n.id === 'c2')!.order = 3;
    tree.nodes.push(node('c_new', 'chapter', 'v1', 2, '插入的章'));

    assert.equal(chapterOrdinalOf(tree, 'c_new'), 2);
    assert.equal(chapterOrdinalOf(tree, 'c2'), 3, '原第二章应变成第 3 章');
    // 关键：id 不变，所以关系锚点不会断，只是显示序号变了
    assert.equal(chapterOrdinalOf(tree, 's3'), 3);
  });

  test('删除一章后，后面章节序号前移', () => {
    const tree = sampleTree();
    tree.nodes = tree.nodes.filter((n) => n.id !== 'c1' && n.parent_id !== 'c1');
    assert.equal(chapterOrdinalOf(tree, 'c2'), 1);
    assert.equal(chapterOrdinalOf(tree, 'c3'), 2);
  });
});

describe('与真实项目存储集成', () => {
  test('从磁盘读出的树能正确换算序号', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-ordinal-'));
    const store = await ProjectStore.create(path.join(dir, 'p'), { title: 'T' });

    const v = await store.createNode({ kind: 'volume', parent_id: null, title: '第一卷' });
    const c1 = await store.createNode({ kind: 'chapter', parent_id: v.id, title: '开篇' });
    const s1 = await store.createNode({ kind: 'scene', parent_id: c1.id, title: '雨夜' });
    const c2 = await store.createNode({ kind: 'chapter', parent_id: v.id, title: '天明' });
    const s2 = await store.createNode({ kind: 'scene', parent_id: c2.id, title: '日出' });

    const tree = await store.readTree();
    assert.equal(chapterOrdinalOf(tree, s1.id), 1);
    assert.equal(chapterOrdinalOf(tree, s2.id), 2);
    assert.equal(chapterOrdinalOf(tree, c2.id), 2);
    assert.equal(chapterOrdinalOf(tree, v.id), null);

    await fs.rm(dir, { recursive: true, force: true });
  });
});
