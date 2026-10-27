/**
 * 图谱布局算法（G2）。
 *
 * 纯函数，无 DOM、无 IO —— 这样布局可以在单元测试里直接验证坐标合理性，
 * 而不必起浏览器。
 *
 * 采用力导向（Fruchterman-Reingold 变体）：
 *   1. 初始化：节点按圆形均匀摆放（避免全部叠在原点导致斥力爆炸）
 *   2. 迭代：斥力把所有节点推开，引力把有关系的节点拉近，温度逐步降低
 *   3. 归一化：把结果缩放到给定画布大小
 *
 * 为什么不用固定布局（如网格）：关系图的价值在于「谁和谁连在一起」，
 * 力导向能自然形成簇，一眼看出小团体。
 *
 * 确定性：用固定种子的伪随机，同样的输入永远得到同样的布局。
 * 作者每次打开图谱看到的位置一致，不会因为重排而迷失。
 */

import type { Entity, Relation } from '../../../../shared/types.ts';

export interface GraphNode {
  id: string;
  name: string;
  type: string;
  /** 连接度（出 + 入），用于决定节点大小 */
  degree: number;
  x: number;
  y: number;
  /** 半径 */
  r: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: string;
  /** 是否无向（无向边只画一次） */
  directed: boolean;
  /** 悬空边的另一端已不存在 */
  dangling: boolean;
  note: string;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 布局用的画布尺寸 */
  width: number;
  height: number;
}

export interface LayoutOptions {
  width: number;
  height: number;
  /** 迭代次数，越多越稳定但越慢。默认 260 够 500 节点 */
  iterations?: number;
  /** 节点基础半径 */
  baseRadius?: number;
  /** 内边距 */
  padding?: number;
}

/** 固定种子的伪随机（mulberry32），保证布局可复现 */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimNode {
  id: string;
  x: number;
  y: number;
}

/**
 * 计算布局。
 *
 * @param entities 全部条目
 * @param relations 全部关系（from/to 都是条目 id）
 * @param typeDirected 类型 key → 是否有向
 */
