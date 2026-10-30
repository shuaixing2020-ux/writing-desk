/**
 * 索引维护服务 —— 把磁盘文件同步进 SQLite。
 *
 * 三个入口：
 *   - indexDoc(docId)         保存后增量更新单个场景（快，走保存路径）
 *   - rebuildAll(ctx)         全量重建（后台作业，索引坏了时的万能修复）
 *   - ensureFresh(ctx)        启动时校验：索引为空或版本不符则重建
 */

import path from 'node:path';
import type { DocNode } from '../../shared/types.ts';
import type { ProjectContext } from '../context.ts';
import type { JobContext } from '../util/job-queue.ts';
import { ENTITY_DIRS } from '../store/project.ts';
import {
  canonicalize,
  parseRelations,
  relationsOnly,
  type ParsedRelation,
} from '../graph/relations-format.ts';
import { resolveTypeKey, loadRelationTypes } from '../graph/types.ts';

/** 索引结构与内容的版本。改动表结构或新增索引表时加一。 */
export const INDEX_SCHEMA_VERSION = 3;

export interface RebuildStats {
  docs: number;
  entities: number;
  words: number;
  relations: number;
  took_ms: number;
}

export class IndexerService {
  private ctx: ProjectContext;

  constructor(ctx: ProjectContext) {
    this.ctx = ctx;
  }

  /** 保存后增量更新单个场景（含出场识别） */
  async indexDoc(node: DocNode): Promise<void> {
    const scene = await this.ctx.store.readScene(node.id);
    if (!scene) {
      this.ctx.index.deleteDoc(node.id);
      return;
    }
    this.ctx.index.upsertDoc({
      id: node.id,
      path: node.file ?? '',
      kind: node.kind,
      title: node.title,
      parent_id: node.parent_id,
      order_no: node.order,
      status: node.status,
      words: node.word_count,
      hash: scene.hash,
      body: scene.body,
      updated_at: node.updated_at,
    });
    // 出场识别只扫这一个场景，秒级更新（架构 7.4）
    await this.ctx.mentions.scanDoc(node.id, scene.body);
  }

  /** 全量重建索引（后台作业） */
  async rebuildAll(job?: JobContext): Promise<RebuildStats> {
    const t0 = Date.now();
    const tree = await this.ctx.store.readTree();
    const scenes = tree.nodes.filter((n) => n.kind === 'scene');

    this.ctx.index.clear();

    // 先写文档元数据（含卷/章，便于搜索结果显示路径）
    this.ctx.index.transaction(() => {
      for (const node of tree.nodes) {
        this.ctx.index.upsertDoc({
          id: node.id,
          path: node.file ?? '',
          kind: node.kind,
          title: node.title,
          parent_id: node.parent_id,
          order_no: node.order,
          status: node.status,
          words: node.word_count,
          hash: '',
          body: node.kind === 'scene' ? '' : node.summary,
          updated_at: node.updated_at,
        });
      }
    });

    // 再逐个场景写入正文与出场（正文可能很大，分批提交避免长事务）
    let words = 0;
    const total = scenes.length || 1;
    for (let i = 0; i < scenes.length; i++) {
      job?.throwIfCancelled();
      const node = scenes[i];
      const scene = await this.ctx.store.readScene(node.id);
      if (scene) {
        this.ctx.index.upsertDoc({
          id: node.id,
          path: node.file ?? '',
          kind: 'scene',
          title: node.title,
          parent_id: node.parent_id,
          order_no: node.order,
          status: node.status,
          words: node.word_count,
          hash: scene.hash,
          body: scene.body,
          updated_at: node.updated_at,
        });
        words += node.word_count;
      }
      if (i % 20 === 0) {
        job?.progress((i / total) * 0.85, `索引正文 ${i + 1}/${scenes.length}`);
      }
    }

    // 设定条目
    const entities = await this.ctx.store.listEntities();
    this.ctx.index.transaction(() => {
      for (const e of entities) {
        this.ctx.index.upsertEntity({
          id: e.id,
          type: e.type,
          name: e.name,
          aliases: e.aliases,
        });
      }
    });

    // 出场索引（全量）
    job?.progress(0.88, '扫描出场');
    await this.ctx.mentions.scanAll(job);

    // 关系索引（全量）：从每个条目文件的 relations 块重建
    job?.progress(0.94, '索引关系');
    const relationStats = await this.rebuildRelations();

    this.ctx.index.setMeta('rebuilt_at', String(Date.now()));
    // 版本号加一：旧项目首次打开会因版本不符而重建，从而补上 relation 表数据
    this.ctx.index.setMeta('schema', String(INDEX_SCHEMA_VERSION));
    job?.progress(1, '索引重建完成');

    return {
      docs: tree.nodes.length,
      entities: entities.length,
      words,
      relations: relationStats.indexed,
      took_ms: Date.now() - t0,
    };
  }

