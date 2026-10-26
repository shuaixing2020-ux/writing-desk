/**
 * 版本快照服务 —— 「撤销历史不止本次会话」的执行层（架构 7.2）。
 *
 * 存储设计：
 *   .studio/snapshots/<hash 前 2 位>/<hash>.gz   内容寻址 + gzip
 *   .studio/snapshots/index.json                SnapshotMeta[]（元数据）
 *
 * 为什么内容寻址：作者的正文常常只改几个字，一次快照的「新内容」大部分是重复的。
 * 按内容哈希存，改十个字只多存一份压缩后的全文；同一内容重复保存（自动快照密集触发）
 * 完全不多占空间。这也是为什么去重是「按哈希」而不是「按时间」。
 *
 * 为什么元数据单独一个 JSON 而不是 SQLite：快照必须能在索引损坏时依然可用
 * ——「恢复旧版本」是稿件安全的最后一道防线，不能依赖可重建的索引。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import DiffMatchPatch from 'diff-match-patch';
import type {
  DiffBlock,
  DiffResult,
  SnapshotContent,
  SnapshotMeta,
  SnapshotReason,
} from '../../shared/types.ts';
import type { ProjectContext } from '../context.ts';
import { readJsonSafe, rmSafe, writeFileAtomic, writeJsonAtomic } from '../util/atomic.ts';
import { hashText } from '../store/project.ts';
import { ulid } from '../util/id.ts';
import { Mutex } from './common.ts';

/** 自动快照节流窗口：同一场景 5 分钟内只留一份 auto 快照 */
export const AUTO_THROTTLE_MS = 5 * 60 * 1000;

const INDEX_FILE = 'index.json';
const SNAPSHOT_DIR = 'snapshots';

/** 这些原因代表「有意义的节点」，不参与远期稀疏清理 */
const MILESTONE_REASONS: SnapshotReason[] = ['manual', 'import', 'delete', 'restore', 'conflict'];

export interface PruneResult {
  removed: number;
  kept: number;
}

export class SnapshotService {
  private ctx: ProjectContext;
  private mutex = new Mutex();
  /** 元数据缓存：快照列表会被面板频繁拉取，不必每次都读盘 */
  private cache: SnapshotMeta[] | null = null;

  constructor(ctx: ProjectContext) {
    this.ctx = ctx;
  }

  private get dir(): string {
    return path.join(this.ctx.store.paths.studio, SNAPSHOT_DIR);
  }

  private get indexFile(): string {
    return path.join(this.dir, INDEX_FILE);
  }

  /** 内容寻址路径：<前2位>/<hash>.gz（分两级目录，避免单目录几万个文件） */
  private blobPath(hash: string): string {
    return path.join(this.dir, hash.slice(0, 2), `${hash}.gz`);
  }

  // ─────────────────────────── 元数据 ───────────────────────────

  private async loadIndex(): Promise<SnapshotMeta[]> {
    if (this.cache) return this.cache;
    const raw = await readJsonSafe<SnapshotMeta[]>(this.indexFile, []);
    const list = Array.isArray(raw) ? raw.filter(isMeta) : [];
    list.sort((a, b) => b.created_at - a.created_at);
    this.cache = list;
    return list;
  }

  private async saveIndex(list: SnapshotMeta[]): Promise<void> {
    list.sort((a, b) => b.created_at - a.created_at);
    await writeJsonAtomic(this.indexFile, list);
    this.cache = list;
  }

  // ─────────────────────────── 创建 ───────────────────────────

  /**
   * 创建快照。
   *
   * 三个提前返回（都是「不产生冗余」的优化，语义上仍然成功）：
   *   1. 该场景最近一条快照内容完全相同 → 直接复用（内容寻址下再写一份毫无意义）
   *   2. reason=auto 且节流窗口内已有 auto 快照 → 跳过
   *   3. 同 id 快照已存在（并发场景）→ 返回已有
   */
  async create(
    docId: string,
    title: string,
    body: string,
    reason: SnapshotReason,
    pinned = false,
  ): Promise<SnapshotMeta> {
    return this.mutex.run(async () => {
      const list = await this.loadIndex();
      const hash = await hashText(body);
      const now = Date.now();

      const latestForDoc = list.find((m) => m.doc_id === docId);

      // 内容没变且原因相同：不必新增元数据（快照的价值在于「不同版本 / 不同节点」）。
      // 原因不同则仍然记一条：手动标记、导入前、删除前这些节点本身有语义，
      // 前端要靠 reason 区分「作者主动存的」和「系统自动存的」。
      if (latestForDoc && latestForDoc.hash === hash && latestForDoc.reason === reason) {
        if (pinned && !latestForDoc.pinned) {
          latestForDoc.pinned = true;
          await this.saveIndex(list);
        }
        return latestForDoc;
      }

      // 自动快照节流：避免输入停顿几秒就堆一份
      if (reason === 'auto' && latestForDoc && latestForDoc.reason === 'auto') {
        if (now - latestForDoc.created_at < AUTO_THROTTLE_MS) return latestForDoc;
      }

      const bytes = Buffer.byteLength(body, 'utf8');
      await this.writeBlob(hash, body);

      const meta: SnapshotMeta = {
        id: ulid(now),
        doc_id: docId,
        doc_title: title,
        hash,
        size: bytes,
        created_at: now,
        reason,
        pinned,
      };
      list.push(meta);
      await this.saveIndex(list);
      return meta;
    });
  }

