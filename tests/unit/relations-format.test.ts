/**
 * 关系格式解析与序列化测试（G0-6）。
 *
 * 这份测试的核心不变量：**往返幂等**。
 * 作者手写的 relations 块经过一次「读 → 写」后不能变形，
 * 注释、空行、未知属性、无法解析的行都要原样保留。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalize,
  lineFor,
  looksLikeBrokenRelation,
  newRelationId,
  parseRelations,
  relationsOnly,
  stringifyRelation,
  stringifyRelations,
  type RelationLine,
} from '../../server/graph/relations-format.ts';

const roundtrip = (block: string): string =>
  stringifyRelations(parseRelations(block));

describe('关系行解析', () => {
  test('解析基本关系', () => {
    const lines = parseRelations('id=r_001 mentor -> ENTITY_B (老掌门) | since=DOC1 | 收养并传艺');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].kind, 'rel');
    const rel = (lines[0] as { kind: 'rel'; rel: Record<string, unknown> }).rel;
    assert.equal(rel.id, 'r_001');
    assert.equal(rel.type, 'mentor');
    assert.equal(rel.to, 'ENTITY_B');
    assert.equal(rel.to_name, '老掌门');
    assert.equal(rel.since, 'DOC1');
    assert.equal(rel.note, '收养并传艺');
  });

  test('省略属性与备注', () => {
    const lines = parseRelations('id=r_1 ally -> ENTITY_C');
    const rel = (lines[0] as { kind: 'rel'; rel: Record<string, unknown> }).rel;
    assert.equal(rel.to, 'ENTITY_C');
    assert.equal(rel.note, '');
    assert.equal(rel.since, undefined);
  });

  test('省略显示名', () => {
    const rel = (parseRelations('id=r_1 kin -> ENTITY_D') [0] as { rel: Record<string, unknown> }).rel;
    assert.equal(rel.to_name, undefined);
  });

  test('备注可以包含 | 与 ->', () => {
    const block = 'id=r_1 enemy -> ENTITY_E (某人) | since=D1 | 他在 A -> B 的迁移中 | 提及「你 | 我」';
    const rel = (parseRelations(block)[0] as { rel: Record<string, unknown> }).rel;
    assert.equal(rel.since, 'D1');
    assert.equal(rel.note, '他在 A -> B 的迁移中 | 提及「你 | 我」');
  });

  test('未知属性进入 extra_props，不丢失', () => {
    const rel = (parseRelations('id=r_1 mentor -> E1 | since=D1 color=red mood=怒') [0] as { rel: Record<string, unknown> }).rel;
    assert.deepEqual(rel.extra_props, { color: 'red', mood: '怒' });
    assert.equal(rel.since, 'D1');
  });

  test('weight 解析为数字，非法值原样保留', () => {
    const ok = (parseRelations('id=r_1 owns -> E1 | weight=3') [0] as { rel: Record<string, unknown> }).rel;
    assert.equal(ok.weight, 3);
    const bad = (parseRelations('id=r_2 owns -> E1 | weight=很重') [0] as { rel: Record<string, unknown> }).rel;
    assert.equal(bad.weight, undefined);
    assert.deepEqual(bad.extra_props, { weight: '很重' });
  });

  test('注释与空行保留为 raw', () => {
    const lines = parseRelations('# 这是注释\nid=r_1 kin -> E1\n\n# 另一条');
    assert.equal(lines[0].kind, 'raw');
    assert.equal((lines[0] as { text: string }).text, '# 这是注释');
    assert.equal(lines[1].kind, 'rel');
    assert.equal(lines[2].kind, 'raw');
  });

  test('无法解析的行原样保留，不抛错', () => {
    const lines = parseRelations('这是一行乱码\nid=r_1 mentor -> E1');
    assert.equal(lines[0].kind, 'raw');
    assert.equal((lines[0] as { text: string }).text, '这是一行乱码');
    assert.equal(lines[1].kind, 'rel');
  });

  test('空输入返回空数组', () => {
    assert.deepEqual(parseRelations(''), []);
  });
});

describe('关系序列化与往返幂等', () => {
  const samples: Array<[string, string]> = [
    ['基本', 'id=r_1 mentor -> E1 (老掌门) | since=D1 | 传艺'],
    ['无属性', 'id=r_1 kin -> E1'],
    ['只有备注', 'id=r_1 kin -> E1 | 备注内容'],
    ['多属性', 'id=r_1 mentor -> E1 (x) | since=D1 until=D9 weight=2 | 备注'],
    ['含注释与空行', '# 分组一\nid=r_1 mentor -> E1 (a) | 备注\n\n# 分组二\nid=r_2 enemy -> E2 (b)'],
    ['未知属性', 'id=r_1 mentor -> E1 | since=D1 color=red | 备注'],
    ['备注含管道', 'id=r_1 enemy -> E1 | since=D1 | 他说「甲 | 乙」'],
    ['备注含箭头', 'id=r_1 enemy -> E1 | 从 A -> B'],
    ['未知行混排', 'id=r_1 mentor -> E1\n无法解析的一行\nid=r_2 kin -> E2'],
  ];

  for (const [name, input] of samples) {
    test(`往返幂等：${name}`, () => {
      const once = roundtrip(input);
      const twice = roundtrip(once);
      assert.equal(twice, once, `第二次往返发生变化：\n第一次: ${JSON.stringify(once)}\n第二次: ${JSON.stringify(twice)}`);
    });
  }

  test('规范化输出：多余空格被规整，但语义不变', () => {
    const out = roundtrip('id=r_1    mentor    ->    E1    (  名字  )   |   since=D1   |   备注  ');
    const rel = relationsOnly(parseRelations(out))[0];
    assert.equal(rel.id, 'r_1');
    assert.equal(rel.type, 'mentor');
    assert.equal(rel.to, 'E1');
    assert.equal(rel.to_name, '名字');
    assert.equal(rel.since, 'D1');
    assert.equal(rel.note, '备注');
  });

  test('raw 行逐字保留（不重整空白）', () => {
    const input = '   # 缩进的注释\nid=r_1 kin -> E1';
    const out = roundtrip(input);
    assert.ok(out.startsWith('   # 缩进的注释'), `注释缩进被改动：${JSON.stringify(out)}`);
  });

  test('空块序列化为空字符串', () => {
    assert.equal(roundtrip(''), '');
    assert.equal(roundtrip('\n\n'), '');
  });

  test('stringifyRelation 单独可用', () => {
    const line = stringifyRelation({ id: 'r_9', type: 'owns', to: 'E1', to_name: '未名剑', since: 'D1', note: '第一件', direction: 'out' });
    assert.equal(line, 'id=r_9 owns -> E1 (未名剑) | since=D1 | 第一件');
  });

  test('有备注无属性：只用一个管道，且能正确解析回备注', () => {
    const line = stringifyRelation({ id: 'r_9', type: 'kin', to: 'E1', note: '只是备注', direction: 'out' });
    // 空属性段 ' | | ' 有歧义（连续分隔符会互相吞掉），所以只用单个管道；
    // 解析侧靠「不含 key=value」判断第二段是备注。
    assert.equal(line, 'id=r_9 kin -> E1 | 只是备注');
    const back = relationsOnly(parseRelations(line))[0];
    assert.equal(back.note, '只是备注');
    assert.equal(back.since, undefined);
  });
});

describe('新关系 id 与破损行识别', () => {
  test('newRelationId 形如 r_ + 26 位', () => {
    const id = newRelationId();
    assert.match(id, /^r_[0-9A-Z]{26}$/);
  });

  test('两次生成不同', () => {
    assert.notEqual(newRelationId(), newRelationId());
  });

  test('looksLikeBrokenRelation 区分注释与坏行', () => {
    const lines: RelationLine[] = parseRelations('# 正常注释\nid=r_1 -> 缺类型\n随便一行\nid=r_2 kin -> E1');
    assert.equal(looksLikeBrokenRelation(lines[0]), false, '注释不算坏行');
    assert.equal(looksLikeBrokenRelation(lines[1]), true, '缺类型的行应被识别为坏行');
    assert.equal(looksLikeBrokenRelation(lines[2]), false, '普通文字不算坏行（可能是作者的备注段）');
    assert.equal(looksLikeBrokenRelation(lines[3]), false, '合法关系不算坏行');
  });
});

// ─────────────────────────── G1' 修订：箭头方向 ───────────────────────────

describe('箭头方向（A1）', () => {
  test('-> 解析为 out（本条目是起点）', () => {
    const [line] = parseRelations('id=r1 mentor -> E2 (林远) | 传艺');
    assert.equal(line.kind, 'rel');
    const rel = (line as { rel: { direction: string; to: string } }).rel;
    assert.equal(rel.direction, 'out');
    assert.equal(rel.to, 'E2');
  });

  test('<- 解析为 in（对方是起点）', () => {
    const [line] = parseRelations('id=r1 mentor <- E2 (老掌门) | 传艺');
    assert.equal(line.kind, 'rel');
    const rel = (line as { rel: { direction: string; to: string } }).rel;
    assert.equal(rel.direction, 'in');
    assert.equal(rel.to, 'E2');
  });

  test('<- 往返不丢方向', () => {
    const src = 'id=r1 mentor <- E2 (老掌门) | since=D1 | 传授';
    const back = stringifyRelations(parseRelations(src));
    assert.equal(back, src);
    assert.equal(parseRelations(back)[0].kind, 'rel');
    assert.equal((parseRelations(back)[0] as { rel: { direction: string } }).rel.direction, 'in');
  });

  test('同一对条目两个方向的行可以并存', () => {
    const block = ['id=r1 mentor -> E2 (林远)', 'id=r2 kin <- E2 (老掌门)'].join('\n');
    const lines = parseRelations(block);
    assert.equal(lines.length, 2);
    assert.deepEqual(
      lines.map((l) => (l as { rel: { direction: string } }).rel.direction),
      ['out', 'in'],
    );
  });

  test('箭头两侧允许空格', () => {
    assert.equal(parseRelations('id=r1 kin->  E2')[0].kind, 'rel');
    assert.equal(parseRelations('id=r1 kin  <-E2')[0].kind, 'rel');
  });

  test('缺少箭头或箭头非法 → 作为 raw 保留', () => {
    assert.equal(parseRelations('id=r1 mentor E2')[0].kind, 'raw');
    assert.equal(parseRelations('id=r1 mentor => E2')[0].kind, 'raw');
  });

  test('looksLikeBrokenRelation 认得出 <- 写坏的行', () => {
    const lines = parseRelations('id=r1 <- ');
    assert.equal(looksLikeBrokenRelation(lines[0]), true);
  });
});

describe('canonicalize：相对行 → 规范方向（A1）', () => {
  test('out：本条目是起点', () => {
    assert.deepEqual(
      canonicalize('ME', { id: 'r1', type: 'mentor', to: 'OTHER', direction: 'out', note: '' }),
      { from: 'ME', to: 'OTHER' },
    );
  });

  test('in：本条目是终点', () => {
    assert.deepEqual(
      canonicalize('ME', { id: 'r1', type: 'mentor', to: 'OTHER', direction: 'in', note: '' }),
      { from: 'OTHER', to: 'ME' },
    );
  });
});

describe('lineFor：规范关系 → 某文件里的一行（A1）', () => {
  const rel = {
    id: 'r1',
    type: 'mentor',
    from: 'A',
    to: 'B',
    note: '传艺',
  };

  test('写在起点文件：->', () => {
    const line = lineFor('A', rel);
    assert.equal(line.direction, 'out');
    assert.equal(line.to, 'B');
    assert.equal(stringifyRelation(line), 'id=r1 mentor -> B | 传艺');
  });

  test('写在终点文件：<-', () => {
    const line = lineFor('B', rel);
    assert.equal(line.direction, 'in');
    assert.equal(line.to, 'A');
    assert.equal(stringifyRelation(line), 'id=r1 mentor <- A | 传艺');
  });

  test('两个文件各写一行，解析回来指向同一条规范关系', () => {
    for (const owner of ['A', 'B']) {
      const back = relationsOnly(parseRelations(stringifyRelation(lineFor(owner, rel))))[0];
      assert.deepEqual(canonicalize(owner, back), { from: 'A', to: 'B' });
    }
  });

  test('属性与备注一并保留', () => {
    const rich = { ...rel, since: 'D1', until: 'D2', reveal: 'D3', weight: 3, extra_props: { custom: 'x' } };
    const line = lineFor('B', rich);
    assert.equal(line.since, 'D1');
    assert.equal(line.until, 'D2');
    assert.equal(line.reveal, 'D3');
    assert.equal(line.weight, 3);
    assert.deepEqual(line.extra_props, { custom: 'x' });
  });
});
