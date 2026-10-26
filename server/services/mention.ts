/**
 * 出场识别 —— 设定库条目在正文中的出现位置（架构 7.4）。
 *
 * 算法：多模式匹配，长名优先。
 *   把所有条目的 name + aliases 建成「首字符 → 模式列表」的桶表，每个桶内按长度降序。
 *   扫描正文时逐字符查桶，命中就用最长的那条并跳过整段。
 *   这解决了两个真实问题：
 *     - 「林远山」不会被拆成「林远」+「山」（长优先，贪心前进）
 *     - 「林远」和「林远山」两个条目同时存在时，各自拿到该拿的命中
 *
 * 为什么不用 Aho–Corasick：条目数量在几百量级，正文按场景切分后每次只扫几千字，
 * 首字符分桶已经足够快（实测 3000 字场景 < 1ms），而 AC 的失败指针实现复杂度不划算。
 *
 * 为什么不用全文索引：搜索索引是「查关键词」，出场识别是「给定词表找全部位置」，
 * 方向相反；用索引反而要发起几百次查询。
 */

import type { Entity } from '../../shared/types.ts';
import type { ProjectContext } from '../context.ts';
import type { JobContext } from '../util/job-queue.ts';
import type { IndexMention } from '../db/index.ts';
import { Mutex } from './common.ts';

interface Pattern {
  /** 匹配文本（名称或别名） */
  text: string;
  /** 该文本对应的全部条目（同名不同人时会有多个，各自都算命中） */
  entityIds: string[];
}

/** 扫描结果：entityId → docId → 命中信息 */
type MentionMap = Map<string, Map<string, { count: number; first: number; last: number }>>;

export class MentionService {
  private ctx: ProjectContext;
  private mutex = new Mutex();
  /**
   * 模式表缓存：条目变动（save/delete）时由 invalidate() 失效。
   *
   * 用独立的 loaded 标记而不是 `patterns === null` 判断是否已加载：
   * 「一个设定条目都没有」是合法且常见的初始状态，缓存下来是空数组，
   * 空数组是 truthy，用 null 判断会把「空缓存」和「未加载」混为一谈。
   */
  private patterns: Pattern[] = [];
  private patternsLoaded = false;

  constructor(ctx: ProjectContext) {
    this.ctx = ctx;
  }

  /** 条目变更后必须调用，否则扫描会用到旧的名称表 */
  invalidate(): void {
    this.patternsLoaded = false;
  }

  // ─────────────────────────── 模式表 ───────────────────────────

  /**
   * 构建模式表。
   * force=true 时忽略缓存 —— 条目变更路径（scanEntity / scanAll）必须强制刷新，
   * 否则即使调用方忘了 invalidate()，也不会用旧名字表算出脏数据。
   */
  private async buildPatterns(force = false): Promise<Pattern[]> {
    if (this.patternsLoaded && !force) return this.patterns;

    const entities = await this.ctx.store.listEntities();
    const byText = new Map<string, Pattern>();

    for (const entity of entities) {
      const names = [entity.name, ...entity.aliases]
        .map((n) => n.trim())
        .filter((n) => n.length > 0);
      for (const name of names) {
        let pattern = byText.get(name);
        if (!pattern) {
          pattern = { text: name, entityIds: [] };
          byText.set(name, pattern);
        }
        if (!pattern.entityIds.includes(entity.id)) pattern.entityIds.push(entity.id);
      }
    }

    // 长名优先：桶内排序由扫描时处理，这里只保证整体顺序稳定
    this.patterns = [...byText.values()].sort((a, b) => b.text.length - a.text.length);
    this.patternsLoaded = true;
    return this.patterns;
  }

  /** 首字符桶：每个位置只比较以该字符开头的模式 */
  private bucketize(patterns: Pattern[]): Map<string, Pattern[]> {
    const buckets = new Map<string, Pattern[]>();
    for (const pattern of patterns) {
      const first = pattern.text[0];
      const arr = buckets.get(first);
      if (arr) arr.push(pattern);
      else buckets.set(first, [pattern]);
    }
    for (const arr of buckets.values()) arr.sort((a, b) => b.text.length - a.text.length);
    return buckets;
  }

  // ─────────────────────────── 扫描 ───────────────────────────