  /** 写内容块。同 hash 已存在则跳过（这就是去重） */
  private async writeBlob(hash: string, body: string): Promise<void> {
    const file = this.blobPath(hash);
    try {
      await fs.access(file);
      return; // 已有同内容块
    } catch {
      /* 不存在，继续写 */
    }
    const gz = zlib.gzipSync(Buffer.from(body, 'utf8'), { level: 9 });
    await writeFileAtomic(file, gz);
  }

  private async readBlob(hash: string): Promise<string | null> {
    try {
      const gz = await fs.readFile(this.blobPath(hash));
      return zlib.gunzipSync(gz).toString('utf8');
    } catch {
      return null;
    }
  }

  // ─────────────────────────── 读取 ───────────────────────────

  /** 列表，按时间倒序；不传 docId 返回全书 */
  async list(docId?: string): Promise<SnapshotMeta[]> {
    const list = await this.loadIndex();
    return docId ? list.filter((m) => m.doc_id === docId) : [...list];
  }

  /** 取快照正文；内容块丢失时返回 null（让调用方提示，而不是抛错中断页面） */
  async get(id: string): Promise<SnapshotContent | null> {
    const list = await this.loadIndex();
    const meta = list.find((m) => m.id === id);
    if (!meta) return null;
    const body = await this.readBlob(meta.hash);
    if (body === null) return null;
    return { id, body, meta };
  }

  async getMeta(id: string): Promise<SnapshotMeta | null> {
    const list = await this.loadIndex();
    return list.find((m) => m.id === id) ?? null;
  }

  // ─────────────────────────── 恢复 ───────────────────────────

  /**
   * 恢复到某个快照。
   *
   * 顺序很重要：先给「当前版本」做一份 restore 快照，再覆盖。
   * 这样即使作者恢复错了版本，也能再退回来 —— 恢复操作本身不能成为不可逆的破坏。
   */
  async restore(id: string): Promise<{ rev: number }> {
    const snap = await this.get(id);
    if (!snap) throw new Error('快照不存在或内容块已丢失，无法恢复');

    const found = await this.ctx.store.resolveDocFile(snap.meta.doc_id);
    if (!found || !found.node.file) throw new Error('原文档已不存在（可能已被删除），无法恢复');

    const current = await this.ctx.store.readScene(snap.meta.doc_id);
    if (current && current.body !== snap.body) {
      await this.create(
        snap.meta.doc_id,
        found.node.title,
        current.body,
        'restore',
        false,
      );
    }

    const result = await this.ctx.store.writeScene(
      snap.meta.doc_id,
      snap.body,
      current?.rev ?? 0,
    );

    // 索引更新失败不影响恢复本身（索引可重建，稿件才是真相）
    try {
      const tree = await this.ctx.store.readTree();
      const node = tree.nodes.find((n) => n.id === snap.meta.doc_id);
      if (node) await this.ctx.indexer.indexDoc(node);
    } catch (err) {
      console.error('[snapshot] 恢复后更新索引失败:', err);
    }

    return { rev: result.rev };
  }

  // ─────────────────────────── 差异 ───────────────────────────

  /**
   * 快照 ↔ 当前正文的差异。
   *
   * 两段式：先用 diff-match-patch 做整篇差异，再按换行切成「段落块」；
   * 相邻的删除块 + 插入块再做一次字符级差异填进 inline，
   * 前端就能把「整段替换」显示成「这一行里改了这几个字」。
   */
  async diff(id: string): Promise<DiffResult> {
    const snap = await this.get(id);
    if (!snap) throw new Error('快照不存在或内容块已丢失');
    const current = await this.ctx.store.readScene(snap.meta.doc_id);
    const oldText = normalize(snap.body);
    const newText = normalize(current?.body ?? '');
    return diffText(oldText, newText);
  }

