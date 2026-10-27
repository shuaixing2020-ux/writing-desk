/**
 * AI 接入层（预留，默认关闭）。
 *
 * 架构方案第 0 节的决策：**AI 先不接，只在架构上预留接口，默认关闭**。
 * 本文件是这个预留位的实现。
 *
 * ═══════════════════ 三条硬约束 ═══════════════════
 *
 * 1. **零出站请求**
 *    本模块**不 import 任何 HTTP 客户端**，也不注册任何适配器。
 *    AiService 的 generate() 在没有适配器时直接抛「未接入」，
 *    不发起任何网络连接。将来若要真的接入，必须新增一个显式安装适配器的
 *    步骤（见 registerAdapter），并同步修改 AGENTS.md 的红线说明。
 *
 * 2. **Key 不出本机**
 *    api_key 存在项目的 project.json（本机磁盘），
 *    读取时（getStatus / 任何返回给前端的结构）一律打码，只回传后四位。
 *    本工具没有任何遥测、没有 crash 上报，Key 不会被带出去。
 *
 * 3. **结果必须人工确认**
 *    即便将来接入，AI 产出只能是「建议」：
 *    不允许自动改写正文，必须在编辑器里由作者确认后才落盘。
 *    这条写在接口注释与前端交互里，防止后人图省事直接覆盖。
 */

import type {
  AiAdapter,
  AiConfig,
  AiFeatureToggles,
  AiProvider,
  AiRequest,
  AiResponse,
  AiStatus,
} from '../../shared/types.ts';
import { AI_FEATURE_LABELS, DEFAULT_AI_CONFIG } from '../../shared/types.ts';

/** AI 未接入或未启用时的统一错误 */
export class AiUnavailableError extends Error {
  code: string;
  constructor(message: string, code = 'ai_unavailable') {
    super(message);
    this.name = 'AiUnavailableError';
    this.code = code;
  }
}

/**
 * 当前版本的可接入能力开关。
 *
 * 这是整个 AI 功能的**总闸**：为 false 时，即使项目配置里 ai.enabled = true，
 * 也不会产生任何调用。将来实现了真正的适配器，把这里改成 true 即可。
 *
 * 当前恒为 false —— 表示「接口已预留，能力未接入」。
 */
export const AI_ADAPTER_INSTALLED = false;

/** 已注册的适配器（当前为空） */
const adapters = new Map<AiProvider, AiAdapter>();

/**
 * 注册适配器。**当前代码库中没有任何调用点**。
 *
 * 这是给未来实现者留的唯一入口。新增适配器时必须：
 *   1. 在 AGENTS.md 里更新「不做任何出站网络请求」这条红线
 *   2. 让用户显式同意后才启用
 *   3. 在界面上能预览将要发送的内容
 */
export function registerAdapter(adapter: AiAdapter): void {
  adapters.set(adapter.provider, adapter);
}

/** 当前状态：给前端展示用 */
export function getAiStatus(config?: AiConfig): AiStatus {
  const enabled = config?.enabled ?? false;
  const missing: string[] = [];

  if (!AI_ADAPTER_INSTALLED) {
    missing.push('AI 能力尚未接入（当前版本只预留接口，不发起任何请求）');
  }
  if (!enabled) {
    missing.push('尚未在设置中开启 AI');
  }
  if (!config?.api_key) {
    missing.push('尚未填写 API Key');
  }
  const features = enabledFeatures(config);
  if (features.length === 0) {
    missing.push('尚未开启任何能力');
  }

  return {
    available: AI_ADAPTER_INSTALLED,
    enabled,
    missing,
    features,
  };
}

/** 已开启的能力列表 */
export function enabledFeatures(config?: AiConfig): Array<keyof AiFeatureToggles> {
  const f = config?.features ?? DEFAULT_AI_CONFIG.features;
  return (Object.keys(f) as Array<keyof AiFeatureToggles>).filter((k) => f[k] === true);
}

/**
 * 执行一次 AI 请求。
 *
 * 当前实现：校验通过后抛「未接入」，**不发任何网络请求**。
 * 前端的按钮因此永远不可用，界面会显示「接口已预留」。
 */
export async function generate(req: AiRequest, config: AiConfig): Promise<AiResponse> {
  const status = getAiStatus(config);

  if (!config.enabled) {
    throw new AiUnavailableError('AI 未启用。请先在设置的「AI 接入」里开启。', 'ai_disabled');
  }
  if (!status.features.includes(req.feature)) {
    throw new AiUnavailableError(
      `「${AI_FEATURE_LABELS[req.feature]}」未开启。请先在设置里单独开启该能力。`,
      'ai_feature_disabled',
    );
  }
  if (!config.api_key) {
    throw new AiUnavailableError('尚未填写 API Key。', 'ai_no_key');
  }

  if (!AI_ADAPTER_INSTALLED || adapters.size === 0) {
    // 刻意在真正发请求之前拦住 —— 这是「零出站请求」的最后一道闸
    throw new AiUnavailableError(
      'AI 能力尚未接入。当前版本只预留了接口与配置位，不会发起任何网络请求。',
      'ai_not_installed',
    );
  }

  const adapter = adapters.get(config.provider);
  if (!adapter) {
    throw new AiUnavailableError(`服务商「${config.provider}」没有可用的适配器。`, 'ai_no_adapter');
  }

  const t0 = Date.now();
  const res = await adapter.generate(req, config);
  return { ...res, took_ms: Date.now() - t0 };
}

/** API Key 打码：只保留后四位，避免任何回传路径泄露完整 key */
export function maskApiKey(key: string): string {
  if (!key) return '';
  const trimmed = key.trim();
  if (trimmed.length <= 4) return '****';
  return `****${trimmed.slice(-4)}`;
}

/**
 * 合并前端提交的 AI 配置。
 *
 * 关键安全点：前端拿到的 api_key 是打码值（****abcd）。
 * 如果它原样回传，不能把打码值当成真 Key 写进磁盘 —— 否则用户的 Key 就被
 * 一串星号覆盖了，下次调用全失败且无从察觉。
 * 所以这里判断：只有「不是打码值」时才更新 key。
 */
export function mergeAiConfig(current: AiConfig, patch: Partial<AiConfig>): AiConfig {
  const next: AiConfig = {
    ...current,
    ...patch,
    features: { ...current.features, ...(patch.features ?? {}) },
  };

  // 打码值原样回传 → 保留原 Key
  if (typeof patch.api_key === 'string' && patch.api_key.startsWith('****')) {
    next.api_key = current.api_key;
  }
  // 空字符串表示「清空 Key」，这是显式意图，允许
  if (typeof patch.api_key === 'string' && patch.api_key.trim() === '') {
    next.api_key = '';
  }

  // 数值夹紧
  next.temperature = clamp(next.temperature, 0, 2, current.temperature);
  next.max_tokens = Math.round(clamp(next.max_tokens, 1, 32000, current.max_tokens));

  return next;
}

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 后端对外暴露的配置（Key 已打码） */
export function publicAiConfig(config: AiConfig): AiConfig {
  return { ...config, api_key: maskApiKey(config.api_key) };
}
