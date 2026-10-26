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

export interface RebuildStats {
  docs: number;
  entities: number;
  words: number;
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

    this.ctx.index.setMeta('rebuilt_at', String(Date.now()));
    this.ctx.index.setMeta('schema', '1');
    job?.progress(1, '索引重建完成');

    return { docs: tree.nodes.length, entities: entities.length, words, took_ms: Date.now() - t0 };
  }

  /** 启动时确保索引可用 */
  async ensureFresh(): Promise<void> {
    const hasSchema = this.ctx.index.getMeta('schema');
    const docCount = this.ctx.index.countDocs();
    if (!hasSchema || docCount === 0) {
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
