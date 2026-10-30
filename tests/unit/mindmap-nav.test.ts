/**
 * 思维导图导航与折叠策略（O3）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
  buildNavIndex,
  clampZoom,
  defaultCollapsedFor,
  fitZoomFor,
  maxDepthOf,
  navToChild,
  navToParent,
  navToSibling,
} from '../../web/src/lib/mindmap-nav.ts';
import type { DocNode } from '../../shared/types.ts';

/** 造节点；只填导航用得到的字段 */
function node(
  id: string,
  parent_id: string | null,
  order: number,
  kind: DocNode['kind'] = 'scene',
): DocNode {
  return {
    id,
    kind,
    title: id,
    parent_id,
    order,
    status: 'draft',
    summary: '',
    word_count: 0,
    updated_at: 0,
    file: '',
    tags: [],
    plotlines: [],
  } as DocNode;
}

/** 卷 v1 → 章 c1 → 场 s1,s2；章 c2；卷 v2 → 章 c3 */
function sample(): DocNode[] {
  return [
    node('v1', null, 1, 'volume'),
    node('c1', 'v1', 1, 'chapter'),
    node('s1', 'c1', 1),
    node('s2', 'c1', 2),
    node('c2', 'v1', 2, 'chapter'),
    node('v2', null, 2, 'volume'),
    node('c3', 'v2', 1, 'chapter'),
  ];
}

describe('buildNavIndex', () => {
  test('父子关系与顺序正确', () => {
    const index = buildNavIndex(sample());
    assert.deepEqual(index.rootIds, ['v1', 'v2']);
    assert.deepEqual(index.byId.get('v1')!.children, ['c1', 'c2']);
    assert.deepEqual(index.byId.get('c1')!.children, ['s1', 's2']);
  });

  test('父节点不存在的节点当成根节点，不丢', () => {
    const index = buildNavIndex([node('x', '不存在的父', 1)]);
    assert.deepEqual(index.rootIds, ['x']);
  });
});

describe('方向键导航', () => {
  test('往右进入第一个子节点', () => {
    const index = buildNavIndex(sample());
    assert.equal(navToChild(index, 'v1', new Set()), 'c1');
    assert.equal(navToChild(index, 'c1', new Set()), 's1');
  });

  test('叶子节点往右返回 null', () => {
    const index = buildNavIndex(sample());
    assert.equal(navToChild(index, 's1', new Set()), null);
  });

  test('折叠的节点往右返回 null（调用方负责展开）', () => {
    const index = buildNavIndex(sample());
    assert.equal(navToChild(index, 'v1', new Set(['v1'])), null);
  });

  test('往左回到父节点；根节点返回 null', () => {
    const index = buildNavIndex(sample());
    assert.equal(navToParent(index, 's2'), 'c1');
    assert.equal(navToParent(index, 'v1'), null);
  });

  test('上下在同级之间移动', () => {
    const index = buildNavIndex(sample());
    assert.equal(navToSibling(index, 's1', 1), 's2');
    assert.equal(navToSibling(index, 's2', -1), 's1');
    assert.equal(navToSibling(index, 'v1', 1), 'v2');
  });

  test('同级到头返回 null', () => {
    const index = buildNavIndex(sample());
    assert.equal(navToSibling(index, 's1', -1), null);
    assert.equal(navToSibling(index, 's2', 1), null);
    assert.equal(navToSibling(index, 'v2', 1), null);
  });

  test('未知节点一律返回 null', () => {
    const index = buildNavIndex(sample());
    assert.equal(navToChild(index, '不存在', new Set()), null);
    assert.equal(navToParent(index, '不存在'), null);
    assert.equal(navToSibling(index, '不存在', 1), null);
  });
});

describe('默认折叠策略', () => {
  test('节点少时不折叠', () => {
    assert.equal(defaultCollapsedFor(sample()).size, 0);
  });

  test('超过阈值时折叠到章级（场景不显示）', () => {
    const many: DocNode[] = [];
    for (let i = 0; i < 350; i++) many.push(node(`s${i}`, 'c1', i));
    many.push(node('v1', null, 1, 'volume'));
    many.push(node('c1', 'v1', 1, 'chapter'));

    const collapsed = defaultCollapsedFor(many);
    assert.ok(collapsed.has('c1'), '章应被折叠');
    assert.ok(!collapsed.has('v1'), '卷不应折叠，否则看不到章');
  });

  test('阈值可调', () => {
    // sample 里有三个章（c1/c2/c3），阈值 1 时全部折叠
    assert.equal(defaultCollapsedFor(sample(), 1).size, 3, '三个章都应被折叠');
  });
});

describe('缩放', () => {
  test('钳制在 0.4 到 2 之间', () => {
    assert.equal(clampZoom(0.1), MIN_ZOOM);
    assert.equal(clampZoom(5), MAX_ZOOM);
    assert.equal(clampZoom(1.234), 1.23);
  });

  test('非有限数回到 1', () => {
    assert.equal(clampZoom(Number.NaN), 1);
    assert.equal(clampZoom(Number.POSITIVE_INFINITY), 1);
  });

  test('步长可用', () => {
    assert.equal(clampZoom(1 + ZOOM_STEP), 1.1);
  });

  test('适应：层数少时不缩放', () => {
    assert.equal(fitZoomFor(2), 1);
  });

  test('适应：层数多时收缩但不越界', () => {
    const z = fitZoomFor(6);
    assert.ok(z < 1 && z >= MIN_ZOOM, `应介于 ${MIN_ZOOM} 与 1 之间，实际 ${z}`);
  });
});

describe('maxDepthOf', () => {
  test('三层结构深度为 2', () => {
    assert.equal(maxDepthOf(sample()), 2);
  });

  test('空树为 0', () => {
    assert.equal(maxDepthOf([]), 0);
  });
});
