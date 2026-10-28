/**
 * 撤销/重做历史测试（G3）。
 *
 * 这是纯内存逻辑，可以直接验证栈行为：
 * 顺序、上限、失败回滚、重做栈清空时机。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { UndoHistory } from '../../web/src/components/graph/history.ts';

/** 造一个记录调用顺序的假历史项 */
function entry(
  label: string,
  log: string[],
  opts: { failUndo?: boolean; failRedo?: boolean } = {},
) {
  return {
    label,
    undo: async () => {
      if (opts.failUndo) throw new Error('undo failed');
      log.push(`undo:${label}`);
    },
    redo: async () => {
      if (opts.failRedo) throw new Error('redo failed');
      log.push(`redo:${label}`);
    },
  };
}

describe('撤销与重做', () => {
  test('空历史不能撤销/重做', async () => {
    const h = new UndoHistory();
    assert.equal(h.canUndo, false);
    assert.equal(h.canRedo, false);
    assert.equal(await h.undo(), null);
    assert.equal(await h.redo(), null);
  });

  test('按后进先出撤销', async () => {
    const h = new UndoHistory();
    const log: string[] = [];
    h.push(entry('A', log));
    h.push(entry('B', log));

    assert.equal(await h.undo(), 'B');
    assert.equal(await h.undo(), 'A');
    assert.deepEqual(log, ['undo:B', 'undo:A']);
    assert.equal(h.canUndo, false);
    assert.equal(h.canRedo, true);
  });

  test('重做按原顺序', async () => {
    const h = new UndoHistory();
    const log: string[] = [];
    h.push(entry('A', log));
    h.push(entry('B', log));
    await h.undo();
    await h.undo();

    assert.equal(await h.redo(), 'A');
    assert.equal(await h.redo(), 'B');
    assert.deepEqual(log, ['undo:B', 'undo:A', 'redo:A', 'redo:B']);
  });

  test('新操作清空重做栈', async () => {
    const h = new UndoHistory();
    const log: string[] = [];
    h.push(entry('A', log));
    await h.undo();
    assert.equal(h.canRedo, true);

    h.push(entry('B', log));
    assert.equal(h.canRedo, false, '推入新步骤后重做栈应清空');
    assert.equal(await h.redo(), null);
  });

  test('undoLabel / redoLabel 反映栈顶', async () => {
    const h = new UndoHistory();
    const log: string[] = [];
    h.push(entry('新增关系', log));
    assert.equal(h.undoLabel, '新增关系');
    assert.equal(h.redoLabel, null);

    await h.undo();
    assert.equal(h.undoLabel, null);
    assert.equal(h.redoLabel, '新增关系');
  });

  test('超过上限时丢弃最旧的步骤', async () => {
    const h = new UndoHistory();
    const log: string[] = [];
    for (let i = 0; i < 55; i++) h.push(entry(`S${i}`, log));

    // 只能撤销 50 步
    let count = 0;
    while (h.canUndo) {
      await h.undo();
      count++;
      if (count > 60) break;
    }
    assert.equal(count, 50, `应只能撤销 50 步，实际 ${count}`);
    // 最早被丢弃的是 S0..S4
    assert.ok(!log.includes('undo:S0'), '最旧的步骤应已被丢弃');
    assert.ok(log.includes('undo:S54'));
  });

  test('撤销失败时该步留在栈上，修好后可再撤销', async () => {
    const h = new UndoHistory();
    const log: string[] = [];
    let shouldFail = true;

    h.push(entry('A', log));
    h.push({
      label: '可能失败的步骤',
      undo: async () => {
        if (shouldFail) throw new Error('undo failed');
        log.push('undo:fixed');
      },
      redo: async () => {},
    });

    await assert.rejects(() => h.undo(), /undo failed/);
    assert.equal(h.undoLabel, '可能失败的步骤', '失败的步骤应仍在栈顶');
    assert.equal(h.canRedo, false, '失败不应产生可重做项');

    // 条件修好后，同一步骤应能正常撤销
    shouldFail = false;
    assert.equal(await h.undo(), '可能失败的步骤');
    assert.deepEqual(log, ['undo:fixed']);
    assert.equal(h.canUndo, true, '还应有 A 可撤销');
  });

  test('重做失败时该步留在重做栈上', async () => {
    const h = new UndoHistory();
    const log: string[] = [];
    h.push(entry('A', log, { failRedo: true }));
    await h.undo();

    await assert.rejects(() => h.redo(), /redo failed/);
    assert.equal(h.redoLabel, 'A', '失败的重做项应仍在重做栈');
  });

  test('clear 清空两个栈', async () => {
    const h = new UndoHistory();
    const log: string[] = [];
    h.push(entry('A', log));
    await h.undo();
    h.clear();
    assert.equal(h.canUndo, false);
    assert.equal(h.canRedo, false);
  });

  test('执行 undo 期间不会把新步骤记进历史', async () => {
    const h = new UndoHistory();
    const log: string[] = [];
    let pushedDuringUndo = false;

    h.push({
      label: 'A',
      undo: async () => {
        // 模拟「撤销过程中又触发了一次 push」
        h.push(entry('不该记录', log));
        pushedDuringUndo = true;
      },
      redo: async () => {},
    });

    await h.undo();
    assert.equal(pushedDuringUndo, true);
    assert.equal(h.canUndo, false, '撤销过程中的 push 应被忽略');
  });
});