  // ─────────────────────────── 清理 ───────────────────────────

  /**
   * 保留策略：近期密集、远期稀疏（架构 7.2）。
   *
   * 时间桶（按快照年龄）：
   *   2 小时内   全部保留（自动快照本身已被 5 分钟节流，最多 24 份）
   *   48 小时内  每小时 1 份
   *   14 天内    每 6 小时 1 份
   *   90 天内    每天 1 份
   *   90 天以上  丢弃
   *
   * 例外：pinned（重大节点）与 milestone 原因（手动/导入前/删除前/恢复前/冲突）永远保留。
   * 删除元数据后，再扫描内容块目录，把没有任何元数据引用的 .gz 删掉（真正的空间回收）。
   */
  async prune(): Promise<PruneResult> {
    return this.mutex.run(async () => {
      const list = await this.loadIndex();
      const now = Date.now();

      // 按场景分组，组内从新到旧
      const byDoc = new Map<string, SnapshotMeta[]>();
      for (const meta of list) {
        const arr = byDoc.get(meta.doc_id);
        if (arr) arr.push(meta);
        else byDoc.set(meta.doc_id, [meta]);
      }

      const keep = new Set<string>();

      for (const metas of byDoc.values()) {
        metas.sort((a, b) => b.created_at - a.created_at);
        const buckets = new Set<string>();

        for (let i = 0; i < metas.length; i++) {
          const meta = metas[i];
          if (meta.pinned || MILESTONE_REASONS.includes(meta.reason)) {
            keep.add(meta.id);
            continue;
          }
          if (i === 0) {
            // 每个场景至少留最新一份，保证「回到上一次」永远可用
            keep.add(meta.id);
            buckets.add(bucketKey(now - meta.created_at, meta.created_at));
            continue;
          }
          const key = bucketKey(now - meta.created_at, meta.created_at);
          if (key === 'drop') continue;
          if (buckets.has(key)) continue;
          buckets.add(key);
          keep.add(meta.id);
        }
      }

      const kept = list.filter((m) => keep.has(m.id));
      const removed = list.length - kept.length;
      if (removed > 0) await this.saveIndex(kept);

      await this.gcBlobs(new Set(kept.map((m) => m.hash)));

      return { removed, kept: kept.length };
    });
  }

  /** 清理没有元数据引用的内容块（包括历史遗留的孤儿文件） */
  private async gcBlobs(referenced: Set<string>): Promise<void> {
    let dirs: string[];
    try {
      dirs = await fs.readdir(this.dir);
    } catch {
      return;
    }
    for (const dirName of dirs) {
      if (dirName === INDEX_FILE || dirName.startsWith('.')) continue;
      const full = path.join(this.dir, dirName);
      let files: string[];
      try {
        const stat = await fs.stat(full);
        if (!stat.isDirectory()) continue;
        files = await fs.readdir(full);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.gz')) continue;
        const hash = file.slice(0, -3);
        if (referenced.has(hash)) continue;
        await rmSafe(path.join(full, file));
      }
      // 空目录顺手删掉，保持 .studio 干净
      const left = await fs.readdir(full).catch(() => [] as string[]);
      if (left.length === 0) await rmSafe(full);
    }
  }

  /** 删除单个快照（面板「清理这一条」用；内容块留给 prune 回收） */
  async remove(id: string): Promise<void> {
    return this.mutex.run(async () => {
      const list = await this.loadIndex();
      const next = list.filter((m) => m.id !== id);
      if (next.length !== list.length) await this.saveIndex(next);
    });
  }

  /** 置顶/取消置顶：重大节点（定稿、发布）永久保留 */
  async pin(id: string, pinned = true): Promise<SnapshotMeta | null> {
    return this.mutex.run(async () => {
      const list = await this.loadIndex();
      const meta = list.find((m) => m.id === id);
      if (!meta) return null;
      meta.pinned = pinned;
      await this.saveIndex(list);
      return meta;
    });
  }
}

// ─────────────────────────── 差异算法 ───────────────────────────

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** 年龄 → 时间桶键；'drop' 表示过期可删 */
function bucketKey(ageMs: number, createdAt: number): string {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  if (ageMs <= 2 * HOUR) return `all:${createdAt}`; // 每份独占一个桶 → 全留
  if (ageMs <= 2 * DAY) return `h:${Math.floor(createdAt / HOUR)}`;
  if (ageMs <= 14 * DAY) return `h6:${Math.floor(createdAt / (6 * HOUR))}`;
  if (ageMs <= 90 * DAY) return `d:${Math.floor(createdAt / DAY)}`;
  return 'drop';
}

