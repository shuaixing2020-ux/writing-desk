/**
 * 关系图谱服务（G1-2）。
 *
 * ═══════════════════ 范围（G1 只做单文件操作）═══════════════════
 *
 * 关系存在**起点条目**的 frontmatter 里，所以这些操作都只改一个文件，
 * 可以安全复用现有的原子写与写入互斥：
 *   - create：往起点文件追加一行
 *   - update：替换起点文件里的对应行（类型、区间、权重、备注）
 *   - remove：从起点文件删掉对应行
 *
 * **刻意不做**（等 G3 的多文件事务日志）：
 *   - 改 `to`（重连端点）
 *   - 反转方向
 *   - 合并/拆分条目
 *   - 级联删除
 * 这些都要同时改两个条目文件，一旦中途失败会出现"半边关系"，
 * 没有事务日志就不该做。
 *
 * ═══════════════════ 写入红线 ═══════════════════
 *
 * 1. 读-改-写在 `this.ctx.store` 的写互斥 + 保存锁内完成
 * 2. 全部走 writeFileAtomic
 * 3. 无法解析的 raw 行原样保留（红线 R5）
 */

import type {
  EntityType,
  GraphLintIssue,
  Relation,
  RelationInput,
  RelationPatch,
  RelationTypeDef,
} from '../../shared/types.ts';
import { ENTITY_TYPE_LABELS } from '../../shared/types.ts';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ProjectContext } from '../context.ts';
import { readTextSafe, writeFileAtomic } from '../util/atomic.ts';
import { parseFrontmatter, stringifyScene, type Frontmatter } from '../util/frontmatter.ts';
import {
  looksLikeBrokenRelation,
  newRelationId,
  canonicalize,
  lineFor,
  parseRelations,
  relationsOnly,
  stringifyRelation,
  stringifyRelations,
  type RelationLine,
} from './relations-format.ts';
import {
  describeAllowed,
  getTypeDef,
  isEndpointAllowed,
  loadRelationTypes,
  resolveTypeKey,
  type RelationTypeTable,
} from './types.ts';
import { chapterOrdinalOf } from './ordinal.ts';
import { withSaveLock } from '../routes/docs.ts';
import { beginTransaction, journalDirOf, type Transaction } from './journal.ts';

