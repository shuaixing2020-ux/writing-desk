/**
 * 备份服务 —— 整项目打包到指定目录（架构 3.7、7.9）。
 *
 * 设计原则：备份必须能被「非本工具」解开。
 *   所以用 tar.gz（Windows 10+ 自带 tar、macOS/Linux 原生支持），
 *   而不是私有格式或需要本工具才能读的容器。
 *   归档内保留原始的目录结构与 Markdown 文件，作者用任何解压工具都能直接看到稿子。
 *
 * 排除了什么、为什么：
 *   - .studio/index.sqlite：索引，可由正文完整重建，且体积大（几百 MB 级）
 *   - .studio/exports：导出产物，随时可重新生成
 *   - .studio/logs：日志，无恢复价值
 *   - 临时文件（.*.tmp）：原子写的中间态，不该进备份
 *   - 备份目标目录本身（如果被设成项目内的子目录，否则每次备份都会把上次的备份打进去）
 *   保留 .studio/snapshots（作者的撤销历史，值钱）与 .studio/trash（误删的最后一道防线）。
 */

import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { BackupResult, BackupTarget } from '../../shared/types.ts';
import type { ProjectContext } from '../context.ts';
import type { JobContext } from '../util/job-queue.ts';
import { ensureDir, readJsonSafe, writeFileAtomic, writeJsonAtomic } from '../util/atomic.ts';
import { ulid } from '../util/id.ts';
import { buildTarGz, type ArchiveEntry } from './archive.ts';
import { Mutex, formatStamp, isInside, toPosix } from './common.ts';

const CONFIG_FILE = 'backup.json';
const BACKUP_PREFIX = 'backup-';
const BACKUP_SUFFIX = '.tar.gz';

/** 不进入备份的相对路径前缀（见文件头说明） */
const EXCLUDED_PREFIXES = ['.studio/index.sqlite', '.studio/exports', '.studio/logs'];

/** 前缀匹配时不要求目录边界：SQLite 还有 -wal / -shm 两个伴生文件 */
const EXCLUDED_FILE_PREFIXES = ['.studio/index.sqlite'];

/** 单文件体积上限：超过多半是用户误放进来的附件，跳过并记录，避免备份变成几 GB */
const MAX_FILE_BYTES = 200 * 1024 * 1024;

export class BackupService {
  private ctx: ProjectContext;
  private mutex = new Mutex();
  private cache: BackupTarget[] | null = null;

  constructor(ctx: ProjectContext) {
    this.ctx = ctx;
  }

  private get configFile(): string {
    return path.join(this.ctx.store.paths.studio, CONFIG_FILE);
  }

  // ─────────────────────────── 配置 ───────────────────────────

  async list(): Promise<BackupTarget[]> {
    if (this.cache) return [...this.cache];
    const raw = await readJsonSafe<BackupTarget[]>(this.configFile, []);
    const list = Array.isArray(raw) ? raw.filter(isTarget) : [];
    this.cache = list;
    return [...list];
  }

  private async saveConfig(list: BackupTarget[]): Promise<void> {
    await writeJsonAtomic(this.configFile, list);
    this.cache = list;
  }

  /**
   * 新建或更新备份目标（按 id upsert；无 id 视为新建）。
   * 只接受绝对路径或相对项目根的可解析路径，并做规范化 —— 备份目录写错位置比不备份更糟。
   */
  async save(input: Partial<BackupTarget> & { dir: string }): Promise<BackupTarget> {
    return this.mutex.run(async () => {
      const dir = String(input.dir ?? '').trim();
      if (!dir) throw new Error('备份目录不能为空');
      const abs = path.isAbsolute(dir) ? path.normalize(dir) : path.resolve(this.ctx.store.root, dir);

      const list = await this.list();
      const existing = input.id ? list.find((t) => t.id === input.id) : undefined;
      const target: BackupTarget = {
        id: existing?.id ?? input.id ?? ulid(),
        dir: abs,
        enabled: input.enabled ?? existing?.enabled ?? true,
        keep: clampInt(input.keep ?? existing?.keep ?? 10, 1, 365),
        interval_min: clampInt(input.interval_min ?? existing?.interval_min ?? 0, 0, 60 * 24 * 30),
        last_run: existing?.last_run ?? null,
        last_file: existing?.last_file ?? null,
        last_error: existing?.last_error ?? null,
      };

      const idx = list.findIndex((t) => t.id === target.id);
      if (idx >= 0) list[idx] = target;
      else list.push(target);
      await this.saveConfig(list);
      return target;
    });
  }

