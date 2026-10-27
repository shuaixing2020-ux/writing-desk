/**
 * 图谱布局算法测试（G2）。
 *
 * 布局是纯函数，可以直接验证坐标合理性，不必起浏览器。
 * 重点保证：确定性、不越界、相连节点更近、过滤逻辑正确。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { filterByChapter, layoutGraph } from '../../web/src/components/graph/layout.ts';
import type { Entity, Relation } from '../../shared/types.ts';

function entity(id: string, name: string, type = 'character'): Entity {
  return { id, name, type, aliases: [], fields: {}, description: '', created_at: 0, updated_at: 0 };
}

function relation(id: string, from: string, to: string, type = 'kin', extra: Partial<Relation> = {}): Relation {
  return { id, from, to, type, note: '', ...extra };
}

const DIRECTED: Record<string, boolean> = { mentor: true, kin: false, ally: false };

describe('布局基本性质', () => {
  test('空图返回空节点', () => {
    const l = layoutGraph([], [], DIRECTED, { width: 800, height: 600 });
    assert.deepEqual(l.nodes, []);
    assert.deepEqual(l.edges, []);
  });

  test('单节点居中', () => {
    const l = layoutGraph([entity('a', '林远')], [], DIRECTED, { width: 800, height: 600 });
    assert.equal(l.nodes.length, 1);
    assert.equal(l.nodes[0].x, 400);
    assert.equal(l.nodes[0].y, 300);
  });

  test('所有节点都在画布内（含内边距）', () => {
    const entities = Array.from({ length: 30 }, (_, i) => entity(`e${i}`, `角色${i}`));
    const rels = entities.slice(1).map((e, i) => relation(`r${i}`, 'e0', e.id));
    const l = layoutGraph(entities, rels, DIRECTED, { width: 900, height: 650, padding: 40 });

    for (const n of l.nodes) {
      assert.ok(n.x >= 35 && n.x <= 865, `节点 ${n.name} x 越界: ${n.x}`);
      assert.ok(n.y >= 35 && n.y <= 615, `节点 ${n.name} y 越界: ${n.y}`);
    }
  });

  test('确定性：同样输入两次布局结果完全一致', () => {
    const entities = Array.from({ length: 12 }, (_, i) => entity(`e${i}`, `N${i}`));
    const rels = [relation('r1', 'e0', 'e1'), relation('r2', 'e1', 'e2'), relation('r3', 'e3', 'e4')];

    const a = layoutGraph(entities, rels, DIRECTED, { width: 800, height: 600, iterations: 150 });
    const b = layoutGraph(entities, rels, DIRECTED, { width: 800, height: 600, iterations: 150 });

    for (let i = 0; i < a.nodes.length; i++) {
      assert.equal(a.nodes[i].x, b.nodes[i].x, `节点 ${i} x 不一致`);
      assert.equal(a.nodes[i].y, b.nodes[i].y, `节点 ${i} y 不一致`);
    }
  });

  test('相连节点比不相连的更近', () => {
    // 两个簇：a-b-c 相连，d 孤立
    const entities = [entity('a', 'A'), entity('b', 'B'), entity('c', 'C'), entity('d', 'D')];
    const rels = [relation('r1', 'a', 'b'), relation('r2', 'b', 'c')];
    const l = layoutGraph(entities, rels, DIRECTED, { width: 800, height: 600, iterations: 300 });

    const pos = new Map(l.nodes.map((n) => [n.id, n]));
    const dist = (p: string, q: string): number =>
      Math.hypot(pos.get(p)!.x - pos.get(q)!.x, pos.get(p)!.y - pos.get(q)!.y);

    // a-b 有边，a-d 无边
    assert.ok(dist('a', 'b') < dist('a', 'd'), `相连的 a-b 应比不相连的 a-d 更近：${dist('a', 'b').toFixed(1)} vs ${dist('a', 'd').toFixed(1)}`);
  });

  test('连接度高的节点半径更大', () => {
    const entities = [entity('hub', '中心'), ...Array.from({ length: 6 }, (_, i) => entity(`s${i}`, `外围${i}`))];
    const rels = entities.slice(1).map((e, i) => relation(`r${i}`, 'hub', e.id));
    const l = layoutGraph(entities, rels, DIRECTED, { width: 800, height: 600, iterations: 200 });

    const hub = l.nodes.find((n) => n.id === 'hub')!;
    const leaf = l.nodes.find((n) => n.id === 's0')!;
    assert.ok(hub.r > leaf.r, `中心节点半径 ${hub.r} 应大于叶节点 ${leaf.r}`);
    assert.equal(hub.degree, 6);
  });
});

describe('边的构建', () => {
  test('有向边带箭头标记，无向边不带', () => {
    const entities = [entity('a', 'A'), entity('b', 'B'), entity('c', 'C')];
    const rels = [
      relation('r1', 'a', 'b', 'mentor'),
      relation('r2', 'b', 'c', 'kin'),
    ];
    const l = layoutGraph(entities, rels, DIRECTED, { width: 800, height: 600 });
    assert.equal(l.edges.find((e) => e.id === 'r1')?.directed, true);
    assert.equal(l.edges.find((e) => e.id === 'r2')?.directed, false);
  });

  test('悬空边被标记', () => {
    const entities = [entity('a', 'A')];
    const rels = [relation('r1', 'a', 'GONE', 'kin')];
    const l = layoutGraph(entities, rels, DIRECTED, { width: 800, height: 600 });
    assert.equal(l.edges.length, 1);
    assert.equal(l.edges[0].dangling, true);
  });

  test('未知类型默认按有向处理', () => {
    const entities = [entity('a', 'A'), entity('b', 'B')];
    const rels = [relation('r1', 'a', 'b', '自定义类型')];
    const l = layoutGraph(entities, rels, DIRECTED, { width: 800, height: 600 });
    assert.equal(l.edges[0].directed, true);
  });
});

describe('章节过滤', () => {
  const ordinals: Record<string, number> = { d1: 1, d2: 2, d3: 3 };
  const ordOf = (id: string): number | null => ordinals[id] ?? null;

  test('since 晚于当前章节的关系被排除', () => {
    const rels = [relation('r1', 'a', 'b', 'kin', { since: 'd3' })];
    assert.equal(filterByChapter(rels, 1, ordOf).length, 0, '第 3 章才成立的关系，在第 1 章不应出现');
    assert.equal(filterByChapter(rels, 3, ordOf).length, 1);
  });

  test('until 早于当前章节的关系被排除', () => {
    const rels = [relation('r1', 'a', 'b', 'kin', { until: 'd2' })];
    assert.equal(filterByChapter(rels, 3, ordOf).length, 0, '第 2 章已结束的关系，在第 3 章不应出现');
    assert.equal(filterByChapter(rels, 2, ordOf).length, 1);
  });

  test('区间内成立', () => {
    const rels = [relation('r1', 'a', 'b', 'kin', { since: 'd1', until: 'd3' })];
    assert.equal(filterByChapter(rels, 2, ordOf).length, 1);
  });

  test('无锚点的关系始终出现', () => {
    const rels = [relation('r1', 'a', 'b', 'kin')];
    for (const ch of [1, 2, 3]) {
      assert.equal(filterByChapter(rels, ch, ordOf).length, 1);
    }
  });

  test('锚点指向已删文档时按不限处理（不让关系凭空消失）', () => {
    const rels = [relation('r1', 'a', 'b', 'kin', { since: 'DELETED_DOC' })];
    assert.equal(filterByChapter(rels, 1, ordOf).length, 1);
  });
});
