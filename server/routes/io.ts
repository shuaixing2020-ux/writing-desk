/**
 * 导入导出与下载路由。
 *
 * POST /api/projects/:pid/import/preview  → ImportPreview（同步，纯计算）
 * POST /api/projects/:pid/import          → Job
 * POST /api/projects/:pid/export          → Job（ExportResult 里带 file）
 * GET  /api/projects/:pid/download?file=  → 文件流
 * POST /api/projects/:pid/index/rebuild   → Job（重建索引）
 *
 * 下载是唯一把「项目内任意相对路径」暴露给客户端的接口，
 * 所以目录穿越校验必须是「解析后绝对路径 startsWith 项目根」的硬校验，
 * 而不是字符串黑名单 —— 黑名单永远会漏。
 */

import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type {
  ExportFormat,
  ExportRequest,
  ExportResult,
  ImportPreview,
  Job,
} from '../../shared/types.ts';
import type { AppContextImpl } from '../app-context.ts';
import {
  badRequest,
  notFound,
  projectOf,
  requireString,
  submitJob,
} from './shared.ts';

const FORMATS: ExportFormat[] = ['txt', 'md', 'docx', 'epub'];
const SCOPES: ExportRequest['scope'][] = ['book', 'volume', 'chapter'];

/** 上传内容上限：单本 30MB 纯文本，足够 3000 万字 */
const MAX_IMPORT_CHARS = 30 * 1024 * 1024;

export function registerIoRoutes(app: FastifyInstance, appCtx: AppContextImpl): void {
  // ─────────────────────── 导入预览 ───────────────────────

  app.post('/api/projects/:pid/import/preview', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    const body = (request.body ?? {}) as Record<string, unknown>;

    const filename = requireString(body.filename, 'filename', { max: 260 });
    const content = requireString(body.content, 'content', {
      allowEmpty: false,
      trim: false,
      max: MAX_IMPORT_CHARS,
    });

    const preview: ImportPreview = await ctx.importer.preview(filename, content);
    return preview;
  });

  // ─────────────────────── 导入 ───────────────────────

  app.post('/api/projects/:pid/import', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    const body = (request.body ?? {}) as Record<string, unknown>;

    const filename = requireString(body.filename, 'filename', { max: 260 });
    const content = requireString(body.content, 'content', {
      allowEmpty: false,
      trim: false,
      max: MAX_IMPORT_CHARS,
    });
    const volumeTitle =
      body.volume_title === undefined ? undefined : String(body.volume_title).slice(0, 120);

    const job: Job = submitJob(appCtx, pid, 'import', async (jobCtx) => {
      const result = await ctx.importer.run(jobCtx, {
        filename,
        content,
        volume_title: volumeTitle,
      });
      appCtx.broadcast({ type: 'tree_changed', project_id: ctx.id });
      appCtx.broadcast({ type: 'index_rebuilt' });
      return result;
    });
    return job;
  });

  // ─────────────────────── 导出 ───────────────────────

  app.post('/api/projects/:pid/export', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    const body = (request.body ?? {}) as Record<string, unknown>;

    const format = body.format;
    if (typeof format !== 'string' || !FORMATS.includes(format as ExportFormat)) {
      throw badRequest('导出格式不合法（应为 txt / md / docx / epub）', 'bad_format');
    }
    const scope = body.scope ?? 'book';
    if (typeof scope !== 'string' || !SCOPES.includes(scope as ExportRequest['scope'])) {
      throw badRequest('导出范围不合法（应为 book / volume / chapter）', 'bad_scope');
    }
    const scopeId =
      body.scope_id === undefined || body.scope_id === null
        ? undefined
        : String(body.scope_id).slice(0, 200);
    if (scope !== 'book' && !scopeId) throw badRequest('指定范围导出时必须提供 scope_id');

    const exportReq: ExportRequest = {
      format: format as ExportFormat,
      scope: scope as ExportRequest['scope'],
      scope_id: scopeId,
      typeset: body.typeset === undefined ? true : Boolean(body.typeset),
    };

    const job: Job = submitJob(appCtx, pid, 'export', async (jobCtx) => {
      const result: ExportResult = await ctx.exporter.export(jobCtx, exportReq);
      return result;
    });
    return job;
  });

  // ─────────────────────── 下载 ───────────────────────

  app.get('/api/projects/:pid/download', async (request, reply) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);
    const query = request.query as Record<string, unknown>;

    const file = requireString(query.file, 'file', { max: 500 });
    const abs = resolveInsideProject(ctx.root, file);

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(abs);
    } catch {
      throw notFound(`文件不存在：${file}`, 'file_not_found');
    }
    if (!stat.isFile()) throw badRequest('目标不是文件', 'not_a_file');

    const name = path.basename(abs);
    reply
      .header('content-type', contentTypeOf(name))
      .header('content-length', String(stat.size))
      .header(
        'content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      );
    return reply.send(createReadStream(abs));
  });

  // ─────────────────────── 重建索引 ───────────────────────

  app.post('/api/projects/:pid/index/rebuild', async (request) => {
    const { pid } = request.params as { pid: string };
    const ctx = await projectOf(appCtx, pid);

    const job: Job = submitJob(appCtx, pid, 'rebuild_index', async (jobCtx) => {
      const stats = await ctx.indexer.rebuildAll(jobCtx);
      appCtx.broadcast({ type: 'index_rebuilt' });
      appCtx.broadcast({ type: 'tree_changed', project_id: ctx.id });
      return stats;
    });
    return job;
  });
}

/**
 * 把客户端给的相对路径解析为项目内的绝对路径。
 *
 * 三重防线：
 *   1. 拒绝绝对路径与 NUL 字节
 *   2. path.resolve 归一化（消掉 ../ 和符号链接式绕法）
 *   3. 结果必须落在 root 或 root/ 之内（注意加分隔符，避免 /a/bc 命中 /a/b）
 */
export function resolveInsideProject(root: string, rel: string): string {
  if (rel.includes('\u0000')) throw badRequest('文件路径不合法', 'bad_path');
  if (path.isAbsolute(rel)) throw badRequest('文件路径必须是项目内相对路径', 'bad_path');

  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, rel);
  const prefix = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
  if (abs !== absRoot && !abs.startsWith(prefix)) {
    throw badRequest('文件路径超出作品目录范围', 'path_escape');
  }
  return abs;
}

function contentTypeOf(name: string): string {
  const ext = path.extname(name).toLowerCase();
  switch (ext) {
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.md':
      return 'text/markdown; charset=utf-8';
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.epub':
      return 'application/epub+zip';
    case '.json':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}