  /**
   * 全量重建关系索引。
   *
   * 数据源是每个条目文件 frontmatter 里的 `relations: |` 块。
   * 无法解析的行不进表（它们由 lint 从文件侧报告），但也不会被改写。
   */
  async rebuildRelations(): Promise<{ indexed: number; unparsable: number }> {
    const entities = await this.ctx.store.listEntities();
    const types = await loadRelationTypes(this.ctx.root);

    // 先把所有条目的关系读出来（异步 IO 不能放在事务回调里），再一次性写库
    const parsed: Array<{ entityId: string; rows: RelationIndexRow[] }> = [];
    let unparsable = 0;

    for (const entity of entities) {
      const located = await this.ctx.store.entityRelationsRaw(entity.id);
      if (!located || !located.block) continue;

      const lines = parseRelations(located.block);
      unparsable += lines.filter(
        (l) => l.kind === 'raw' && l.text.trim() !== '' && !l.text.trim().startsWith('#'),
      ).length;

      parsed.push({ entityId: entity.id, rows: toIndexRows(entity.id, relationsOnly(lines), types) });
    }

    let indexed = 0;
    this.ctx.index.transaction(() => {
      this.ctx.index.clearRelations();
      for (const { entityId, rows } of parsed) {
        this.ctx.index.replaceRelationsOf(entityId, rows);
        indexed += rows.length;
      }
    });

    return { indexed, unparsable };
  }

  /** 单个条目的关系变更后增量更新（保存条目、增删改关系时调用） */
  async indexRelationsOf(entityId: string): Promise<void> {
    const located = await this.ctx.store.entityRelationsRaw(entityId);
    if (!located) {
      this.ctx.index.clearRelationsOf(entityId);
      return;
    }
    const types = await loadRelationTypes(this.ctx.root);
    const lines = parseRelations(located.block);
    const rows = toIndexRows(entityId, relationsOnly(lines), types);
    this.ctx.index.transaction(() => this.ctx.index.replaceRelationsOf(entityId, rows));
  }

  /** 启动时确保索引可用 */
  async ensureFresh(): Promise<void> {
    const hasSchema = this.ctx.index.getMeta('schema');
    const docCount = this.ctx.index.countDocs();
    // 版本不符就重建：新增表（如 relation）时旧索引缺数据，
    // 靠版本号让旧项目在打开时自动补齐。
    if (!hasSchema || hasSchema !== String(INDEX_SCHEMA_VERSION) || docCount === 0) {
      // 首次打开或索引丢失：静默重建（这是"索引可重建"的兜底路径）
      await this.rebuildAll();
    }
  }

  /** 场景被删除时清理索引 */
  removeDoc(docId: string): void {
    this.ctx.index.deleteDoc(docId);
  }

  /** 设定条目变更后重建出场索引 */
  async rescanMentionsForEntity(entityId: string): Promise<void> {
    await this.ctx.mentions.scanEntity(entityId);
  }
}

/** 从作品根目录推导作品 id（用目录名，人可读） */
export function projectIdFromRoot(root: string): string {
  return path.basename(root);
}

// ─────────────────────── 关系索引写入工具 ───────────────────────

interface RelationIndexRow {
  id: string;
  to_id: string;
  type: string;
  since: string | null;
  until: string | null;
  reveal: string | null;
  weight: number | null;
  note: string;
  extra: Record<string, string> | null;
  line_no: number | null;
}

/**
 * 把解析出的关系行转成索引行。
 * 类型统一成注册表 key（文件里写「师徒」也能正确落库成 mentor）。
 */
function toIndexRows(
  ownerId: string,
  rels: ParsedRelation[],
  types: Awaited<ReturnType<typeof loadRelationTypes>>,
): RelationIndexRow[] {
  return rels.map((rel) => {
    // 行里只记「对方 + 箭头」，规范方向由所在文件决定
    const { from, to } = canonicalize(ownerId, rel);
    return {
    id: rel.id,
    from_id: from,
    to_id: to,
    type: resolveTypeKey(types, rel.type) ?? rel.type,
    since: rel.since ?? null,
    until: rel.until ?? null,
    reveal: rel.reveal ?? null,
    weight: rel.weight ?? null,
    note: rel.note ?? '',
    extra: rel.extra_props ?? null,
    line_no: null,
    };
  });
}