/** 带稳定错误码的关系操作错误 */
export class RelationError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'RelationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class GraphService {
  private ctx: ProjectContext;

  constructor(ctx: ProjectContext) {
    this.ctx = ctx;
  }

  // ─────────────────────── 查询 ───────────────────────

  /**
   * 某条目的出向与入向关系。
   *
   * - out：存在自己文件里的关系（我指向谁）
   * - in：从索引反查（谁指向我）。无向关系（亲属/盟友）也算进来
   *
   * 每条带 dangling 标记：目标条目已不存在时提示界面显示"目标已被删除"。
   */
  async list(entityId: string): Promise<{
    out: Array<Relation & { dangling?: boolean }>;
    in: Array<Relation & { dangling?: boolean }>;
  }> {
    const entities = await this.ctx.store.listEntities();
    const byId = new Map(entities.map((e) => [e.id, e]));
    if (!byId.has(entityId)) {
      throw new RelationError('rel_entity_missing', `条目不存在：${entityId}`, 404);
    }

    const out: Array<Relation & { dangling?: boolean }> = [];
    const inboundRaw = this.ctx.index.relationsTo(entityId);
    const outRaw = this.ctx.index.relationsFrom(entityId);

    for (const row of outRaw) {
      const target = byId.get(row.to_id);
      const rel: Relation & { dangling?: boolean } = {
        id: row.id,
        type: row.type,
        from: entityId,
        to: row.to_id,
        note: row.note,
      };
      if (target) rel.to_name = target.name;
      if (row.since) rel.since = row.since;
      if (row.until) rel.until = row.until;
      if (row.reveal) rel.reveal = row.reveal;
      if (row.weight !== null) rel.weight = row.weight;
      if (row.extra) rel.extra_props = row.extra;
      if (!target) rel.dangling = true;
      out.push(rel);
    }

    // 入向：别人指向我。排除自指重复（out 里已经有了）
    const inList: Array<Relation & { dangling?: boolean }> = [];
    for (const row of inboundRaw) {
      if (row.from_id === entityId) continue;
      const source = byId.get(row.from_id);
      const rel: Relation & { dangling?: boolean } = {
        id: row.id,
        type: row.type,
        from: row.from_id,
        to: entityId,
        note: row.note,
      };
      if (source) rel.to_name = source.name;
      else rel.dangling = true;
      if (row.since) rel.since = row.since;
      if (row.until) rel.until = row.until;
      if (row.reveal) rel.reveal = row.reveal;
      if (row.weight !== null) rel.weight = row.weight;
      if (row.extra) rel.extra_props = row.extra;
      inList.push(rel);
    }

    return { out, in: inList };
  }

  /** 全部关系类型定义（前端下拉用） */
  async listTypes(): Promise<{ types: RelationTypeDef[]; warnings: string[] }> {
    const table = await loadRelationTypes(this.ctx.root);
    return { types: [...table.byKey.values()], warnings: table.warnings };
  }

  // ─────────────────────── 校验 ───────────────────────

  /**
   * 校验一条待写入的关系。
   * 传入 `excludeRelationId` 用于 update 时跳过自身。
   */
  private async validate(input: {
    fromId: string;
    toId: string;
    typeKey: string;
    since?: string | null;
    until?: string | null;
    excludeRelationId?: string;
  }): Promise<{ def: RelationTypeDef; fromType: EntityType; toType: EntityType }> {
    const table = await loadRelationTypes(this.ctx.root);
    const def = getTypeDef(table, input.typeKey);
    if (!def) {
      throw new RelationError(
        'rel_type_unknown',
        `未知的关系类型「${input.typeKey}」。可用类型：${[...table.byKey.keys()].slice(0, 8).join('、')}…`,
      );
    }

    const entities = await this.ctx.store.listEntities();
    const byId = new Map(entities.map((e) => [e.id, e]));

    const from = byId.get(input.fromId);
    if (!from) throw new RelationError('rel_target_missing', `起点条目不存在：${input.fromId}`, 404);
    const to = byId.get(input.toId);
    if (!to) {
      throw new RelationError('rel_target_missing', `目标条目不存在：${input.toId}`, 404);
    }

    if (input.fromId === input.toId) {
      throw new RelationError('rel_self_loop', '关系不能指向自己。');
    }

    if (!isEndpointAllowed(def, from.type, to.type)) {
      const fromLabel = ENTITY_TYPE_LABELS[from.type] ?? from.type;
      const toLabel = ENTITY_TYPE_LABELS[to.type] ?? to.type;
      throw new RelationError(
        'rel_endpoint_invalid',
        `「${def.label}」不支持 ${fromLabel}→${toLabel}。允许的组合：${describeAllowed(def) || '不限'}`,
      );
    }

    // 锚点必须存在
    const tree = await this.ctx.store.readTree();
    const docIds = new Set(tree.nodes.map((n) => n.id));
    for (const [key, value] of [
      ['since', input.since],
      ['until', input.until],
    ] as const) {
      if (value && !docIds.has(value)) {
        throw new RelationError('rel_anchor_missing', `锚点 ${key} 指向的文档不存在：${value}`);
      }
    }

    // 区间合法性：until 的章序号不能早于 since
    if (input.since && input.until) {
      const s = chapterOrdinalOf(tree, input.since);
      const u = chapterOrdinalOf(tree, input.until);
      if (s !== null && u !== null && u < s) {
        throw new RelationError(
          'rel_range_invalid',
          `结束位置（第 ${u} 章）早于起始位置（第 ${s} 章）。`,
        );
      }
    }

    // 重复检查：同类型、同端点（无向忽略方向）、区间重叠
    const existing = this.ctx.index.relationsFrom(input.fromId);
    for (const row of existing) {
      if (input.excludeRelationId && row.id === input.excludeRelationId) continue;
      if (row.type !== def.key) continue;

      const samePair = def.directed
        ? row.to_id === input.toId
        : row.to_id === input.toId || row.to_id === input.fromId;
      if (!samePair) continue;

      // 区间不重叠就不算重复（同一个师徒关系可以分两个时期）
      if (!rangesOverlap(row.since, row.until, input.since ?? null, input.until ?? null)) continue;

      throw new RelationError(
        'rel_duplicate',
        `已存在相同的「${def.label}」关系（${to.name}）。如需分段，请给两条关系设置不同的起止章节。`,
        409,
      );
    }

    // 成环检查（仅对 acyclic 类型）
    if (def.acyclic) {
      const cycle = await this.findCycle(input.fromId, input.toId, def.key, input.excludeRelationId);
      if (cycle) {
        // cycle 的首尾都是起点，直接 join 即可；再补一次起点会写出
        // 「苏晚 → 林远 → 苏晚 → 苏晚」这种重复尾巴。
        const names = cycle.map((id) => byId.get(id)?.name ?? id).join(' → ');
        throw new RelationError('rel_cycle', `「${def.label}」不能成环：${names}`);
      }
    }

    return { def, fromType: from.type, toType: to.type };
  }

  /** 从 to 出发能否沿同类型关系走回 from（是则为环） */
  private async findCycle(
    fromId: string,
    toId: string,
    typeKey: string,
    excludeRelationId?: string,
  ): Promise<string[] | null> {
    const visited = new Set<string>();
    const stack: Array<{ id: string; path: string[] }> = [{ id: toId, path: [fromId, toId] }];

    while (stack.length > 0) {
      const { id, path } = stack.pop()!;
      if (id === fromId) return path;
      if (visited.has(id)) continue;
      visited.add(id);

      for (const row of this.ctx.index.relationsFrom(id)) {
        if (row.type !== typeKey) continue;
        if (excludeRelationId && row.id === excludeRelationId) continue;
        stack.push({ id: row.to_id, path: [...path, row.to_id] });
      }
    }
    return null;
  }

  // ─────────────────────── 写入 ───────────────────────

  /**
   * 读取起点条目的关系块，交给 fn 修改，再写回。
   *
   * 这是所有写操作的统一骨架：一个文件、一次读、一次写、原子落盘。
   * 锁用与场景保存同一把（withSaveLock），避免关系写入和正文保存打架。
   */
  /**
   * 这条关系行实际写在哪个条目文件里。
   *
   * 修订后的存储把关系写在「发起操作的条目」文件里，箭头表示方向，
   * 所以它可能在起点文件，也可能在终点文件 —— 修改与删除前必须先找到它，
   * 否则会在另一个文件里凭空造出一行重复关系。
   */
  private async ownerFileOf(
    relationId: string,
    fromId: string,
    toId: string,
  ): Promise<string> {
    const hasLine = async (entityId: string): Promise<boolean> => {
      const located = await this.ctx.store.entityRelationsRaw(entityId);
      if (!located || !located.block) return false;
      return parseRelations(located.block).some(
        (l) => l.kind === 'rel' && l.rel.id === relationId,
      );
    };
    if (await hasLine(fromId)) return fromId;
    if (fromId !== toId && (await hasLine(toId))) return toId;
    return fromId; // 两边都没有：交给上层报错
  }

  private async mutateRelations<T>(
    fromId: string,
    fn: (lines: RelationLine[]) => T,
  ): Promise<T> {
    return withSaveLock(this.ctx, fromId, async () => {
      const located = await this.ctx.store.entityRelationsRaw(fromId);
      if (!located) {
        throw new RelationError('rel_entity_missing', `条目不存在：${fromId}`, 404);
      }

      const raw = await readTextSafe(located.abs);
      if (raw === null) {
        throw new RelationError('rel_entity_missing', `条目文件读不到：${fromId}`, 404);
      }

      const { data, body } = parseFrontmatter(raw);
      const lines = parseRelations(typeof data.relations === 'string' ? data.relations : '');

      const result = fn(lines);

      // 序列化并写回；块为空时删掉该键，保持文件干净
      const block = stringifyRelations(lines);
      const next: Frontmatter = { ...data };
      if (block.trim()) next.relations = block;
      else delete next.relations;
      next.updated_at = Date.now();

      await writeFileAtomic(located.abs, stringifyScene(next, body));

      // 同步索引与出场（条目标题可能因 to_name 刷新而变化，但 id 不变）
      await this.ctx.indexer.indexRelationsOf(fromId);

      return result;
    });
  }

  /**
   * 新建关系。
   *
   * 第一个参数是「发起操作的条目」（owner），关系行写进它的文件；
   * 方向相对 owner：direction=out 表示 owner 是起点。
   * 旧契约 `{ to }` 仍然可用，等价于 owner 是起点。
   */
  async create(
    ownerId: string,
    input: RelationInput,
    opts: { dryRun?: boolean } = {},
  ): Promise<Relation> {
    const table = await loadRelationTypes(this.ctx.root);
    const typeKey = resolveTypeKey(table, input.type);
    if (!typeKey) {
      throw new RelationError('rel_type_unknown', `未知的关系类型「${input.type}」。`);
    }

    const other = input.other ?? input.to;
    if (!other) {
      throw new RelationError('rel_target_missing', '缺少对方条目。');
    }
    const direction = input.direction ?? 'out';
    // 换算成规范方向：起点 → 终点
    const fromId = direction === 'out' ? ownerId : other;
    const toId = direction === 'out' ? other : ownerId;

    // 校验必须在写入前跑一遍（dryRun 时只做校验就返回）
    const { def } = await this.validate({
      fromId,
      toId,
      typeKey,
      since: input.since ?? null,
      until: input.until ?? null,
    });

    const entities = await this.ctx.store.listEntities();
    const target = entities.find((e) => e.id === toId);

    // 撤销删除时允许按原 id 恢复；其余场景由服务端生成。
    // 显式 id 必须校验格式与唯一性，否则会覆盖已有关系。
    let relId = newRelationId();
    if (input.id) {
      if (!/^r_[0-9A-Za-z]{1,40}$/.test(input.id)) {
        throw new RelationError('rel_bad_id', `关系 id 格式不合法：${input.id}`);
      }
      if (this.ctx.index.getRelation(input.id)) {
        throw new RelationError('rel_duplicate', `关系 id 已存在：${input.id}`, 409);
      }
      const sameId = this.ctx.index
        .allRelations()
        .some((r) => r.id === input.id);
      if (sameId) {
        throw new RelationError('rel_duplicate', `关系 id 已存在：${input.id}`, 409);
      }
      relId = input.id;
    }

    const rel: Relation = {
      id: relId,
      type: def.key,
      from: fromId,
      to: toId,
      note: input.note ?? '',
    };
    if (target) rel.to_name = target.name;
    if (input.since) rel.since = input.since;
    if (input.until) rel.until = input.until;
    if (input.reveal) rel.reveal = input.reveal;
    if (input.weight !== undefined) rel.weight = input.weight;

    if (opts.dryRun) return rel;

    await this.mutateRelations(ownerId, (lines) => {
      // 追加到末尾：作者的书写顺序即阅读顺序
      lines.push({ kind: 'rel', rel: lineFor(ownerId, rel) });
      return null;
    });

    return rel;
  }

  /**
   * 修改关系。
   *
   * 只允许改「同一个起点文件里那一行」的内容：类型、区间、权重、备注。
   * **不允许改 to**（那要动两个文件，属 G3）。
   */
  async update(
    relationId: string,
    patch: RelationPatch,
    opts: { dryRun?: boolean } = {},
  ): Promise<Relation> {
    const row = this.ctx.index.getRelation(relationId);
    if (!row) {
      throw new RelationError('rel_not_found', `关系不存在：${relationId}`, 404);
    }

    const table = await loadRelationTypes(this.ctx.root);
    const nextType = patch.type !== undefined ? resolveTypeKey(table, patch.type) : row.type;
    if (!nextType) {
      throw new RelationError('rel_type_unknown', `未知的关系类型「${patch.type}」。`);
    }

    const nextSince = patch.since !== undefined ? patch.since : row.since;
    const nextUntil = patch.until !== undefined ? patch.until : row.until;

    // 改方向 = 翻转箭头（单文件操作）。
    // 注意方向是「相对关系所在文件」的：先找到它在哪个文件里，
    // 只有 patch.direction 与当前相对方向不同才真的翻转。
    const ownerId = await this.ownerFileOf(relationId, row.from_id, row.to_id);
    const currentRel: 'out' | 'in' = ownerId === row.from_id ? 'out' : 'in';
    const flip = patch.direction !== undefined && patch.direction !== currentRel;
    const nextFrom = flip ? row.to_id : row.from_id;
    const nextTo = flip ? row.from_id : row.to_id;

    const { def } = await this.validate({
      fromId: nextFrom,
      toId: nextTo,
      typeKey: nextType,
      since: nextSince,
      until: nextUntil,
      excludeRelationId: relationId,
    });

    const entities = await this.ctx.store.listEntities();
    const target = entities.find((e) => e.id === nextTo);

    const updated: Relation = {
      id: relationId,
      type: def.key,
      from: nextFrom,
      to: nextTo,
      note: patch.note !== undefined ? patch.note : row.note,
    };
    if (target) updated.to_name = target.name;
    const since = nextSince;
    const until = nextUntil;
    const reveal = patch.reveal !== undefined ? patch.reveal : row.reveal;
    const weight = patch.weight !== undefined ? patch.weight : row.weight;
    if (since) updated.since = since;
    if (until) updated.until = until;
    if (reveal) updated.reveal = reveal;
    if (weight !== null && weight !== undefined) updated.weight = weight;
    if (row.extra) updated.extra_props = row.extra;

    if (opts.dryRun) return updated;

    let found = false;
    await this.mutateRelations(ownerId, (lines) => {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.kind === 'rel' && line.rel.id === relationId) {
          // 就地替换：保持行位置，作者的分组顺序不乱
          lines[i] = { kind: 'rel', rel: lineFor(ownerId, updated) };
          found = true;
          break;
        }
      }
      return null;
    });

    if (!found) {
      throw new RelationError(
        'rel_not_found',
        `关系在条目文件里找不到（索引与文件不一致，请重建索引）：${relationId}`,
        409,
      );
    }

    return updated;
  }

  /** 删除关系：只在起点文件里移除那一行 */
  async remove(relationId: string): Promise<void> {
    const row = this.ctx.index.getRelation(relationId);
    if (!row) {
      throw new RelationError('rel_not_found', `关系不存在：${relationId}`, 404);
    }

    // 关系行写在「发起操作的条目」文件里，可能在起点也可能在终点，
    // 只去 from_id 的文件找会漏掉 `<-` 写法（删不掉且报 409）。
    const ownerId = await this.ownerFileOf(relationId, row.from_id, row.to_id);

    let found = false;
    await this.mutateRelations(ownerId, (lines) => {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.kind === 'rel' && line.rel.id === relationId) {
          lines.splice(i, 1);
          found = true;
          break;
        }
      }
      return null;
    });

    if (!found) {
      throw new RelationError('rel_not_found', `关系在条目文件里找不到：${relationId}`, 409);
    }
  }

  // ─────────────────────── 多文件操作（G3） ───────────────────────
  //
  // 下面这些操作都必须同时改两个条目文件。走事务日志：
  // 先记日志再应用，崩溃后下次打开作品时前滚补齐。

  /**
   * 反转关系方向：A→B 变成 B→A。
   *
   * 实现：A 的文件删掉这一行，B 的文件新增一行（id 保持不变，
   * 这样已经被引用的关系 id 不会失效）。
   */
  async reverse(relationId: string): Promise<Relation> {
    const row = this.ctx.index.getRelation(relationId);
    if (!row) {
      throw new RelationError('rel_not_found', `关系不存在：${relationId}`, 404);
    }

    const table = await loadRelationTypes(this.ctx.root);
    const def = table.byKey.get(row.type);
    if (def && !def.directed) {
      throw new RelationError(
        'rel_not_reversible',
        `「${def.label}」是无向关系，反转没有意义。`,
      );
    }

    if (row.from_id === row.to_id) {
      throw new RelationError('rel_self_loop', '自指关系无法反转。');
    }

    const entities = await this.ctx.store.listEntities();
    const byId = new Map(entities.map((e) => [e.id, e]));
    const fromEntity = byId.get(row.from_id);
    const toEntity = byId.get(row.to_id);
    if (!fromEntity || !toEntity) {
      throw new RelationError('rel_target_missing', '关系的一端条目已不存在，无法反转。', 404);
    }

    // 反转后端点角色互换，需要重新校验方向约束
    await this.validate({
      fromId: row.to_id,
      toId: row.from_id,
      typeKey: row.type,
      since: row.since,
      until: row.until,
      // 必须排除被反转的这条关系本身：检查「反转后是否成环」时，
      // 原来的 A→B 还留在索引里，如果不排除，它会立刻和待写的 B→A
      // 组成一个假环（实测报「师徒不能成环：苏晚 → 林远 → 苏晚」）。
      excludeRelationId: relationId,
    });

    // 用同一把锁锁住两个条目（按 id 排序加锁，避免死锁）
    const [lockA, lockB] = [row.from_id, row.to_id].sort();

    return withSaveLock(this.ctx, lockA, () =>
      withSaveLock(this.ctx, lockB, async () => {
        const tx = beginTransaction(
          this.ctx.root,
          journalDirOf(this.ctx.store.paths.studio),
          `反转关系 ${relationId}：${fromEntity.name} → ${toEntity.name}`,
        );

        // 源文件：移除这一行
        const srcPlan = await this.planMutation(row.from_id, (lines) => {
          const idx = lines.findIndex((l) => l.kind === 'rel' && l.rel.id === relationId);
          if (idx === -1) {
            throw new RelationError(
              'rel_not_found',
              '关系在条目文件里找不到（索引与文件不一致，请重建索引）。',
              409,
            );
          }
          lines.splice(idx, 1);
          return null;
        });
        tx.stage(srcPlan.relPath, srcPlan.before, srcPlan.after);

        // 目标文件：加入反向后的一行
        // 反转后的规范关系：起点终点互换，写在新的起点（原终点）文件里
        const reversedCanonical: Relation = {
          id: relationId,
          type: row.type,
          from: row.to_id,
          to: row.from_id,
          note: row.note,
          ...(row.since ? { since: row.since } : {}),
          ...(row.until ? { until: row.until } : {}),
          ...(row.reveal ? { reveal: row.reveal } : {}),
          ...(row.weight !== null ? { weight: row.weight } : {}),
          ...(row.extra ? { extra_props: row.extra } : {}),
        };

        const dstPlan = await this.planMutation(row.to_id, (lines) => {
          lines.push({ kind: 'rel', rel: lineFor(row.to_id, reversedCanonical) });
          return null;
        });
        tx.stage(dstPlan.relPath, dstPlan.before, dstPlan.after);

        await tx.commit();

        // 两个条目的索引都要刷新
        await this.ctx.indexer.indexRelationsOf(row.from_id);
        await this.ctx.indexer.indexRelationsOf(row.to_id);

        return reversedCanonical;
      }),
    );
  }

  /**
   * 接续关系端点：把 A→B 改成 A→C。
   *
   * 只改 A 的文件就够了（起点没变）—— 除非旧终点 B 那边还存着反向视角的行。
   * 本工具的关系只存在起点文件里，所以这里其实仍是单文件操作，
   * 但仍然走事务（统一路径，且将来若支持反向存储也能安全扩展）。
   */
  async retarget(relationId: string, newToId: string): Promise<Relation> {
    const row = this.ctx.index.getRelation(relationId);
    if (!row) {
      throw new RelationError('rel_not_found', `关系不存在：${relationId}`, 404);
    }
    if (row.to_id === newToId) {
      throw new RelationError('rel_same_target', '目标条目没有变化。');
    }

    const table = await loadRelationTypes(this.ctx.root);
    const nextType = row.type;
    if (!resolveTypeKey(table, nextType)) {
      throw new RelationError('rel_type_unknown', `未知的关系类型「${nextType}」。`);
    }

    await this.validate({
      fromId: row.from_id,
      toId: newToId,
      typeKey: nextType,
      since: row.since,
      until: row.until,
      excludeRelationId: relationId,
    });

    const entities = await this.ctx.store.listEntities();
    const target = entities.find((e) => e.id === newToId);

    return withSaveLock(this.ctx, row.from_id, async () => {
      const tx = beginTransaction(
        this.ctx.root,
        journalDirOf(this.ctx.store.paths.studio),
        `关系 ${relationId} 改指向 ${target?.name ?? newToId}`,
      );

      const plan = await this.planMutation(row.from_id, (lines) => {
        const line = lines.find((l) => l.kind === 'rel' && l.rel.id === relationId);
        if (!line || line.kind !== 'rel') {
          throw new RelationError(
            'rel_not_found',
            '关系在条目文件里找不到（索引与文件不一致，请重建索引）。',
            409,
          );
        }
        // 就地替换：保持行位置
        line.rel = {
          ...line.rel,
          to: newToId,
          to_name: target?.name,
        };
        return null;
      });
      tx.stage(plan.relPath, plan.before, plan.after);
      await tx.commit();

      await this.ctx.indexer.indexRelationsOf(row.from_id);

      return {
        id: row.id,
        type: row.type,
        from: row.from_id,
        to: newToId,
        ...(target ? { to_name: target.name } : {}),
        note: row.note,
        ...(row.since ? { since: row.since } : {}),
        ...(row.until ? { until: row.until } : {}),
        ...(row.reveal ? { reveal: row.reveal } : {}),
        ...(row.weight !== null ? { weight: row.weight } : {}),
      } as Relation;
    });
  }

  /**
   * 只计算改动、不落盘：返回「文件相对路径 + 改前 + 改后」。
   * 供事务登记使用。
   */
  private async planMutation(
    entityId: string,
    fn: (lines: RelationLine[]) => unknown,
  ): Promise<{ relPath: string; before: string; after: string }> {
    const located = await this.ctx.store.entityRelationsRaw(entityId);
    if (!located) {
      throw new RelationError('rel_entity_missing', `条目不存在：${entityId}`, 404);
    }

    const before = await readTextSafe(located.abs);
    if (before === null) {
      throw new RelationError('rel_entity_missing', `条目文件读不到：${entityId}`, 404);
    }

    const { data, body } = parseFrontmatter(before);
    const lines = parseRelations(typeof data.relations === 'string' ? data.relations : '');
    fn(lines);

    const block = stringifyRelations(lines);
    const next: Frontmatter = { ...data };
    if (block.trim()) next.relations = block;
    else delete next.relations;
    next.updated_at = Date.now();

    const after = stringifyScene(next, body);
    const relPath = path.relative(this.ctx.root, located.abs).split(path.sep).join('/');
    return { relPath, before, after };
  }

  /** 当前是否还有未完成的事务日志（调试与自检用） */
  async hasPendingJournal(): Promise<boolean> {
    try {
      const files = await fs.readdir(journalDirOf(this.ctx.store.paths.studio));
      return files.some((f) => f.endsWith('.json'));
    } catch {
      return false;
    }
  }

  /** 条目被删除时清理它作为起点的关系索引（文件已随条目移入回收站） */
  clearForEntity(entityId: string): void {
    this.ctx.index.clearRelationsOf(entityId);
  }

  // ─────────────────────── 一致性检查 ───────────────────────

  /**
   * 全书关系一致性检查。
   *
   * 报告四类问题，全部**只报不改**——关系是作者的结构化意图，工具不该猜着修。
   */
  async lint(): Promise<GraphLintIssue[]> {
    const issues: GraphLintIssue[] = [];
    const entities = await this.ctx.store.listEntities();
    const byId = new Map(entities.map((e) => [e.id, e]));
    const table = await loadRelationTypes(this.ctx.root);
    const tree = await this.ctx.store.readTree();
    const docIds = new Set(tree.nodes.map((n) => n.id));

    for (const entity of entities) {
      const located = await this.ctx.store.entityRelationsRaw(entity.id);
      if (!located || !located.block) continue;

      const lines = parseRelations(located.block);
      const seen = new Set<string>();

      lines.forEach((line, idx) => {
        const lineNo = idx + 1;

        // 1. 无法解析的行
        if (looksLikeBrokenRelation(line)) {
          issues.push({
            code: 'relation_unparsable_line',
            severity: 'error',
            entity_id: entity.id,
            entity_name: entity.name,
            detail: `无法解析的关系行：${(line as { text: string }).text.trim()}`,
            line_no: lineNo,
          });
          return;
        }
        if (line.kind !== 'rel') return;

        const rel = line.rel;

        // 2. 未知类型
        if (!resolveTypeKey(table, rel.type)) {
          issues.push({
            code: 'relation_unknown_type',
            severity: 'warn',
            entity_id: entity.id,
            entity_name: entity.name,
            relation_id: rel.id,
            detail: `未知的关系类型「${rel.type}」（可在 bible/_relation_types.json 里定义）`,
            line_no: lineNo,
          });
        }

        // 3. 悬空目标
        if (!byId.has(rel.to)) {
          issues.push({
            code: 'relation_dangling_target',
            severity: 'warn',
            entity_id: entity.id,
            entity_name: entity.name,
            relation_id: rel.id,
            detail: `目标条目已不存在：${rel.to}${rel.to_name ? `（${rel.to_name}）` : ''}`,
            line_no: lineNo,
          });
        }

        // 4. 锚点文档不存在
        for (const [key, value] of [
          ['since', rel.since],
          ['until', rel.until],
          ['reveal', rel.reveal],
        ] as const) {
          if (value && !docIds.has(value)) {
            issues.push({
              code: 'relation_anchor_missing',
              severity: 'warn',
              entity_id: entity.id,
              entity_name: entity.name,
              relation_id: rel.id,
              detail: `锚点 ${key} 指向的文档已不存在：${value}`,
              line_no: lineNo,
            });
          }
        }

        // 5. 同一 id 重复出现
        if (seen.has(rel.id)) {
          issues.push({
            code: 'relation_duplicate',
            severity: 'error',
            entity_id: entity.id,
            entity_name: entity.name,
            relation_id: rel.id,
            detail: `关系 id 在同一文件里重复：${rel.id}`,
            line_no: lineNo,
          });
        }
        seen.add(rel.id);
      });
    }

    return issues;
  }
}

// ─────────────────────── 工具 ───────────────────────

/** 从 Relation 去掉 from（文件里不存起点，由所在文件决定） */
function withoutFrom(rel: Relation): Omit<Relation, 'from'> {
  const { from: _from, ...rest } = rel;
  return rest;
}

/**
 * 两个区间是否重叠。
 *
 * null 视为「不限」：两端都没限 → 必然重叠；只有一端有限 → 覆盖全区间。
 * 这样「师徒关系分两段」时，只要区间不交叠就不算重复。
 */
function rangesOverlap(
  aSince: string | null,
  aUntil: string | null,
  bSince: string | null,
  bUntil: string | null,
): boolean {
  if (aSince === null && aUntil === null) return true;
  if (bSince === null && bUntil === null) return true;
  // 用文档 id 无法比大小，这里退化为「有一端相同即视为重叠」的保守策略，
  // 具体区间判定由上层用章节序号做严格比较。
  return aSince === bSince || aUntil === bUntil || aSince === aUntil;
}