export function layoutGraph(
  entities: Entity[],
  relations: Relation[],
  typeDirected: Record<string, boolean>,
  options: LayoutOptions,
): GraphLayout {
  const { width, height } = options;
  const iterations = options.iterations ?? 260;
  const baseRadius = options.baseRadius ?? 7;
  const padding = options.padding ?? 40;

  // ── 1. 建节点与边 ──
  const entityIds = new Set(entities.map((e) => e.id));
  const degree = new Map<string, number>();
  const edges: GraphEdge[] = [];

  for (const rel of relations) {
    degree.set(rel.from, (degree.get(rel.from) ?? 0) + 1);
    degree.set(rel.to, (degree.get(rel.to) ?? 0) + 1);

    edges.push({
      id: rel.id,
      from: rel.from,
      to: rel.to,
      type: rel.type,
      directed: typeDirected[rel.type] ?? true,
      dangling: !entityIds.has(rel.to) || !entityIds.has(rel.from),
      note: rel.note,
    });
  }

  if (entities.length === 0) {
    return { nodes: [], edges, width, height };
  }

  // 单节点：放正中间
  if (entities.length === 1) {
    const e = entities[0];
    return {
      nodes: [{ id: e.id, name: e.name, type: e.type, degree: 0, x: width / 2, y: height / 2, r: baseRadius + 2 }],
      edges,
      width,
      height,
    };
  }

  // ── 2. 初始化：圆形均匀分布（确定性） ──
  const rand = seededRandom(0x5eed);
  const sim: SimNode[] = entities.map((e, i) => {
    const angle = (i / entities.length) * Math.PI * 2 + rand() * 0.4;
    const radius = Math.min(width, height) * 0.34;
    return {
      id: e.id,
      x: width / 2 + Math.cos(angle) * radius,
      y: height / 2 + Math.sin(angle) * radius,
    };
  });

  const index = new Map(sim.map((n, i) => [n.id, i]));
  const idxEdges: Array<[number, number]> = [];
  for (const rel of relations) {
    const a = index.get(rel.from);
    const b = index.get(rel.to);
    if (a === undefined || b === undefined || a === b) continue;
    idxEdges.push([a, b]);
  }

  // ── 3. 力导向迭代 ──
  const area = width * height;
  // 理想边长：节点越多越短，避免图被撑爆
  const k = Math.sqrt(area / Math.max(4, sim.length)) * 0.42;
  const gravity = 0.012; // 向心力，防止孤立节点飘到画布外
  const cx = width / 2;
  const cy = height / 2;

  let temperature = Math.min(width, height) * 0.11;
  const cooling = Math.pow(0.004, 1 / iterations); // 温度衰减到初始的 0.4%

  for (let iter = 0; iter < iterations; iter++) {
    const dispX = new Float64Array(sim.length);
    const dispY = new Float64Array(sim.length);

    // 斥力：所有节点两两相斥（O(n²)，500 节点约 12 万次/轮，可接受）
    for (let i = 0; i < sim.length; i++) {
      for (let j = i + 1; j < sim.length; j++) {
        let dx = sim[i].x - sim[j].x;
        let dy = sim[i].y - sim[j].y;
        let dist2 = dx * dx + dy * dy;
        if (dist2 < 0.01) {
          // 完全重合：用确定性的极小偏移推开
          dx = (rand() - 0.5) * 0.6;
          dy = (rand() - 0.5) * 0.6;
          dist2 = dx * dx + dy * dy;
        }
        const dist = Math.sqrt(dist2);
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        dispX[i] += fx;
        dispY[i] += fy;
        dispX[j] -= fx;
        dispY[j] -= fy;
      }
    }

    // 引力：有关系的节点互相吸引
    for (const [a, b] of idxEdges) {
      const dx = sim[a].x - sim[b].x;
      const dy = sim[a].y - sim[b].y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = (dist * dist) / k;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      dispX[a] -= fx;
      dispY[a] -= fy;
      dispX[b] += fx;
      dispY[b] += fy;
    }

    // 向心力 + 位移（受温度限制）
    for (let i = 0; i < sim.length; i++) {
      dispX[i] += (cx - sim[i].x) * gravity * k;
      dispY[i] += (cy - sim[i].y) * gravity * k;

      const d = Math.sqrt(dispX[i] * dispX[i] + dispY[i] * dispY[i]) || 0.01;
      const limited = Math.min(d, temperature);
      sim[i].x += (dispX[i] / d) * limited;
      sim[i].y += (dispY[i] / d) * limited;
    }

    temperature *= cooling;
  }

  // ── 4. 归一化到画布（含内边距） ──
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of sim) {
    minX = Math.min(minX, n.x);
    maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y);
    maxY = Math.max(maxY, n.y);
  }
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const usableW = Math.max(1, width - padding * 2);
  const usableH = Math.max(1, height - padding * 2);
  // 保持纵横比，避免圆形被拉成椭圆
  const scale = Math.min(usableW / spanX, usableH / spanY);

  const offsetX = padding + (usableW - spanX * scale) / 2;
  const offsetY = padding + (usableH - spanY * scale) / 2;

  const nodes: GraphNode[] = entities.map((e) => {
    const s = sim[index.get(e.id)!];
    const deg = degree.get(e.id) ?? 0;
    return {
      id: e.id,
      name: e.name,
      type: e.type,
      degree: deg,
      x: offsetX + (s.x - minX) * scale,
      y: offsetY + (s.y - minY) * scale,
      // 连接度高的节点更大，但增长很慢，避免喧宾夺主
      r: baseRadius + Math.min(6, Math.sqrt(deg) * 1.6),
    };
  });

  return { nodes, edges, width, height };
}

/**
 * 按章节序号过滤关系。
 *
 * 语义：一条关系在「截至第 N 章」时是否成立？
 *   - since 的章序号 <= N（已发生）
 *   - until 不存在，或 until 的章序号 >= N（还没结束）
 * 锚点无法换算的（指向已删文档）按「不限制」处理，不让关系凭空消失。
 */
export function filterByChapter(
  relations: Relation[],
  upTo: number,
  ordinalOf: (docId: string) => number | null,
): Relation[] {
  return relations.filter((rel) => {
    if (rel.since) {
      const s = ordinalOf(rel.since);
      if (s !== null && s > upTo) return false;
    }
    if (rel.until) {
      const u = ordinalOf(rel.until);
      if (u !== null && u < upTo) return false;
    }
    return true;
  });
}
