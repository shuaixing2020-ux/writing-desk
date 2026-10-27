/**
 * AI 接入层单元测试。
 *
 * 这层最重要的不是「能不能生成」，而是**保证不该发生时绝不发生**：
 *   - 默认关闭
 *   - 未接入时代理不发请求
 *   - API Key 永不完整回传
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_ADAPTER_INSTALLED,
  AiUnavailableError,
  enabledFeatures,
  generate,
  getAiStatus,
  maskApiKey,
  mergeAiConfig,
  publicAiConfig,
} from '../../server/services/ai.ts';
import { DEFAULT_AI_CONFIG, type AiConfig } from '../../shared/types.ts';

type CfgPatch = Partial<Omit<AiConfig, 'features'>> & { features?: Partial<AiConfig['features']> };

function cfg(patch: CfgPatch = {}): AiConfig {
  return {
    ...structuredClone(DEFAULT_AI_CONFIG),
    ...patch,
    features: { ...DEFAULT_AI_CONFIG.features, ...(patch.features ?? {}) },
  };
}

describe('AI 默认关闭', () => {
  test('默认配置是关闭的，且所有能力关闭', () => {
    assert.equal(DEFAULT_AI_CONFIG.enabled, false);
    assert.equal(DEFAULT_AI_CONFIG.api_key, '');
    for (const v of Object.values(DEFAULT_AI_CONFIG.features)) {
      assert.equal(v, false);
    }
  });

  test('当前版本没有安装适配器', () => {
    assert.equal(AI_ADAPTER_INSTALLED, false);
  });

  test('默认配置下 status.available 为 false', () => {
    const st = getAiStatus(DEFAULT_AI_CONFIG);
    assert.equal(st.available, false);
    assert.equal(st.enabled, false);
    assert.deepEqual(st.features, []);
    assert.ok(st.missing.length > 0, '应列出缺失项');
  });
});

describe('AI 调用拦截（零出站请求）', () => {
  test('未启用时直接拒绝，不调用适配器', async () => {
    await assert.rejects(
      () => generate({ feature: 'continue', prompt: 'x' }, cfg({ api_key: 'sk-x' })),
      (err: unknown) => err instanceof AiUnavailableError && err.code === 'ai_disabled',
    );
  });

  test('启用但未开启该能力时拒绝', async () => {
    await assert.rejects(
      () => generate({ feature: 'continue', prompt: 'x' }, cfg({ enabled: true, api_key: 'sk-x' })),
      (err: unknown) => err instanceof AiUnavailableError && err.code === 'ai_feature_disabled',
    );
  });

  test('启用且开启能力，但没有 API Key 时拒绝', async () => {
    await assert.rejects(
      () =>
        generate(
          { feature: 'continue', prompt: 'x' },
          cfg({ enabled: true, features: { continue: true } }),
        ),
      (err: unknown) => err instanceof AiUnavailableError && err.code === 'ai_no_key',
    );
  });

  test('全部条件满足但因未安装适配器仍被拦截', async () => {
    await assert.rejects(
      () =>
        generate(
          { feature: 'continue', prompt: 'x' },
          cfg({ enabled: true, api_key: 'sk-live', features: { continue: true } }),
        ),
      (err: unknown) => err instanceof AiUnavailableError && err.code === 'ai_not_installed',
    );
  });
});

describe('API Key 保护', () => {
  test('打码只保留后四位', () => {
    assert.equal(maskApiKey('sk-1234567890abcd'), '****abcd');
    // 恰好 4 字符及以下看不出后四位差异，整体打码
    assert.equal(maskApiKey('abcd'), '****');
    assert.equal(maskApiKey('abc'), '****');
    assert.equal(maskApiKey(''), '');
  });

  test('对外配置里 Key 一定是打码的', () => {
    const pub = publicAiConfig(cfg({ api_key: 'sk-real-key-99xy' }));
    assert.equal(pub.api_key, '****99xy');
    assert.ok(!pub.api_key.includes('real'));
  });

  test('回传打码值不会覆盖真实 Key', () => {
    const current = cfg({ api_key: 'sk-real-key-99xy' });
    const merged = mergeAiConfig(current, { api_key: '****99xy' });
    assert.equal(merged.api_key, 'sk-real-key-99xy', '打码值不应写入磁盘');
  });

  test('空字符串表示显式清空 Key', () => {
    const current = cfg({ api_key: 'sk-real' });
    const merged = mergeAiConfig(current, { api_key: '' });
    assert.equal(merged.api_key, '');
  });

  test('正常新 Key 会被写入', () => {
    const current = cfg({ api_key: 'old' });
    const merged = mergeAiConfig(current, { api_key: 'sk-new-key' });
    assert.equal(merged.api_key, 'sk-new-key');
  });
});

describe('配置合并', () => {
  test('能力开关局部更新不影响其他项', () => {
    const current = cfg({ features: { continue: true, polish: true } });
    const merged = mergeAiConfig(current, { features: { polish: false } as never });
    assert.equal(merged.features.continue, true);
    assert.equal(merged.features.polish, false);
  });

  test('温度与 max_tokens 被夹紧到合法范围', () => {
    const merged = mergeAiConfig(cfg(), { temperature: 99, max_tokens: -5 });
    assert.equal(merged.temperature, 2);
    assert.equal(merged.max_tokens, 1);
  });

  test('非法数值回退到原值', () => {
    const current = cfg({ temperature: 0.8 });
    const merged = mergeAiConfig(current, { temperature: Number.NaN });
    assert.equal(merged.temperature, 0.8);
  });

  test('enabledFeatures 只返回开启的项', () => {
    const f = enabledFeatures(cfg({ features: { naming: true } }));
    assert.deepEqual(f, ['naming']);
  });
});
