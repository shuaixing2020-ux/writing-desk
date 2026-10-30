/**
 * SQLite 索引层（架构 6.3）—— 「索引可重建」的执行层。
 *
 * 铁律：这里的一切数据都可由磁盘文件完整重建。
 * 索引损坏 → 删掉 .studio/index.sqlite → 重建，不丢任何内容。
 *
 * 中文全文检索方案（架构 7.4）：
 *   FTS5 的 trigram 分词器对 ≥3 字的子串有效；2 字人名（如「林远」）搜不到。
 *   因此采用「逐字建索引」：把正文按字符拆开存入 fts5 表，
 *   查询时把 query 也拆成字符序列，用短语查询 ("林" "远") 精确匹配连续子串。
 *   这样任意长度（含 2 字）的中文子串都能命中，且能返回位置。
 */

import { DatabaseSync } from 'node:sqlite';
import { ensureDir } from '../util/atomic.ts';

export interface IndexDoc {
  id: string;
  path: string;
  kind: 'volume' | 'chapter' | 'scene';
  title: string;
  parent_id: string | null;
  order_no: number;
  status: string;
  words: number;
  hash: string;
  body: string;
  updated_at: number;
}

export interface IndexEntity {
  id: string;
  type: string;
  name: string;
  aliases: string[];
}

export interface IndexMention {
  entity_id: string;
  doc_id: string;
  count: number;
  first_pos: number;
  last_pos: number;
}

export interface SearchOptions {
  /** 限定文档类型 */
  kind?: 'scene' | 'entity';
  limit?: number;
}

