/**
 * 树结构操作（纯函数）。
 *
 * 大纲列表与思维导图共用同一棵「卷 → 章 → 场景」树，也就共用这一组操作。
 * 这里只把「按了什么键」翻译成「要对服务端做哪几件事」（Intent 列表），
 * 不碰网络、不碰 DOM —— 于是在 node:test 里就能把连续按键流跑一遍。
 *
 * 深度决定类型：第 0 层卷、第 1 层章、第 2 层场景；不允许超过三层。
 *
 * 为什么要返回「意图列表」而不是直接改树：
 *   真实节点在服务端（文件），本地改完再提交容易和磁盘不一致。
 *   返回意图后由 API 层逐个执行，失败时能按相反的意图回滚（U5）。
 */

export type Kind = 'volume' | 'chapter' | 'scene';

export interface TNode {
  id: string;
  title: string;
  children: TNode[];
}

export type Intent =
  | { op: 'create'; parentId: string | null; index: number; kind: Kind; title: string }
  | { op: 'move'; id: string; parentId: string | null; index: number }
  | { op: 'rename'; id: string; title: string };

/** 三层封顶：0 卷、1 章、2 场景（更深的都按场景算，避免出现第四层） */
export function kindAtDepth(depth: number): Kind {
  if (depth <= 0) return 'volume';
  if (depth === 1) return 'chapter';
  return 'scene';
}

interface Located {
  node: TNode;
  depth: number;
  parent: TNode | null;
  /** 在兄弟中的下标 */
  index: number;
}

/** 在树里定位一个节点 */
export function locate(tree: TNode[], id: string): Located | null {
  const walk = (nodes: TNode[], parent: TNode | null, depth: number): Located | null => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.id === id) return { node, depth, parent, index: i };
      const hit = walk(node.children, node, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(tree, null, 0);
}

/** 某节点的兄弟数组与其父 */
function siblingsOf(tree: TNode[], found: Located): TNode[] {
  return found.parent ? found.parent.children : tree;
}

/**
 * 新建同级：插在当前节点后面。
 * 同级意味着同深度，所以类型与当前节点一致。
 */
export function createSibling(tree: TNode[], id: string): Intent[] {
  const found = locate(tree, id);
  if (!found) return [];
  return [
    {
      op: 'create',
      parentId: found.parent ? found.parent.id : null,
      index: found.index + 1,
      kind: kindAtDepth(found.depth),
      title: '',
    },
  ];
}

/**
 * 新建下级：插到当前节点的子列表末尾。
 * 已经是场景层（深度 2）时不再往下长，退化为新建同级。
 */
export function createChild(tree: TNode[], id: string): Intent[] {
  const found = locate(tree, id);
  if (!found) return [];
  if (found.depth >= 2) return createSibling(tree, id);
  return [
    {
      op: 'create',
      parentId: found.node.id,
      index: found.node.children.length,
      kind: kindAtDepth(found.depth + 1),
      title: '',
    },
  ];
}

/**
 * 降一级：成为上一个兄弟的最后一个子节点。
 *
 * 返回 null 的三种情况（与原型验证过的规则一致）：
 *   - 没有上一个兄弟（首项无处可降）
 *   - 已经在场景层（再降就超过三层）
 *   - 自己有子节点（带着下级一起降会让层级错乱，先不支持）
 */
export function indent(tree: TNode[], id: string): Intent[] | null {
  const found = locate(tree, id);
  if (!found) return null;
  if (found.depth >= 2) return null;
  if (found.node.children.length > 0) return null;

  const siblings = siblingsOf(tree, found);
  const prev = siblings[found.index - 1];
  if (!prev) return null;

  return [
    {
      op: 'move',
      id: found.node.id,
      parentId: prev.id,
      index: prev.children.length,
    },
  ];
}

/**
 * 升一级：成为父节点的下一个兄弟。
 * 没有父节点（本来就是最外层）时返回 null。
 */
export function outdent(tree: TNode[], id: string): Intent[] | null {
  const found = locate(tree, id);
  if (!found || !found.parent) return null;

  const grand = locate(tree, found.parent.id);
  if (!grand) return null;

  return [
    {
      op: 'move',
      id: found.node.id,
      parentId: grand.parent ? grand.parent.id : null,
      index: grand.index + 1,
    },
  ];
}

/** 上移一位；已经是第一个时返回 null */
export function moveUp(tree: TNode[], id: string): Intent[] | null {
  const found = locate(tree, id);
  if (!found || found.index === 0) return null;
  return [
    {
      op: 'move',
      id: found.node.id,
      parentId: found.parent ? found.parent.id : null,
      index: found.index - 1,
    },
  ];
}

/** 下移一位；已经是最后一个时返回 null */
export function moveDown(tree: TNode[], id: string): Intent[] | null {
  const found = locate(tree, id);
  if (!found) return null;
  const siblings = siblingsOf(tree, found);
  if (found.index >= siblings.length - 1) return null;
  return [
    {
      op: 'move',
      id: found.node.id,
      parentId: found.parent ? found.parent.id : null,
      index: found.index + 1,
    },
  ];
}

/**
 * 把「显示顺序的扁平列表」与树对齐，供大纲逐行渲染。
 * 只返回每一行，不下钻语义，方便 UI 直接 map。
 */
export function flatten(tree: TNode[]): Array<{ node: TNode; depth: number; parent: TNode | null }> {
  const out: Array<{ node: TNode; depth: number; parent: TNode | null }> = [];
  const walk = (nodes: TNode[], parent: TNode | null, depth: number): void => {
    for (const node of nodes) {
      out.push({ node, depth, parent });
      walk(node.children, node, depth + 1);
    }
  };
  walk(tree, null, 0);
  return out;
}
