/**
 * 关系图谱视图（G2，只读）。
 *
 * 为什么放在全屏浮层而不是 inspector：300px 画不下有意义的图。
 * 复用外壳已有的 fullview 机制（设置页也用它），不新造容器。
 *
 * 交互范围（G2 刻意只读）：
 *   - 拖动平移、滚轮缩放
 *   - 点击节点 → 跳到该条目详情
 *   - 悬停节点 → 高亮它的直接邻居
 *   - 章节滑块 → 只看"截至第 N 章"成立的关系
 *   - 类型过滤 → 只看某些关系类型
 * 图内编辑（拖拽连线、右键菜单、撤销）属 G3，这里不做。
 */

import type { PanelContext } from '../../lib/contracts.ts';
import type { Entity, Relation, RelationTypeDef } from '../../../../shared/types.ts';
import { ENTITY_TYPE_LABELS } from '../../../../shared/types.ts';
import { h } from '../../lib/dom.ts';
import { errText, toast } from '../panels/shared.ts';
import { filterByChapter, layoutGraph, type GraphLayout } from './layout.ts';

/** SVG 命名空间 */
const NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** 条目类型 → 颜色（用设计令牌，深色主题下自动适配） */
const TYPE_VARS: Record<string, string> = {
  character: '--info',
  place: '--ok',
  faction: '--warn',
  item: '--accent',
  term: '--ink-3',
  event: '--danger',
};

export interface GraphViewOptions {
  ctx: PanelContext;
  /** 关闭视图 */
  onClose: () => void;
}

export class GraphView {
  private ctx: PanelContext;
  private onClose: () => void;
  private root: HTMLElement;
  private canvas: HTMLElement;
  private svg: SVGSVGElement;
  private layerEdges: SVGGElement;
  private layerNodes: SVGGElement;
  private statusEl: HTMLElement;

  private entities: Entity[] = [];
  private relations: Relation[] = [];
  private types: RelationTypeDef[] = [];
  private ordinals = new Map<string, number>();
  private maxChapter = 0;

  private layout: GraphLayout | null = null;
  private selectedTypes = new Set<string>();
  private chapterLimit: number | null = null;

  // 视图变换
  private scale = 1;
  private tx = 0;
  private ty = 0;

  private dragging = false;
  private dragStart = { x: 0, y: 0, tx: 0, ty: 0 };
  private hoveredId: string | null = null;
  private destroyed = false;

  constructor(opts: GraphViewOptions) {
    this.ctx = opts.ctx;
    this.onClose = opts.onClose;

    this.layerEdges = svgEl('g', { class: 'gv-edges' });
    this.layerNodes = svgEl('g', { class: 'gv-nodes' });
    this.svg = svgEl('svg', { class: 'gv-svg' });
    this.svg.append(this.layerEdges, this.layerNodes);

    this.canvas = h('div', { class: 'gv-canvas' }, this.svg);
    this.statusEl = h('div', { class: 'gv-status' }, '载入中…');

    this.root = h(
      'div',
      { class: 'gv-root' },
      this.buildToolbar(),
      this.canvas,
      this.statusEl,
      h(
        'div',
        { class: 'gv-legend' },
        ...Object.entries(TYPE_VARS).map(([type, cssVar]) =>
          h(
            'span',
            { class: 'gv-legend-item' },
            h('i', { class: 'gv-dot', style: { background: `var(${cssVar})` } }),
            ENTITY_TYPE_LABELS[type] ?? type,
          ),
        ),
      ),
    );

    this.bindInteractions();
  }

  get el(): HTMLElement {
    return this.root;
  }

  // ─────────────────────── 工具栏 ───────────────────────

