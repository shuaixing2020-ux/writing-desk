/**
 * 关系图谱面板（R3）。
 *
 * 与 G2 的全屏图谱是两件东西：那个用来「看整本书的关系网」，
 * 这个停在检查器里，写作时随手看一眼本章出场人物之间的关系。
 *
 * 渲染用 Canvas 2D（红线 U1 不引库）。布局走 lib/graph-layout 的增量版本：
 * 每帧一步，alpha 降到 0 就停 —— 不让一个看不见的动画长期占 CPU。
 */

import type { PanelContext, PanelDef, PanelInstance } from '../../lib/contracts.ts';
import type { AppState } from '../../lib/store.ts';
import { h } from '../../lib/dom.ts';
import { ICONS, emptyBlock, errText, panelShell, toast } from './shared.ts';
import { initLayout, kineticEnergy, stepLayout, type LNode } from '../../lib/graph-layout.ts';

interface GNode {
  id: string;
  type: string;
  name: string;
}
interface GEdge {
  id: string;
  type: string;
  from: string;
  to: string;
  note: string;
  symmetric: boolean;
}

/** 节点配色：按条目类型分（与设计令牌一致，不写死十六进制以外的值） */
const TYPE_COLOR: Record<string, string> = {
  character: '#b4553a',
  faction: '#5a7d5a',
  place: '#4f6f8a',
  item: '#8a6f4f',
  term: '#6a6a8a',
  event: '#9a5f7a',
};
const TYPE_LABEL: Record<string, string> = {
  character: '角色',
  faction: '势力',
  place: '地点',
  item: '物品',
  term: '术语',
  event: '事件',
};

const RADIUS = 9;

