/**
 * 运维接口（本机专用）。
 *
 * 唯一用途：让网页上的「重启服务」按钮能真的重启，不用回终端敲命令。
 *
 * 安全边界：
 *   - 只接受来自本机回环地址的请求（服务默认也只监听 127.0.0.1）
 *   - 只在被 scripts/start.mjs 监督时可用（否则重启后没人拉起，
 *     进程直接没了，作者会以为工具崩了）—— 这时返回 501 并说明原因
 *   - 不做任何构建、不写稿件，只发一个退出码让监督进程重启
 */

import type { FastifyInstance } from 'fastify';
import type { AppContextImpl } from '../app-context.ts';

/** 监督进程约定：子进程以这个退出码结束 = 请重启我 */
export const RESTART_EXIT_CODE = 75;

function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

export function registerSystemRoutes(app: FastifyInstance, _appCtx: AppContextImpl): void {
  /** 页面用来确认服务是否活着（重启后轮询这个） */
  app.get('/api/system/supervised', async () => ({
    supervised: process.env.WD_SUPERVISED === '1',
    pid: process.pid,
    node: process.version,
    uptime_s: Math.round(process.uptime()),
  }));

  app.post('/api/system/restart', async (request, reply) => {
    if (!isLoopback(request.ip)) {
      return reply.code(403).send({ error: '只允许本机发起重启', code: 'not_local' });
    }
    if (process.env.WD_SUPERVISED !== '1') {
      return reply.code(501).send({
        error:
          '当前进程不是由 scripts/start.mjs 启动的，重启后不会被拉起。请改用 npm run serve 启动。',
        code: 'not_supervised',
      });
    }

    // 先让响应发出去，再退出；否则页面只会看到连接被重置
    setTimeout(() => {
      console.log('[system] 收到网页重启请求，退出以便监督进程重新拉起');
      process.exit(RESTART_EXIT_CODE);
    }, 150);

    return { ok: true, restarting: true };
  });
}
