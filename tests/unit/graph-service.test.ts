/**
 * GraphService 测试（G1-2）。
 *
 * 覆盖八条校验规则、写入后文件完整性、并发、dry_run、悬空与 lint。
 * 这些测试直接操作真实文件，不走 mock。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAppContext } from '../../server/app-context.ts';
import { ProjectStore } from '../../server/store/project.ts';
import { writeFileAtomic } from '../../server/util/atomic.ts';
import { parseFrontmatter, stringifyScene } from '../../server/util/frontmatter.ts';
import { GraphService, RelationError } from '../../server/graph/service.ts';

interface Ctx {
  dir: string;
  root: string;
  pid: string;
  app: Awaited<ReturnType<typeof createAppContext>>;
  graph: GraphService;
  entities: { a: string; b: string; f: string; place: string; event: string };
  docs: { c1: string; c2: string };
}

async function setup(): Promise<Ctx> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-graphsvc-'));
  const root = path.join(dir, 'p');
  await ProjectStore.create(root, { title: 'T' });

  const app = await createAppContext(dir);
  const ctx = await app.openProject('p');

  const store = ctx.store;
  const v = await store.createNode({ kind: 'volume', parent_id: null, title: '第一卷' });
  const c1 = await store.createNode({ kind: 'chapter', parent_id: v.id, title: '第一章' });
  const c2 = await store.createNode({ kind: 'chapter', parent_id: v.id, title: '第二章' });

  const a = await store.saveEntity({ type: 'character', name: '林远' });
  const b = await store.saveEntity({ type: 'character', name: '老掌门' });
  const f = await store.saveEntity({ type: 'faction', name: '青云门' });
  const place = await store.saveEntity({ type: 'place', name: '山门' });
  const event = await store.saveEntity({ type: 'event', name: '入山' });

  // 重建索引，让关系索引就位
  await ctx.indexer.rebuildAll();

  return {
    dir,
    root,
    pid: 'p',
    app,
    graph: new GraphService(ctx),
    entities: { a: a.id, b: b.id, f: f.id, place: place.id, event: event.id },
    docs: { c1: c1.id, c2: c2.id },
  };
}

async function teardown(c: Ctx): Promise<void> {
  await c.app.closeAll();
  await fs.rm(c.dir, { recursive: true, force: true });
}

async function expectError(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    assert.fail(`应抛出 ${code}，但没有报错`);
  } catch (err) {
    assert.ok(err instanceof RelationError, `应为 RelationError，实际 ${(err as Error).name}: ${(err as Error).message}`);
    assert.equal((err as RelationError).code, code, `错误码不符：${(err as Error).message}`);
  }
}

describe('校验规则', () => {
  test('rel_type_unknown：未知类型', async () => {
    const c = await setup();
    await expectError(() => c.graph.create(c.entities.a, { type: '不存在的类型', to: c.entities.b }), 'rel_type_unknown');
    await teardown(c);
  });

  test('rel_self_loop：指向自己', async () => {
    const c = await setup();
    await expectError(() => c.graph.create(c.entities.a, { type: 'kin', to: c.entities.a }), 'rel_self_loop');
    await teardown(c);
  });

  test('rel_target_missing：目标不存在', async () => {
    const c = await setup();
    await expectError(() => c.graph.create(c.entities.a, { type: 'kin', to: 'NOT_EXIST' }), 'rel_target_missing');
    await teardown(c);
  });

  test('rel_endpoint_invalid：类型不支持该组合', async () => {
    const c = await setup();
    // 师徒只能角色→角色
    await expectError(() => c.graph.create(c.entities.a, { type: 'mentor', to: c.entities.f }), 'rel_endpoint_invalid');
    await teardown(c);
  });

  test('rel_anchor_missing：锚点文档不存在', async () => {
    const c = await setup();
    await expectError(
      () => c.graph.create(c.entities.a, { type: 'kin', to: c.entities.b, since: 'NO_SUCH_DOC' }),
      'rel_anchor_missing',
    );
    await teardown(c);
  });

  test('rel_range_invalid：结束早于起始', async () => {
    const c = await setup();
    await expectError(
      () => c.graph.create(c.entities.a, { type: 'kin', to: c.entities.b, since: c.docs.c2, until: c.docs.c1 }),
      'rel_range_invalid',
    );
    await teardown(c);
  });

  test('rel_duplicate：同类型同端点无区间', async () => {
    const c = await setup();
    await c.graph.create(c.entities.a, { type: 'kin', to: c.entities.b });
    await expectError(() => c.graph.create(c.entities.a, { type: 'kin', to: c.entities.b }), 'rel_duplicate');
    await teardown(c);
  });

  test('rel_cycle：导致类型成环', async () => {
    const c = await setup();
    const e1 = await c.app.openProject('p').then((x) => x.store.saveEntity({ type: 'event', name: '事件甲' }));
    const e2 = await c.app.openProject('p').then((x) => x.store.saveEntity({ type: 'event', name: '事件乙' }));
    await c.app.openProject('p').then((x) => x.indexer.rebuildAll());

    await c.graph.create(e1.id, { type: 'causes', to: e2.id });
    await expectError(() => c.graph.create(e2.id, { type: 'causes', to: e1.id }), 'rel_cycle');

    await teardown(c);
  });
});

describe('成功路径', () => {
  test('创建关系后可在 list 中读到（出向与入向）', async () => {
    const c = await setup();
    const rel = await c.graph.create(c.entities.a, { type: 'mentor', to: c.entities.b, note: '传艺' });

    const aView = await c.graph.list(c.entities.a);
    assert.equal(aView.out.length, 1);
    assert.equal(aView.out[0].id, rel.id);
    assert.equal(aView.out[0].to_name, '老掌门');
    assert.equal(aView.out[0].note, '传艺');

    const bView = await c.graph.list(c.entities.b);
    assert.equal(bView.in.length, 1);
    assert.equal(bView.in[0].from, c.entities.a);

    await teardown(c);
  });

  test('中文类型名可用', async () => {
    const c = await setup();
    const rel = await c.graph.create(c.entities.a, { type: '师徒', to: c.entities.b });
    assert.equal(rel.type, 'mentor', '应规范化为 key');
    await teardown(c);
  });

  test('锚点与备注正确落盘', async () => {
    const c = await setup();
    await c.graph.create(c.entities.a, {
      type: 'member_of',
      to: c.entities.f,
      since: c.docs.c1,
      note: '入门',
    });

    const ctx = await c.app.openProject('p');
    const located = await ctx.store.entityRelationsRaw(c.entities.a);
    assert.ok(located?.block.includes('member_of'));
    assert.ok(located?.block.includes(`since=${c.docs.c1}`));
    assert.ok(located?.block.includes('入门'));

    await teardown(c);
  });

  test('更新关系：改备注与区间，行位置不变', async () => {
    const c = await setup();
    const r1 = await c.graph.create(c.entities.a, { type: 'kin', to: c.entities.b, note: '原备注' });
    const r2 = await c.graph.create(c.entities.a, { type: 'mentor', to: c.entities.b });

    await c.graph.update(r1.id, { note: '新备注', until: c.docs.c2 });

    const ctx = await c.app.openProject('p');
    const block = (await ctx.store.entityRelationsRaw(c.entities.a))!.block;
    const lines = block.split('\n').filter((l) => l.trim());
    assert.equal(lines[0].includes('新备注'), true, '第一条应为更新后的关系（位置不变）');
    assert.equal(lines[0].includes(`until=${c.docs.c2}`), true);
    assert.equal(lines[1].includes(r2.id), true, '第二条位置不应变');

    await teardown(c);
  });

  test('删除关系后不再出现在列表里', async () => {
    const c = await setup();
    const rel = await c.graph.create(c.entities.a, { type: 'kin', to: c.entities.b });
    const before = await c.graph.list(c.entities.a);
    assert.equal(before.out.length, 1);

    await c.graph.remove(rel.id);
    const after = await c.graph.list(c.entities.a);
    assert.equal(after.out.length, 0);

    await teardown(c);
  });
});

describe('写入完整性', () => {
  test('关系写入不碰正文与其他 frontmatter 键', async () => {
    const c = await setup();
    const ctx = await c.app.openProject('p');

    // 给条目加自定义字段与描述
    const located = await ctx.store.entityRelationsRaw(c.entities.a);
    const abs = located!.abs;
    await writeFileAtomic(
      abs,
      stringifyScene(
        { id: c.entities.a, type: 'character', name: '林远', aliases: ['小林'], 'x-demo': 'keep', 身份: '弟子' },
        '主角的描述正文。',
      ),
    );

    await c.graph.create(c.entities.a, { type: 'kin', to: c.entities.b });

    const raw = await fs.readFile(abs, 'utf8');
    const { data, body } = parseFrontmatter(raw);
    assert.equal(body, '主角的描述正文。', '正文被改动');
    assert.equal(String(data['x-demo']), 'keep', 'x- 键被丢弃');
    assert.equal(String(data['身份']), '弟子', '自定义字段被丢弃');
    assert.deepEqual(data.aliases, ['小林'], '别名被改动');
    assert.ok(String(data.relations).includes('kin'), '关系未写入');

    await teardown(c);
  });

  test('无法解析的 raw 行在写入后原样保留', async () => {
    const c = await setup();
    const ctx = await c.app.openProject('p');
    const located = await ctx.store.entityRelationsRaw(c.entities.a);
    const abs = located!.abs;

    await writeFileAtomic(
      abs,
      stringifyScene(
        {
          id: c.entities.a,
          type: 'character',
          name: '林远',
          // 含注释、坏行、合法关系
          relations: '# 注释\nid=r_bad 这一行写错了\nid=r_ok kin -> TARGET_NOT_EXIST',
        },
        '正文',
      ),
    );

    await c.graph.create(c.entities.a, { type: 'kin', to: c.entities.b });

    const block = (await ctx.store.entityRelationsRaw(c.entities.a))!.block;
    assert.ok(block.includes('# 注释'), '注释被丢弃');
    assert.ok(block.includes('id=r_bad 这一行写错了'), '坏行被丢弃或改写');

    await teardown(c);
  });

  test('关系全删后 frontmatter 里不留空的 relations 键', async () => {
    const c = await setup();
    const rel = await c.graph.create(c.entities.a, { type: 'kin', to: c.entities.b });
    await c.graph.remove(rel.id);

    const ctx = await c.app.openProject('p');
    const raw = await fs.readFile((await ctx.store.entityRelationsRaw(c.entities.a))!.abs, 'utf8');
    assert.ok(!/^relations:\s*\|?\s*$/m.test(raw), `空的 relations 键应被移除：\n${raw}`);

    await teardown(c);
  });
});

describe('并发与 dry_run', () => {
  test('并发创建 20 条关系：全部保留且文件未损坏', async () => {
    const c = await setup();
    const ctx = await c.app.openProject('p');

    // 建 20 个不同类型组合的目标（角色→角色用 kin，避免重复）
    const targets: string[] = [];
    for (let i = 0; i < 20; i++) {
      targets.push((await ctx.store.saveEntity({ type: 'character', name: `角色${i}` })).id);
    }
    await ctx.indexer.rebuildAll();

    await Promise.all(
      targets.map((t) => c.graph.create(c.entities.a, { type: 'kin', to: t })),
    );

    const view = await c.graph.list(c.entities.a);
    assert.equal(view.out.length, 20, `应保留 20 条关系，实际 ${view.out.length}`);

    // 文件仍可解析
    const raw = await fs.readFile((await ctx.store.entityRelationsRaw(c.entities.a))!.abs, 'utf8');
    const parsed = parseFrontmatter(raw);
    assert.ok(typeof parsed.data.relations === 'string');
    assert.equal(parsed.data.relations!.split('\n').filter((l) => l.trim()).length, 20);

    await teardown(c);
  });

  test('dry_run 不写文件、不进索引', async () => {
    const c = await setup();
    const ctx = await c.app.openProject('p');
    const before = await fs.readFile((await ctx.store.entityRelationsRaw(c.entities.a))!.abs, 'utf8');

    const preview = await c.graph.create(c.entities.a, { type: 'kin', to: c.entities.b }, { dryRun: true });
    assert.ok(preview.id, 'dry_run 也应返回一个预演的 id');

    const after = await fs.readFile((await ctx.store.entityRelationsRaw(c.entities.a))!.abs, 'utf8');
    assert.equal(after, before, 'dry_run 不应改动文件');

    const view = await c.graph.list(c.entities.a);
    assert.equal(view.out.length, 0, 'dry_run 不应进索引');

    await teardown(c);
  });
});

describe('悬空与 lint', () => {
  test('目标条目删除后 list 标记 dangling，lint 报出', async () => {
    const c = await setup();
    const ctx = await c.app.openProject('p');

    await c.graph.create(c.entities.a, { type: 'kin', to: c.entities.b });

    // 删除目标条目
    await ctx.store.deleteEntity(c.entities.b);

    const view = await c.graph.list(c.entities.a);
    assert.equal(view.out.length, 1);
    assert.equal(view.out[0].dangling, true, '目标已删除，应标记 dangling');

    const issues = await c.graph.lint();
    const dangling = issues.filter((i) => i.code === 'relation_dangling_target');
    assert.equal(dangling.length, 1, `应报告 1 条悬空，实际 ${dangling.length}`);

    await teardown(c);
  });

  test('lint 报告无法解析的行与未知类型', async () => {
    const c = await setup();
    const ctx = await c.app.openProject('p');
    const abs = (await ctx.store.entityRelationsRaw(c.entities.a))!.abs;

    await writeFileAtomic(
      abs,
      stringifyScene(
        {
          id: c.entities.a,
          type: 'character',
          name: '林远',
          relations: 'id=r_bad 写错的行\nid=r_x 不存在的类型 -> NOT_EXIST',
        },
        '',
      ),
    );

    const issues = await c.graph.lint();
    assert.ok(issues.some((i) => i.code === 'relation_unparsable_line'), '应报告坏行');
    assert.ok(issues.some((i) => i.code === 'relation_unknown_type'), '应报告未知类型');

    await teardown(c);
  });

  test('lint 报告锚点文档不存在', async () => {
    const c = await setup();
    const ctx = await c.app.openProject('p');
    const abs = (await ctx.store.entityRelationsRaw(c.entities.a))!.abs;

    await writeFileAtomic(
      abs,
      stringifyScene(
        {
          id: c.entities.a,
          type: 'character',
          name: '林远',
          relations: `id=r_1 kin -> ${c.entities.b} | since=DELETED_DOC_0001`,
        },
        '',
      ),
    );

    const issues = await c.graph.lint();
    assert.ok(issues.some((i) => i.code === 'relation_anchor_missing'), '应报告锚点缺失');

    await teardown(c);
  });
});

// ─────────────────────── G1' 修订：owner + direction（A3） ───────────────────────

describe('发起方与方向（A3）', () => {
  test('在林远页面建「老掌门是林远的师父」：写进林远文件，方向为 in', async () => {
    const c = await setup();
    try {
      // owner = 林远(a)，other = 老掌门(b)，方向 in 表示对方是起点
      const rel = await c.graph.create(c.entities.a, {
        type: 'mentor',
        other: c.entities.b,
        direction: 'in',
      });
      assert.equal(rel.from, c.entities.b, '起点应是老掌门');
      assert.equal(rel.to, c.entities.a, '终点应是林远');

      // 林远文件里应有一行 `<-`，老掌门文件里不该有这条关系
      const ctx = await c.app.openProject('p');
      const aRaw = await ctx.store.entityRelationsRaw(c.entities.a);
      const bRaw = await ctx.store.entityRelationsRaw(c.entities.b);
      assert.match(aRaw!.block, /<-/);
      assert.ok(!bRaw || !bRaw.block.includes(rel.id), '对方文件不该被改动');
    } finally {
      await c.app.closeAll();
      await fs.rm(c.dir, { recursive: true, force: true });
    }
  });

  test('两个方向的建法得到同一条规范关系', async () => {
    const c = await setup();
    try {
      // 老掌门为 owner、方向 out
      const r1 = await c.graph.create(c.entities.b, {
        type: 'mentor',
        other: c.entities.a,
        direction: 'out',
      });
      assert.equal(r1.from, c.entities.b);
      assert.equal(r1.to, c.entities.a);

      // 同一个关系换 owner 建会被判重复
      await assert.rejects(
        () =>
          c.graph.create(c.entities.a, {
            type: 'mentor',
            other: c.entities.b,
            direction: 'in',
          }),
        (err: unknown) => err instanceof RelationError && err.code === 'rel_duplicate',
      );
    } finally {
      await c.app.closeAll();
      await fs.rm(c.dir, { recursive: true, force: true });
    }
  });

  test('旧契约 { to } 仍然有效（发起方是起点）', async () => {
    const c = await setup();
    try {
      const rel = await c.graph.create(c.entities.a, { type: 'mentor', to: c.entities.b });
      assert.equal(rel.from, c.entities.a);
      assert.equal(rel.to, c.entities.b);
    } finally {
      await c.app.closeAll();
      await fs.rm(c.dir, { recursive: true, force: true });
    }
  });

  test('PATCH direction 翻转箭头，且只在原文件里改', async () => {
    const c = await setup();
    try {
      const ctx = await c.app.openProject('p');
      const rel = await c.graph.create(c.entities.a, {
        type: 'mentor',
        other: c.entities.b,
        direction: 'in', // 写在林远文件里的 `<-`
      });

      // 当前相对方向是 in；改成 out 应翻转
      const flipped = await c.graph.update(rel.id, { direction: 'out' });
      assert.equal(flipped.from, c.entities.a, '翻转后起点应变林远');
      assert.equal(flipped.to, c.entities.b);

      const aRaw = await ctx.store.entityRelationsRaw(c.entities.a);
      assert.match(aRaw!.block, /->/, '林远文件里应变成 ->');
      assert.ok(!aRaw!.block.includes('<-'), '不应再有 <-');
    } finally {
      await c.app.closeAll();
      await fs.rm(c.dir, { recursive: true, force: true });
    }
  });

  test('PATCH direction 与当前方向相同则不翻转', async () => {
    const c = await setup();
    try {
      const rel = await c.graph.create(c.entities.a, {
        type: 'mentor',
        other: c.entities.b,
        direction: 'out',
      });
      const same = await c.graph.update(rel.id, { direction: 'out' });
      assert.equal(same.from, c.entities.a);
      assert.equal(same.to, c.entities.b);
    } finally {
      await c.app.closeAll();
      await fs.rm(c.dir, { recursive: true, force: true });
    }
  });

  test('索引按方向还原规范关系：两端都能查到', async () => {
    const c = await setup();
    try {
      // 写在林远文件的 `<-` 行
      await c.graph.create(c.entities.a, {
        type: 'mentor',
        other: c.entities.b,
        direction: 'in',
      });
      const aView = await c.graph.list(c.entities.a);
      const bView = await c.graph.list(c.entities.b);
      assert.equal(aView.in.length, 1, '林远应有 1 条入向');
      assert.equal(aView.out.length, 0);
      assert.equal(bView.out.length, 1, '老掌门应有 1 条出向');
      assert.equal(bView.in.length, 0);
    } finally {
      await c.app.closeAll();
      await fs.rm(c.dir, { recursive: true, force: true });
    }
  });
});