  /**
   * 扫描单场景并写回索引。
   * indexer.indexDoc 在每次保存后调用它 —— 只扫改动的那一个场景，秒级更新。
   */
  async scanDoc(docId: string, body: string): Promise<void> {
    let patterns = await this.buildPatterns();
    if (patterns.length === 0) {
      // 缓存可能是「条目还没建」时留下的空表。保存路径不会调 invalidate，
      // 这里再强制读一次盘：代价只在「确实没有任何条目」时才发生，
      // 但如果作者刚加了条目就写正文，不重读就会漏掉这次出场。
      patterns = await this.buildPatterns(true);
    }
    if (patterns.length === 0) {
      // 确实没有任何设定条目：把该文档的历史出场记录清掉，避免删条目后残留
      await this.clearDoc(docId);
      return;
    }

    const hits = this.scanText(body, patterns);
    await this.writeDocMentions(docId, hits);
  }

  /** 场景被删除/清空后清理它的出场记录（避免反向引用里出现「幽灵章节」） */
  async clearDoc(docId: string): Promise<void> {
    const rows = this.ctx.index.mentionsForDoc(docId);
    if (rows.length === 0) return;
    this.ctx.index.transaction(() => {
      for (const row of rows) {
        this.ctx.index.replaceMentions(row.entity_id, this.withoutDoc(row.entity_id, docId));
      }
    });
  }

  /**
   * 条目变更后重扫。
   *
   * 为什么不是「只扫这个条目」：别名之间存在遮蔽关系。
   * 给 A 加一个更长的别名后，原本属于 B 的短名命中会消失；
   * 只更新 A 会让 B 的出场统计变成脏数据。因此这里做一次全书重扫，
   * 但只写回「结果确实变了」的条目，避免无谓的数据库写入。
   */
  async scanEntity(entityId: string): Promise<void> {
    const patterns = await this.buildPatterns(true);
    const tree = await this.ctx.store.readTree();
    const scenes = tree.nodes.filter((n) => n.kind === 'scene');

    const buckets = this.bucketize(patterns);
    const fresh: MentionMap = new Map();
    for (const node of scenes) {
      const scene = await this.ctx.store.readScene(node.id);
      if (!scene) continue;
      mergeInto(fresh, node.id, this.scanText(scene.body, patterns, buckets));
    }

    const dirty = new Set<string>([entityId]);
    // 其它条目的结果可能被遮蔽关系改变，一并比较
    for (const entity of await this.ctx.store.listEntities()) dirty.add(entity.id);

    for (const id of dirty) {
      const next = fresh.get(id) ?? new Map();
      if (!this.sameMentions(id, next)) this.replaceEntityMentions(id, next);
    }
  }

  /** 全量重扫（重建索引、批量导入后用） */
  async scanAll(job?: JobContext): Promise<void> {
    const patterns = await this.buildPatterns(true);
    const tree = await this.ctx.store.readTree();
    const scenes = tree.nodes.filter((n) => n.kind === 'scene');
    const total = scenes.length || 1;

    const buckets = this.bucketize(patterns);
    const fresh: MentionMap = new Map();
    for (let i = 0; i < scenes.length; i++) {
      job?.throwIfCancelled();
      const node = scenes[i];
      const scene = await this.ctx.store.readScene(node.id);
      if (!scene) continue;
      mergeInto(fresh, node.id, this.scanText(scene.body, patterns, buckets));
      if (i % 20 === 0) job?.progress((i / total) * 0.9, `识别出场 ${i + 1}/${scenes.length}`);
    }

    const entities = await this.ctx.store.listEntities();
    this.ctx.index.transaction(() => {
      for (const entity of entities) {
        this.replaceEntityMentions(entity.id, fresh.get(entity.id) ?? new Map());
      }
    });
    job?.progress(0.95, '出场索引已更新');
  }

  // ─────────────────────────── 核心匹配 ───────────────────────────

  /**
   * 在文本里找全部命中。
   * 贪心最长匹配：命中后按命中长度前进，因此不会重复计数，也不会把长名拆成短名。
   */
  private scanText(
    body: string,
    patterns: Pattern[],
    buckets: Map<string, Pattern[]> = this.bucketize(patterns),
  ): Map<string, { count: number; first: number; last: number }> {
    const result = new Map<string, { count: number; first: number; last: number }>();
    if (!body) return result;

    let pos = 0;

    while (pos < body.length) {
      const bucket = buckets.get(body[pos]);
      if (!bucket) {
        pos++;
        continue;
      }

      let matched: Pattern | null = null;
      for (const candidate of bucket) {
        if (body.startsWith(candidate.text, pos)) {
          matched = candidate;
          break; // 桶内已按长度降序，第一个命中就是最长的
        }
      }

      if (!matched) {
        pos++;
        continue;
      }

      for (const entityId of matched.entityIds) {
        const cur = result.get(entityId);
        if (cur) {
          cur.count++;
          cur.last = pos;
        } else {
          result.set(entityId, { count: 1, first: pos, last: pos });
        }
      }
      pos += matched.text.length;
    }

    return result;
  }

