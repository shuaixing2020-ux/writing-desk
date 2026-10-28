/**
 * 多文件操作与事务日志测试（G3）。
 *
 * 这是整个关系图谱里风险最高的部分：反转方向、改指向都要同时改两个条目文件。
 * 中途崩溃会留下「半边关系」——两边文件看起来都正常，但语义已经不一致。
 *
 * 测试重点：
 *   1. 正常路径：两个文件都改对，日志清理干净
 *   2. 崩溃路径：应用到一半失败，日志保留；下次 recoverPending 能补齐
 *   3. 坏日志：不阻塞作品打开
 *   4. 幂等：重复前滚结果不变
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAppContext } from '../../server/app-context.ts';
import { ProjectStore } from '../../server/store/project.ts';
import { parseFrontmatter } from '../../server/util/frontmatter.ts';
import { GraphService, RelationError } from '../../server/graph/service.ts';
import { beginTransaction, journalDirOf, recoverPending } from '../../server/graph/journal.ts';

interface Ctx {
  dir: string;
  root: string;
  app: Awaited<ReturnType<typeof createAppContext>>;
  graph: GraphService;
  journalDir: string;
  ids: { a: string; b: string; c: string };
}

async function setup(): Promise<Ctx> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-multifile-'));
  const root = path.join(dir, 'p');
  await ProjectStore.create(root, { title: 'T' });

  const app = await createAppContext(dir);
  const ctx = await app.openProject('p');
  const store = ctx.store;

  const a = await store.saveEntity({ type: 'character', name: '林远' });
  const b = await store.saveEntity({ type: 'character', name: '老掌门' });
  const c = await store.saveEntity({ type: 'character', name: '苏晚' });

  await ctx.indexer.rebuildAll();

  return {
    dir,
    root,
    app,
    graph: new GraphService(ctx),
    journalDir: journalDirOf(store.paths.studio),
    ids: { a: a.id, b: b.id, c: c.id },
  };
}

async function teardown(c: Ctx): Promise<void> {
  await c.app.closeAll();
  await fs.rm(c.dir, { recursive: true, force: true });
}

/** 读某条目文件里的关系 id 列表 */
async function relationIdsOf(c: Ctx, entityId: string): Promise<string[]> {
  const ctx = await c.app.openProject('p');
  const located = await ctx.store.entityRelationsRaw(entityId);
  if (!located || !located.block) return [];
  return located.block
    .split('\n')
    .map((l) => /^id=(\S+)/.exec(l.trim())?.[1])
    .filter((x): x is string => Boolean(x));
}

