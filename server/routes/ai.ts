/**
 * AI 路由（预留接口，默认关闭）。
 *
 * GET    /api/projects/:pid/ai          → { config: AiConfig（Key 已打码）, status: AiStatus }
 * PATCH  /api/projects/:pid/ai          → 更新配置（Key 打码值不会被当成真 Key）
 * GET    /api/projects/:pid/ai/providers → 可选服务商与模型
 * POST   /api/projects/:pid/ai/generate  → 执行一次请求；dry_run=true 只回预览
 *
 * 出站边界：只有「用户开启 + 填 Key + 点击生成」才会真的发请求；
 * dry_run 分支只构造请求体、绝不发网络。requests 只发往用户在设置里
 * 填的 base_url（默认 DeepSeek / Moonshot 官方地址）。
 */

import type { FastifyInstance } from 'fastify';
import type { AiConfig } from '../../shared/types.ts';
import type { AppContextImpl } from '../app-context.ts';
import { projectOf, badRequest } from './shared.ts';
import {
  AiUnavailableError,
  PROVIDER_DEFAULTS,
  PROVIDER_MODELS,
  buildRequest,
  describeRequest,
  generate,
  getAiStatus,
  mergeAiConfig,
  publicAiConfig,
} from '../services/ai.ts';

export function registerAiRoutes(app: FastifyInstance, appCtx: AppContextImpl): void {
  app.get('/api/projects/:pid/ai', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    const meta = await ctx.store.readMeta();
    return {
      config: publicAiConfig(meta.ai),
      status: getAiStatus(meta.ai),
    };
  });

  /** 可选服务商与模型（前端下拉用；也允许手填自定义模型） */
  app.get('/api/projects/:pid/ai/providers', async () => ({
    providers: (Object.keys(PROVIDER_DEFAULTS) as Array<keyof typeof PROVIDER_DEFAULTS>).map((key) => ({
      key,
      label: PROVIDER_DEFAULTS[key].label,
      base_url: PROVIDER_DEFAULTS[key].base_url,
      default_model: PROVIDER_DEFAULTS[key].model,
      models: PROVIDER_MODELS[key],
    })),
  }));

  app.patch('/api/projects/:pid/ai', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    const meta = await ctx.store.readMeta();
    const body = (request.body ?? {}) as Partial<AiConfig>;

    // provider 白名单校验
    if (body.provider !== undefined) {
      const allowed = ['deepseek', 'moonshot', 'openai-compatible'];
      if (!allowed.includes(body.provider)) {
        throw badRequest('不支持的服务商', 'bad_provider');
      }
    }
    if (body.base_url !== undefined && typeof body.base_url !== 'string') {
      throw badRequest('base_url 必须是字符串');
    }
    // 长度保护：避免把超大内容写进 project.json
    if (typeof body.base_url === 'string' && body.base_url.length > 500) {
      throw badRequest('base_url 过长');
    }
    if (typeof body.api_key === 'string' && body.api_key.length > 500) {
      throw badRequest('API Key 过长');
    }

    const merged = mergeAiConfig(meta.ai, body);
    const nextMeta = await ctx.store.updateMeta({ ai: merged });

    return {
      config: publicAiConfig(nextMeta.ai),
      status: getAiStatus(nextMeta.ai),
    };
  });

  app.post('/api/projects/:pid/ai/generate', async (request, reply) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    const meta = await ctx.store.readMeta();
    const body = (request.body ?? {}) as {
      feature?: string;
      prompt?: string;
      context?: string;
      style?: string;
      dry_run?: boolean;
    };

    const feature = body.feature as keyof typeof meta.ai.features;
    if (!feature || !(feature in meta.ai.features)) {
      throw badRequest('未指定有效的 AI 能力', 'bad_feature');
    }

    const draft = {
      feature,
      prompt: typeof body.prompt === 'string' ? body.prompt.slice(0, 20000) : '',
      context: typeof body.context === 'string' ? body.context.slice(0, 20000) : '',
      style: typeof body.style === 'string' ? body.style.slice(0, 200) : undefined,
    };

    // 预览：只构造请求并返回「将要发送的内容」，不发任何网络请求。
    // 界面必须先展示它，作者确认后才允许真正生成（见 AGENTS.md 的 AI 段落）。
    if (body.dry_run === true) {
      try {
        const built = buildRequest(draft, meta.ai);
        return {
          preview: {
            endpoint: built.endpoint,
            model: built.model,
            provider: meta.ai.provider,
            description: describeRequest(built, meta.ai),
            messages: built.body.messages,
            temperature: built.body.temperature,
            max_tokens: built.body.max_tokens,
          },
        };
      } catch (err) {
        if (err instanceof AiUnavailableError) {
          return reply.code(503).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }

    try {
      const result = await generate(draft, meta.ai);
      return result;
    } catch (err) {
      if (err instanceof AiUnavailableError) {
        // 这不算服务器错误：是「功能未接入/未启用」的正常状态
        return reply.code(503).send({ error: err.message, code: err.code });
      }
      throw err;
    }
  });
}