interface LineToken {
  type: 'equal' | 'insert' | 'delete';
  /** 一整行（含行尾换行），保证块与块拼接后能还原原文 */
  text: string;
}

/** 把字符级 diff 序列切成「带换行的行片段」 */
function toLineTokens(diffs: Array<[number, string]>): LineToken[] {
  const out: LineToken[] = [];
  for (const [op, text] of diffs) {
    const type: LineToken['type'] = op === 0 ? 'equal' : op === 1 ? 'insert' : 'delete';
    // 保留行尾换行，这样块与块之间能正确拼接
    const parts = text.match(/[^\n]*\n|[^\n]+$/g);
    if (!parts) continue;
    for (const part of parts) out.push({ type, text: part });
  }
  return out;
}

/**
 * 段落级 + 字符级差异（DiffResult）。
 *
 * 两段式：
 *   1. 先用 diff-match-patch 的「行映射成单字符」技巧做**段落级**差异
 *      （diff_linesToChars_ + diff_charsToLines_）：整篇上千段也只有几千个 token，
 *      比逐字符 diff 快一个数量级，而且块边界天然落在段落上。
 *   2. 删除块紧跟插入块 = 整段被改写，再对这两个块做一次**字符级** diff 填进 inline，
 *      前端就能把「整段替换」显示成「这一行里改了这几个字」。
 */
export function diffText(oldText: string, newText: string): DiffResult {
  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = 2; // 秒：超大章节也不至于卡住请求

  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(oldText, newText);
  const raw = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines_(raw, lineArray);

  // 行 token → 段落块。空行只是段落分隔符，不单独成块，
  // 否则面板里会出现一堆只有换行的「空块」。
  const blocks: DiffBlock[] = [];
  const pushLine = (type: DiffBlock['type'], line: string): void => {
    if (!line.trim()) return;
    const last = blocks[blocks.length - 1];
    if (last && last.type === type) last.text += '\n' + line;
    else blocks.push({ type, text: line });
  };
  for (const token of toLineTokens(raw)) {
    const line = token.text.endsWith('\n') ? token.text.slice(0, -1) : token.text;
    pushLine(token.type, line);
  }

  // 删除/插入成对出现：统一成「先删后插」，并补字符级高亮
  for (let i = 0; i < blocks.length - 1; i++) {
    if (blocks[i].type === 'insert' && blocks[i + 1].type === 'delete') {
      const tmp = blocks[i];
      blocks[i] = blocks[i + 1];
      blocks[i + 1] = tmp;
    }
    const del = blocks[i];
    const ins = blocks[i + 1];
    if (del.type !== 'delete' || ins.type !== 'insert') continue;
    const { delInline, insInline } = inlineDiff(dmp, del.text, ins.text);
    del.inline = delInline;
    ins.inline = insInline;
    i++; // 这对已经处理过
  }

  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const block of blocks) {
    const paras = block.text.split('\n').filter((l) => l.trim().length > 0).length;
    if (block.type === 'insert') added += paras;
    else if (block.type === 'delete') removed += paras;
    else unchanged += paras;
  }

  return { blocks, stats: { added, removed, unchanged } };
}

function inlineDiff(
  dmp: DiffMatchPatch,
  oldText: string,
  newText: string,
): {
  delInline: Array<{ type: 'equal' | 'insert' | 'delete'; text: string }>;
  insInline: Array<{ type: 'equal' | 'insert' | 'delete'; text: string }>;
} {
  const raw = dmp.diff_main(oldText, newText, false);
  dmp.diff_cleanupSemantic(raw);
  const delInline: Array<{ type: 'equal' | 'insert' | 'delete'; text: string }> = [];
  const insInline: Array<{ type: 'equal' | 'insert' | 'delete'; text: string }> = [];
  for (const [op, text] of raw) {
    if (!text) continue;
    if (op === 0) {
      delInline.push({ type: 'equal', text });
      insInline.push({ type: 'equal', text });
    } else if (op === -1) {
      delInline.push({ type: 'delete', text });
    } else {
      insInline.push({ type: 'insert', text });
    }
  }
  return { delInline, insInline };
}

function isMeta(v: unknown): v is SnapshotMeta {
  if (!v || typeof v !== 'object') return false;
  const m = v as SnapshotMeta;
  return (
    typeof m.id === 'string' &&
    typeof m.doc_id === 'string' &&
    typeof m.hash === 'string' &&
    typeof m.created_at === 'number'
  );
}
