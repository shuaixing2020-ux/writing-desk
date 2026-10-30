/**
 * 思维导图的导航与折叠策略（纯函数）。
 *
 * 导图里的方向键语义和列表不同：列表是「上一行/下一行」，
 * 导图是「往右进子节点、往左回父节点、上下在同级间走」。
 * 这套规则抽出来单独测，免得和 DOM 缠在一起。
 */

import type { DocNode } from '../../../shared/types.ts';

/** 导图节点超过这个数量就默认收起场景层，避免一屏几百个胶囊 */
export const MAP_COLLAPSE_THRESHOLD = 300;

/** 展示到「章」级：卷与章展开，场景收起 */
export function defaultCollapsedFor(nodes: DocNode[], threshold = MAP_COLLAPSE_THRESHOLD): Set<string> {
  const collapsed = new Set<string>();
  if (nodes.length <= threshold) return collapsed;
  // 折叠「章」，于是场景不显示；卷保持展开露出章
  for (const n of nodes) if (n.kind === 'chapter') collapsed.add(n.id);
  return collapsed;
}

export interface NavIndex {
  byId: Map<string, { id: string; parentId: string | null; children: string[] }>;
  rootIds: string[];
}

/** 由扁平节点列表建出父子索引（保持 order 顺序） */
export function buildNavIndex(nodes: DocNode[]): NavIndex {
  const byId = new Map<string, { id: string; parentId: string | null; children: string[] }>();
  const rootIds: string[] = [];
  const sorted = [...nodes].sort((a, b) => a.order - b.order);

  for (const n of sorted) byId.set(n.id, { id: n.id, parentId: n.parent_id, children: [] });
  for (const n of sorted) {
    const entry = byId.get(n.id)!;
    if (n.parent_id && byId.has(n.parent_id)) byId.get(n.parent_id)!.children.push(n.id);
    else rootIds.push(n.id);
  }
  return { byId, rootIds };
}

/** 往右：进入第一个子节点（折叠时没有可见子节点，返回 null 由调用方展开） */
export function navToChild(index: NavIndex, current: string, collapsed: Set<string>): string | null {
  const node = index.byId.get(current);
  if (!node || collapsed.has(current)) return null;
  return node.children[0] ?? null;
}

/** 往左：回到父节点 */
export function navToParent(index: NavIndex, current: string): string | null {
  return index.byId.get(current)?.parentId ?? null;
}

/** 上下：在同级之间移动（delta -1 上一个，+1 下一个） */
export function navToSibling(index: NavIndex, current: string, delta: -1 | 1): string | null {
  const node = index.byId.get(current);
  if (!node) return null;
  const siblings = node.parentId ? index.byId.get(node.parentId)?.children : index.rootIds;
  if (!siblings) return null;
  const at = siblings.indexOf(current);
  if (at === -1) return null;
  return siblings[at + delta] ?? null;
}

/** 缩放上下限 */
export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 2;
export const ZOOM_STEP = 0.1;

/** 把缩放钳制到合法区间；非有限数回退到 1 */
export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) * 100) / 100;
}

/**
 * 「适应」：按树的最大深度估算合适缩放。
 * 不是精确测量（那要读 DOM），只做一个保守的收缩：层数越多缩得越小。
 */
export function fitZoomFor(maxDepth: number): number {
  if (!Number.isFinite(maxDepth) || maxDepth < 0) return 1;
  if (maxDepth <= 2) return 1;
  return clampZoom(1 - (maxDepth - 2) * 0.15);
}

/** 树的最大深度（0 起） */
export function maxDepthOf(nodes: DocNode[]): number {
  const index = buildNavIndex(nodes);
  const walk = (id: string, depth: number): number => {
    const node = index.byId.get(id);
    if (!node || node.children.length === 0) return depth;
    let best = depth;
    for (const child of node.children) best = Math.max(best, walk(child, depth + 1));
    return best;
  };
  let max = 0;
  for (const id of index.rootIds) max = Math.max(max, walk(id, 0));
  return max;
}
