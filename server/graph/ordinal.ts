/**
 * 章节序号换算。
 *
 * 关系的 since / until / reveal 存的是**文档 id**（章或场景），
 * 显示与过滤时要换算成「第 N 章」。
 *
 * 为什么存 id 而不直接存序号：
 *   序号会随插入/删除/拖拽排序变化，存序号的关系会在作者调整结构后全部指错。
 *   存 id 则永远指向同一处内容，序号在显示时才现算。
 *
 * 序号口径：按文档树深度优先顺序，章节点从 1 开始计数；
 * 场景归属它所在的章。卷本身没有序号（它只是分组）。
 * 章下的场景 → 该章的序号；章本身 → 自身序号；卷 → null。
 */

import type { DocNode, DocTree } from '../../shared/types.ts';

/**
 * 取某个文档所属章节的序号（从 1 开始）。
 *
 * @returns 章序号；文档不存在、或是卷（不属于任何章）时返回 null
 */
export function chapterOrdinalOf(tree: DocTree, docId: string): number | null {
  const byId = new Map<string, DocNode>();
  for (const n of tree.nodes) byId.set(n.id, n);

  const node = byId.get(docId);
  if (!node) return null;

  // 从自己往上找最近的「章」节点
  let cur: DocNode | undefined = node;
  let guard = 0;
  while (cur && guard++ < 100) {
    if (cur.kind === 'chapter') {
      return chapterOrdinal(byId, cur);
    }
    if (cur.parent_id === null || cur.parent_id === undefined) break;
    cur = byId.get(cur.parent_id);
  }
  return null; // 卷，或孤儿节点
}

/** 某章在全书中的序号：按深度优先顺序数到它为止；找不到返回 null */
function chapterOrdinal(byId: Map<string, DocNode>, chapter: DocNode): number | null {
  const ordered = flattenChapters(byId);
  const idx = ordered.findIndex((c) => c.id === chapter.id);
  return idx === -1 ? null : idx + 1;
}

/**
 * 按深度优先顺序展开全部章（卷 → 章，章内场景不参与计数）。
 * 排序依赖 order 字段；父节点缺失的章按孤立节点处理，放到最后，保证不丢。
 */
export function flattenChapters(byId: Map<string, DocNode>): DocNode[] {
  const childrenOf = (parentId: string | null): DocNode[] =>
    [...byId.values()]
      .filter((n) => (n.parent_id ?? null) === parentId)
      .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'zh'));

  const out: DocNode[] = [];
  const seen = new Set<string>();

  const walk = (node: DocNode): void => {
    if (seen.has(node.id)) return; // 防环
    seen.add(node.id);
    if (node.kind === 'chapter') out.push(node);
    for (const child of childrenOf(node.id)) walk(child);
  };

  for (const root of childrenOf(null)) walk(root);

  // 父节点不存在的章（数据损坏时的兜底）：仍然给出序号，不让它消失
  for (const n of [...byId.values()].sort((a, b) => a.order - b.order)) {
    if (n.kind === 'chapter' && !seen.has(n.id)) {
      out.push(n);
      seen.add(n.id);
    }
  }

  return out;
}

/** 章序号 → 章的显示标题（找不到返回 null） */
export function chapterTitleAt(tree: DocTree, ordinal: number): string | null {
  const byId = new Map<string, DocNode>();
  for (const n of tree.nodes) byId.set(n.id, n);
  const chapters = flattenChapters(byId);
  return chapters[ordinal - 1]?.title ?? null;
}

/** 把文档 id 换算成「第 N 章」这样的可读文本；无法换算返回 null */
export function describeAnchor(tree: DocTree, docId: string | undefined): string | null {
  if (!docId) return null;
  const n = chapterOrdinalOf(tree, docId);
  return n === null ? null : `第 ${n} 章`;
}