  async remove(id: string): Promise<void> {
    return this.mutex.run(async () => {
      const list = await this.list();
      const next = list.filter((t) => t.id !== id);
      if (next.length !== list.length) await this.saveConfig(next);
    });
  }

  async get(id: string): Promise<BackupTarget | null> {
    const list = await this.list();
    return list.find((t) => t.id === id) ?? null;
  }

  // ─────────────────────────── 执行 ───────────────────────────

  /**
   * 运行备份。
   *   传 targetId → 只跑该目标，返回 BackupResult
   *   不传      → 跑全部 enabled 目标，返回 BackupResult[]
   *
   * 单个目标失败不影响其它目标（一个外接盘没插，不该阻断另一个盘的备份）。
   */
  async run(job: JobContext, targetId?: string): Promise<BackupResult | BackupResult[]> {
    const all = await this.list();
    const targets = targetId ? all.filter((t) => t.id === targetId) : all.filter((t) => t.enabled);

    if (targetId && targets.length === 0) throw new Error('备份目标不存在');
    if (targets.length === 0) throw new Error('还没有可用的备份目标，请先在设置里添加备份目录');

    job.progress(0.05, '扫描项目文件');
    const entries = await this.collectEntries();
    const payload = buildTarGz(entries, { level: 6 }); // 备份用 6 级：速度与体积的平衡点
    job.progress(0.6, '写入备份文件');

    const results: BackupResult[] = [];
    const errors: string[] = [];

    for (let i = 0; i < targets.length; i++) {
      job.throwIfCancelled();
      const target = targets[i];
      try {
        const result = await this.writeToTarget(job, target, payload, entries.length);
        results.push(result);
        target.last_run = Date.now();
        target.last_file = result.file;
        target.last_error = null;
      } catch (err) {
        const message = (err as Error).message || '未知错误';
        target.last_error = message;
        errors.push(`${target.dir}：${message}`);
        console.error(`[backup] 目标 ${target.dir} 失败:`, err);
      }
      job.progress(0.6 + ((i + 1) / targets.length) * 0.35, `备份 ${i + 1}/${targets.length}`);
    }

    // 目标状态（含失败信息）必须落盘，设置面板才能显示「上次失败原因」
    await this.saveConfig(all);

    if (results.length === 0) {
      throw new Error(`全部备份目标都失败了：${errors.join('；')}`);
    }
    job.progress(1, `备份完成（${results.length} 个目标）`);
    return targetId ? results[0] : results;
  }

  /** 打包到单个目标目录，并按保留份数轮转 */
  private async writeToTarget(
    job: JobContext,
    target: BackupTarget,
    payload: Buffer,
    fileCount: number,
  ): Promise<BackupResult> {
    const t0 = Date.now();
    await ensureDir(target.dir);

    const meta = await this.ctx.store.readMeta();
    const stamp = formatStamp();
    const base = safeBase(meta.title || path.basename(this.ctx.store.root));
    const file = path.join(target.dir, `${BACKUP_PREFIX}${base}-${stamp}${BACKUP_SUFFIX}`);

    // 走原子写：备份文件半截是最危险的状态 —— 看起来存在，恢复时才发现坏。
    // writeFileAtomic 内部已做 fsync + rename，落盘后即可拔盘。
    await writeFileAtomic(file, payload);

    job.note(`已备份 ${fileCount} 个文件到 ${target.dir}`);

    await rotate(target.dir, target.keep, file);

    return {
      target_id: target.id,
      file,
      size: payload.length,
      took_ms: Date.now() - t0,
    };
  }

