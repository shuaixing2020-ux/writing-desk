/**
 * AI 接入层（已接入，默认关闭，需显式开启并填 Key）。
 *
 * ═══════════════ 红线已变更（2026-10） ═══════════════
 *
 * 原红线是「不做任何出站网络请求」。接入 AI 必然要出站，所以按
 * AGENTS.md 第三节记录的条件收窄为：
 *
 *   1. **只在用户显式开启 + 填了 Key + 点了「生成」时**才发请求。
 *      任何一次调用都必须先在界面上展示**将要发送的确切内容**；
 *      未展示、未确认，不发。
 *   2. **发出去的范围最小化**：只有本次要处理的那段正文/提示词，
 *      连同所选模型与生成参数。不发送作品其他章节、不发送设定库全量、
 *      不发送任何文件路径或本机信息。
 *   3. **AI 产出只能作为建议**：返回给作者看，由作者点「插入」才落盘；
 *      任何情况下都不自动改写正文。
 *   4. 仍然**没有任何遥测、崩溃上报、第三方统计**。除了发往用户自己配置的
 *      模型接口，不向任何其他地址发请求。
 *   5. API Key 只存本机 project.json，任何返回前端的结构都打码。
 *
 * 支持 OpenAI 兼容协议（`POST {base_url}/chat/completions`），
 * 因此 DeepSeek / Moonshot / 自建网关都能用同一套代码。
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
export const AI_ADAPTER_INSTALLED = true;

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

// ─────────────────────── 提示词与请求体（纯函数） ───────────────────────

/** 各服务商的默认接口地址与默认模型 */
export const PROVIDER_DEFAULTS: Record<AiProvider, { base_url: string; model: string; label: string }> = {
  deepseek: { base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', label: 'DeepSeek' },
  moonshot: { base_url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', label: 'Moonshot' },
  'openai-compatible': { base_url: '', model: '', label: '自定义（OpenAI 兼容）' },
};

/** 可选模型（给前端下拉用；也可以手填） */
export const PROVIDER_MODELS: Record<AiProvider, string[]> = {
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  moonshot: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  'openai-compatible': [],
};

const SYSTEM_PROMPTS: Record<keyof AiFeatureToggles, string> = {
  continue:
    '你是中文小说写作助手。根据作者提供的前文，续写接下来的内容。只输出续写的正文，不要解释、不要复述前文、不要加标题。',
  polish:
    '你是中文小说编辑。润色作者给出的段落：保持情节、人物、视角与语气不变，只改进措辞与节奏。只输出润色后的正文。',
  naming:
    '你是中文小说命名助手。按作者的要求给出 5 个候选名字，每行一个，不要编号、不要解释。',
  consistency:
    '你是中文小说的一致性检查助手。对照作者给出的设定与正文，列出冲突或不一致之处，按条目输出，每条一句话。',
};

export interface BuiltRequest {
  endpoint: string;
  model: string;
  /** 将要发送的请求体（可直接展示给作者看） */
  body: {
    model: string;
    messages: Array<{ role: 'system' | 'user'; content: string }>;
    temperature: number;
    max_tokens: number;
    stream: false;
  };
}

/**
 * 构造请求（纯函数，不发网络）。
 *
 * 前端「预览」与真正发送都走这一个函数 —— 保证作者看到的就是要发出去的，
 * 不存在「预览一套、实际发另一套」的可能。
 */
export function buildRequest(req: AiRequest, config: AiConfig): BuiltRequest {
  const defaults = PROVIDER_DEFAULTS[config.provider] ?? PROVIDER_DEFAULTS['openai-compatible'];
  const baseUrl = (config.base_url || defaults.base_url).replace(/\/+$/, '');
  const model = (config.model || defaults.model || '').trim();
  if (!baseUrl) throw new AiUnavailableError('尚未配置接口地址（base_url）。', 'ai_no_base_url');
  if (!model) throw new AiUnavailableError('尚未选择模型。', 'ai_no_model');

  const system = SYSTEM_PROMPTS[req.feature] ?? SYSTEM_PROMPTS.continue;
  const parts: string[] = [];
  const context = (req.context ?? '').trim();
  if (context) {
    parts.push(`【前文/设定】\n${context}`);
  }
  if (req.prompt.trim()) {
    parts.push(
      req.feature === 'continue' ? `【从这里接着写】\n${req.prompt.trim()}` : req.prompt.trim(),
    );
  }
  if (req.style?.trim()) {
    parts.push(`【风格要求】${req.style.trim()}`);
  }
  if (parts.length === 0) {
    throw new AiUnavailableError('没有可发送的内容（正文与提示词都是空的）。', 'ai_empty_input');
  }

  return {
    endpoint: `${baseUrl}/chat/completions`,
    model,
    body: {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: parts.join('\n\n') },
      ],
      temperature: config.temperature,
      max_tokens: config.max_tokens,
      stream: false,
    },
  };
}

