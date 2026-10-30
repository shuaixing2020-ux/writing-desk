/**
 * 一句话建关系（R2）。
 *
 * 作者不该被迫理解「起点」「终点」——他说的是「老掌门是林远的师父」。
 * 这里把那句话翻成一条规范关系，再决定写进哪个条目的文件、箭头朝哪。
 *
 * 三个概念要分清：
 *   from / to       规范方向（谁指向谁）
 *   owner           关系行写进谁的文件（发起操作的那个条目）
 *   direction       相对 owner 的箭头：out = owner 是起点
 */

import type { RelationTypeDef } from '../../../shared/types.ts';

export interface RoleWord {
  /** 角色词，如「师父」「徒弟」「盟友」 */
  word: string;
  /** 所属类型键，如 mentor */
  type: string;
  /** true = 这个词指起点一方；false = 指终点一方；null = 对称类型 */
  selfIsFrom: boolean | null;
}

/**
 * 从类型注册表里取出所有可用角色词。
 *
 * 对称类型只出一次（from_role 与 to_role 相同，出两个就重复了）。
 * 跳过没有角色词定义的旧配置项 —— 宁可少一个词，也不给作者看空选项。
 */
export function roleWords(types: RelationTypeDef[]): RoleWord[] {
  const out: RoleWord[] = [];
  for (const t of types) {
    const from = (t.from_role ?? '').trim();
    const to = (t.to_role ?? '').trim();
    const symmetric = t.symmetric ?? !t.directed;

    if (symmetric) {
      const word = from || to;
      if (word) out.push({ word, type: t.key, selfIsFrom: null });
      continue;
    }
    if (from) out.push({ word: from, type: t.key, selfIsFrom: true });
    if (to && to !== from) out.push({ word: to, type: t.key, selfIsFrom: false });
  }
  return out;
}

export interface ResolvedSentence {
  from: string;
  to: string;
  type: string;
  symmetric: boolean;
}

/**
 * 解析「x 是 y 的 {word}」。
 *
 * word 指起点 → from=x, to=y；world 指终点 → from=y, to=x。
 * 对称类型没有方向，约定 from=x、to=y，由 symmetric 标记让上层忽略顺序。
 */
export function resolveSentence(x: string, y: string, w: RoleWord): ResolvedSentence {
  if (w.selfIsFrom === null) {
    return { from: x, to: y, type: w.type, symmetric: true };
  }
  if (w.selfIsFrom) {
    return { from: x, to: y, type: w.type, symmetric: false };
  }
  return { from: y, to: x, type: w.type, symmetric: false };
}

export interface OwnerDirection {
  owner: string;
  other: string;
  /** 相对 owner：out 表示 owner 是起点 */
  direction: 'out' | 'in';
}

/**
 * 决定写进哪个文件、箭头朝哪。
 *
 * 优先写当前打开的那个条目 —— 作者在谁的页面操作，就动谁的文件。
 * 当前页面既不是 x 也不是 y 时退回写 x（与原型一致）。
 */
export function ownerAndDirection(
  ctxEntityId: string | null,
  x: string,
  y: string,
  r: ResolvedSentence,
): OwnerDirection {
  const pick = (owner: string, other: string): OwnerDirection => ({
    owner,
    other,
    direction: r.from === owner ? 'out' : 'in',
  });

  if (ctxEntityId && ctxEntityId === x) return pick(x, y);
  if (ctxEntityId && ctxEntityId === y) return pick(y, x);
  return pick(x, y);
}

/** 预览文案：让作者提交前就看到会建出什么 */
export function previewText(
  xName: string,
  yName: string,
  w: RoleWord,
  typeLabel: string,
): string {
  const arrow =
    w.selfIsFrom === null ? '（对称关系）' : w.selfIsFrom ? `（${typeLabel}，${xName} → ${yName}）` : `（${typeLabel}，${yName} → ${xName}）`;
  return `将建立：${xName} 是 ${yName} 的${w.word} ${arrow}`;
}

/**
 * 站在某条目视角把一条关系写成一句话。
 * 用于详情页的关系列表：作者读到的是「林远的师父是老掌门」，而不是箭头。
 */
export function relationSentence(
  viewerId: string,
  rel: { from: string; to: string; type: string },
  nameOf: (id: string) => string,
  labelOf: (type: string) => string,
  rolesOf: (type: string) => { from_role: string; to_role: string; symmetric: boolean },
): string {
  const typeLabel = labelOf(rel.type);
  const roles = rolesOf(rel.type);
  const fromName = nameOf(rel.from);
  const toName = nameOf(rel.to);

  if (roles.symmetric) return `${fromName} 与 ${toName} 是${roles.from_role || typeLabel}`;
  if (viewerId === rel.from) {
    // 我是起点：我的「徒弟」是对方
    return `我的${roles.to_role || typeLabel}是 ${toName}`;
  }
  // 我是终点：我的「师父」是对方
  return `我的${roles.from_role || typeLabel}是 ${fromName}`;
}
