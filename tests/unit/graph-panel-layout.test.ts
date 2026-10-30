/**
 * 关系图谱面板的增量布局测试（R3）。
 *
 * 与 G2 的 layoutGraph 不同：这里是「每帧一步」的增量版本，
 * 面板动画用得上。三件事可客观断言：可复现、不越界、会收敛。
 * 手感另由人工验收。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  initLayout,
  kineticEnergy,
  stepLayout,
  type LNode,
} from '../../web/src/lib/graph-layout.ts';

const W = 800;
const H = 600;

function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `e${i}`);
}

function run(nodes: LNode[], edges: Array<[string, string]>, steps: number): number {
  let alpha = 1;
  for (let i = 0; i < steps; i++) alpha = stepLayout(nodes, edges, W, H, alpha);
  return alpha;
}

describe('initLayout', () => {
  test('同一 seed 的结果完全一致', () => {
    const a = initLayout(ids(12), W, H, 42);
    const b = initLayout(ids(12), W, H, 42);
    assert.deepEqual(a, b);
  });

  test('不同 seed 会给出不同布局', () => {
    const a = initLayout(ids(12), W, H, 1);
    const b = initLayout(ids(12), W, H, 2);
    assert.notDeepEqual(
      a.map((n) => [n.x, n.y]),
      b.map((n) => [n.x, n.y]),
    );
  });

  test('所有初始点都在画布内', () => {
    for (const n of initLayout(ids(40), W, H, 7)) {
      assert.ok(n.x >= 0 && n.x <= W, `x 越界：${n.x}`);
      assert.ok(n.y >= 0 && n.y <= H, `y 越界：${n.y}`);
    }
  });

  test('单个节点放在中心', () => {
    const [n] = initLayout(['only'], W, H, 3);
    assert.equal(n.x, W / 2);
    assert.equal(n.y, H / 2);
  });

  test('空列表返回空数组', () => {
    assert.deepEqual(initLayout([], W, H, 1), []);
  });
});

describe('stepLayout', () => {
  test('步进后所有节点仍在边界内', () => {
    const nodes = initLayout(ids(30), W, H, 11);
    const edges: Array<[string, string]> = [];
    for (let i = 1; i < 30; i++) edges.push(['e0', `e${i}`]);

    run(nodes, edges, 120);
    for (const n of nodes) {
      assert.ok(n.x >= 0 && n.x <= W, `x 越界：${n.x}`);
      assert.ok(n.y >= 0 && n.y <= H, `y 越界：${n.y}`);
    }
  });

  test('alpha 单调下降到 0', () => {
    const nodes = initLayout(ids(10), W, H, 5);
    let alpha = 1;
    let prev = alpha;
    for (let i = 0; i < 400; i++) {
      alpha = stepLayout(nodes, [['e0', 'e1']], W, H, alpha);
      assert.ok(alpha <= prev, 'alpha 不应回升');
      prev = alpha;
      if (alpha === 0) break;
    }
    assert.equal(alpha, 0, '足够多步之后应停下');
  });

  test('能量趋于稳定（后期显著小于最初）', () => {
    const nodes = initLayout(ids(20), W, H, 9);
    const edges: Array<[string, string]> = [];
    for (let i = 1; i < 20; i++) edges.push([`e${i - 1}`, `e${i}`]);

    let alpha = 1;
    for (let i = 0; i < 5; i++) alpha = stepLayout(nodes, edges, W, H, alpha);
    const early = kineticEnergy(nodes);

    for (let i = 0; i < 200; i++) alpha = stepLayout(nodes, edges, W, H, alpha);
    const late = kineticEnergy(nodes);

    assert.ok(late < early, `后期动能应更小：早期 ${early.toFixed(2)}，后期 ${late.toFixed(2)}`);
  });

  test('无边的图收敛后节点不重叠', () => {
    const nodes = initLayout(ids(14), W, H, 21);
    run(nodes, [], 300);

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
        assert.ok(d > 4, `节点 ${i}/${j} 太近：${d.toFixed(2)}`);
      }
    }
  });

  test('空图不崩', () => {
    assert.equal(stepLayout([], [], W, H, 1), 0);
  });

  test('pinned 节点不动', () => {
    const nodes = initLayout(ids(5), W, H, 13);
    const pinned = nodes[0];
    const before = { x: pinned.x, y: pinned.y };
    pinned.pinned = true;
    run(nodes, [['e0', 'e1'], ['e0', 'e2']], 50);
    assert.equal(pinned.x, before.x);
    assert.equal(pinned.y, before.y);
  });
});
