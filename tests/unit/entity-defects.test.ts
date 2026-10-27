/**
 * 设定库条目缺陷复现测试（关系图谱 G0-1）。
 *
 * 这份测试的存在意义：在动手改任何产品代码之前，先证明缺陷**真实存在**。
 * 每一条都对应差异分析里的 F1–F6、F9，失败信息里写明缺陷编号，
 * 修好之后同一个测试应该转绿 —— 这就是「先红后绿」。
 *
 * 运行：npm test -- tests/unit/entity-defects.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ProjectStore } from '../../server/store/project.ts';
import { writeFileAtomic } from '../../server/util/atomic.ts';
import { parseFrontmatter, stringifyScene } from '../../server/util/frontmatter.ts';

// ─────────────────────── 夹具工具 ───────────────────────

async function tmpProject(): Promise<{ root: string; store: ProjectStore; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-defect-'));
  const root = path.join(dir, 'p');
  const store = await ProjectStore.create(root, { title: '缺陷复现' });
  return { root, store, dir };
}

/** 递归列出 bible/ 下所有 md 文件（相对 bible/ 的路径） */
async function listBibleFiles(root: string): Promise<string[]> {
  const base = path.join(root, 'bible');
  const out: string[] = [];
  const walk = async (d: string, prefix: string): Promise<void> => {
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, `${prefix}${e.name}/`);
      else if (e.name.endsWith('.md')) out.push(`${prefix}${e.name}`);
    }
  };
  await walk(base, '');
  return out.sort();
}