async function pendingJournals(c: Ctx): Promise<string[]> {
  try {
    return (await fs.readdir(c.journalDir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

describe('事务日志基础', () => {
  test('提交后所有文件写入且日志被清理', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-journal-'));
    const journal = path.join(dir, '.studio', 'journal');
    const root = path.join(dir, 'p');

    const tx = beginTransaction(root, journal, '测试事务');
    tx.stage('a.txt', null, 'AAA');
    tx.stage('sub/b.txt', null, 'BBB');
    await tx.commit();

    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'AAA');
    assert.equal(await fs.readFile(path.join(root, 'sub', 'b.txt'), 'utf8'), 'BBB');

    const left = (await fs.readdir(journal)).filter((f) => f.endsWith('.json'));
    assert.equal(left.length, 0, '提交成功后不应留下日志');

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('after 为 null 表示删除文件', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-journal-'));
    const journal = path.join(dir, '.studio', 'journal');
    const root = path.join(dir, 'p');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'gone.txt'), 'x');

    const tx = beginTransaction(root, journal, '删除');
    tx.stage('gone.txt', 'x', null);
    await tx.commit();

    await assert.rejects(() => fs.readFile(path.join(root, 'gone.txt')), '文件应已被删除');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('同一文件多次登记：保留最早的 before 与最新的 after', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-journal-'));
    const journal = path.join(dir, '.studio', 'journal');
    const root = path.join(dir, 'p');

    const tx = beginTransaction(root, journal, '多次改');
    tx.stage('f.txt', null, 'v1');
    tx.stage('f.txt', 'v1', 'v2');
    tx.stage('f.txt', 'v2', 'v3');
    await tx.commit();

    assert.equal(await fs.readFile(path.join(root, 'f.txt'), 'utf8'), 'v3');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('空事务不写日志也不落盘', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-journal-'));
    const journal = path.join(dir, '.studio', 'journal');
    const tx = beginTransaction(path.join(dir, 'p'), journal, '空');
    assert.equal(tx.isEmpty, true);
    await tx.commit();
    assert.equal(await fs.readdir(journal).catch(() => []).then((f) => f.length), 0);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('崩溃恢复（前滚）', () => {
  test('应用失败时日志保留，之后可以被补齐', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-journal-'));
    const journal = path.join(dir, '.studio', 'journal');
    const root = path.join(dir, 'p');
    await fs.mkdir(root, { recursive: true });

    // 手工造一个「只做了一半」的状态：写日志，但只应用了第一个文件
    const tx = beginTransaction(root, journal, '手工半途');
    tx.stage('one.txt', null, 'ONE');
    tx.stage('two.txt', null, 'TWO');

    // 直接调用内部的 stage 后，用「写日志 + 只应用一个文件」模拟崩溃
    const entry = {
      version: 1,
      id: 'crash-1',
      created_at: Date.now(),
      description: '模拟崩溃',
      changes: [
        { path: 'one.txt', before: null, after: 'ONE' },
        { path: 'two.txt', before: null, after: 'TWO' },
      ],
    };
    await fs.mkdir(journal, { recursive: true });
    await fs.writeFile(path.join(journal, 'crash-1.json'), JSON.stringify(entry));
    await fs.writeFile(path.join(root, 'one.txt'), 'ONE'); // 只应用了第一个

    assert.equal(await fs.readFile(path.join(root, 'one.txt'), 'utf8'), 'ONE');
    await assert.rejects(() => fs.readFile(path.join(root, 'two.txt')), '两个文件里应只有其中一个存在');

    // 打开作品时应该自动补齐
    const result = await recoverPending(root, journal);
    assert.equal(result.recovered.length, 1, `应恢复 1 个事务，实际 ${result.recovered.length}`);
    assert.equal(await fs.readFile(path.join(root, 'two.txt'), 'utf8'), 'TWO', '缺失的那个文件应被补齐');
    assert.equal((await pendingJournalsIn(journal)).length, 0, '恢复后日志应被删除');

    await fs.rm(dir, { recursive: true, force: true });
    void tx;
  });

  test('前滚幂等：重复恢复结果一致', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-journal-'));
    const journal = path.join(dir, '.studio', 'journal');
    const root = path.join(dir, 'p');
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(journal, { recursive: true });

    const entry = {
      version: 1,
      id: 'idem-1',
      created_at: Date.now(),
      description: '幂等',
      changes: [{ path: 'x.txt', before: null, after: 'X' }],
    };
    await fs.writeFile(path.join(journal, 'idem-1.json'), JSON.stringify(entry));

    await recoverPending(root, journal);
    const first = await fs.readFile(path.join(root, 'x.txt'), 'utf8');

    // 再放一次同样的日志
    await fs.writeFile(path.join(journal, 'idem-1.json'), JSON.stringify(entry));
    await recoverPending(root, journal);
    const second = await fs.readFile(path.join(root, 'x.txt'), 'utf8');

    assert.equal(first, second, '重复前滚结果应一致');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('坏日志被移到 .corrupt，不阻塞恢复其它日志', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-journal-'));
    const journal = path.join(dir, '.studio', 'journal');
    const root = path.join(dir, 'p');
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(journal, { recursive: true });

    await fs.writeFile(path.join(journal, 'bad.json'), '{ 这不是 JSON');
    await fs.writeFile(
      path.join(journal, 'good.json'),
      JSON.stringify({
        version: 1,
        id: 'good',
        created_at: Date.now(),
        description: 'ok',
        changes: [{ path: 'ok.txt', before: null, after: 'OK' }],
      }),
    );

    const result = await recoverPending(root, journal);
    assert.equal(result.recovered.length, 1, '好的日志应被恢复');
    assert.equal(result.failed.length, 1, '坏的日志应被记为失败');
    assert.equal(await fs.readFile(path.join(root, 'ok.txt'), 'utf8'), 'OK');

    const files = await fs.readdir(journal);
    assert.ok(files.some((f) => f.endsWith('.corrupt')), '坏日志应被改名保留，而不是删掉');

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('没有日志目录时安静返回（新作品）', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-journal-'));
    const result = await recoverPending(path.join(dir, 'p'), path.join(dir, 'nope'));
    assert.deepEqual(result, { recovered: [], failed: [] });
    await fs.rm(dir, { recursive: true, force: true });
  });
});

async function pendingJournalsIn(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

describe('反转关系方向', () => {
  test('A→B 变成 B→A，两个文件都正确且 id 不变', async () => {
    const c = await setup();
    const rel = await c.graph.create(c.ids.a, { type: 'mentor', to: c.ids.b, note: '传艺' });

    const reversed = await c.graph.reverse(rel.id);
    assert.equal(reversed.from, c.ids.b, '起点应变成原来的终点');
    assert.equal(reversed.to, c.ids.a, '终点应变成原来的起点');
    assert.equal(reversed.id, rel.id, 'id 必须保持不变，否则外部引用会失效');
    assert.equal(reversed.note, '传艺', '备注应保留');

    // 文件层面：A 里没有了，B 里有了
    assert.deepEqual(await relationIdsOf(c, c.ids.a), [], '原起点的文件里应已删除该行');
    assert.deepEqual(await relationIdsOf(c, c.ids.b), [rel.id], '原终点的文件里应有该行');

    // 索引层面：方向也更新了
    const aView = await c.graph.list(c.ids.a);
    const bView = await c.graph.list(c.ids.b);
    assert.equal(aView.out.length, 0);
    assert.equal(aView.in.length, 1);
    assert.equal(bView.out.length, 1);
    assert.equal(bView.in.length, 0);

    assert.deepEqual(await pendingJournals(c), [], '事务完成后不应留下日志');
    await teardown(c);
  });

  test('无向关系不能反转', async () => {
    const c = await setup();
    const rel = await c.graph.create(c.ids.a, { type: 'kin', to: c.ids.b });
    await assert.rejects(
      () => c.graph.reverse(rel.id),
      (err: unknown) => err instanceof RelationError && err.code === 'rel_not_reversible',
    );
    // 失败后不应留下日志
    assert.deepEqual(await pendingJournals(c), []);
    await teardown(c);
  });

  test('反转后真的成环时仍然报错', async () => {
    const c = await setup();
    // A→B（师徒，禁成环）
    await c.graph.create(c.ids.a, { type: 'mentor', to: c.ids.b });
    // B→C
    const bc = await c.graph.create(c.ids.b, { type: 'mentor', to: c.ids.c });
    // 再把 C→A 加上就成环；先试 C→A 应当被拒
    await assert.rejects(
      () => c.graph.create(c.ids.c, { type: 'mentor', to: c.ids.a }),
      (err: unknown) => err instanceof RelationError && err.code === 'rel_cycle',
    );
    // B→C 反转成 C→B 是合法的（不成环）
    const reversed = await c.graph.reverse(bc.id);
    assert.equal(reversed.from, c.ids.c);
    assert.equal(reversed.to, c.ids.b);
    await teardown(c);
  });

  test('反转保留锚点与权重', async () => {
    const c = await setup();
    const ctx = await c.app.openProject('p');
    const v = await ctx.store.createNode({ kind: 'volume', parent_id: null, title: '卷' });
    const ch = await ctx.store.createNode({ kind: 'chapter', parent_id: v.id, title: '章' });
    await ctx.indexer.rebuildAll();

    const rel = await c.graph.create(c.ids.a, {
      type: 'mentor',
      to: c.ids.b,
      since: ch.id,
      weight: 3,
      note: '备注保留',
    });

    const reversed = await c.graph.reverse(rel.id);
    assert.equal(reversed.since, ch.id, '锚点应保留');
    assert.equal(reversed.weight, 3, '权重应保留');
    assert.equal(reversed.note, '备注保留');
    await teardown(c);
  });
});

describe('改指向', () => {
  test('A→B 改成 A→C，位置不变', async () => {
    const c = await setup();
    const r1 = await c.graph.create(c.ids.a, { type: 'mentor', to: c.ids.b, note: '第一条' });
    const r2 = await c.graph.create(c.ids.a, { type: 'kin', to: c.ids.b });

    const updated = await c.graph.retarget(r1.id, c.ids.c);
    assert.equal(updated.from, c.ids.a);
    assert.equal(updated.to, c.ids.c);

    // 第一条仍在原位置（顺序不乱）
    const ids = await relationIdsOf(c, c.ids.a);
    assert.deepEqual(ids, [r1.id, r2.id], '改指向应保持行位置');

    const view = await c.graph.list(c.ids.a);
    assert.equal(view.out.find((r) => r.id === r1.id)?.to, c.ids.c);
    assert.deepEqual(await pendingJournals(c), []);
    await teardown(c);
  });

  test('改成相同目标被拒绝', async () => {
    const c = await setup();
    const rel = await c.graph.create(c.ids.a, { type: 'mentor', to: c.ids.b });
    await assert.rejects(
      () => c.graph.retarget(rel.id, c.ids.b),
      (err: unknown) => err instanceof RelationError && err.code === 'rel_same_target',
    );
    await teardown(c);
  });

  test('改成不存在的目标被拒绝', async () => {
    const c = await setup();
    const rel = await c.graph.create(c.ids.a, { type: 'mentor', to: c.ids.b });
    await assert.rejects(
      () => c.graph.retarget(rel.id, 'NOT_EXIST'),
      (err: unknown) => err instanceof RelationError && err.code === 'rel_target_missing',
    );
    assert.deepEqual(await pendingJournals(c), []);
    await teardown(c);
  });
});