  private buildToolbar(): HTMLElement {
    const typeFilter = h('div', { class: 'gv-types' });

    const slider = h('input', {
      class: 'gv-slider',
      type: 'range',
      min: 0,
      max: 0,
      value: 0,
      'aria-label': '截至章节',
    }) as HTMLInputElement;
    const sliderLabel = h('span', { class: 'gv-slider-label' }, '全部章节');

    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      this.chapterLimit = v === 0 ? null : v;
      sliderLabel.textContent = v === 0 ? '全部章节' : `截至第 ${v} 章`;
      this.render();
    });

    const resetBtn = h(
      'button',
      {
        class: 'btn sm',
        type: 'button',
        onclick: () => {
          this.scale = 1;
          this.tx = 0;
          this.ty = 0;
          this.applyTransform();
        },
      },
      '重置视图',
    );

    const fitBtn = h(
      'button',
      {
        class: 'btn sm',
        type: 'button',
        onclick: () => {
          this.fitToView();
        },
      },
      '适应窗口',
    );

    const lintBtn = h(
      'button',
      {
        class: 'btn sm',
        type: 'button',
        onclick: () => void this.showLint(),
      },
      '检查问题',
    );

    const bar = h(
      'div',
      { class: 'gv-toolbar' },
      h('div', { class: 'gv-toolbar-group' }, h('span', { class: 'gv-label' }, '章节'), slider, sliderLabel),
      h('div', { class: 'gv-toolbar-group gv-types-wrap' }, h('span', { class: 'gv-label' }, '类型'), typeFilter),
      h('div', { class: 'gv-toolbar-group' }, resetBtn, fitBtn, lintBtn),
    );

    // 类型 chips 在数据加载后填充，这里先占位
    (bar as HTMLElement & { _typeFilter?: HTMLElement; _slider?: HTMLInputElement })._typeFilter = typeFilter;
    (bar as HTMLElement & { _slider?: HTMLInputElement })._slider = slider;
    return bar;
  }

  // ─────────────────────── 数据加载 ───────────────────────

  async load(): Promise<void> {
    try {
      this.statusEl.textContent = '载入中…';

      // 注意顺序：关系要按条目 id 逐个查，所以必须**先拿到条目列表**。
      // 早先写成 Promise.all 并行，fetchAllRelations 读到的 this.entities 还是空数组，
      // 结果图里一条边都没有。
      const [entities, typesRes] = await Promise.all([
        this.ctx.api.listEntities(),
        this.ctx.api.listRelationTypes(),
      ]);

      this.entities = entities;
      this.types = typesRes.types;
      this.relations = await this.fetchAllRelations();

      // 章节序号表：从文档树算
      const nodes = this.ctx.store.state.nodes;
      const chapters = nodes.filter((n) => n.kind === 'chapter').sort((a, b) => a.order - b.order);
      const byId = new Map(nodes.map((n) => [n.id, n]));
      this.maxChapter = chapters.length;
      this.ordinals = new Map();
      for (const c of chapters) {
        this.ordinals.set(c.id, chapters.findIndex((x) => x.id === c.id) + 1);
      }
      // 场景归它所在的章
      for (const n of nodes) {
        if (n.kind !== 'scene' || !n.parent_id) continue;
        const parentOrdinal = this.ordinals.get(n.parent_id);
        if (parentOrdinal !== undefined) this.ordinals.set(n.id, parentOrdinal);
      }
      void byId;

      this.fillTypeChips();
      const slider = (this.root.querySelector('.gv-slider') as HTMLInputElement) ?? null;
      if (slider) {
        slider.max = String(this.maxChapter);
        slider.disabled = this.maxChapter === 0;
      }

      this.render();
    } catch (err) {
      this.statusEl.textContent = `载入失败：${errText(err)}`;
      toast(this.ctx, `图谱载入失败：${errText(err)}`, 'error');
    }
  }

  /**
   * 取全书关系。
   *
   * 没有「一次取全部关系」的接口，所以按条目并发查。
   * 500 个条目并发 500 个请求对本地服务是可接受的（都在毫秒级），
   * 但为稳妥起见限制并发为 12。
   */
  private async fetchAllRelations(): Promise<Relation[]> {
    const out: Relation[] = [];
    const ids = this.entities.map((e) => e.id);
    const BATCH = 12;

    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const views = await Promise.all(
        batch.map((id) => this.ctx.api.listRelations(id).catch(() => ({ out: [], in: [] }))),
      );
      for (const v of views) out.push(...v.out);
    }
    return out;
  }

  private fillTypeChips(): void {
    const bar = this.root.querySelector('.gv-toolbar') as HTMLElement | null;
    const typeFilter = bar?.querySelector('.gv-types') as HTMLElement | null;
    if (!typeFilter) return;

    // 只显示实际用到的类型
    const used = new Set(this.relations.map((r) => r.type));
    const chips = this.types.filter((t) => used.has(t.key));
    typeFilter.textContent = '';

    if (chips.length === 0) {
      typeFilter.appendChild(h('span', { class: 'gv-label' }, '暂无关系'));
      return;
    }

    for (const t of chips) {
      const on = this.selectedTypes.size === 0 || this.selectedTypes.has(t.key);
      typeFilter.appendChild(
        h(
          'button',
          {
            class: `gv-chip${on ? ' on' : ''}`,
            type: 'button',
            onclick: (ev: Event) => {
              const btn = ev.currentTarget as HTMLElement;
              if (this.selectedTypes.size === 0) {
                // 从"全选"点一下某个：变成"只选它"
                this.selectedTypes = new Set(chips.map((c) => c.key));
                this.selectedTypes.delete(t.key);
              } else if (this.selectedTypes.has(t.key)) {
                this.selectedTypes.delete(t.key);
                if (this.selectedTypes.size === 0) this.selectedTypes = new Set();
              } else {
                this.selectedTypes.add(t.key);
                if (this.selectedTypes.size === chips.length) this.selectedTypes = new Set();
              }
              btn.blur();
              this.fillTypeChips();
              this.render();
            },
          },
          t.label,
        ),
      );
    }
  }

  // ─────────────────────── 渲染 ───────────────────────

  private currentRelations(): Relation[] {
    let rels = this.relations;
    if (this.selectedTypes.size > 0) {
      rels = rels.filter((r) => this.selectedTypes.has(r.type));
    }
    if (this.chapterLimit !== null) {
      rels = filterByChapter(rels, this.chapterLimit, (id) => this.ordinals.get(id) ?? null);
    }
    return rels;
  }

  private render(): void {
    if (this.destroyed) return;

    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(320, Math.floor(rect.width));
    const height = Math.max(240, Math.floor(rect.height));

    const rels = this.currentRelations();
    const typeDirected: Record<string, boolean> = {};
    for (const t of this.types) typeDirected[t.key] = t.directed;

    // 只画出当前过滤后有连接的节点 + 全部节点（孤立节点也显示，便于发现"还没连关系的人"）
    const layout = layoutGraph(this.entities, rels, typeDirected, { width, height, iterations: 220 });
    this.layout = layout;

    this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    this.svg.setAttribute('width', String(width));
    this.svg.setAttribute('height', String(height));

    this.layerEdges.textContent = '';
    this.layerNodes.textContent = '';

    const pos = new Map(layout.nodes.map((n) => [n.id, n]));

    // ── 边 ──
    for (const edge of layout.edges) {
      const a = pos.get(edge.from);
      const b = pos.get(edge.to);
      if (!a || !b) continue;

      // 无向边只画一次（按 id 排序去重）
      if (!edge.directed && edge.from > edge.to) continue;

      const line = svgEl('line', {
        class: `gv-edge${edge.dangling ? ' dangling' : ''}`,
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        'data-from': edge.from,
        'data-to': edge.to,
      });
      line.appendChild(svgEl('title')).textContent = `${edge.type}${edge.note ? `：${edge.note}` : ''}`;
      this.layerEdges.appendChild(line);

      // 有向边加箭头
      if (edge.directed) {
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const tipX = b.x - Math.cos(angle) * (b.r + 1);
        const tipY = b.y - Math.sin(angle) * (b.r + 1);
        const size = 5;
        const leftX = tipX - Math.cos(angle - 0.42) * size;
        const leftY = tipY - Math.sin(angle - 0.42) * size;
        const rightX = tipX - Math.cos(angle + 0.42) * size;
        const rightY = tipY - Math.sin(angle + 0.42) * size;
        this.layerEdges.appendChild(
          svgEl('polygon', {
            class: `gv-arrow${edge.dangling ? ' dangling' : ''}`,
            points: `${tipX},${tipY} ${leftX},${leftY} ${rightX},${rightY}`,
          }),
        );
      }
    }

    // ── 节点 ──
    for (const node of layout.nodes) {
      const g = svgEl('g', {
        class: 'gv-node',
        transform: `translate(${node.x},${node.y})`,
        'data-id': node.id,
      });

      g.appendChild(
        svgEl('circle', {
          class: 'gv-node-circle',
          r: node.r,
          fill: `var(${TYPE_VARS[node.type] ?? '--ink-3'})`,
        }),
      );

      // 标签：连接度高的显示，其余的悬停显示
      if (node.degree > 0 || layout.nodes.length <= 60) {
        const text = svgEl('text', {
          class: 'gv-node-label',
          x: 0,
          y: node.r + 12,
          'text-anchor': 'middle',
        });
        text.textContent = node.name;
        g.appendChild(text);
      }

      g.appendChild(svgEl('title')).textContent = `${node.name}（${ENTITY_TYPE_LABELS[node.type] ?? node.type}）· ${node.degree} 条关系`;

      g.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.ctx.actions.jumpToEntity(node.id);
        this.onClose();
      });
      g.addEventListener('mouseenter', () => {
        this.hoveredId = node.id;
        this.highlightNeighbors();
      });
      g.addEventListener('mouseleave', () => {
        this.hoveredId = null;
        this.highlightNeighbors();
      });

      this.layerNodes.appendChild(g);
    }

    this.applyTransform();

    const danglingCount = layout.edges.filter((e) => e.dangling).length;
    const parts = [`${layout.nodes.length} 个条目`, `${layout.edges.length} 条关系`];
    if (this.chapterLimit !== null) parts.push(`截至第 ${this.chapterLimit} 章`);
    if (danglingCount > 0) parts.push(`${danglingCount} 条悬空`);
    this.statusEl.textContent = parts.join(' · ');
  }

  /** 悬停节点时高亮它的邻居，其余降低不透明度 */
  private highlightNeighbors(): void {
    const id = this.hoveredId;
    const nodes = this.layerNodes.querySelectorAll<SVGGElement>('.gv-node');
    const edges = this.layerEdges.querySelectorAll<SVGLineElement | SVGPolygonElement>('.gv-edge, .gv-arrow');

    if (!id) {
      nodes.forEach((n) => n.classList.remove('dim', 'focus'));
      edges.forEach((e) => e.classList.remove('dim', 'focus'));
      return;
    }

    const neighbors = new Set<string>([id]);
    this.layout?.edges.forEach((e) => {
      if (e.from === id) neighbors.add(e.to);
      if (e.to === id) neighbors.add(e.from);
    });

    nodes.forEach((n) => {
      const nid = n.dataset.id ?? '';
      n.classList.toggle('focus', nid === id);
      n.classList.toggle('dim', !neighbors.has(nid));
    });
    edges.forEach((e) => {
      const from = e.getAttribute('data-from');
      const to = e.getAttribute('data-to');
      const related = from === id || to === id;
      e.classList.toggle('focus', related);
      e.classList.toggle('dim', !related);
    });
  }

  private applyTransform(): void {
    for (const layer of [this.layerEdges, this.layerNodes]) {
      layer.setAttribute('transform', `translate(${this.tx},${this.ty}) scale(${this.scale})`);
    }
  }

  private fitToView(): void {
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.applyTransform();
  }

  // ─────────────────────── 交互 ───────────────────────

  private bindInteractions(): void {
    // 拖动平移
    this.svg.addEventListener('pointerdown', (ev) => {
      if ((ev.target as Element).closest('.gv-node')) return;
      this.dragging = true;
      this.dragStart = { x: ev.clientX, y: ev.clientY, tx: this.tx, ty: this.ty };
      this.svg.setPointerCapture(ev.pointerId);
      this.svg.classList.add('dragging');
    });
    this.svg.addEventListener('pointermove', (ev) => {
      if (!this.dragging) return;
      this.tx = this.dragStart.tx + (ev.clientX - this.dragStart.x);
      this.ty = this.dragStart.ty + (ev.clientY - this.dragStart.y);
      this.applyTransform();
    });
    const endDrag = (): void => {
      this.dragging = false;
      this.svg.classList.remove('dragging');
    };
    this.svg.addEventListener('pointerup', endDrag);
    this.svg.addEventListener('pointercancel', endDrag);

    // 滚轮缩放（以光标为中心）
    this.svg.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        const rect = this.svg.getBoundingClientRect();
        const mx = ev.clientX - rect.left;
        const my = ev.clientY - rect.top;
        const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
        const next = Math.min(4, Math.max(0.25, this.scale * factor));
        // 保持光标下的点不动
        this.tx = mx - ((mx - this.tx) / this.scale) * next;
        this.ty = my - ((my - this.ty) / this.scale) * next;
        this.scale = next;
        this.applyTransform();
      },
      { passive: false },
    );

    // Esc 关闭
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') this.onClose();
    };
    document.addEventListener('keydown', onKey);
    this._removeKey = () => document.removeEventListener('keydown', onKey);

    // 窗口尺寸变化后重排
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const onResize = (): void => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => this.render(), 220);
    };
    window.addEventListener('resize', onResize);
    this._removeResize = () => window.removeEventListener('resize', onResize);
  }

  private _removeKey?: () => void;
  private _removeResize?: () => void;

  private async showLint(): Promise<void> {
    try {
      const issues = await this.ctx.api.lintRelations();
      if (issues.length === 0) {
        toast(this.ctx, '关系数据检查通过，没有发现问题', 'ok');
        return;
      }
      toast(this.ctx, `发现 ${issues.length} 个关系问题，见设定库条目详情`, 'warn');
    } catch (err) {
      toast(this.ctx, `检查失败：${errText(err)}`, 'error');
    }
  }

  destroy(): void {
    this.destroyed = true;
    this._removeKey?.();
    this._removeResize?.();
    this.root.remove();
  }
}
