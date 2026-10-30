/**
 * 删除策略（纯函数）。
 *
 * 这里回答三个问题，全部与 DOM 无关，可脱离浏览器测试（U6）：
 *   1. 这次删除需不需要确认框
 *   2. 传进来的 id 里有嵌套的，该保留哪些
 *   3. 删完之后该选中谁
 *
 * 为什么需要第 1 条：作者删一个空场景是清理动作，每删一个都弹框会让人麻木；
 * 而删一个有两万字、含十几个场景的卷是危险动作，必须停下来确认。
 * 分级的标准是「可能后悔的程度」，不是「是不是删除」。
 */

export interface DeleteTarget {
  id: string;
  kind: string;
  status: string;
  /** 自身字数（容器恒为 0） */
  words: number;
  /** 后代数量 */
  descendants: number;
  /** 后代字数之和 */
  descendantWords: number;
}

/**
 * 是否需要确认框。
 *
 * 为真当且仅当存在任一项满足：
 *   - 有内容：words + descendantWords > 0
 *   - 删容器会带走下级：kind 是容器且 descendants > 0
 *   - 已发布：status === 'published'
 */
export function needsConfirm(targets: DeleteTarget[]): boolean {
  return targets.some((t) => {
    if (t.words + t.descendantWords > 0) return true;
    if (isContainer(t.kind) && t.descendants > 0) return true;
    if (t.status === 'published') return true;
    return false;
  });
}

/** 容器 = 卷与章；场景是叶子 */
export function isContainer(kind: string): boolean {
  return kind !== 'scene';
}

/**
 * 去掉嵌套项，只保留最外层。
 *
 * 同时选了「第一卷」和它下面的「第一章」时，只删第一卷 ——
 * 否则会先删章、再删卷，第二次找不到目标，且回收站里留下两份重叠记录。
 * 保持传入顺序，便于上层按显示顺序操作。
 */
export function dedupeNested(
  ids: string[],
  parentOf: (id: string) => string | null,
): string[] {
  const set = new Set(ids);
  const isDescendantOfSelected = (id: string): boolean => {
    let cur = parentOf(id);
    let guard = 0;
    while (cur && guard++ < 1000) {
      if (set.has(cur)) return true;
      cur = parentOf(cur);
    }
    return false;
  };

  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue; // 重复 id 只算一次
    seen.add(id);
    if (!isDescendantOfSelected(id)) out.push(id);
  }
  return out;
}

/**
 * 删除之后应该选中谁。
 *
 * 优先选「当前项之后第一个没被删的」，没有就往前找最近的。
 * 全被删了返回 null（界面显示空状态）。
 * 这样连续删除时焦点会一路往下走，符合「删完接着往下写」的直觉。
 */
export function nextSelectionAfterDelete(
  order: string[],
  deleted: Set<string>,
  current: string | null,
): string | null {
  const idx = current ? order.indexOf(current) : -1;

  // 往后找。当前项不在列表里时 idx = -1，等价于「从头找」——
  // 这种边界出现在当前文档被折叠隐藏时，退回列表开头比跳到末尾更可预期。
  for (let i = idx + 1; i < order.length; i++) {
    const id = order[i];
    if (!deleted.has(id)) return id;
  }
  // 往前找
  for (let i = (idx === -1 ? order.length - 1 : idx - 1); i >= 0; i--) {
    const id = order[i];
    if (!deleted.has(id)) return id;
  }
  return null;
}

/** 把统计信息汇总成确认框里的一句话 */
export function describeDeleteSummary(targets: DeleteTarget[]): {
  count: number;
  descendants: number;
  words: number;
} {
  let descendants = 0;
  let words = 0;
  for (const t of targets) {
    descendants += t.descendants;
    words += t.words + t.descendantWords;
  }
  return { count: targets.length, descendants, words };
}