  // ─────────────────────────── 索引写入 ───────────────────────────

  /** 把单场景的命中写进索引：每个条目保留其它场景的记录，只替换本文档这一行 */
  private async writeDocMentions(
    docId: string,
    hits: Map<string, { count: number; first: number; last: number }>,
  ): Promise<void> {
    const affected = new Set<string>(hits.keys());
    // 之前有、这次没有的条目：需要删掉本文档那一行
    for (const m of this.ctx.index.mentionsForDoc(docId)) affected.add(m.entity_id);

    this.ctx.index.transaction(() => {
      for (const entityId of affected) {
        const next = this.withoutDoc(entityId, docId);
        const hit = hits.get(entityId);
        if (hit) {
          next.push({
            entity_id: entityId,
            doc_id: docId,
            count: hit.count,
            first_pos: hit.first,
            last_pos: hit.last,
          });
        }
        this.ctx.index.replaceMentions(entityId, next);
      }
    });
  }

  /** 取某条目除指定文档外的全部出场记录（replaceMentions 是整体替换，必须先读后写） */
  private withoutDoc(entityId: string, docId: string): IndexMention[] {
    return this.ctx.index
      .mentionsForEntity(entityId)
      .filter((m) => m.doc_id !== docId)
      .map((m) => ({
        entity_id: entityId,
        doc_id: m.doc_id,
        count: m.count,
        first_pos: m.first_pos,
        last_pos: m.last_pos,
      }));
  }

  private replaceEntityMentions(
    entityId: string,
    hits: Map<string, { count: number; first: number; last: number }>,
  ): void {
    const list: IndexMention[] = [];
    for (const [docId, hit] of hits) {
      list.push({
        entity_id: entityId,
        doc_id: docId,
        count: hit.count,
        first_pos: hit.first,
        last_pos: hit.last,
      });
    }
    this.ctx.index.replaceMentions(entityId, list);
  }

  private sameMentions(
    entityId: string,
    next: Map<string, { count: number; first: number; last: number }>,
  ): boolean {
    const current = this.ctx.index.mentionsForEntity(entityId);
    if (current.length !== next.size) return false;
    for (const m of current) {
      const hit = next.get(m.doc_id);
      if (!hit) return false;
      if (hit.count !== m.count || hit.first !== m.first_pos || hit.last !== m.last_pos) return false;
    }
    return true;
  }

  /**
   * 补全 Mention 展示信息（实体名、文档名、路径）。
   * 索引里只存 id 与位置，展示用的名字从文件读 —— 这样改名后反向引用立刻正确，
   * 不需要等索引重建。
   */
  async describeMentions(entity: Entity): Promise<
    Array<{
      doc_id: string;
      doc_title: string;
      count: number;
      first_pos: number;
      last_pos: number;
    }>
  > {
    const tree = await this.ctx.store.readTree();
    const titleById = new Map(tree.nodes.map((n) => [n.id, n.title]));
    const orderById = new Map(tree.nodes.map((n) => [n.id, n]));
    const rows = this.ctx.index.mentionsForEntity(entity.id);
    return rows
      .map((m) => ({
        doc_id: m.doc_id,
        doc_title: titleById.get(m.doc_id) ?? m.doc_id,
        count: m.count,
        first_pos: m.first_pos,
        last_pos: m.last_pos,
      }))
      .sort((a, b) => {
        const na = orderById.get(a.doc_id);
        const nb = orderById.get(b.doc_id);
        // 按文档在书里的先后排，而不是按 id 字典序
        return (na?.order ?? 0) - (nb?.order ?? 0);
      });
  }
}

// ─────────────────────────── 内部工具 ───────────────────────────

function mergeInto(
  target: MentionMap,
  docId: string,
  hits: Map<string, { count: number; first: number; last: number }>,
): void {
  for (const [entityId, hit] of hits) {
    let docs = target.get(entityId);
    if (!docs) {
      docs = new Map();
      target.set(entityId, docs);
    }
    const cur = docs.get(docId);
    if (cur) {
      cur.count += hit.count;
      cur.last = Math.max(cur.last, hit.last);
      cur.first = Math.min(cur.first, hit.first);
    } else {
      docs.set(docId, { ...hit });
    }
  }
}
