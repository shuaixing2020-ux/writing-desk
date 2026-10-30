/**
 * 节点选择与排序（纯函数，无 IO）。
 *
 * 批量删除前要解决两件事：
 *   1. 去掉嵌套项 —— 同时传了「第一卷」和它下面的「第一章」时，只处理第一卷，
 *      否则会先删章再把卷移走，第二步找不到目标。
 *   2. 稳定顺序 —— 同一父目录下按序号从大到小删，避免删前面的项时
 *      影响后面项的位置（虽然当前删除不会重排序号，但显式排序让行为可复现）。
 *
 * 放在 util 里而不是路由里，是为了能脱离 HTTP 单测（U6）。
 */

import type { DocNode } from '../../shared/types.ts';

export interface OutermostPick {
  /** 需要处理的顶层 id，保持传入顺序中第一次出现的次序 */
  keep: string[];
  /** 因为祖先已在列表里而被丢弃的后代 id */
  dropped: string[];
}

/**
 * 从一组 id 里挑出「最外层」的那些。
 *
 * 判定：如果某个 id 的任一祖先也在集合里，它就是后代，应丢弃。
 * 不存在的 id 原样保留在 keep 里 —— 是否 404 由调用方判断，
 * 这里不吞掉它们，否则调用方无法报告"你删的东西不存在"。
 */
export function pickOutermostIds(nodes: DocNode[], ids: string[]): OutermostPick {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const input = new Set(ids);

  const hasSelectedAncestor = (id: string): boolean => {
    let cur = byId.get(id);
    let guard = 0;
    // 沿 parent 链向上找；守卫防御损坏数据造成的环
    while (cur && cur.parent_id && guard++ < 1000) {
      if (input.has(cur.parent_id)) return true;
      cur = byId.get(cur.parent_id);
    }
    return false;
  };

  const keep: string[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();

  for (const id of ids) {
    if (seen.has(id)) continue; // 传入重复 id：只处理一次
    seen.add(id);
    if (hasSelectedAncestor(id)) dropped.push(id);
    else keep.push(id);
  }

  return { keep, dropped };
}

/**
 * 删除顺序：同一父目录下序号大的先删，其余保持稳定。
 *
 * 用 parent_id 分组后按 order 降序；不同父目录之间按父 id 排序，
 * 保证同样的输入永远得到同样的顺序（可复现，便于测试与排查）。
 */
export function orderForDeletion(nodes: DocNode[], ids: string[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));

  return [...ids].sort((a, b) => {
    const na = byId.get(a);
    const nb = byId.get(b);
    // 未知 id 排最后（它们不该走到删除阶段，但不要因此打乱已知项的顺序）
    if (!na && !nb) return a.localeCompare(b);
    if (!na) return 1;
    if (!nb) return -1;

    const pa = na.parent_id ?? '';
    const pb = nb.parent_id ?? '';
    if (pa !== pb) return pa.localeCompare(pb);
    if (na.order !== nb.order) return nb.order - na.order; // 大序号先删
    return na.id.localeCompare(nb.id);
  });
}

/**
 * 收集一组根节点及其全部后代。
 *
 * 用于「删除前给所有涉及的场景拍快照」：卷/章本身没有正文，
 * 真正需要保护的是它们下面的场景。
 */
export function collectSubtree(nodes: DocNode[], rootIds: string[]): DocNode[] {
  const out: DocNode[] = [];
  const seen = new Set<string>();

  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    out.push(node);
    for (const child of nodes.filter((n) => n.parent_id === id)) walk(child.id);
  };

  for (const id of rootIds) walk(id);
  return out;
}
