/**
 * 树操作单元测试（O1）。
 *
 * 大纲与思维导图共用这套操作，键盘连续按错一步就会把结构搞乱，
 * 所以每一条边界都单独立个用例：首项能不能缩进、场景层还能不能再降、
 * 提升之后排在哪、上下移到头返回什么。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createChild,
  createSibling,
  flatten,
  indent,
  kindAtDepth,
  locate,
  moveDown,
  moveUp,
  outdent,
  type Intent,
  type TNode,
} from '../../web/src/lib/tree-ops.ts';

/** 造一棵三层树：
 *  卷一
 *    章一
 *      场一
 *      场二
 *    章二
 *  卷二
 *    章三
 */
function sample(): TNode[] {
  return [
    {
      id: 'v1',
      title: '卷一',
      children: [
        {
          id: 'c1',
          title: '章一',
          children: [
            { id: 's1', title: '场一', children: [] },
            { id: 's2', title: '场二', children: [] },
          ],
        },
        { id: 'c2', title: '章二', children: [] },
      ],
    },
    {
      id: 'v2',
      title: '卷二',
      children: [{ id: 'c3', title: '章三', children: [] }],
    },
  ];
}

/** 把意图应用到树上，模拟服务端执行结果（用于验证移动落点） */
function apply(tree: TNode[], intent: Intent): void {
  if (intent.op === 'create') {
    const node: TNode = { id: `new-${Math.random().toString(36).slice(2, 7)}`, title: intent.title, children: [] };
    const list = intent.parentId ? locate(tree, intent.parentId)?.node.children : tree;
    if (list) list.splice(intent.index, 0, node);
    return;
  }
  if (intent.op === 'rename') {
    const found = locate(tree, intent.id);
    if (found) found.node.title = intent.title;
    return;
  }
  // move
  const found = locate(tree, intent.id);
  if (!found) return;
  const from = found.parent ? found.parent.children : tree;
  const at = from.indexOf(found.node);
  if (at !== -1) from.splice(at, 1);
  const to = intent.parentId ? locate(tree, intent.parentId)?.node.children : tree;
  if (to) to.splice(intent.index, 0, found.node);
}

function ids(tree: TNode[]): string[] {
  return flatten(tree).map((r) => r.node.id);
}

describe('kindAtDepth：深度决定类型', () => {
  test('0 卷 / 1 章 / 2 场景', () => {
    assert.equal(kindAtDepth(0), 'volume');
    assert.equal(kindAtDepth(1), 'chapter');
    assert.equal(kindAtDepth(2), 'scene');
  });

  test('超过三层仍按场景处理，不产生第四种类型', () => {
    assert.equal(kindAtDepth(3), 'scene');
    assert.equal(kindAtDepth(9), 'scene');
  });
});

describe('createSibling：新建同级', () => {
  test('插在当前节点后面，类型与深度一致', () => {
    const tree = sample();
    const out = createSibling(tree, 'c1');
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], { op: 'create', parentId: 'v1', index: 1, kind: 'chapter', title: '' });
  });

  test('场景的同级仍是场景', () => {
    const tree = sample();
    const out = createSibling(tree, 's1');
    assert.deepEqual(out[0], { op: 'create', parentId: 'c1', index: 1, kind: 'scene', title: '' });
  });

  test('卷的同级是卷，父为空', () => {
    const tree = sample();
    const out = createSibling(tree, 'v1');
    assert.deepEqual(out[0], { op: 'create', parentId: null, index: 1, kind: 'volume', title: '' });
  });

  test('未知 id 返回空列表', () => {
    assert.deepEqual(createSibling(sample(), '不存在'), []);
  });
});

describe('createChild：新建下级', () => {
  test('卷下新建章，插在末尾', () => {
    const tree = sample();
    const out = createChild(tree, 'v1');
    assert.deepEqual(out[0], { op: 'create', parentId: 'v1', index: 2, kind: 'chapter', title: '' });
  });

  test('章下新建场景', () => {
    const tree = sample();
    const out = createChild(tree, 'c1');
    assert.deepEqual(out[0], { op: 'create', parentId: 'c1', index: 2, kind: 'scene', title: '' });
  });

  test('场景层退化：不再往下长，改为新建同级', () => {
    const tree = sample();
    const out = createChild(tree, 's1');
    assert.deepEqual(out, createSibling(tree, 's1'));
    assert.equal(out[0].op, 'create');
    assert.equal((out[0] as { kind: string }).kind, 'scene');
  });
});

describe('indent：降一级', () => {
  test('成为上一个兄弟的最后一个子节点', () => {
    const tree = sample();
    const out = indent(tree, 'c2');
    assert.deepEqual(out, [{ op: 'move', id: 'c2', parentId: 'c1', index: 2 }]);

    apply(tree, out![0]);
    // 章二 现在挂在 章一 下、排在两个场景之后
    const c1 = locate(tree, 'c1')!.node;
    assert.deepEqual(c1.children.map((n) => n.id), ['s1', 's2', 'c2']);
  });

  test('第一个兄弟无处可降，返回 null', () => {
    assert.equal(indent(sample(), 'c1'), null);
    assert.equal(indent(sample(), 's1'), null);
    assert.equal(indent(sample(), 'v1'), null);
  });

  test('场景层不能再降（超过三层）', () => {
    assert.equal(indent(sample(), 's2'), null);
  });

  test('带子节点的节点不能降（会带着下级一起乱层）', () => {
    // 章一 有子节点，把它当作「第二个兄弟」看待
    const tree = sample();
    (tree[0].children as TNode[]).push({ id: 'c9', title: '章九', children: [{ id: 'sz', title: '场九', children: [] }] });
    assert.equal(indent(tree, 'c9'), null);
  });

  test('卷之间不能降级', () => {
    assert.equal(indent(sample(), 'v2'), null);
  });

  test('未知 id 返回 null', () => {
    assert.equal(indent(sample(), '不存在'), null);
  });
});

