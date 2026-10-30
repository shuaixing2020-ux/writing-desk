/**
 * 删除策略单元测试（C2）。
 *
 * 这些规则决定「删除时要不要拦一下」，判断错了会直接伤害作者：
 * 拦得太多 → 每次删空场景都弹框，作者很快学会无脑点确认；
 * 拦得太少 → 一次误删整卷。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  dedupeNested,
  describeDeleteSummary,
  nextSelectionAfterDelete,
  needsConfirm,
  type DeleteTarget,
} from '../../web/src/lib/delete-policy.ts';

function target(patch: Partial<DeleteTarget> & { id: string }): DeleteTarget {
  return {
    kind: 'scene',
    status: 'draft',
    words: 0,
    descendants: 0,
    descendantWords: 0,
    ...patch,
  };
}

describe('needsConfirm：什么时候该拦一下', () => {
  test('空场景直接删，不弹框', () => {
    assert.equal(needsConfirm([target({ id: 'a' })]), false);
  });

  test('有字数的场景要确认', () => {
    assert.equal(needsConfirm([target({ id: 'a', words: 12 })]), true);
  });

  test('空章但有下级要确认', () => {
    assert.equal(
      needsConfirm([target({ id: 'c', kind: 'chapter', descendants: 3 })]),
      true,
    );
  });

  test('空卷但没有下级，直接删', () => {
    assert.equal(
      needsConfirm([target({ id: 'v', kind: 'volume', descendants: 0 })]),
      false,
    );
  });

  test('容器自身 0 字但后代有字，要确认', () => {
    assert.equal(
      needsConfirm([
        target({ id: 'v', kind: 'volume', descendants: 5, descendantWords: 3200 }),
      ]),
      true,
    );
  });

  test('已发布状态的空场景也要确认（哪怕没字）', () => {
    assert.equal(needsConfirm([target({ id: 'a', status: 'published' })]), true);
  });

  test('多个目标里只要有一个需要，整体就确认', () => {
    assert.equal(
      needsConfirm([target({ id: 'a' }), target({ id: 'b', words: 5 })]),
      true,
    );
  });

  test('空列表不需要确认', () => {
    assert.equal(needsConfirm([]), false);
  });
});

describe('dedupeNested：嵌套项只留最外层', () => {
  // v1 ← c1 ← s1 ;  v1 ← c2 ;  v2 独立
  const parents: Record<string, string | null> = {
    v1: null,
    c1: 'v1',
    s1: 'c1',
    c2: 'v1',
    v2: null,
  };
  const parentOf = (id: string): string | null => parents[id] ?? null;

  test('卷与其下场景同时选中，只留卷', () => {
    assert.deepEqual(dedupeNested(['v1', 's1'], parentOf), ['v1']);
  });

  test('多层嵌套（卷 / 章 / 场景）只留卷', () => {
    assert.deepEqual(dedupeNested(['v1', 'c1', 's1'], parentOf), ['v1']);
  });

  test('兄弟项全部保留，顺序不变', () => {
    assert.deepEqual(dedupeNested(['c2', 'c1'], parentOf), ['c2', 'c1']);
  });

  test('不同分支互不影响', () => {
    assert.deepEqual(dedupeNested(['c1', 'v2'], parentOf), ['c1', 'v2']);
  });

  test('重复 id 只保留一次', () => {
    assert.deepEqual(dedupeNested(['c1', 'c1'], parentOf), ['c1']);
  });

  test('未知 id 原样保留（由上层报错）', () => {
    assert.deepEqual(dedupeNested(['不存在'], parentOf), ['不存在']);
  });
});

describe('nextSelectionAfterDelete：删完选中谁', () => {
  const order = ['a', 'b', 'c', 'd'];

  test('选中项之后有存活项 → 选后面最近的一个', () => {
    assert.equal(nextSelectionAfterDelete(order, new Set(['b']), 'b'), 'c');
  });

  test('删的是最后一项 → 往前找', () => {
    assert.equal(nextSelectionAfterDelete(order, new Set(['d']), 'd'), 'c');
  });

  test('连续范围被删 → 跳过它们选下一个', () => {
    assert.equal(nextSelectionAfterDelete(order, new Set(['b', 'c']), 'b'), 'd');
  });

  test('全被删 → null', () => {
    assert.equal(nextSelectionAfterDelete(order, new Set(order), 'b'), null);
  });

  test('连续删除时焦点一路往下走', () => {
    // 删 b 后选 c；再删 c 后选 d
    const afterFirst = nextSelectionAfterDelete(order, new Set(['b']), 'b');
    assert.equal(afterFirst, 'c');
    const afterSecond = nextSelectionAfterDelete(order, new Set(['b', 'c']), 'c');
    assert.equal(afterSecond, 'd');
  });

  test('当前项为空 → 选第一个存活的', () => {
    assert.equal(nextSelectionAfterDelete(order, new Set(['a']), null), 'b');
  });

  test('当前项不在可见顺序里（祖先被折叠）→ 从头选第一个存活的', () => {
    // 这是边界情况：当前文档被折叠隐藏时，"它之后"没有意义。
    // 规则定为「退回列表开头」，比从末尾往前跳更符合自顶向下的阅读方向。
    assert.equal(nextSelectionAfterDelete(order, new Set(['a']), '不在列表里'), 'b');
  });
});

describe('describeDeleteSummary：确认框文案数据', () => {
  test('汇总项数、下级数与总字数', () => {
    const s = describeDeleteSummary([
      target({ id: 'v', kind: 'volume', descendants: 4, descendantWords: 1200 }),
      target({ id: 's', words: 30 }),
    ]);
    assert.equal(s.count, 2);
    assert.equal(s.descendants, 4);
    assert.equal(s.words, 1230);
  });
});
