/**
 * 基础层单元测试：原子写、frontmatter 往返、字数口径、项目存储、索引搜索。
 *
 * 这些是「稿件永不丢」的地基，必须有测试兜底。
 * 运行：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeFileAtomic, readJsonSafe, writeJsonAtomic } from '../../server/util/atomic.ts';
import { parseFrontmatter, stringifyScene } from '../../server/util/frontmatter.ts';
import { countWords, countParagraphs } from '../../server/util/words.ts';
import { ProjectStore } from '../../server/store/project.ts';
import { IndexDb } from '../../server/db/index.ts';

async function tmpDir(prefix = 'wd-test-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('原子写（稿件安全底线）', () => {
  test('写入后内容完整可读', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'a.md');
    await writeFileAtomic(file, '夜雨敲窗');
    assert.equal(await fs.readFile(file, 'utf8'), '夜雨敲窗');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('覆盖写入不残留临时文件', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'b.md');
    await writeFileAtomic(file, 'v1');
    await writeFileAtomic(file, 'v2');
    assert.equal(await fs.readFile(file, 'utf8'), 'v2');
    const left = (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(left, [], '不应残留 .tmp 文件');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('并发写入不会产生半截文件', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'c.md');
    const payloads = Array.from({ length: 30 }, (_, i) => `内容${i}-`.repeat(200));
    await Promise.all(payloads.map((p) => writeFileAtomic(file, p)));
    const content = await fs.readFile(file, 'utf8');
    // 结果必须是某一个完整 payload，不能是拼接残片
    assert.ok(payloads.includes(content), '并发写后文件必须是某个完整版本');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('JSON 损坏时返回 fallback 并备份坏文件', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'x.json');
    await fs.writeFile(file, '{ 这不是合法 JSON');
    const out = await readJsonSafe(file, { ok: true });
    assert.deepEqual(out, { ok: true });
    const backups = (await fs.readdir(dir)).filter((f) => f.includes('.corrupt.'));
    assert.equal(backups.length, 1, '坏文件应被备份');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('JSON 原子写可往返', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'y.json');
    const value = { a: 1, b: ['x', 'y'], c: { d: '中文' } };
    await writeJsonAtomic(file, value);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), value);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('frontmatter 往返', () => {
  test('基本字段往返一致', () => {
    const data = {
      id: '01JABC',
      title: '雨夜',
      status: 'draft',
      tags: ['开篇', '伏笔-玉佩'],
      order: 3,
      rev: 7,
    };
    const body = '夜雨敲窗，山门外一片寂静。\n\n“师父，我回来了。”';
    const text = stringifyScene(data, body);
    const parsed = parseFrontmatter(text);
    assert.equal(parsed.data.id, '01JABC');
    assert.equal(parsed.data.title, '雨夜');
    assert.deepEqual(parsed.data.tags, ['开篇', '伏笔-玉佩']);
    assert.equal(parsed.data.order, 3);
    assert.equal(parsed.body, body);
  });

  test('含特殊字符的标题被正确引用', () => {
    const text = stringifyScene({ id: 'x', title: '第1章: 开端 #tag' }, '正文');
    const parsed = parseFrontmatter(text);
    assert.equal(parsed.data.title, '第1章: 开端 #tag');
  });

  test('多行摘要用块标量', () => {
    const text = stringifyScene({ id: 'x', summary: '第一行\n第二行' }, '正文');
    const parsed = parseFrontmatter(text);
    assert.equal(parsed.data.summary, '第一行\n第二行');
  });

  test('无 frontmatter 的文件按纯正文处理（兼容手工放入的 md）', () => {
    const parsed = parseFrontmatter('就是一段正文\n第二段');
    assert.deepEqual(parsed.data, {});
    assert.equal(parsed.body, '就是一段正文\n第二段');
  });

  test('未闭合的 frontmatter 不吞正文', () => {
    const parsed = parseFrontmatter('---\ntitle: 坏文件\n\n正文在这里');
    assert.equal(parsed.body, '---\ntitle: 坏文件\n\n正文在这里');
  });

  test('正文尾部空白被规范化，反复读写稳定', () => {
    const once = stringifyScene({ id: 'x' }, '正文  \n\n\n');
    const parsed1 = parseFrontmatter(once);
    const twice = stringifyScene(parsed1.data, parsed1.body);
    assert.equal(once, twice, '往返必须幂等');
  });
});

describe('字数口径', () => {
  const text = '夜雨敲窗，山门外一片寂静。\n\n“师父，我回来了。”';

  test('仅汉字', () => {
    // 夜雨敲窗(4) + 山门外一片寂静(7) + 师父我回来了(6) = 17
    assert.equal(countWords(text, 'hanzi'), 17);
  });

  test('汉字加标点', () => {
    const hanzi = countWords(text, 'hanzi');
    const withPunct = countWords(text, 'hanzi_punct');
    assert.ok(withPunct > hanzi, '含标点应多于仅汉字');
    // ，。 “ ” 。 共 6 个标点
    assert.equal(withPunct, hanzi + 6);
  });

  test('平台口径不计空白', () => {
    const a = countWords('一二三 四五六', 'platform');
    const b = countWords('一二三四五六', 'platform');
    assert.equal(a, b, '空格不应计入');
  });

  test('空文本为 0', () => {
    assert.equal(countWords('', 'hanzi'), 0);
    assert.equal(countWords('', 'platform'), 0);
  });

  test('扩展区汉字与生僻字被计入', () => {
    // 𠀀 是扩展 B 区汉字
    assert.equal(countWords('𠀀𠀁', 'hanzi'), 2);
  });

  test('段落数统计', () => {
    assert.equal(countParagraphs('一段\n\n二段\n\n\n三段'), 3);
  });
});

describe('项目存储', () => {
  test('创建作品后目录结构符合架构 6.1', async () => {
    const dir = await tmpDir();
    const root = path.join(dir, '我的小说');
    await ProjectStore.create(root, { title: '示例小说' });

    for (const sub of ['manuscript', 'bible', 'notes', 'inbox', '.studio']) {
      const st = await fs.stat(path.join(root, sub)).catch(() => null);
      assert.ok(st?.isDirectory(), `${sub} 目录应存在`);
    }
    for (const sub of ['characters', 'places', 'factions', 'items', 'terms', 'events']) {
      const st = await fs.stat(path.join(root, 'bible', sub)).catch(() => null);
      assert.ok(st?.isDirectory(), `bible/${sub} 应存在`);
    }
    const meta = JSON.parse(await fs.readFile(path.join(root, 'project.json'), 'utf8'));
    assert.equal(meta.title, '示例小说');
    assert.equal(meta.schema_version, 1);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('卷章场景树：创建、排序、字数', async () => {
    const dir = await tmpDir();
    const store = await ProjectStore.create(path.join(dir, 'p'), { title: 'T' });

    const v1 = await store.createNode({ kind: 'volume', parent_id: null, title: '第一卷' });
    const c1 = await store.createNode({ kind: 'chapter', parent_id: v1.id, title: '开篇' });
    const s1 = await store.createNode({ kind: 'scene', parent_id: c1.id, title: '雨夜' });
    const s2 = await store.createNode({ kind: 'scene', parent_id: c1.id, title: '天明' });

    await store.writeScene(s1.id, '夜雨敲窗，山门外一片寂静。', 1);
    await store.writeScene(s2.id, '天亮了。', 1);

    const tree = await store.readTree();
    const scenes = tree.nodes.filter((n) => n.kind === 'scene');
    assert.equal(scenes.length, 2);
    assert.equal(scenes[0].title, '雨夜');
    // 夜雨敲窗(4) + 山门外一片寂静(7) = 11
    assert.equal(scenes[0].word_count, 11);
    assert.equal(scenes[1].title, '天明');
    assert.equal(scenes[0].parent_id, c1.id);

    const totals = await store.totals();
    assert.equal(totals.scene_count, 2);
    // 11 + 天亮了(3)
    assert.equal(totals.word_count, 11 + 3);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('文件名带顺序前缀，身份靠 frontmatter id', async () => {
    const dir = await tmpDir();
    const store = await ProjectStore.create(path.join(dir, 'p'), { title: 'T' });
    const v = await store.createNode({ kind: 'volume', parent_id: null, title: '第一卷' });
    const c = await store.createNode({ kind: 'chapter', parent_id: v.id, title: '开篇' });
    const s = await store.createNode({ kind: 'scene', parent_id: c.id, title: '雨夜' });

    const found = await store.resolveDocFile(s.id);
    assert.ok(found?.node.file, '树节点应带 file 相对路径');
    assert.match(found!.node.file!, /s0001-雨夜\.md$/);

    // 改名后 id 不变
    await store.renameNode(s.id, '雨夜（改）');
    const tree = await store.readTree();
    const after = tree.nodes.find((n) => n.kind === 'scene');
    assert.equal(after?.id, s.id, '改名不应改变 id');
    assert.equal(after?.title, '雨夜（改）');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('修订号递增，内容哈希变化', async () => {
    const dir = await tmpDir();
    const store = await ProjectStore.create(path.join(dir, 'p'), { title: 'T' });
    const v = await store.createNode({ kind: 'volume', parent_id: null, title: 'V' });
    const c = await store.createNode({ kind: 'chapter', parent_id: v.id, title: 'C' });
    const s = await store.createNode({ kind: 'scene', parent_id: c.id, title: 'S' });

    const r1 = await store.writeScene(s.id, '第一版', 1);
    const r2 = await store.writeScene(s.id, '第二版', r1.rev);
    assert.equal(r2.rev, r1.rev + 1);
    assert.notEqual(r1.hash, r2.hash);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('删除进回收站，可恢复', async () => {
    const dir = await tmpDir();
    const store = await ProjectStore.create(path.join(dir, 'p'), { title: 'T' });
    const v = await store.createNode({ kind: 'volume', parent_id: null, title: 'V' });
    const c = await store.createNode({ kind: 'chapter', parent_id: v.id, title: 'C' });
    const s = await store.createNode({ kind: 'scene', parent_id: c.id, title: 'S' });
    await store.writeScene(s.id, '要保留的内容', 1);

    const deleted = await store.deleteNode(c.id);
    assert.ok(deleted.length >= 2, '删章应带走场景');
    assert.equal((await store.readTree()).nodes.length, 1, '只剩卷');

    const trash = await store.listTrash();
    assert.equal(trash.length, 1);

    await store.restoreFromTrash(trash[0].id);
    assert.ok((await store.readTree()).nodes.length >= 2, '恢复后节点回来');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('设定库条目往返（含别名与自定义字段）', async () => {
    const dir = await tmpDir();
    const store = await ProjectStore.create(path.join(dir, 'p'), { title: 'T' });

    const saved = await store.saveEntity({
      type: 'character',
      name: '林远',
      aliases: ['小林', '林师兄'],
      fields: { 身份: '青云门弟子', 年龄: '十九' },
      description: '性格沉稳，剑法出众。',
    });

    const all = await store.listEntities();
    assert.equal(all.length, 1);
    assert.equal(all[0].name, '林远');
    assert.deepEqual(all[0].aliases, ['小林', '林师兄']);
    assert.equal(all[0].fields['身份'], '青云门弟子');
    assert.match(all[0].description, /性格沉稳/);

    // 文件落在 bible/characters/
    const charDir = path.join(dir, 'p', 'bible', 'characters');
    const files = await fs.readdir(charDir);
    assert.ok(files.some((f) => f.includes('林远')));

    await store.deleteEntity(saved.id);
    assert.equal((await store.listEntities()).length, 0);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('索引与中文搜索', () => {
  test('2 字中文人名可搜到（trigram 做不到的场景）', async () => {
    const dir = await tmpDir();
    const db = await IndexDb.open(path.join(dir, 'i.sqlite'));
    db.transaction(() => {
      db.upsertDoc({
        id: 'd1', path: 'a.md', kind: 'scene', title: '雨夜', parent_id: null, order_no: 1,
        status: 'draft', words: 20, hash: 'h1', body: '夜雨敲窗，林远推门而入。', updated_at: 1,
      });
      db.upsertDoc({
        id: 'd2', path: 'b.md', kind: 'scene', title: '天明', parent_id: null, order_no: 2,
        status: 'draft', words: 20, hash: 'h2', body: '赵六在门口等着。', updated_at: 2,
      });
    });

    const hit = db.search('林远');
    assert.equal(hit.length, 1);
    assert.equal(hit[0].doc_id, 'd1');
    assert.match(hit[0].snippet, /<mark>林远<\/mark>/);

    assert.equal(db.search('赵六').length, 1);
    assert.equal(db.search('不存在的人').length, 0);
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('多字与单字搜索、命中计数', async () => {
    const dir = await tmpDir();
    const db = await IndexDb.open(path.join(dir, 'i.sqlite'));
    db.upsertDoc({
      id: 'd1', path: 'a.md', kind: 'scene', title: 'A', parent_id: null, order_no: 1,
      status: 'draft', words: 20, hash: 'h', body: '山门外下雨。山门外无人。', updated_at: 1,
    });
    assert.equal(db.search('山门外')[0].count, 2, '应统计出现次数');
    assert.equal(db.search('雨').length, 1);
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('重建索引后搜索结果一致（索引可丢弃重建）', async () => {
    const dir = await tmpDir();
    const root = path.join(dir, 'p');
    const store = await ProjectStore.create(root, { title: 'T' });
    const v = await store.createNode({ kind: 'volume', parent_id: null, title: 'V' });
    const c = await store.createNode({ kind: 'chapter', parent_id: v.id, title: 'C' });
    const s = await store.createNode({ kind: 'scene', parent_id: c.id, title: 'S' });
    await store.writeScene(s.id, '林远站在山门外。', 1);

    const dbPath = path.join(root, '.studio', 'index.sqlite');
    const db1 = await IndexDb.open(dbPath);
    const tree = await store.readTree();
    const node = tree.nodes.find((n) => n.id === s.id)!;
    const scene = await store.readScene(s.id);
    db1.upsertDoc({
      id: node.id, path: node.file!, kind: 'scene', title: node.title, parent_id: node.parent_id,
      order_no: node.order, status: node.status, words: node.word_count, hash: scene!.hash,
      body: scene!.body, updated_at: node.updated_at,
    });
    assert.equal(db1.search('林远').length, 1);
    db1.close();

    // 删库重建
    await fs.rm(dbPath, { force: true });
    await fs.rm(`${dbPath}-wal`, { force: true }).catch(() => {});
    await fs.rm(`${dbPath}-shm`, { force: true }).catch(() => {});
    const db2 = await IndexDb.open(dbPath);
    db2.upsertDoc({
      id: node.id, path: node.file!, kind: 'scene', title: node.title, parent_id: node.parent_id,
      order_no: node.order, status: node.status, words: node.word_count, hash: scene!.hash,
      body: scene!.body, updated_at: node.updated_at,
    });
    assert.equal(db2.search('林远').length, 1, '重建后仍可搜到');
    db2.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
