/**
 * 一句话建关系的纯函数测试（R2）。
 *
 * 最容易错的是方向：作者说「老掌门是林远的师父」，起点其实是老掌门。
 * 这一组用例把「谁说谁」的四种情形都钉住。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ownerAndDirection,
  previewText,
  relationSentence,
  resolveSentence,
  roleWords,
  type RoleWord,
} from '../../web/src/lib/relation-sentence.ts';
import type { RelationTypeDef } from '../../shared/types.ts';

function def(patch: Partial<RelationTypeDef> & { key: string }): RelationTypeDef {
  return {
    label: patch.key,
    inverse_label: patch.key,
    directed: true,
    allowed: null,
    acyclic: false,
    exclusive_with: [],
    from_role: patch.key,
    to_role: patch.key,
    symmetric: false,
    ...patch,
  } as RelationTypeDef;
}

const TYPES: RelationTypeDef[] = [
  def({ key: 'mentor', label: '师徒', from_role: '师父', to_role: '徒弟' }),
  def({ key: 'ally', label: '盟友', from_role: '盟友', to_role: '盟友', symmetric: true, directed: false }),
];

const mentorFrom: RoleWord = { word: '师父', type: 'mentor', selfIsFrom: true };
const mentorTo: RoleWord = { word: '徒弟', type: 'mentor', selfIsFrom: false };
const ally: RoleWord = { word: '盟友', type: 'ally', selfIsFrom: null };

describe('roleWords：从类型表取角色词', () => {
  test('非对称类型出两个词', () => {
    const words = roleWords([TYPES[0]]);
    assert.deepEqual(
      words.map((w) => [w.word, w.selfIsFrom]),
      [
        ['师父', true],
        ['徒弟', false],
      ],
    );
  });

  test('对称类型只出一个词', () => {
    const words = roleWords([TYPES[1]]);
    assert.equal(words.length, 1);
    assert.equal(words[0].word, '盟友');
    assert.equal(words[0].selfIsFrom, null);
  });

  test('没有角色词的旧配置被跳过', () => {
    const legacy = def({ key: 'old', from_role: '', to_role: '' });
    assert.deepEqual(roleWords([legacy]), []);
  });
});

describe('resolveSentence：把句子翻成方向', () => {
  test('「老掌门 是 林远 的师父」→ 老掌门 → 林远', () => {
    const r = resolveSentence('lao', 'lin', mentorFrom);
    assert.equal(r.from, 'lao');
    assert.equal(r.to, 'lin');
    assert.equal(r.type, 'mentor');
    assert.equal(r.symmetric, false);
  });

  test('「苏晚 是 老掌门 的徒弟」→ 老掌门 → 苏晚（方向反过来）', () => {
    const r = resolveSentence('su', 'lao', mentorTo);
    assert.equal(r.from, 'lao');
    assert.equal(r.to, 'su');
  });

  test('对称类型无方向，只标记 symmetric', () => {
    const r = resolveSentence('a', 'b', ally);
    assert.equal(r.symmetric, true);
    assert.equal(r.type, 'ally');
  });
});

describe('ownerAndDirection：写进哪个文件、箭头朝哪', () => {
  test('当前条目是 x：写 x 的文件，方向 out', () => {
    const r = resolveSentence('x', 'y', mentorFrom);
    assert.deepEqual(ownerAndDirection('x', 'x', 'y', r), {
      owner: 'x',
      other: 'y',
      direction: 'out',
    });
  });

  test('当前条目是 y：写 y 的文件，方向 in（对方才是起点）', () => {
    const r = resolveSentence('x', 'y', mentorFrom); // from=x
    assert.deepEqual(ownerAndDirection('y', 'x', 'y', r), {
      owner: 'y',
      other: 'x',
      direction: 'in',
    });
  });

  test('「老掌门是林远的师父」在林远页面操作：写林远文件，箭头 <-', () => {
    // x=老掌门，y=林远，词「师父」指起点 → from=老掌门
    const r = resolveSentence('lao', 'lin', mentorFrom);
    const o = ownerAndDirection('lin', 'lao', 'lin', r);
    assert.equal(o.owner, 'lin');
    assert.equal(o.other, 'lao');
    assert.equal(o.direction, 'in');
  });

  test('当前条目与两端都无关：默认写 x', () => {
    const r = resolveSentence('x', 'y', mentorFrom);
    assert.deepEqual(ownerAndDirection('other', 'x', 'y', r), {
      owner: 'x',
      other: 'y',
      direction: 'out',
    });
  });

  test('当前条目为空：默认写 x', () => {
    const r = resolveSentence('x', 'y', mentorFrom);
    assert.equal(ownerAndDirection(null, 'x', 'y', r).owner, 'x');
  });
});

describe('previewText：提交前给作者看的一句话', () => {
  test('师父句式', () => {
    assert.equal(
      previewText('老掌门', '林远', mentorFrom, '师徒'),
      '将建立：老掌门 是 林远 的师父 （师徒，老掌门 → 林远）',
    );
  });

  test('徒弟句式方向相反', () => {
    assert.equal(
      previewText('苏晚', '老掌门', mentorTo, '师徒'),
      '将建立：苏晚 是 老掌门 的徒弟 （师徒，老掌门 → 苏晚）',
    );
  });

  test('对称关系标出来', () => {
    assert.match(previewText('甲', '乙', ally, '盟友'), /对称关系/);
  });
});

describe('relationSentence：详情页用一句话显示关系', () => {
  const nameOf = (id: string) => ({ lao: '老掌门', lin: '林远' })[id] ?? id;
  const labelOf = () => '师徒';
  const rolesOf = () => ({ from_role: '师父', to_role: '徒弟', symmetric: false });

  test('我是终点：我的师父是对方', () => {
    const s = relationSentence('lin', { from: 'lao', to: 'lin', type: 'mentor' }, nameOf, labelOf, rolesOf);
    assert.equal(s, '我的师父是 老掌门');
  });

  test('我是起点：我的徒弟是对方', () => {
    const s = relationSentence('lao', { from: 'lao', to: 'lin', type: 'mentor' }, nameOf, labelOf, rolesOf);
    assert.equal(s, '我的徒弟是 林远');
  });

  test('对称关系用「与…是…」', () => {
    const s = relationSentence(
      'a',
      { from: 'lao', to: 'lin', type: 'ally' },
      nameOf,
      () => '盟友',
      () => ({ from_role: '盟友', to_role: '盟友', symmetric: true }),
    );
    assert.equal(s, '老掌门 与 林远 是盟友');
  });
});