/** 找出 bible/ 下所有含某 id 的文件 */
async function filesContainingId(root: string, id: string): Promise<string[]> {
  const out: string[] = [];
  for (const rel of await listBibleFiles(root)) {
    const raw = await fs.readFile(path.join(root, 'bible', rel), 'utf8');
    if (raw.includes(`id: ${id}`)) out.push(rel);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
// F1：saveEntity 丢弃未知 frontmatter 键
// ══════════════════════════════════════════════════════════════

describe('F1 保存条目时应保留未知键', () => {
  test('relations 块与 x- 前缀键在保存后逐字保留', async () => {
    const { root, store, dir } = await tmpProject();

    // 手写一个带 relations 块与自定义扩展键的条目文件
    const charDir = path.join(root, 'bible', 'characters');
    const file = path.join(charDir, '林远.md');
    const raw = stringifyScene(
      {
        id: 'F1ENTITY0000000000000001',
        type: 'character',
        name: '林远',
        aliases: ['小林'],
        relations:
          'id=r_001 mentor -> F1ENTITY0000000000000002 (老掌门) | since=01JC1 | 收养并传艺',
        'x-demo': '1',
        created_at: 1700000000000,
      },
      '主角。',
    );
    await writeFileAtomic(file, raw);

    // 只改名称，其余不动
    await store.saveEntity({
      id: 'F1ENTITY0000000000000001',
      type: 'character',
      name: '林远（改）',
      aliases: ['小林'],
      description: '主角。',
    });

    // 改名会改变文件名（这是设计：文件名是人类可读的 slug），所以按 id 定位
    const hits = await filesContainingId(root, 'F1ENTITY0000000000000001');
    assert.equal(hits.length, 1, `应恰好一份文件，实际 ${hits.length} 份`);
    const after = await fs.readFile(path.join(root, 'bible', hits[0]), 'utf8');
    const { data, body } = parseFrontmatter(after);

    // 缺陷：saveEntity 从零构造 frontmatter，这两个键会消失
    assert.ok(
      data.relations !== undefined && String(data.relations).includes('mentor ->'),
      `F1 缺陷：relations 块在保存后丢失了。实际 frontmatter 键：${Object.keys(data).join(', ')}`,
    );
    assert.ok(
      data['x-demo'] !== undefined && String(data['x-demo']) === '1',
      `F1 缺陷：x-demo 在保存后丢失了。实际 frontmatter 键：${Object.keys(data).join(', ')}`,
    );

    // 顺带确认改名本身生效了、正文没被动
    assert.equal(data.name, '林远（改）', '名称应已更新');
    assert.equal(body, '主角。', '正文不应被改动');

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('未知键不应被当成自定义字段（fields）来回搬运', async () => {
    // 这条是 F1 的补充：即使靠 fields 兜住 relations，
    // 多行块被 fields 平铺成普通字符串后，格式也会被破坏。
    const { root, store, dir } = await tmpProject();
    const charDir = path.join(root, 'bible', 'characters');
    const file = path.join(charDir, '测试.md');
    const block = 'id=r_001 mentor -> TARGET00000000000000001 (某人)\nid=r_002 enemy -> TARGET00000000000000002 (某人2)';
    await writeFileAtomic(
      file,
      stringifyScene({ id: 'F1B00000000000000000001', type: 'character', name: '测试', relations: block }, '正文'),
    );

    const before = parseFrontmatter(await fs.readFile(file, 'utf8'));
    await store.saveEntity({ id: 'F1B00000000000000000001', type: 'character', name: '测试2' });
    const hits2 = await filesContainingId(root, 'F1B00000000000000000001');
    assert.equal(hits2.length, 1, `应恰好一份文件，实际 ${hits2.length} 份`);
    const after = parseFrontmatter(await fs.readFile(path.join(root, 'bible', hits2[0]), 'utf8'));

    // 多行块必须还以「多行」形式存在，而不是变成 fields 里的单行字符串
    assert.equal(
      typeof after.data.relations,
      typeof before.data.relations,
      'F1 缺陷：relations 的类型（多行块 / 字符串）在保存后发生了变化',
    );
    assert.equal(
      String(after.data.relations),
      String(before.data.relations),
      'F1 缺陷：relations 内容在保存后发生变化',
    );

    await fs.rm(dir, { recursive: true, force: true });
  });
});

// ══════════════════════════════════════════════════════════════
// F2：类型变更产生重复条目
// ══════════════════════════════════════════════════════════════

describe('F2 修改条目类型后应恰好保留一份文件', () => {
  test('角色改为势力：只在 factions/ 留一份', async () => {
    const { root, store, dir } = await tmpProject();

    const a = await store.saveEntity({ type: 'character', name: '青云门', description: '门派' });
    await store.saveEntity({ id: a.id, type: 'faction', name: '青云门', description: '门派' });

    const hits = await filesContainingId(root, a.id);
    assert.equal(
      hits.length,
      1,
      `F2 缺陷：同一 id 在 bible/ 下有 ${hits.length} 份文件（${hits.join(' 与 ')}），应恰好 1 份`,
    );
    assert.ok(hits[0].startsWith('factions/'), `F2 缺陷：文件应在 factions/ 下，实际在 ${hits[0]}`);

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('改类型后 listEntities 不应返回重复条目', async () => {
    const { root, store, dir } = await tmpProject();

    const a = await store.saveEntity({ type: 'character', name: '未名剑', description: '剑' });
    await store.saveEntity({ id: a.id, type: 'item', name: '未名剑', description: '剑' });

    const all = await store.listEntities();
    const same = all.filter((e) => e.id === a.id);
    assert.equal(same.length, 1, `F2 缺陷：listEntities 返回了 ${same.length} 条同 id 条目`);
    assert.equal(same[0].type, 'item', '类型应为 item');

    await fs.rm(dir, { recursive: true, force: true });
  });
});

// ══════════════════════════════════════════════════════════════
// F3：新建同名条目覆盖已有条目
// ══════════════════════════════════════════════════════════════

describe('F3 新建同名条目应被拒绝，不得覆盖', () => {
  test('同类型同名：抛错且已有条目内容不变', async () => {
    const { root, store, dir } = await tmpProject();

    const a = await store.saveEntity({ type: 'character', name: '林远', description: '第一个林远' });
    const file = path.join(root, 'bible', 'characters', '林远.md');
    const before = await fs.readFile(file, 'utf8');

    let threw = false;
    try {
      await store.saveEntity({ type: 'character', name: '林远', description: '第二个林远' });
    } catch {
      threw = true;
    }

    const after = await fs.readFile(file, 'utf8');
    assert.ok(
      threw,
      'F3 缺陷：新建同名条目没有报错，应抛出 entity_name_conflict',
    );
    assert.equal(after, before, `F3 缺陷：已有条目 ${a.id} 的文件被新建操作覆盖了`);
    assert.ok(after.includes('第一个林远'), 'F3 缺陷：已有条目的正文被覆盖');

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('不同大小写与首尾空格的同名也应视为冲突', async () => {
    const { root, store, dir } = await tmpProject();
    await store.saveEntity({ type: 'character', name: 'Alice', description: 'A' });

    let threw = false;
    try {
      await store.saveEntity({ type: 'character', name: '  alice  ', description: 'A2' });
    } catch {
      threw = true;
    }
    assert.ok(threw, 'F3 缺陷：忽略大小写与空格的同名未被拒绝');

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('不同类型下允许同名', async () => {
    const { root, store, dir } = await tmpProject();
    await store.saveEntity({ type: 'character', name: '青云门' });
    // 角色与地点同名是合理的，不应互相干扰
    await store.saveEntity({ type: 'place', name: '青云门' });

    const all = await store.listEntities();
    assert.equal(all.filter((e) => e.name === '青云门').length, 2, '不同类型应允许同名');

    await fs.rm(dir, { recursive: true, force: true });
  });
});

// ══════════════════════════════════════════════════════════════
// F4：改名冲突覆盖
// ══════════════════════════════════════════════════════════════

describe('F4 改名撞到已有名称应被拒绝', () => {
  test('把 B 改名成 A：抛错，A 与 B 都不变', async () => {
    const { root, store, dir } = await tmpProject();

    const a = await store.saveEntity({ type: 'character', name: '林远', description: '主角' });
    const b = await store.saveEntity({ type: 'character', name: '赵六', description: '路人' });

    const fileA = path.join(root, 'bible', 'characters', '林远.md');
    const fileB = path.join(root, 'bible', 'characters', '赵六.md');
    const beforeA = await fs.readFile(fileA, 'utf8');
    const beforeB = await fs.readFile(fileB, 'utf8');

    let threw = false;
    try {
      await store.saveEntity({ id: b.id, type: 'character', name: '林远' });
    } catch {
      threw = true;
    }

    assert.ok(threw, 'F4 缺陷：改名冲突没有报错，应抛出 entity_name_conflict');
    assert.equal(await fs.readFile(fileA, 'utf8'), beforeA, `F4 缺陷：条目 ${a.id} 被改名操作覆盖`);
    assert.equal(await fs.readFile(fileB, 'utf8'), beforeB, 'F4 缺陷：发起改名的条目内容被改动');

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('改名成自己当前的名称不算冲突', async () => {
    const { root, store, dir } = await tmpProject();
    const a = await store.saveEntity({ type: 'character', name: '林远' });
    // 保存时原样带回名称（前端表单每次保存都会这么做）不应报错
    await store.saveEntity({ id: a.id, type: 'character', name: '林远' });
    const all = await store.listEntities();
    assert.equal(all.length, 1);

    await fs.rm(dir, { recursive: true, force: true });
  });
});

// ══════════════════════════════════════════════════════════════
// F5：缺少 id 的条目文件
// ══════════════════════════════════════════════════════════════

describe('F5 缺少 id 的条目文件应被补写稳定 id', () => {
  test('首次读取补写 id，重命名文件后 id 不变', async () => {
    const { root, store, dir } = await tmpProject();
    const charDir = path.join(root, 'bible', 'characters');

    // 模拟作者手工放进 bible/ 的文件：没有 id
    await writeFileAtomic(
      path.join(charDir, '手写角色.md'),
      stringifyScene({ type: 'character', name: '手写角色' }, '手工放进来的。'),
    );

    const list1 = await store.listEntities();
    const e1 = list1.find((e) => e.name === '手写角色');
    assert.ok(e1, '应能读到该条目');

    const raw1 = await fs.readFile(path.join(charDir, '手写角色.md'), 'utf8');
    assert.ok(
      /^id:\s*\S+/m.test(raw1),
      'F5 缺陷：首次读取后没有把 id 补写进文件（重命名后 id 会变）',
    );

    // 重命名文件
    await fs.rename(path.join(charDir, '手写角色.md'), path.join(charDir, '改过名.md'));
    const list2 = await store.listEntities();
    const e2 = list2.find((e) => e.name === '手写角色');
    assert.ok(e2, '重命名后仍应能读到');
    assert.equal(
      e2.id,
      e1.id,
      `F5 缺陷：重命名文件后 id 从 ${e1.id} 变成 ${e2.id}，关系引用会断链`,
    );

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('补写 id 时正文与其他字段不变', async () => {
    const { root, store, dir } = await tmpProject();
    const charDir = path.join(root, 'bible', 'characters');
    const file = path.join(charDir, '保留.md');
    await writeFileAtomic(
      file,
      stringifyScene({ type: 'place', name: '保留', aliases: ['别名A'], 位置: '青云山' }, '描述正文'),
    );

    await store.listEntities();

    const { data, body } = parseFrontmatter(await fs.readFile(file, 'utf8'));
    assert.equal(body, '描述正文', 'F5：正文被改动');
    assert.equal(data.name, '保留', 'F5：名称被改动');
    assert.deepEqual(data.aliases, ['别名A'], 'F5：别名被改动');
    assert.equal(String(data['位置']), '青云山', 'F5：自定义字段被改动');

    await fs.rm(dir, { recursive: true, force: true });
  });
});

// ══════════════════════════════════════════════════════════════
// F6：条目在回收站里的展示与恢复
// ══════════════════════════════════════════════════════════════

describe('F6 条目删除后应在回收站正确显示并恢复回 bible/', () => {
  test('回收站不应显示成一串时间戳 id', async () => {
    const { store, dir } = await tmpProject();
    const a = await store.saveEntity({ type: 'character', name: '待删角色', description: 'x' });
    await store.deleteEntity(a.id);

    const trash = await store.listTrash();
    assert.equal(trash.length, 1, '回收站应有一条');

    const entry = trash[0];
    // 缺陷：displayName 来自 nodes[0].title，但条目删除时 nodes 是空数组，
    // 于是回退成目录名（形如 1793139127635-01M5ZP...）
    assert.ok(
      !/^\d{10,}-/.test(entry.name),
      `F6 缺陷：回收站显示成了目录名「${entry.name}」，应显示条目名「待删角色」`,
    );
    assert.equal(entry.name, '待删角色', `F6 缺陷：作者看到的名字不对，实际「${entry.name}」`);

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('恢复条目应回到 bible/<类型目录>/，不能落到 manuscript/', async () => {
    const { root, store, dir } = await tmpProject();
    const a = await store.saveEntity({ type: 'character', name: '待恢复', description: '正文' });
    await store.deleteEntity(a.id);

    const trash = await store.listTrash();
    await store.restoreFromTrash(trash[0].id);

    // 关键：不能出现在稿件目录里
    const manuscriptFiles = await fs.readdir(path.join(root, 'manuscript')).catch(() => [] as string[]);
    assert.deepEqual(
      manuscriptFiles.filter((f) => f.includes('待恢复')),
      [],
      `F6 缺陷：条目被恢复到 manuscript/（${manuscriptFiles.join(', ')}），那是正文目录`,
    );

    // 应该回到 bible/ 下并且能重新被读到
    const all = await store.listEntities();
    const back = all.find((e) => e.id === a.id);
    assert.ok(back, 'F6 缺陷：恢复后 listEntities 读不到该条目');
    assert.equal(back.type, 'character', '恢复后类型应保持');
    assert.equal(back.description, '正文', '恢复后正文应保持');

    await fs.rm(dir, { recursive: true, force: true });
  });
});

// ══════════════════════════════════════════════════════════════
// F9：frontmatter 转义往返（记录实际行为，不在 G0 修复）
// ══════════════════════════════════════════════════════════════

describe('F9 frontmatter 转义往返', () => {
  test('含反斜杠与制表符的值往返', () => {
    // 这条只记录实际行为。若不一致，是已知限制：
    // 关系格式用 `|` 多行块规避，不走标量转义路径。
    const samples = [
      'C:\\Users\\path',
      '带\t制表符',
      '带"引号"的值',
      'a\\b\\c',
    ];
    const failures: string[] = [];
    for (const s of samples) {
      const text = stringifyScene({ id: 'x', name: s }, '');
      const back = parseFrontmatter(text).data.name;
      if (back !== s) failures.push(`  ${JSON.stringify(s)} → ${JSON.stringify(back)}`);
    }
    if (failures.length > 0) {
      console.log('\n[F9 已知限制] 以下值往返不一致（G0 不修复，关系格式用多行块规避）：');
      console.log(failures.join('\n'));
    }
    // 断言：至少普通中文与引号必须正确，否则说明解析器有更严重问题
    const plain = parseFrontmatter(stringifyScene({ name: '普通中文名称' }, '')).data.name;
    assert.equal(plain, '普通中文名称', '普通中文往返必须正确');
  });
});
