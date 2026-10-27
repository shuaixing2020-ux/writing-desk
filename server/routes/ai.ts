/**
 * AI 路由（预留接口，默认关闭）。
 *
 * GET    /api/projects/:pid/ai          → { config: AiConfig（Key 已打码）, status: AiStatus }
 * PATCH  /api/projects/:pid/ai          → 更新配置（Key 打码值不会被当成真 Key）
 * POST   /api/projects/:pid/ai/generate → 执行一次请求（当前恒返回「未接入」）
 *
 * 为什么把 generate 也实现出来：
 *   前端按钮与错误提示可以先接好，将来装上一个适配器就能用。
 *   但服务层的 generate() 在 AI_ADAPTER_INSTALLED = false 时会在任何
 *   网络调用之前抛出，所以这条路由目前**不会产生任何出站请求**。
 */

import type { FastifyInstance } from 'fastify';
import type { AiConfig } from '../../shared/types.ts';
import type { AppContextImpl } from '../app-context.ts';
import { projectOf, badRequest } from './shared.ts';
import {
  AiUnavailableError,
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
    };

    const feature = body.feature as keyof typeof meta.ai.features;
    if (!feature || !(feature in meta.ai.features)) {
      throw badRequest('未指定有效的 AI 能力', 'bad_feature');
    }

    try {
      const result = await generate(
        {
          feature,
          prompt: typeof body.prompt === 'string' ? body.prompt.slice(0, 20000) : '',
          context: typeof body.context === 'string' ? body.context.slice(0, 20000) : '',
          style: typeof body.style === 'string' ? body.style.slice(0, 200) : undefined,
        },
        meta.ai,
      );
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
