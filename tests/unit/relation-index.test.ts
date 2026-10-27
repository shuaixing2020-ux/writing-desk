/**
 * relation 索引表测试（G1-1）。
 *
 * 核心不变量：**索引可丢弃重建**，重建前后查询结果必须一致。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { IndexDb } from '../../server/db/index.ts';
import { ProjectStore } from '../../server/store/project.ts';
import { writeFileAtomic } from '../../server/util/atomic.ts';
import { stringifyScene } from '../../server/util/frontmatter.ts';
import { buildFixture, FIXTURE } from '../fixtures/graph/build.ts';
import { loadRelationTypes } from '../../server/graph/types.ts';
import { parseRelations, relationsOnly } from '../../server/graph/relations-format.ts';

async function indexFixture(root: string): Promise<IndexDb> {
  const db = await IndexDb.open(path.join(root, '.studio', 'test-index.sqlite'));
  const store = new ProjectStore(root);
  const types = await loadRelationTypes(root);
  const { resolveTypeKey } = await import('../../server/graph/types.ts');

  const entities = await store.listEntities();
  db.transaction(() => {
    db.clearRelations();
    for (const e of entities) {
      db.upsertEntity({ id: e.id, type: e.type, name: e.name, aliases: e.aliases });
    }
  });

  for (const e of entities) {
    const located = await store.entityRelationsRaw(e.id);
    if (!located?.block) continue;
    const rows = relationsOnly(parseRelations(located.block)).map((r) => ({
      id: r.id,
      to_id: r.to,
      type: resolveTypeKey(types, r.type) ?? r.type,
      since: r.since ?? null,
      until: r.until ?? null,
      reveal: r.reveal ?? null,
      weight: r.weight ?? null,
      note: r.note ?? '',
      extra: r.extra_props ?? null,
      line_no: null,
    }));
    db.replaceRelationsOf(e.id, rows);
  }
  return db;
}

describe('relation 表结构与读写', () => {
  test('建表成功，空库计数为 0', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-relidx-'));
    const db = await IndexDb.open(path.join(dir, 'i.sqlite'));
    assert.equal(db.countRelations(), 0);
    assert.deepEqual(db.allRelations(), []);
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('replaceRelationsOf 整体替换同一来源的关系', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-relidx-'));
    const db = await IndexDb.open(path.join(dir, 'i.sqlite'));

    db.replaceRelationsOf('A', [
      { id: 'r1', to_id: 'B', type: 'mentor', since: 'D1', until: null, reveal: null, weight: null, note: '甲', extra: null, line_no: 1 },
      { id: 'r2', to_id: 'C', type: 'ally', since: null, until: null, reveal: null, weight: 2, note: '', extra: { color: 'red' }, line_no: 2 },
    ]);
    assert.equal(db.countRelations(), 2);

    // 再次替换：旧的应全部消失
    db.replaceRelationsOf('A', [
      { id: 'r3', to_id: 'D', type: 'kin', since: null, until: null, reveal: null, weight: null, note: '', extra: null, line_no: 1 },
    ]);
    assert.equal(db.countRelations(), 1);
    assert.equal(db.getRelation('r3')?.to_id, 'D');
    assert.equal(db.getRelation('r1'), null, '被替换掉的旧关系不应残留');

    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('relationsFrom / relationsTo 双向查询', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-relidx-'));
    const db = await IndexDb.open(path.join(dir, 'i.sqlite'));

    db.replaceRelationsOf('A', [
      { id: 'r1', to_id: 'B', type: 'mentor', since: null, until: null, reveal: null, weight: null, note: '', extra: null, line_no: 1 },
    ]);
    db.replaceRelationsOf('C', [
      { id: 'r2', to_id: 'B', type: 'enemy', since: null, until: null, reveal: null, weight: null, note: '', extra: null, line_no: 1 },
    ]);

    assert.equal(db.relationsFrom('A').length, 1);
    assert.equal(db.relationsFrom('B').length, 0, 'B 没有指向别人的关系');
    assert.equal(db.relationsTo('B').length, 2, 'B 被两条关系指向');

    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('extra_props 往返不丢', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-relidx-'));
    const db = await IndexDb.open(path.join(dir, 'i.sqlite'));
    db.replaceRelationsOf('A', [
      { id: 'r1', to_id: 'B', type: 'mentor', since: null, until: null, reveal: null, weight: null, note: '', extra: { color: 'red', mood: '怒' }, line_no: 1 },
    ]);
    const row = db.getRelation('r1');
    assert.deepEqual(row?.extra, { color: 'red', mood: '怒' });
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('clearRelationsOf 只清指定来源', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-relidx-'));
    const db = await IndexDb.open(path.join(dir, 'i.sqlite'));
    db.replaceRelationsOf('A', [{ id: 'r1', to_id: 'B', type: 'kin', since: null, until: null, reveal: null, weight: null, note: '', extra: null, line_no: 1 }]);
    db.replaceRelationsOf('C', [{ id: 'r2', to_id: 'B', type: 'ally', since: null, until: null, reveal: null, weight: null, note: '', extra: null, line_no: 1 }]);

    db.clearRelationsOf('A');
    assert.equal(db.countRelations(), 1);
    assert.equal(db.getRelation('r2')?.to_id, 'B', 'C 的关系不应被清掉');

    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('重复关系 id 会被后者覆盖（id 是主键），并可通过 count 察觉', async () => {
    // id 是主键，所以「同一 id 出现在两个文件里」时后写入的会顶掉前者 ——
    // 这正是 duplicateRelationIds 想发现的问题：文件侧有两个 id 相同的行，
    // 但表里只剩一条，计数对不上。
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-relidx-'));
    const db = await IndexDb.open(path.join(dir, 'i.sqlite'));
    const row = (id: string, to: string) => ({
      id, to_id: to, type: 'kin', since: null, until: null, reveal: null, weight: null, note: '', extra: null, line_no: 1,
    });
    db.replaceRelationsOf('A', [row('dup', 'B'), row('ok1', 'B')]);
    db.replaceRelationsOf('C', [row('dup', 'D')]);

    // 期望文件侧有 3 行，表里只应剩 2 条（dup 被覆盖）
    assert.equal(db.countRelations(), 2, 'id 主键会导致重复 id 互相覆盖');
    assert.equal(db.getRelation('dup')?.to_id, 'D', '后写入的应生效');

    // allRelations 能完整列出，便于与文件侧比对发现不一致
    const all = db.allRelations();
    assert.equal(all.length, 2);
    assert.ok(all.some((r) => r.id === 'ok1'));

    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('从真实夹具重建索引', () => {
  test('夹具里的关系全部进表，坏行不进表', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-relidx-'));
    const root = path.join(dir, 'p');
    await buildFixture(root);

    const db = await indexFixture(root);
    const all = db.allRelations();

    // 林远 4 条（mentor/ally/owns/enemy），青云门 3 条（ally/师徒/敌对）；坏行 r_bad1 不算
    assert.equal(all.length, 7, `应有 7 条关系，实际 ${all.length}：${all.map((r) => r.id).join(', ')}`);
    assert.ok(all.every((r) => r.id !== 'r_bad1'), '无法解析的行不应进表');

    // 中文类型名被规范化为 key
    const sectInner = all.find((r) => r.id === 'r_sect_inner');
    assert.equal(sectInner?.type, 'mentor', '「师徒」应被解析成 mentor');

    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('重建前后查询结果一致（索引可丢弃）', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-relidx-'));
    const root = path.join(dir, 'p');
    await buildFixture(root);

    const db1 = await indexFixture(root);
    const before = db1.allRelations().map((r) => `${r.id}:${r.to_id}:${r.type}`).sort();
    db1.close();
    await fs.rm(path.join(root, '.studio', 'test-index.sqlite'), { force: true });

    const db2 = await indexFixture(root);
    const after = db2.allRelations().map((r) => `${r.id}:${r.to_id}:${r.type}`).sort();
    db2.close();

    assert.deepEqual(after, before, '删库重建后结果必须一致');
    assert.ok(before.length > 0);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('悬空关系仍进表（悬空是 lint 的事，不是索引的事）', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-relidx-'));
    const root = path.join(dir, 'p');
    await buildFixture(root);

    const db = await indexFixture(root);
    const dangling = db.getRelation('r_linyuan_owns');
    assert.ok(dangling, '指向不存在目标的关系也应进表，否则 lint 无法发现它');
    assert.equal(dangling.to_id, 'DELETED_ITEM_000000000001');

    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('条目被删除后其起点关系消失', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-relidx-'));
    const root = path.join(dir, 'p');
    await buildFixture(root);

    const db = await indexFixture(root);
    assert.ok(db.relationsFrom(FIXTURE.entities.linyuan).length > 0);

    // 模拟条目被删：文件移走后 clearRelationsOf
    const store = new ProjectStore(root);
    await store.deleteEntity(FIXTURE.entities.linyuan);
    db.clearRelationsOf(FIXTURE.entities.linyuan);

    assert.equal(db.relationsFrom(FIXTURE.entities.linyuan).length, 0, '被删条目的起点关系必须清掉');
    // 但别人指向它的关系还在（悬空状态，由 lint 报告）
    assert.ok(db.relationsTo(FIXTURE.entities.linyuan).length > 0, '入向关系应保留为悬空状态');

    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
