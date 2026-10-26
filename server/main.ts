/**
 * 写作台服务启动入口。
 *
 * 一个进程、一个端口：REST API + WebSocket + 前端静态文件。
 * 这是「本地常驻服务」模型的落点（架构 5.3）：没有开发服务器、没有跨域、没有外网。
 *
 * 安全底线（架构 7.9）：
 *   - 默认只监听 127.0.0.1，局域网外不可达
 *   - WD_LAN=1 才监听 0.0.0.0，且启动日志必须醒目提示风险
 *   - 全进程不发起任何出站网络请求
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { WsEvent } from '../shared/types.ts';
import type { AppContextImpl } from './app-context.ts';
import { createAppContext, listProjectSummaries } from './app-context.ts';
import { HttpError } from './routes/shared.ts';
import { registerProjectRoutes } from './routes/projects.ts';
import { registerMetaRoutes } from './routes/meta.ts';
import { registerDocRoutes } from './routes/docs.ts';
import { registerEntityRoutes } from './routes/entities.ts';
import { registerSearchRoutes } from './routes/search.ts';
import { registerLintRoutes } from './routes/lint.ts';
import { registerSnapshotRoutes } from './routes/snapshots.ts';
import { registerTrashRoutes } from './routes/trash.ts';
import { registerInboxRoutes } from './routes/inbox.ts';
import { registerIoRoutes } from './routes/io.ts';
import { registerBackupRoutes } from './routes/backup.ts';
import { registerJobRoutes } from './routes/jobs.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIST = path.join(REPO_ROOT, 'web', 'dist');

const DEFAULT_PORT = 7788;
const WS_PING_INTERVAL_MS = 30_000;

interface WsClient {
  send(data: string): void;
  close(): void;
  on(event: 'close' | 'error', cb: () => void): void;
}

export async function buildServer(dataDir: string): Promise<{
  app: FastifyInstance;
  appCtx: AppContextImpl;
}> {
  const appCtx = createAppContext(dataDir);

  const app = Fastify({
    logger: false,
    // 作品正文单次保存可能到几百 KB；默认 1MB 对长章够用，留足余量
    bodyLimit: 8 * 1024 * 1024,
  });

  /**
   * 前端 api.ts 的 request() 给所有请求（含 DELETE）都带了
   * `content-type: application/json`，但 DELETE 没有 body。
   * Fastify 默认解析器遇到「声明了 JSON 但 body 为空」会直接 400
   * （FST_ERR_CTP_EMPTY_JSON_BODY），导致所有删除类接口全挂。
   * 这里把空 body 视作 {} —— 语义正确，且对带 body 的请求行为不变。
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body: string, done) => {
      const text = body.trim();
      if (!text) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        const e = err as Error & { statusCode?: number };
        e.statusCode = 400;
        e.message = `请求体不是合法 JSON：${e.message}`;
        done(e, undefined);
      }
    },
  );

  // ─────────────────────── WebSocket ───────────────────────

  const clients = new Set<WsClient>();

  await app.register(fastifyWebsocket, {
    options: { maxPayload: 1024 * 1024 },
  });

  app.get('/ws', { websocket: true }, (socket) => {
    const client = socket as unknown as WsClient;
    clients.add(client);

    client.send(JSON.stringify({ type: 'ping', t: Date.now() } satisfies WsEvent));

    socket.on('close', () => clients.delete(client));
    socket.on('error', () => clients.delete(client));
    // 前端不发业务消息；收到任何消息只当心跳，不解析（不信任客户端输入）
    socket.on('message', () => {
      /* 忽略 */
    });
  });

  appCtx.setBroadcast((event: unknown) => {
    const payload = JSON.stringify(event);
    for (const client of clients) {
      try {
        client.send(payload);
      } catch {
        clients.delete(client);
      }
    }
  });

  // 作业进度 → WebSocket。这是前端状态栏作业进度的唯一来源。
  appCtx.jobs.onUpdate((job) => {
    appCtx.broadcast({ type: 'job', job } satisfies WsEvent);
  });

  // 心跳：定期发 ping，让前端能判断连接是否还活着（并顺带清理死连接）
  const pingTimer = setInterval(() => {
    const payload = JSON.stringify({ type: 'ping', t: Date.now() } satisfies WsEvent);
    for (const client of clients) {
      try {
        client.send(payload);
      } catch {
        clients.delete(client);
      }
    }
  }, WS_PING_INTERVAL_MS);
  pingTimer.unref();

  // ─────────────────────── 路由 ───────────────────────

  registerProjectRoutes(app, appCtx);
  registerMetaRoutes(app, appCtx);
  registerDocRoutes(app, appCtx);
  registerEntityRoutes(app, appCtx);
  registerSearchRoutes(app, appCtx);
  registerLintRoutes(app, appCtx);
  registerSnapshotRoutes(app, appCtx);
  registerTrashRoutes(app, appCtx);
  registerInboxRoutes(app, appCtx);
  registerIoRoutes(app, appCtx);
  registerBackupRoutes(app, appCtx);
  registerJobRoutes(app, appCtx);

  app.get('/api/health', async () => ({
    ok: true,
    version: 1,
    data_dir: appCtx.dataDir,
    open_projects: appCtx.listOpen().length,
  }));

  // ─────────────────────── 静态托管 ───────────────────────

  const hasDist = await fs
    .access(path.join(WEB_DIST, 'index.html'))
    .then(() => true)
    .catch(() => false);

  if (hasDist) {
    await app.register(fastifyStatic, {
      root: WEB_DIST,
      prefix: '/',
      // 前端是 esbuild 产物，文件名不带 hash；开发期禁缓存避免改了看不到
      cacheControl: false,
      // index:false 是为了不让 static 自己处理目录请求（它会返回 403），
      // 根路径与未知路径统一交给下面的显式路由 / SPA 回退。
      index: false,
      // wildcard:true 让构建产物（含 build:watch 新增的文件）无需重启即可访问
      wildcard: true,
    });

    // 根路径必须显式注册：wildcard 的 /* 遇到目录会返回 403，
    // 而 `/` 正是用户打开应用的第一跳。
    const serveIndex = async (
      _request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<unknown> => {
      reply.type('text/html; charset=utf-8');
      return reply.sendFile('index.html');
    };
    // Fastify 的 get 会自动覆盖 HEAD，不用再注册一次（重复注册会直接抛错）
    app.get('/', serveIndex);
  } else {
    // 没有构建产物时给一条可读的说明页，而不是 404 —— 用户第一次跑 npm start 必须知道怎么办
    app.get('/', async (_request, reply) => {
      reply.type('text/html; charset=utf-8').code(503);
      return buildMissingDistPage();
    });
  }

  // SPA 回退：非 /api、非 /ws 的 GET 一律回 index.html，
  // 让前端的 hash/history 路由与刷新都能工作。
  app.setNotFoundHandler(async (request, reply) => {
    const url = request.raw.url ?? '/';
    const isApi = url.startsWith('/api/') || url === '/api';
    const isWs = url.startsWith('/ws');

    if (isApi || isWs) {
      return reply.code(404).send({ error: `接口不存在：${request.method} ${url}`, code: 'not_found' });
    }

    if (!hasDist) {
      reply.type('text/html; charset=utf-8').code(503);
      return buildMissingDistPage();
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.code(405).send({ error: '不支持的方法', code: 'method_not_allowed' });
    }

    return reply.type('text/html; charset=utf-8').sendFile('index.html');
  });

  // ─────────────────────── 全局错误处理 ───────────────────────

  app.setErrorHandler(async (error: Error, request, reply) => {
    // Fastify 内置错误（JSON 解析失败 / body 过大 / 404）自带 statusCode 与 code，
    // 自己的 HttpError 也带；统一从运行时读，不做 instanceof 之外的类型假设。
    const raw = error as unknown as { statusCode?: unknown; code?: unknown };
    const status =
      error instanceof HttpError
        ? error.statusCode
        : typeof raw.statusCode === 'number'
          ? raw.statusCode
          : 500;
    const code =
      error instanceof HttpError
        ? error.code
        : typeof raw.code === 'string'
          ? raw.code
          : 'error';

    // 4xx 是用户输入问题，只记一行；5xx 是程序问题，必须留栈
    if (status >= 500) {
      console.error(`[api] ${request.method} ${request.raw.url} → ${status}`, error);
    }

    // Fastify 内置错误（JSON 解析失败、body 过大）带自己的中文信息，直接用
    const message =
      status >= 500 && !(error instanceof HttpError)
        ? `服务内部错误：${error.message || '未知错误'}`
        : error.message || '请求失败';

    return reply.code(status).send({ error: message, code });
  });

  // 关闭钩子：先断开 WebSocket，再关作品索引，最后让 Fastify 收尾
  app.addHook('onClose', async () => {
    clearInterval(pingTimer);
    appCtx.setBroadcast(null);
    for (const client of clients) {
      try {
        client.close();
      } catch {
        /* 已断开 */
      }
    }
    clients.clear();
    await appCtx.closeAll();
  });

  return { app, appCtx };
}

function buildMissingDistPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>写作台 · 需要先构建前端</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #f6f1e7; color: #2c2620;
    font: 16px/1.8 -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif;
  }
  .card {
    max-width: 560px; padding: 40px 44px; border-radius: 14px;
    background: #fffdf8; box-shadow: 0 1px 2px rgba(60,45,25,.06), 0 12px 32px rgba(60,45,25,.07);
  }
  h1 { margin: 0 0 12px; font-size: 20px; letter-spacing: .04em; }
  p { margin: 0 0 14px; color: #5a4f43; }
  code {
    display: inline-block; padding: 3px 8px; border-radius: 6px;
    background: #efe7d8; color: #4a3b28; font-family: ui-monospace, Menlo, monospace; font-size: 14px;
  }
  pre {
    margin: 18px 0 0; padding: 16px 18px; border-radius: 10px;
    background: #2c2620; color: #f0e9dc; overflow-x: auto;
    font-family: ui-monospace, Menlo, monospace; font-size: 13.5px; line-height: 1.7;
  }
</style>
</head>
<body>
  <div class="card">
    <h1>还没有构建前端</h1>
    <p>服务端已经启动，但找不到 <code>web/dist/index.html</code>。请先构建前端，然后刷新本页。</p>
    <pre>npm run build
# 或开发模式（改动自动重新构建）
npm run build:watch</pre>
    <p style="margin-top:18px">你的稿件保存在磁盘上的 Markdown 文件里，构建前端不会影响任何内容。</p>
  </div>
</body>
</html>`;
}

// ─────────────────────── 启动 ───────────────────────

function resolveDataDir(): string {
  const fromEnv = process.env.WD_DATA_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(REPO_ROOT, 'data', 'projects');
}

function resolvePort(): number {
  const raw = process.env.WD_PORT?.trim();
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[启动] WD_PORT 不是合法端口：${raw}，回退到 ${DEFAULT_PORT}`);
    return DEFAULT_PORT;
  }
  return port;
}

