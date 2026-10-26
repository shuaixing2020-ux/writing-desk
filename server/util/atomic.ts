/**
 * 原子写入 —— 「稿件永不丢」的执行层（架构 7.1 第 3 条）。
 *
 * 流程：写同目录临时文件 → fsync 文件 → rename 覆盖目标 → fsync 目录。
 * 任何时刻崩溃，目标文件要么是旧内容、要么是新内容，永不半写。
 *
 * 注意：rename 在同一文件系统内是原子的；临时文件必须与目标同目录，
 * 否则跨设备 rename 会退化成 copy，失去原子性。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** 对目录做 fsync，确保 rename 的目录项落盘（Linux/macOS 需要） */
async function fsyncDir(dir: string): Promise<void> {
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(dir, 'r');
    await fh.sync();
  } catch {
    // 部分平台（如 Windows）不支持对目录 fsync，忽略即可
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * 原子写文本文件。自动创建父目录。
 */
export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  opts: { mode?: number } = {},
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );

  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(tmp, 'w', opts.mode ?? 0o644);
    await fh.writeFile(data);
    await fh.sync(); // 数据落盘，避免 rename 后内容仍在页缓存
    await fh.close();
    fh = undefined;
    await fs.rename(tmp, filePath);
    await fsyncDir(dir);
  } catch (err) {
    await fh?.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** 原子写 JSON（带缩进，便于人直接阅读与 git diff） */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2) + '\n');
}

/**
 * 读取 JSON；文件不存在返回 fallback；内容损坏时备份坏文件并返回 fallback，
 * 避免「索引文件坏了导致整个作品打不开」。
 */
export async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return fallback;
    // 损坏：保留现场，便于人工恢复
    const backup = `${filePath}.corrupt.${Date.now()}`;
    await fs.rename(filePath, backup).catch(() => {});
    console.error(`[atomic] ${filePath} 解析失败，已备份到 ${backup}:`, e.message);
    return fallback;
  }
}

/** 读取文本，不存在返回 null */
export async function readTextSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** 安全删除（不存在的路径不报错） */
export async function rmSafe(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
}

/** 确保目录存在 */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** 判断路径是否存在 */
export async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