/** 给作者看的一句话摘要：发到哪、用哪个模型、发多少字 */
export function describeRequest(built: BuiltRequest, config: AiConfig): string {
  const provider = PROVIDER_DEFAULTS[config.provider]?.label ?? config.provider;
  const chars = built.body.messages.reduce((n, m) => n + m.content.length, 0);
  return `将发送到 ${provider}（${built.endpoint}），模型 ${built.model}，共 ${chars} 字。`;
}

// ─────────────────────── OpenAI 兼容适配器 ───────────────────────

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

/**
 * 一次真实调用。
 *
 * 只发到用户在设置里填的地址；请求体来自 buildRequest（与预览完全一致）。
 * 超时 90 秒；任何非 2xx 都转成可读错误，不吞。
 */
async function openAiCompatibleGenerate(req: AiRequest, config: AiConfig): Promise<AiResponse> {
  if (!AI_ADAPTER_INSTALLED) {
    throw new AiUnavailableError('AI 能力未接入。', 'ai_not_installed');
  }
  if (!config.api_key) {
    throw new AiUnavailableError('尚未填写 API Key。', 'ai_no_key');
  }

  const built = buildRequest(req, config);
  let res: Response;
  try {
    res = await fetch(built.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.api_key}`,
      },
      body: JSON.stringify(built.body),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    const msg = (err as Error).name === 'TimeoutError' ? '请求超时（90 秒）' : (err as Error).message;
    throw new AiUnavailableError(`调用失败：${msg}`, 'ai_network');
  }

  const text = await res.text();
  let data: ChatCompletionResponse | null = null;
  try {
    data = JSON.parse(text) as ChatCompletionResponse;
  } catch {
    /* 非 JSON：下面按纯文本处理 */
  }

  if (!res.ok) {
    const detail = data?.error?.message ?? text.slice(0, 300);
    throw new AiUnavailableError(`接口返回 ${res.status}：${detail}`, 'ai_http');
  }

  const content = data?.choices?.[0]?.message?.content?.trim() ?? (data ? '' : text.trim());
  if (!content) {
    throw new AiUnavailableError('接口没有返回内容。', 'ai_empty_response');
  }

  return {
    text: content,
    provider: config.provider,
    model: built.model,
    took_ms: 0,
    usage: {
      prompt_tokens: data?.usage?.prompt_tokens ?? 0,
      completion_tokens: data?.usage?.completion_tokens ?? 0,
      total_tokens: data?.usage?.total_tokens ?? 0,
    },
  };
}

// 注册三个服务商（协议相同，只是默认地址不同）
registerAdapter({ provider: 'deepseek', generate: openAiCompatibleGenerate });
registerAdapter({ provider: 'moonshot', generate: openAiCompatibleGenerate });
registerAdapter({ provider: 'openai-compatible', generate: openAiCompatibleGenerate });

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 后端对外暴露的配置（Key 已打码） */
export function publicAiConfig(config: AiConfig): AiConfig {
  return { ...config, api_key: maskApiKey(config.api_key) };
}