async function main(): Promise<void> {
  const dataDir = resolveDataDir();
  await fs.mkdir(dataDir, { recursive: true });

  const lan = process.env.WD_LAN === '1' || process.env.WD_LAN === 'true';
  const host = lan ? '0.0.0.0' : '127.0.0.1';
  const port = resolvePort();

  const { app, appCtx } = await buildServer(dataDir);

  try {
    await app.listen({ port, host });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EADDRINUSE') {
      console.error(`\n[启动失败] 端口 ${port} 已被占用。`);
      console.error(`  可能是写作台已经在运行，或换一个端口：WD_PORT=7789 npm start\n`);
    } else {
      console.error('\n[启动失败]', err, '\n');
    }
    process.exitCode = 1;
    return;
  }

  // 启动摘要：作品数要「打开后」统计才准（索引可读），但打开全部作品太慢，
  // 这里用扫描结果（读 project.json + 已存在的索引），足够给出可信概览。
  const projects = await listProjectSummaries(dataDir, appCtx);
  const totalWords = projects.reduce((sum, p) => sum + p.word_count, 0);

  // 局域网模式下要打印「手机真正能访问的地址」，否则用户只知道 127.0.0.1，
  // 在手机上打不开也不知道该输什么。这里取本机的内网 IPv4。
  const lanAddrs = lan ? listLanAddresses() : [];
  const url = `http://127.0.0.1:${port}`;

  console.log('');
  console.log('  写作台 · 本地优先的小说写作工作台');
  console.log('  ─────────────────────────────────────');
  console.log(`  访问地址   ${url}`);
  console.log(`  数据目录   ${dataDir}`);
  console.log(`  作品数量   ${projects.length} 个（共 ${formatNum(totalWords)} 字）`);
  console.log(`  监听地址   ${host}:${port}${lan ? '' : '（仅本机可访问）'}`);
  console.log(`  稿件格式   Markdown + frontmatter，可直接用任何编辑器打开`);
  console.log('  ─────────────────────────────────────');
  if (lan) {
    console.log('');
    if (lanAddrs.length > 0) {
      console.log('  手机访问（同一 Wi-Fi 下打开下面任一地址）：');
      for (const addr of lanAddrs) {
        console.log(`    http://${addr}:${port}`);
      }
    } else {
      console.log('  手机访问：未检测到内网 IPv4 地址，请确认已连接 Wi-Fi 或有线网络。');
      console.log(`  也可手动用本机内网 IP 访问，端口 ${port}。`);
    }
    console.log('');
    console.log('  ⚠ 局域网模式已开启：同一网络内的任何设备都能访问本服务。');
    console.log('    本工具没有登录与权限校验，任何能连上的人都能读写你的全部稿件。');
    console.log('    只在完全可信的网络里使用；用完请关闭（去掉 WD_LAN=1）。');
    console.log('');
  }
  console.log('  按 Ctrl+C 退出（退出前会自动关闭索引，稿件已实时落盘）');
  console.log('');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[关闭] 收到 ${signal}，正在安全关闭…`);
    try {
      await app.close();
      console.log('[关闭] 已完成，稿件均已落盘。');
    } catch (err) {
      console.error('[关闭] 关闭时出错：', err);
      process.exitCode = 1;
    }
    process.exit();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 未捕获异常：不静默退出，先把已打开的索引关干净
  process.on('uncaughtException', (err) => {
    console.error('[致命] 未捕获异常：', err);
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[致命] 未处理的 Promise 拒绝：', reason);
  });
}

function formatNum(n: number): string {
  return n.toLocaleString('zh-CN');
}

// 直接执行时启动（被测试 import 时不启动）
const isMain = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isMain) {
  void main();
}

/**
 * 列出本机可用的内网 IPv4 地址，供局域网模式打印手机可访问的 URL。
 *
 * 过滤掉回环与链路本地地址（169.254.x.x），并优先返回私有网段：
 * 家用 Wi-Fi 基本都是 192.168 / 10 / 172.16-31 这三段。
 */
function listLanAddresses(): string[] {
  const out: Array<{ addr: string; isPrivate: boolean; iface: string }> = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const info of addrs ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue; // 链路本地，手机连不上
      const isPrivate =
        info.address.startsWith('192.168.') ||
        info.address.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(info.address);
      out.push({ addr: info.address, isPrivate, iface });
    }
  }
  // 私有网段排前面：公网 IP 虽然也能连，但不是家用场景的主要答案
  out.sort((a, b) => Number(b.isPrivate) - Number(a.isPrivate));
  // 去重（有些系统同一地址出现在多个接口上）
  const seen = new Set<string>();
  return out.filter((x) => (seen.has(x.addr) ? false : (seen.add(x.addr), true))).map((x) => x.addr);
}
