/**
 * AI 请求构造测试（R2 之后的新能力）。
 *
 * 这里一个网络请求都不发：只验证「将发送什么」——
 * 发到哪个地址、用哪个模型、消息里到底带了哪些内容。
 * 这些正是作者在预览里看到的东西，必须与真正发出的一致。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildRequest, describeRequest, PROVIDER_DEFAULTS } from '../../server/services/ai.ts';
import { DEFAULT_AI_CONFIG, type AiConfig } from '../../shared/types.ts';

function cfg(patch: Partial<AiConfig> = {}): AiConfig {
  return { ...DEFAULT_AI_CONFIG, ...patch } as AiConfig;
}

describe('buildRequest', () => {
  test('默认服务商地址与模型', () => {
    const built = buildRequest(
      { feature: 'continue', prompt: '接着写', context: '前文' },
      cfg({ provider: 'deepseek' }),
    );
    assert.equal(built.endpoint, 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(built.model, 'deepseek-chat');
  });

  test('自定义 base_url 与模型优先', () => {
    const built = buildRequest(
      { feature: 'continue', prompt: 'x', context: '' },
      cfg({ provider: 'openai-compatible', base_url: 'https://my-gw.example/v1', model: 'my-model' }),
    );
    assert.equal(built.endpoint, 'https://my-gw.example/v1/chat/completions');
    assert.equal(built.model, 'my-model');
  });

  test('base_url 末尾斜杠会被清掉，不会拼出双斜杠', () => {
    const built = buildRequest(
      { feature: 'continue', prompt: 'x' },
      cfg({ provider: 'openai-compatible', base_url: 'https://gw.example/v1///', model: 'm' }),
    );
    assert.equal(built.endpoint, 'https://gw.example/v1/chat/completions');
  });

  test('只带上下文与指令，不带其他章节', () => {
    const built = buildRequest(
      { feature: 'continue', prompt: '接着写', context: '只这一段前文' },
      cfg({ provider: 'deepseek' }),
    );
    const user = built.body.messages.find((m) => m.role === 'user')!.content;
    assert.match(user, /只这一段前文/);
    assert.match(user, /接着写/);
    assert.equal(built.body.messages.length, 2, '一条 system + 一条 user');
  });

  test('生成参数透传', () => {
    const built = buildRequest(
      { feature: 'continue', prompt: 'x' },
      cfg({ provider: 'deepseek', temperature: 0.7, max_tokens: 800 }),
    );
    assert.equal(built.body.temperature, 0.7);
    assert.equal(built.body.max_tokens, 800);
    assert.equal(built.body.stream, false);
  });

  test('没有地址或模型时明确报错', () => {
    assert.throws(
      () => buildRequest({ feature: 'continue', prompt: 'x' }, cfg({ provider: 'openai-compatible', base_url: '', model: '' })),
      /接口地址|模型/,
    );
  });

  test('正文与指令都为空时报错，不发空请求', () => {
    assert.throws(
      () => buildRequest({ feature: 'continue', prompt: '', context: '' }, cfg({ provider: 'deepseek' })),
      /没有可发送的内容/,
    );
  });

  test('三种服务商都有默认地址', () => {
    for (const [key, val] of Object.entries(PROVIDER_DEFAULTS)) {
      assert.ok(typeof val.label === 'string' && val.label.length > 0, `${key} 缺 label`);
    }
  });
});

describe('describeRequest', () => {
  test('摘要里含服务商、地址、模型与字数', () => {
    const config = cfg({ provider: 'deepseek' });
    const built = buildRequest({ feature: 'continue', prompt: '接着写', context: '前文' }, config);
    const text = describeRequest(built, config);
    assert.match(text, /DeepSeek/);
    assert.match(text, /chat\/completions/);
    assert.match(text, /deepseek-chat/);
    assert.match(text, /\d+ 字/);
  });
});