  // ─────────────────────────── 收集文件 ───────────────────────────

  /**
   * 遍历项目目录，收集要进归档的文件。
   *
   * 顺序：project.json 最先（作者解压后一眼看到项目元数据），
   * 然后 manuscript / bible / notes / inbox / plot / script，最后 .studio。
   */
  private async collectEntries(): Promise<ArchiveEntry[]> {
    const root = this.ctx.store.root;
    const out: ArchiveEntry[] = [];
    const skipDirs = new Set<string>();

    // 备份目标若在项目内，跳过它自己，避免备份套备份
    for (const target of await this.list()) {
      if (isInside(root, target.dir) && path.resolve(target.dir) !== path.resolve(root)) {
        skipDirs.add(path.resolve(target.dir));
      }
    }

    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      // 排序保证同一份项目每次备份的归档顺序稳定，便于对比
      entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = toPosix(path.relative(root, full));

        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          if (skipDirs.has(path.resolve(full))) continue;
          if (EXCLUDED_PREFIXES.some((p) => rel === p || rel.startsWith(p + '/'))) continue;
          await walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (entry.name.endsWith('.tmp')) continue;
        if (EXCLUDED_PREFIXES.some((p) => rel === p || rel.startsWith(p + '/'))) continue;
        if (EXCLUDED_FILE_PREFIXES.some((p) => rel.startsWith(p))) continue;

        try {
          const stat = await fs.stat(full);
          if (stat.size > MAX_FILE_BYTES) {
            console.warn(`[backup] 跳过超大文件 ${rel}（${stat.size} 字节）`);
            continue;
          }
          out.push({ name: rel, data: await fs.readFile(full) });
        } catch {
          // 单个文件读失败（被占用/权限）不能让整次备份失败，跳过即可
        }
      }
    };

    await walk(root);

    // 备份自述文件：解压后能知道这份备份来自哪个作品、什么时候、多少字
    const meta = await this.ctx.store.readMeta();
    const totals = await this.ctx.store.totals();
    const manifest = {
      format: 'writing-desk-backup',
      version: 1,
      project_id: meta.id,
      title: meta.title,
      author: meta.author,
      mode: meta.mode,
      count_mode: meta.count_mode,
      created_at: Date.now(),
      created_at_text: new Date().toLocaleString('zh-CN'),
      word_count: totals.word_count,
      scene_count: totals.scene_count,
      files: out.length,
      note: '本文件由写作台的备份功能生成。正文为 manuscript/ 下的 Markdown 文件，可用任意文本编辑器打开。',
    };
    out.push({
      name: '_backup.json',
      data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'),
    });

    return out;
  }
}

// ─────────────────────────── 轮转与工具 ───────────────────────────

/**
 * 保留份数轮转：只删「本工具生成的」备份文件（前缀 + 后缀匹配），
 * 绝不动目标目录里的其它东西 —— 备份目录常常是用户的移动硬盘根目录。
 */
async function rotate(dir: string, keep: number, justWritten: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const files: Array<{ name: string; mtime: number }> = [];
  for (const name of names) {
    if (!name.startsWith(BACKUP_PREFIX) || !name.endsWith(BACKUP_SUFFIX)) continue;
    const full = path.join(dir, name);
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile()) continue;
      files.push({ name, mtime: stat.mtimeMs });
    } catch {
      /* 跳过 */
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const keepSet = new Set(files.slice(0, Math.max(1, keep)).map((f) => f.name));
  keepSet.add(path.basename(justWritten)); // 刚写的那份无论排序如何都保留

  for (const file of files) {
    if (keepSet.has(file.name)) continue;
    await fs.rm(path.join(dir, file.name), { force: true }).catch(() => {});
  }
}

function clampInt(value: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** 文件名里不能出现路径分隔符与冒号 */
function safeBase(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, '')
      .slice(0, 40) || 'project'
  );
}

function isTarget(v: unknown): v is BackupTarget {
  if (!v || typeof v !== 'object') return false;
  const t = v as BackupTarget;
  return typeof t.id === 'string' && typeof t.dir === 'string';
}
