/**
 * 标点规整单元测试。
 *
 * 这块逻辑直接改写作者正文，所以每条规则都要有测试，
 * 尤其要保证：幂等、不破坏英文/数字、不碰代码块。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePunctuation,
  normalizePunctuationSafe,
  punctuationDiffCount,
} from '../../server/util/punctuation.ts';

describe('标点规整', () => {
  test('省略号：ASCII 三点 → ……', () => {
    assert.equal(normalizePunctuation('他走了...'), '他走了……');
    assert.equal(normalizePunctuation('等等....'), '等等……');
  });

  test('省略号：中文句号三连 → ……', () => {
    assert.equal(normalizePunctuation('他走了。。。'), '他走了……');
  });

  test('省略号：已规范的不再变', () => {
    assert.equal(normalizePunctuation('他走了……'), '他走了……');
  });

  test('破折号：-- 与 — → ——', () => {
    assert.equal(normalizePunctuation('他说--然后走了'), '他说——然后走了');
    assert.equal(normalizePunctuation('他说—然后走了'), '他说——然后走了');
  });

  test('重复感叹号与问号折叠', () => {
    assert.equal(normalizePunctuation('太好了！！！'), '太好了！');
    assert.equal(normalizePunctuation('真的？？？'), '真的？');
  });

  test('半角标点在中语境转全角', () => {
    assert.equal(normalizePunctuation('他说,好'), '他说，好');
    assert.equal(normalizePunctuation('结束了.走了'), '结束了。走了');
    assert.equal(normalizePunctuation('你说什么?我不信'), '你说什么？我不信');
    assert.equal(normalizePunctuation('注意:这里'), '注意：这里');
    assert.equal(normalizePunctuation('第一;第二'), '第一；第二');
  });

  test('不破坏英文与数字', () => {
    assert.equal(normalizePunctuation('Hello, world.'), 'Hello, world.');
    assert.equal(normalizePunctuation('价格是3.14元'), '价格是3.14元');
    assert.equal(normalizePunctuation('a, b, c'), 'a, b, c');
  });

  test('中文与标点间多余空格被清理', () => {
    assert.equal(normalizePunctuation('你好 ，世界'), '你好，世界');
    assert.equal(normalizePunctuation('你好， 世界'), '你好，世界');
  });

  test('空文本安全', () => {
    assert.equal(normalizePunctuation(''), '');
  });

  test('幂等：连续应用结果不变', () => {
    const samples = [
      '他走了...',
      '太好了！！！',
      '他说,好',
      '你好 ，世界',
      '正常的一段话，没有标点问题。',
      '他说……然后走了！',
    ];
    for (const s of samples) {
      const once = normalizePunctuation(s);
      const twice = normalizePunctuation(once);
      assert.equal(twice, once, `不幂等: ${JSON.stringify(s)}`);
    }
  });
});

describe('标点规整（代码块保护）', () => {
  test('围栏代码块内不改写', () => {
    const input = '正常文字...\n\n```js\nconst a = 1...2;\n```\n\n更多文字...';
    const out = normalizePunctuationSafe(input);
    assert.ok(out.includes('1...2'), '代码块内容被改坏了');
    assert.ok(out.includes('正常文字……'));
    assert.ok(out.includes('更多文字……'));
  });

  test('行内代码内不改写', () => {
    const input = '执行 `a...b` 这个命令...';
    const out = normalizePunctuationSafe(input);
    assert.ok(out.includes('a...b'), '行内代码被改坏了');
  });

  test('纯小说正文走快路径且结果正确', () => {
    const input = '夜雨敲窗...山门外一片寂静！！！';
    assert.equal(normalizePunctuationSafe(input), '夜雨敲窗……山门外一片寂静！');
  });
});

describe('规整差异计数', () => {
  test('无变化返回 null', () => {
    assert.equal(punctuationDiffCount('一样的', '一样的'), null);
  });

  test('有变化返回受影响段落数', () => {
    const before = '第一段...\n\n第二段没问题\n\n第三段！！！';
    const after = '第一段……\n\n第二段没问题\n\n第三段！';
    assert.equal(punctuationDiffCount(before, after), 2);
  });
});