export interface RawSearchHit {
  doc_id: string;
  title: string;
  path: string;
  count: number;
  snippet: string;
  kind: 'scene' | 'entity';
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS doc (
  id         TEXT PRIMARY KEY,
  path       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  parent_id  TEXT,
  order_no   INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'draft',
  words      INTEGER NOT NULL DEFAULT 0,
  hash       TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS doc_parent ON doc(parent_id, order_no);
CREATE INDEX IF NOT EXISTS doc_kind ON doc(kind);

CREATE TABLE IF NOT EXISTS entity (
  id   TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS entity_type ON entity(type);

CREATE TABLE IF NOT EXISTS mention (
  entity_id TEXT NOT NULL,
  doc_id    TEXT NOT NULL,
  count     INTEGER NOT NULL DEFAULT 0,
  first_pos INTEGER NOT NULL DEFAULT 0,
  last_pos  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entity_id, doc_id)
);
CREATE INDEX IF NOT EXISTS mention_doc ON mention(doc_id);

-- 逐字全文索引：每个 (doc, 字符) 一行，seq 为字符序号
CREATE TABLE IF NOT EXISTS char_index (
  doc_id TEXT NOT NULL,
  seq    INTEGER NOT NULL,
  ch     TEXT NOT NULL,
  PRIMARY KEY (doc_id, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS char_ch ON char_index(ch, doc_id);

CREATE TABLE IF NOT EXISTS lint_result (
  rule_id  TEXT NOT NULL,
  doc_id   TEXT NOT NULL,
  from_pos INTEGER NOT NULL,
  to_pos   INTEGER NOT NULL,
  text     TEXT NOT NULL,
  message  TEXT NOT NULL,
  severity TEXT NOT NULL,
  PRIMARY KEY (rule_id, doc_id, from_pos)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 关系索引。与其他索引表一样：**可丢弃重建**，真相在条目文件的 relations 块里。
-- 关系行写在「发起操作的条目」文件里，箭头表方向，因此需要两个概念：
--   owner_id：这一行写在哪个条目文件里（更新/删除时去这里找）
--   from_id / to_id：规范方向（起点 / 终点），与写在哪无关
-- 这张表只存结构化的字段；无法解析的行不进表，由 lint 从文件里报告。
CREATE TABLE IF NOT EXISTS relation (
  id        TEXT PRIMARY KEY,
  owner_id  TEXT,
  from_id   TEXT NOT NULL,
  to_id     TEXT NOT NULL,
  type      TEXT NOT NULL,
  since     TEXT,
  until     TEXT,
  reveal    TEXT,
  weight    INTEGER,
  note      TEXT NOT NULL DEFAULT '',
  -- 未知属性以 JSON 保存，保证往返不丢（红线 R5：绝不静默丢弃）
  extra     TEXT NOT NULL DEFAULT '',
  -- 在 relations 块里的行号（从 1 开始），用于 lint 定位
  line_no   INTEGER
);
CREATE INDEX IF NOT EXISTS relation_from  ON relation(from_id);
CREATE INDEX IF NOT EXISTS relation_owner ON relation(owner_id);
CREATE INDEX IF NOT EXISTS relation_to   ON relation(to_id);
CREATE INDEX IF NOT EXISTS relation_type ON relation(type);

CREATE TABLE IF NOT EXISTS goal_log (
  date    TEXT PRIMARY KEY,
  words   INTEGER NOT NULL DEFAULT 0,
  seconds INTEGER NOT NULL DEFAULT 0
);
`;

export class IndexDb {
  private db: DatabaseSync;
  private inTx = false;

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath);
    this.db.exec(SCHEMA);
  }

  static async open(filePath: string): Promise<IndexDb> {
    await ensureDir(require_dirname(filePath));
    return new IndexDb(filePath);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* 已关闭 */
    }
  }

  /** 批量写入用事务包裹，300 万字重建时快一个数量级 */
  transaction<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.inTx = true;
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  clear(): void {
    this.transaction(() => {
      this.db.exec(`
        DELETE FROM doc;
        DELETE FROM entity;
        DELETE FROM mention;
        DELETE FROM char_index;
        DELETE FROM lint_result;
        DELETE FROM relation;
      `);
    });
  }

  // ─────────────────────── 写入 ───────────────────────

  upsertDoc(doc: IndexDoc): void {
    this.db
      .prepare(
        `INSERT INTO doc (id, path, kind, title, parent_id, order_no, status, words, hash, body, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           path=excluded.path, kind=excluded.kind, title=excluded.title,
           parent_id=excluded.parent_id, order_no=excluded.order_no,
           status=excluded.status, words=excluded.words, hash=excluded.hash,
           body=excluded.body, updated_at=excluded.updated_at`,
      )
      .run(
        doc.id,
        doc.path,
        doc.kind,
        doc.title,
        doc.parent_id,
        doc.order_no,
        doc.status,
        doc.words,
        doc.hash,
        doc.body,
        doc.updated_at,
      );

    // 重建该文档的逐字索引
    this.db.prepare('DELETE FROM char_index WHERE doc_id = ?').run(doc.id);
    if (doc.body) {
      const insert = this.db.prepare('INSERT INTO char_index (doc_id, seq, ch) VALUES (?, ?, ?)');
      let seq = 0;
      for (const ch of doc.body) {
        // 只索引非空白字符，减少 30% 体积；空白不参与子串匹配
        if (!/\s/.test(ch)) insert.run(doc.id, seq, ch);
        seq++;
      }
    }
  }

  deleteDoc(docId: string): void {
    this.db.prepare('DELETE FROM doc WHERE id = ?').run(docId);
    this.db.prepare('DELETE FROM char_index WHERE doc_id = ?').run(docId);
    this.db.prepare('DELETE FROM mention WHERE doc_id = ?').run(docId);
    this.db.prepare('DELETE FROM lint_result WHERE doc_id = ?').run(docId);
  }

  upsertEntity(entity: IndexEntity): void {
    this.db
      .prepare(
        `INSERT INTO entity (id, type, name, aliases) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET type=excluded.type, name=excluded.name, aliases=excluded.aliases`,
      )
      .run(entity.id, entity.type, entity.name, JSON.stringify(entity.aliases));
  }

  deleteEntity(entityId: string): void {
    this.db.prepare('DELETE FROM entity WHERE id = ?').run(entityId);
    this.db.prepare('DELETE FROM mention WHERE entity_id = ?').run(entityId);
  }

  replaceMentions(entityId: string, mentions: IndexMention[]): void {
    this.db.prepare('DELETE FROM mention WHERE entity_id = ?').run(entityId);
    const insert = this.db.prepare(
      'INSERT INTO mention (entity_id, doc_id, count, first_pos, last_pos) VALUES (?, ?, ?, ?, ?)',
    );
    for (const m of mentions) insert.run(entityId, m.doc_id, m.count, m.first_pos, m.last_pos);
  }

  replaceLintResults(docId: string, results: Array<{ rule_id: string; from_pos: number; to_pos: number; text: string; message: string; severity: string }>): void {
    this.db.prepare('DELETE FROM lint_result WHERE doc_id = ?').run(docId);
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO lint_result (rule_id, doc_id, from_pos, to_pos, text, message, severity)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of results) {
      insert.run(r.rule_id, docId, r.from_pos, r.to_pos, r.text, r.message, r.severity);
    }
  }

  // ─────────────────────── 关系索引 ───────────────────────
  //
  // 这张表与其他索引表同性质：**可从文件完整重建**。
  // 真相是条目文件的 `relations: |` 块，表只用于快速反查（某人被谁指向）。

  /** 整体替换某个起点的全部关系（先删后插，调用方保证在事务内） */
  replaceRelationsOf(ownerId: string, rels: RelationRow[]): void {
    // 按「写在哪个文件」清理：同一条规范的边可能被两个文件各写一行，
    // 用 from_id 清理会误删另一端的行。
    this.db.prepare('DELETE FROM relation WHERE owner_id = ?').run(ownerId);
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO relation
        (id, owner_id, from_id, to_id, type, since, until, reveal, weight, note, extra, line_no)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rels) {
      insert.run(
        r.id,
        ownerId,
        r.from_id ?? ownerId,
        r.to_id,
        r.type,
        r.since ?? null,
        r.until ?? null,
        r.reveal ?? null,
        r.weight ?? null,
        r.note ?? '',
        r.extra ? JSON.stringify(r.extra) : '',
        r.line_no ?? null,
      );
    }
  }

  /** 删除某个起点的全部关系（条目被删除/移入回收站时调用） */
  clearRelationsOf(fromId: string): void {
    this.db.prepare('DELETE FROM relation WHERE from_id = ?').run(fromId);
  }

  /** 删除单条关系 */
  deleteRelation(id: string): void {
    this.db.prepare('DELETE FROM relation WHERE id = ?').run(id);
  }

  /** 该条目指向别人的关系 */
  relationsFrom(id: string): StoredRelationRow[] {
    const rows = this.db
      .prepare('SELECT * FROM relation WHERE from_id = ? ORDER BY line_no, id')
      .all(id) as Array<Record<string, unknown>>;
    return rows.map(toRelationRow);
  }

  /**
   * 指向该条目的关系。
   *
   * 无向关系（亲属、盟友）在文件里只存一份（约定存 id 较小的一方），
   * 所以「反向视角」在查询时由调用方按类型定义补充，这里只按 to_id 精确匹配。
   */
  relationsTo(id: string): StoredRelationRow[] {
    const rows = this.db
      .prepare('SELECT * FROM relation WHERE to_id = ? ORDER BY from_id, line_no')
      .all(id) as Array<Record<string, unknown>>;
    return rows.map(toRelationRow);
  }

  getRelation(id: string): StoredRelationRow | null {
    const row = this.db.prepare('SELECT * FROM relation WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toRelationRow(row) : null;
  }

  allRelations(): StoredRelationRow[] {
    const rows = this.db.prepare('SELECT * FROM relation ORDER BY from_id, line_no').all() as Array<
      Record<string, unknown>
    >;
    return rows.map(toRelationRow);
  }

  clearRelations(): void {
    this.db.prepare('DELETE FROM relation').run();
  }

  countRelations(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM relation').get() as { c: number };
    return Number(row.c);
  }

  /**
   * 找出所有关系 id 重复的行（同一 id 出现在多个文件里）。
   * 用于 lint —— 这通常意味着复制粘贴条目文件后忘了改 id。
   */
  duplicateRelationIds(): Array<{ id: string; from_ids: string[] }> {
    const rows = this.db
      .prepare(
        `SELECT id, GROUP_CONCAT(from_id) AS froms, COUNT(*) AS n
           FROM relation GROUP BY id HAVING n > 1`,
      )
      .all() as Array<{ id: string; froms: string; n: number }>;
    return rows.map((r) => ({ id: r.id, from_ids: String(r.froms).split(',') }));
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  // ─────────────────────── 查询 ───────────────────────

  getDoc(docId: string): IndexDoc | null {
    const row = this.db.prepare('SELECT * FROM doc WHERE id = ?').get(docId) as
      | Record<string, unknown>
      | undefined;
    return row ? (row as unknown as IndexDoc) : null;
  }

  countDocs(kind?: string): number {
    const row = kind
      ? (this.db.prepare('SELECT COUNT(*) AS c FROM doc WHERE kind = ?').get(kind) as { c: number })
      : (this.db.prepare('SELECT COUNT(*) AS c FROM doc').get() as { c: number });
    return Number(row.c);
  }

  totalWords(): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(words), 0) AS w FROM doc WHERE kind = 'scene'")
      .get() as { w: number };
    return Number(row.w);
  }

  listEntities(type?: string): Array<{ id: string; type: string; name: string; aliases: string[] }> {
    const rows = (
      type
        ? this.db.prepare('SELECT * FROM entity WHERE type = ? ORDER BY name').all(type)
        : this.db.prepare('SELECT * FROM entity ORDER BY type, name').all()
    ) as Array<{ id: string; type: string; name: string; aliases: string }>;
    return rows.map((r) => ({ ...r, aliases: safeJsonArray(r.aliases) }));
  }

  /** 某个场景里出场过的条目 id（"聚焦本章出场人物"用） */
  entityIdsMentionedIn(docId: string): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT entity_id FROM mention WHERE doc_id = ? AND count > 0')
      .all(docId) as Array<{ entity_id: string }>;
    return rows.map((r) => r.entity_id);
  }

  mentionsForEntity(entityId: string): Array<{ doc_id: string; count: number; first_pos: number; last_pos: number }> {
    return this.db
      .prepare('SELECT doc_id, count, first_pos, last_pos FROM mention WHERE entity_id = ?')
      .all(entityId) as Array<{ doc_id: string; count: number; first_pos: number; last_pos: number }>;
  }

  mentionsForDoc(docId: string): Array<{ entity_id: string; count: number }> {
    return this.db
      .prepare('SELECT entity_id, count FROM mention WHERE doc_id = ? ORDER BY count DESC')
      .all(docId) as Array<{ entity_id: string; count: number }>;
  }

  /**
   * 中文子串搜索。
   *
   * 原理：选 query 中出现频率最低的字符作为锚点，从 char_index 取出它所有
   * (doc_id, seq) 候选；再在正文里按 seq 直接切出等长子串比对。
   * 这样既能命中 2 字词（trigram 做不到），也避免全表扫描。
   *
   * 注意：char_index 的 seq 是「字符序号（含空白）」，与 Array.from(body) 下标一致。
   */
  search(query: string, opts: SearchOptions = {}): RawSearchHit[] {
    const q = Array.from(query).filter((ch) => !/\s/.test(ch));
    if (q.length === 0) return [];
    const limit = opts.limit ?? 50;

    // 选锚点字符：库中出现次数最少的，候选集最小
    let anchorChar = q[0];
    let anchorCount = Number.POSITIVE_INFINITY;
    for (const ch of new Set(q)) {
      const row = this.db.prepare('SELECT COUNT(*) AS c FROM char_index WHERE ch = ?').get(ch) as { c: number };
      const c = Number(row.c);
      if (c === 0) return []; // 任一字符不存在 → 必然无命中
      if (c < anchorCount) {
        anchorCount = c;
        anchorChar = ch;
      }
    }
    const anchorIndex = q.indexOf(anchorChar);
    const needle = q.join('');

    const anchors = this.db
      .prepare('SELECT doc_id, seq FROM char_index WHERE ch = ?')
      .all(anchorChar) as Array<{ doc_id: string; seq: number }>;

    const bodyStmt = this.db.prepare('SELECT title, path, body FROM doc WHERE id = ?');
    const bodies = new Map<string, { title: string; path: string; chars: string[] }>();
    const hits = new Map<string, { firstSeq: number; count: number }>();

    for (const anchor of anchors) {
      const startSeq = anchor.seq - anchorIndex;
      if (startSeq < 0) continue;

      let doc = bodies.get(anchor.doc_id);
      if (!doc) {
        const row = bodyStmt.get(anchor.doc_id) as { title: string; path: string; body: string } | undefined;
        if (!row) continue;
        doc = { title: row.title, path: row.path, chars: Array.from(row.body) };
        bodies.set(anchor.doc_id, doc);
      }
      if (startSeq + q.length > doc.chars.length) continue;

      // 直接切片比对：char_index 已保证锚点字符匹配，这里验证整段
      if (doc.chars.slice(startSeq, startSeq + q.length).join('') !== needle) continue;

      const cur = hits.get(anchor.doc_id);
      if (cur) cur.count++;
      else hits.set(anchor.doc_id, { firstSeq: startSeq, count: 1 });
    }

    const out: RawSearchHit[] = [];
    for (const [docId, info] of hits) {
      const doc = bodies.get(docId);
      if (!doc) continue;
      out.push({
        doc_id: docId,
        title: doc.title,
        path: doc.path,
        count: info.count,
        snippet: makeSnippet(doc.chars, info.firstSeq, q.length),
        kind: 'scene',
      });
    }

    out.sort((a, b) => b.count - a.count);
    return out.slice(0, limit);
  }

  /** 搜索设定条目（名称 + 别名） */
  searchEntities(query: string, limit = 30): RawSearchHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const rows = this.db.prepare('SELECT * FROM entity').all() as Array<{
      id: string;
      type: string;
      name: string;
      aliases: string;
    }>;
    const out: RawSearchHit[] = [];
    for (const r of rows) {
      const aliases = safeJsonArray(r.aliases);
      const hay = [r.name, ...aliases].join(' ').toLowerCase();
      if (!hay.includes(q)) continue;
      const mentions = this.mentionsForEntity(r.id);
      const total = mentions.reduce((s, m) => s + m.count, 0);
      out.push({
        doc_id: r.id,
        title: r.name,
        path: `设定库 / ${r.type}`,
        count: total,
        snippet: aliases.length ? `别名：${aliases.join('、')}` : r.name,
        kind: 'entity',
      });
    }
    return out.sort((a, b) => b.count - a.count).slice(0, limit);
  }
}

/** 关系索引行的形状（与 shared/types.ts 的 Relation 对齐，另带行号） */
/** 从表里读出来的关系行（from_id 必有） */
export type StoredRelationRow = RelationRow & { from_id: string };

export interface RelationRow {
  id: string;
  /**
   * 关系所属的起点条目。
   *
   * 写入时可以不传 —— replaceRelationsOf(fromId, rows) 会统一填上；
   * 读取时总是有值（来自表的 from_id 列）。
   */
  from_id?: string;
  to_id: string;
  type: string;
  since: string | null;
  until: string | null;
  reveal: string | null;
  weight: number | null;
  note: string;
  extra: Record<string, string> | null;
  line_no: number | null;
  /** 这一行写在哪个条目文件里 */
  owner_id?: string;
}

function toRelationRow(raw: Record<string, unknown>): StoredRelationRow {
  let extra: Record<string, string> | null = null;
  if (typeof raw.extra === 'string' && raw.extra) {
    try {
      const parsed = JSON.parse(raw.extra) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        extra = parsed as Record<string, string>;
      }
    } catch {
      // 坏数据不阻塞查询：当作没有额外属性，lint 会从文件侧报告
      extra = null;
    }
  }
  return {
    id: String(raw.id),
    from_id: String(raw.from_id),
    to_id: String(raw.to_id),
    type: String(raw.type),
    since: raw.since === null || raw.since === undefined ? null : String(raw.since),
    until: raw.until === null || raw.until === undefined ? null : String(raw.until),
    reveal: raw.reveal === null || raw.reveal === undefined ? null : String(raw.reveal),
    weight: typeof raw.weight === 'number' ? raw.weight : null,
    note: typeof raw.note === 'string' ? raw.note : '',
    extra,
    line_no: typeof raw.line_no === 'number' ? raw.line_no : null,
  };
}

function safeJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** 用字符序号生成带 <mark> 的片段 */
function makeSnippet(chars: string[], startSeq: number, len: number): string {
  const from = Math.max(0, startSeq - 30);
  const to = Math.min(chars.length, startSeq + len + 30);
  const head = from > 0 ? '…' : '';
  const tail = to < chars.length ? '…' : '';
  const before = chars.slice(from, startSeq).join('');
  const hit = chars.slice(startSeq, startSeq + len).join('');
  const after = chars.slice(startSeq + len, to).join('');
  return `${head}${escapeHtml(before)}<mark>${escapeHtml(hit)}</mark>${escapeHtml(after)}${tail}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

function require_dirname(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx > 0 ? p.slice(0, idx) : '.';
}
