/**
 * 关系图谱布局（纯函数，R3）。
 *
 * Fruchterman-Reingold 的简化版：斥力把所有点推开，边把两端拉近，
 * 每步按 alpha 降温，最后收敛。放在纯函数里是为了能单测：
 * 「同一 seed 同一结果」「不会跑出边界」「能量趋于稳定」这三条都能断言。
 *
 * 为什么不用现成的图库：红线 U1 不引入新依赖，而且这里只需要几百个点。
 */

export interface LNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned?: boolean;
}

/** 确定性伪随机：同一 seed 得到同一初始布局，测试才能断言 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 理想边长：点越多，图要越大才不挤 */
function idealLength(count: number): number {
  return Math.max(24, Math.min(90, 900 / Math.max(4, Math.sqrt(Math.max(1, count)) * 2)));
}

/**
 * 初始布局：在一个圆盘里撒点（比纯随机更均匀，收敛更快）。
 * 单个节点放中心。
 */
export function initLayout(ids: string[], width: number, height: number, seed: number): LNode[] {
  const rand = mulberry32(seed);
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.max(20, Math.min(width, height) * 0.36);

  if (ids.length === 1) {
    return [{ id: ids[0], x: cx, y: cy, vx: 0, vy: 0 }];
  }

  return ids.map((id, i) => {
    // 均分角度 + 抖动，避免每次都排成完美圆形
    const angle = (i / ids.length) * Math.PI * 2 + rand() * 0.35;
    const r = radius * (0.45 + rand() * 0.55);
    return {
      id,
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
      vx: 0,
      vy: 0,
    };
  });
}

/** 一步积分。返回新的 alpha（调用方据此判断是否停）。 */
export function stepLayout(
  nodes: LNode[],
  edges: Array<[string, string]>,
  width: number,
  height: number,
  alpha: number,
): number {
  const n = nodes.length;
  if (n === 0) return 0;

  const k = idealLength(n);
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const fx = new Float64Array(n);
  const fy = new Float64Array(n);

  // 斥力：所有点对（n 小，平方复杂度可接受）
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let dx = nodes[i].x - nodes[j].x;
      let dy = nodes[i].y - nodes[j].y;
      let dist = Math.hypot(dx, dy);
      if (dist < 0.01) {
        // 完全重合时给一个确定性的小扰动，避免除零
        dx = (i - j) * 0.01 + 0.01;
        dy = (j - i) * 0.01 + 0.01;
        dist = Math.hypot(dx, dy);
      }
      const force = (k * k) / dist;
      const ux = dx / dist;
      const uy = dy / dist;
      fx[i] += ux * force;
      fy[i] += uy * force;
      fx[j] -= ux * force;
      fy[j] -= uy * force;
    }
  }

  // 引力：边把两端拉近
  for (const [a, b] of edges) {
    const i = index.get(a);
    const j = index.get(b);
    if (i === undefined || j === undefined || i === j) continue;
    const dx = nodes[i].x - nodes[j].x;
    const dy = nodes[i].y - nodes[j].y;
    const dist = Math.max(0.01, Math.hypot(dx, dy));
    const force = (dist * dist) / k;
    const ux = dx / dist;
    const uy = dy / dist;
    fx[i] -= ux * force;
    fy[i] -= uy * force;
    fx[j] += ux * force;
    fy[j] += uy * force;
  }

  // 位移限幅 + 边界收拢，保证不会飞出画布
  const maxStep = k * 2;
  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    if (node.pinned) continue;
    let dx = fx[i] * alpha;
    let dy = fy[i] * alpha;
    const len = Math.hypot(dx, dy);
    if (len > maxStep) {
      dx = (dx / len) * maxStep;
      dy = (dy / len) * maxStep;
    }
    node.vx = dx;
    node.vy = dy;
    node.x = Math.min(width - 8, Math.max(8, node.x + dx));
    node.y = Math.min(height - 8, Math.max(8, node.y + dy));
  }

  return Math.max(0, alpha * 0.96 - 0.001);
}

/** 总动能：用来判断是否已经稳定（测试与面板都可用） */
export function kineticEnergy(nodes: LNode[]): number {
  let sum = 0;
  for (const n of nodes) sum += n.vx * n.vx + n.vy * n.vy;
  return sum;
}