describe('outdent：升一级', () => {
  test('提升后成为父节点的下一个兄弟', () => {
    const tree = sample();
    // 章二 升一级 → 挂到 卷一 的父（根），排在 卷一 之后
    const out = outdent(tree, 'c2');
    assert.deepEqual(out, [{ op: 'move', id: 'c2', parentId: null, index: 1 }]);

    apply(tree, out![0]);
    assert.deepEqual(ids(tree), ['v1', 'c1', 's1', 's2', 'c2', 'v2', 'c3']);
  });

  test('最外层没有父节点，返回 null', () => {
    assert.equal(outdent(sample(), 'v1'), null);
    assert.equal(outdent(sample(), 'v2'), null);
  });

  test('场景提升后排在父节点之后', () => {
    const tree = sample();
    const out = outdent(tree, 's1');
    // 场一 的父是 章一，章一 的父是 卷一，章一 是其第 0 个子节点
    assert.deepEqual(out, [{ op: 'move', id: 's1', parentId: 'v1', index: 1 }]);
  });
});

describe('moveUp / moveDown：调整顺序', () => {
  test('上移一位', () => {
    const tree = sample();
    assert.deepEqual(moveUp(tree, 's2'), [{ op: 'move', id: 's2', parentId: 'c1', index: 0 }]);
  });

  test('已经是第一个时返回 null', () => {
    assert.equal(moveUp(sample(), 's1'), null);
    assert.equal(moveUp(sample(), 'c1'), null);
    assert.equal(moveUp(sample(), 'v1'), null);
  });

  test('下移一位', () => {
    const tree = sample();
    assert.deepEqual(moveDown(tree, 's1'), [{ op: 'move', id: 's1', parentId: 'c1', index: 1 }]);
  });

  test('已经是最后一个时返回 null', () => {
    assert.equal(moveDown(sample(), 's2'), null);
    assert.equal(moveDown(sample(), 'c2'), null);
    assert.equal(moveDown(sample(), 'v2'), null);
  });

  test('移动后顺序正确（模拟执行）', () => {
    const tree = sample();
    apply(tree, moveDown(tree, 's1')![0]);
    assert.deepEqual(locate(tree, 'c1')!.node.children.map((n) => n.id), ['s2', 's1']);
  });
});

describe('连续按键流（模拟原型里验证过的路径）', () => {
  test('Enter 新建同级 → Tab 降级 → Enter 新建同级', () => {
    const tree = sample();

    // Enter 在 章二 上新建同级
    const created = createSibling(tree, 'c2');
    apply(tree, created[0]);
    const newId = locate(tree, 'v1')!.node.children[2].id;
    assert.equal(locate(tree, 'v1')!.node.children.length, 3);

    // Tab 把新章降级到「上一个兄弟」下 —— 上一个兄弟是 章二（不是 章一）
    const indented = indent(tree, newId);
    assert.deepEqual(indented, [{ op: 'move', id: newId, parentId: 'c2', index: 0 }]);
    apply(tree, indented![0]);
    assert.equal(locate(tree, newId)!.parent?.id, 'c2');
    assert.equal(locate(tree, newId)!.depth, 2);

    // 再 Enter 新建同级：此时它在场景层，新建的也是场景
    const sibling = createSibling(tree, newId);
    assert.equal(sibling[0].op, 'create');
    assert.equal((sibling[0] as { kind: string }).kind, 'scene');
    assert.equal((sibling[0] as { parentId: string }).parentId, 'c2');
  });

  test('Shift+Tab 把刚降级的节点提回去', () => {
    const tree = sample();
    apply(tree, indent(tree, 'c2')![0]);
    const back = outdent(tree, 'c2');
    apply(tree, back![0]);
    assert.equal(locate(tree, 'c2')!.parent?.id, 'v1');
    assert.equal(locate(tree, 'c2')!.index, 1);
  });
});

describe('locate 与 flatten', () => {
  test('locate 返回正确的深度、父与下标', () => {
    const tree = sample();
    const s2 = locate(tree, 's2')!;
    assert.equal(s2.depth, 2);
    assert.equal(s2.parent?.id, 'c1');
    assert.equal(s2.index, 1);
  });

  test('flatten 按显示顺序展开', () => {
    assert.deepEqual(ids(sample()), ['v1', 'c1', 's1', 's2', 'c2', 'v2', 'c3']);
  });

  test('flatten 带出深度', () => {
    const rows = flatten(sample());
    assert.deepEqual(
      rows.map((r) => r.depth),
      [0, 1, 2, 2, 1, 0, 1],
    );
  });
});
