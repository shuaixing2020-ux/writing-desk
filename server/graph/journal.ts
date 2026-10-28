/**
 * 多文件操作的事务日志（G3）。
 *
 * ═══════════════════════ 要解决的问题 ═══════════════════════
 *
 * 有些操作必须同时改多个条目文件，例如：
 *   - 反转关系方向：A 的文件删一行，B 的文件加一行
 *   - 接续关系端点：A 的文件删旧的，B 的文件加新的
 *   - 合并条目：多个文件的关系要搬到另一个文件
 *
 * 如果改到一半崩溃（断电、进程被杀），会出现"半边关系"：
 * A 说 B 是老掌门的朋友，但 B 那边什么都没有 —— 数据看起来正常，
 * 实际已经不一致，而且作者很难发现。
 *
 * ═══════════════════════ 怎么解决 ═══════════════════════
 *
 * 预写日志（WAL 思路）：
 *   1. 先把「每个文件改前 / 改后」的完整内容写进日志文件并 fsync
 *   2. 再逐个应用改动
 *   3. 全部成功后，删掉日志
 *   4. 启动时若发现日志还在，说明上次没走完 —— 按日志补齐（前滚）
 *
 * 为什么不用「写临时文件再整体原子替换」：
 *   多个文件的 rename 不是原子的，崩溃点仍然会造成不一致。
 *
 * 为什么选择前滚（redo）而不是回滚（undo）：
 *   日志里同时有改前和改后内容，前滚能保证最终到达"改后"这个一致状态；
 *   回滚则需要额外保证"所有文件都回到改前"，中途崩溃同样要再处理。
 *   前滚更简单，且结果与用户意图一致。
 *
 * ═══════════════════════ 边界 ═══════════════════════
 *
 * - 日志只保证「最终一致」，不提供隔离性（单作者本地工具，并发由写锁保证）
 * - 日志文件本身用 writeFileAtomic 写，不会半截
 * - 崩溃恢复在打开作品时做一次，不做后台轮询
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureDir, writeFileAtomic, writeJsonAtomic } from '../util/atomic.ts';

/** 一次事务里单个文件的变化 */
export interface FileChange {
  /** 相对项目根的路径（如 bible/characters/林远.md） */
  path: string;
  /** 改前内容；null 表示文件原本不存在 */
  before: string | null;
  /** 改后内容；null 表示要删除该文件 */
  after: string | null;
}

export interface JournalEntry {
  version: 1;
  /** 事务 id，也是日志文件名 */
  id: string;
  /** 创建时间戳 */
  created_at: number;
  /** 这次事务在做什么（用于日志与错误信息） */
  description: string;
  changes: FileChange[];
}

/** 事务进行中的中间态：调用方先登记改动，再统一提交 */
export class Transaction {
  private projectRoot: string;
  private journalDir: string;
  private changes: FileChange[] = [];
  private description: string;

  constructor(projectRoot: string, journalDir: string, description: string) {
    this.projectRoot = projectRoot;
    this.journalDir = journalDir;
    this.description = description;
  }

  /**
   * 登记一个文件的改动。
   * 同一路径重复登记时，保留最早的 before、最新的 after
   * （一次事务里同一个文件被改多次，只需要记首尾两个状态）。
   */
  stage(relPath: string, before: string | null, after: string | null): void {
    const existing = this.changes.find((c) => c.path === relPath);
    if (existing) {
      existing.after = after;
      return;
    }
    this.changes.push({ path: relPath, before, after });
  }

  get isEmpty(): boolean {
    return this.changes.length === 0;
  }

  get size(): number {
    return this.changes.length;
  }

  /**
   * 提交：写日志 → 应用改动 → 删日志。
   *
   * 任何一步失败都会留下日志，下次打开作品时前滚补齐。
   */
  async commit(): Promise<void> {
    if (this.changes.length === 0) return;

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const entry: JournalEntry = {
      version: 1,
      id,
      created_at: Date.now(),
      description: this.description,
      changes: this.changes,
    };

    await ensureDir(this.journalDir);
    const journalFile = path.join(this.journalDir, `${id}.json`);

    // 1. 先落日志（writeJsonAtomic 自带 fsync）
    await writeJsonAtomic(journalFile, entry);

    // 2. 再应用
    try {
      for (const change of this.changes) {
        await this.applyOne(change);
      }
    } catch (err) {
      // 应用失败：日志留着，下次启动前滚。这里不删日志，
      // 也不尝试回滚 —— 回滚同样可能失败，只会让状态更难判断。
      throw new Error(
        `多文件操作「${this.description}」未完成，已记录日志 ${id}，` +
          `下次打开作品时会自动补齐。原因：${(err as Error).message}`,
      );
    }

    // 3. 全部成功，删日志
    await fs.rm(journalFile, { force: true });
  }

  private async applyOne(change: FileChange): Promise<void> {
    const abs = path.join(this.projectRoot, change.path);
    if (change.after === null) {
      await fs.rm(abs, { force: true });
      return;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await writeFileAtomic(abs, change.after);
  }
}

/**
 * 前滚：把遗留日志里的改动重新应用一遍。
 *
 * 幂等：改动内容来自日志，重复应用结果相同。
 * 日志本身损坏时移到 .corrupt 后缀并跳过，不阻塞作品打开。
 */
export async function recoverPending(
  projectRoot: string,
  journalDir: string,
): Promise<{ recovered: string[]; failed: Array<{ id: string; error: string }> }> {
  const recovered: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  let files: string[];
  try {
    files = await fs.readdir(journalDir);
  } catch {
    return { recovered, failed }; // 目录不存在 = 没有待恢复的事务
  }

  const entries = files.filter((f) => f.endsWith('.json')).sort();

  for (const file of entries) {
    const abs = path.join(journalDir, file);

    // 这里刻意不用 readJsonSafe：它会把坏文件重命名成 `.corrupt.<时间戳>`，
    // 再叠加我们自己的归档会产生两个名字。日志恢复需要确定的命名，
    // 所以自己读、自己解析、自己归档。
    let entry: JournalEntry | null = null;
    try {
      const raw = await fs.readFile(abs, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as JournalEntry).changes)) {
        entry = parsed as JournalEntry;
      }
    } catch {
      entry = null;
    }

    if (!entry) {
      // 坏日志：移到一边（不删除，保留现场），不阻塞启动
      await fs.rename(abs, `${abs}.corrupt`).catch(() => {});
      failed.push({ id: file, error: '日志内容损坏，已移到 .corrupt' });
      continue;
    }

    try {
      for (const change of entry.changes) {
        const target = path.join(projectRoot, change.path);
        if (change.after === null) {
          await fs.rm(target, { force: true });
        } else {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await writeFileAtomic(target, change.after);
        }
      }
      await fs.rm(abs, { force: true });
      recovered.push(entry.id);
    } catch (err) {
      failed.push({ id: entry.id, error: (err as Error).message });
    }
  }

  return { recovered, failed };
}

/** 新建一个事务（不立即创建日志文件） */
export function beginTransaction(
  projectRoot: string,
  journalDir: string,
  description: string,
): Transaction {
  return new Transaction(projectRoot, journalDir, description);
}

/** 项目里存放日志的目录 */
export function journalDirOf(studioDir: string): string {
  return path.join(studioDir, 'journal');
}