export const panel: PanelDef = {
  id: 'graph',
  title: '关系图',
  icon: ICONS.graph,
  inInspector: true,

  mount(container: HTMLElement, ctx: PanelContext): PanelInstance {
    const shell = panelShell(container, { tools: [] });
    // 本面板是「画布占满剩余高度」，需要覆盖默认的滚动容器样式
    shell.body.classList.add('p-graph-body');

    const status = h('div', { class: 'p-graph-status' }, '读取关系…');
    const canvas = h('canvas', { class: 'p-graph-canvas' }) as HTMLCanvasElement;
    const hint = h('div', { class: 'p-graph-hint hidden' });

    const toolbar = h(
      'div',
      { class: 'p-graph-tools' },
      (() => {
        const b = h('button', { class: 'btn sm', type: 'button' }, '聚焦本章');
        b.addEventListener('click', () => void load({ doc: ctx.store.state.currentDocId ?? undefined }));
        return b;
      })(),
      (() => {
        const b = h('button', { class: 'btn sm', type: 'button' }, '全部');
        b.addEventListener('click', () => void load({}));
        return b;
      })(),
      (() => {
        // 面板窄，复杂关系看不清：一键打开全屏图谱（同一份数据、同一个入口）
        const b = h('button', {
          class: 'btn sm',
          type: 'button',
          title: '在整页里展开关系图谱',
        }, '展开');
        b.addEventListener('click', () => ctx.actions.openGraphView());
        return b;
      })(),
    );

    const searchInput = h('input', {
      class: 'p-graph-search',
      type: 'search',
      placeholder: '高亮条目…',
      spellcheck: 'false',
    }) as HTMLInputElement;

    shell.body.append(toolbar, searchInput, hint, status, canvas);

    let nodes: GNode[] = [];
    let edges: GEdge[] = [];
    let layout: LNode[] = [];
    /** 画布的 CSS 像素尺寸：布局与绘制都用它，DPR 只影响背面缓冲区 */
    let cssW = 0;
    let cssH = 0;
    let alpha = 0;
    let raf = 0;
    let destroyed = false;
    let selectedId: string | null = null;
    let highlight = '';

    const layoutById = new Map<string, LNode>();
    const nodeById = new Map<string, GNode>();

    // ── 动画：可见才跑，停稳即止 ──
    function startLoop(): void {
      if (raf) return;
      const tick = (): void => {
        raf = 0;
        if (destroyed) return;
        if (alpha > 0) {
          alpha = stepLayout(layout, edges.map((e) => [e.from, e.to] as [string, string]), cssW || 300, cssH || 200, alpha);
          draw();
          raf = requestAnimationFrame(tick);
          return;
        }
        // 停稳后再画一帧（外力推一下就收敛了）
        if (kineticEnergy(layout) > 0.01) {
          alpha = 0.3;
          raf = requestAnimationFrame(tick);
        }
      };
      raf = requestAnimationFrame(tick);
    }

    function stopLoop(): void {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }

    // 面板不可见时停掉动画：检查器收起来就不该继续烧 CPU
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        if (visible) startLoop();
        else stopLoop();
      },
      { threshold: 0 },
    );
    observer.observe(container);

    // ── 绘制 ──
    function resize(): void {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(80, Math.floor(rect.width));
      const hh = Math.max(80, Math.floor(rect.height));
      cssW = w;
      cssH = hh;
      if (canvas.width === w * dpr && canvas.height === hh * dpr) return;
      canvas.width = w * dpr;
      canvas.height = hh * dpr;
      const c = canvas.getContext('2d');
      if (c) c.setTransform(dpr, 0, 0, dpr, 0, 0);
      // 尺寸变了要重新布局，否则点会挤在角落
      rebuildLayout(w, hh);
    }

    function rebuildLayout(w: number, hh: number): void {
      layout = initLayout(nodes.map((n) => n.id), w, hh, 20251030);
      layoutById.clear();
      for (const n of layout) layoutById.set(n.id, n);
      alpha = 1;
      draw();
      startLoop();
    }

    function draw(): void {
      const c = canvas.getContext('2d');
      if (!c) return;
      const w = canvas.width / (Math.min(2, window.devicePixelRatio || 1));
      const hh = canvas.height / (Math.min(2, window.devicePixelRatio || 1));

      c.clearRect(0, 0, w, hh);

      // 边
      c.lineWidth = 1;
      for (const e of edges) {
        const a = layoutById.get(e.from);
        const b = layoutById.get(e.to);
        if (!a || !b) continue;
        const active = selectedId === e.from || selectedId === e.to;
        c.strokeStyle = active ? 'rgba(180,85,58,0.75)' : 'rgba(120,110,100,0.35)';
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
        c.stroke();

        // 有向边画箭头，对称边不画
        if (!e.symmetric) {
          const ang = Math.atan2(b.y - a.y, b.x - a.x);
          const tipX = b.x - Math.cos(ang) * RADIUS;
          const tipY = b.y - Math.sin(ang) * RADIUS;
          c.fillStyle = active ? 'rgba(180,85,58,0.85)' : 'rgba(120,110,100,0.5)';
          c.beginPath();
          c.moveTo(tipX, tipY);
          c.lineTo(tipX - Math.cos(ang - 0.4) * 7, tipY - Math.sin(ang - 0.4) * 7);
          c.lineTo(tipX - Math.cos(ang + 0.4) * 7, tipY - Math.sin(ang + 0.4) * 7);
          c.closePath();
          c.fill();
        }

        // 边中点标类型（太密就不标，避免糊成一片）
        if (edges.length <= 60) {
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          c.fillStyle = 'rgba(90,84,78,0.85)';
          c.font = '10px system-ui, sans-serif';
          c.textAlign = 'center';
          c.fillText(e.type, mx, my - 3);
        }
      }

      // 节点
      for (const n of nodes) {
        const p = layoutById.get(n.id);
        if (!p) continue;
        const isSel = selectedId === n.id;
        const isHit = highlight && n.name.toLowerCase().includes(highlight);

        c.beginPath();
        c.arc(p.x, p.y, RADIUS, 0, Math.PI * 2);
        c.fillStyle = TYPE_COLOR[n.type] ?? '#7a7268';
        c.fill();

        if (isSel || isHit) {
          c.lineWidth = 2;
          c.strokeStyle = isSel ? '#b4553a' : '#d9b96a';
          c.stroke();
        }

        c.fillStyle = 'rgba(60,56,52,0.92)';
        c.font = '11px system-ui, sans-serif';
        c.textAlign = 'center';
        c.fillText(n.name, p.x, p.y + RADIUS + 12);
      }
    }

    // ── 交互 ──
    canvas.addEventListener('click', (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      let hit: GNode | null = null;
      for (const n of nodes) {
        const p = layoutById.get(n.id);
        if (!p) continue;
        if (Math.hypot(p.x - x, p.y - y) <= RADIUS + 3) {
          hit = n;
          break;
        }
      }
      if (!hit) {
        selectedId = null;
        draw();
        return;
      }
      selectedId = hit.id;
      draw();
      // 点节点 = 在设定库打开它（复用现有动作，不另开一套导航）
      void ctx.actions.jumpToEntity(hit.id);
    });

    canvas.addEventListener('mousemove', (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const over = nodes.some((n) => {
        const p = layoutById.get(n.id);
        return p && Math.hypot(p.x - x, p.y - y) <= RADIUS + 3;
      });
      canvas.style.cursor = over ? 'pointer' : 'default';
    });

    searchInput.addEventListener('input', () => {
      highlight = searchInput.value.trim().toLowerCase();
      draw();
    });

    // ── 数据 ──
    async function load(opts: { focus?: string; doc?: string }): Promise<void> {
      status.textContent = '读取关系…';
      status.classList.remove('hidden');
      hint.classList.add('hidden');
      try {
        let res = await ctx.api.getGraph(opts);

        // 条目太多时先只显示聚焦邻域，并提示（R3 要求）
        if (!opts.focus && !opts.doc && res.nodes.length > 300) {
          const busiest = res.nodes
            .map((n) => ({
              id: n.id,
              degree: res.edges.filter((e) => e.from === n.id || e.to === n.id).length,
            }))
            .sort((a, b) => b.degree - a.degree)[0];
          if (busiest) {
            res = await ctx.api.getGraph({ focus: busiest.id, depth: 2 });
            hint.textContent = '条目较多，先显示关系最密的邻域。点「全部」看整张网。';
            hint.classList.remove('hidden');
          }
        }

        nodes = res.nodes;
        edges = res.edges;
        nodeById.clear();
        for (const n of nodes) nodeById.set(n.id, n);
        selectedId = null;

        status.textContent =
          nodes.length === 0
            ? ''
            : `${nodes.length} 个条目 · ${edges.length} 条关系`;
        if (nodes.length === 0) {
          status.classList.add('hidden');
          shell.body.appendChild(
            emptyBlock({
              icon: ICONS.graph,
              title: '还没有关系',
              hint: '在设定库的条目详情里用「一句话」建第一条关系，这里就会出现。',
            }),
          );
        }

        resize();
        // 注意用 CSS 像素：canvas.width 是 devicePixelRatio 放大后的值，
        // 拿它布局会把节点排到可视区之外，界面上只剩角落里一个点。
        const rect = canvas.getBoundingClientRect();
        cssW = Math.max(80, Math.floor(rect.width));
        cssH = Math.max(80, Math.floor(rect.height));
        rebuildLayout(cssW, cssH);
      } catch (err) {
        status.textContent = '';
        toast(ctx, `关系图读取失败：${errText(err)}`, 'error');
      }
    }

    void load({});

    return {
      update(state: AppState, changed: Set<keyof AppState>): void {
        // 关系变了（建/删/改）才重取；避免每次输入都跑一遍
        if (changed.has('entities') || changed.has('nodes')) {
          void load({});
        }
        void state;
      },
      destroy(): void {
        destroyed = true;
        stopLoop();
        observer.disconnect();
        container.textContent = '';
      },
    };
  },
};
