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
import { confirmDanger, errText, toast } from '../panels/shared.ts';
import { historyFor } from './history.ts';
import { filterByChapter, layoutGraph, type GraphEdge, type GraphLayout } from './layout.ts';

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

  // 拖拽连线（图内编辑）
  private linkSourceId: string | null = null;
  private linkLine: SVGLineElement | null = null;
  private linkMoved = false;
  private linkStart = { x: 0, y: 0 };
  /** 拖拽超过这个像素才算「连线」，否则视为点击（打开条目） */
  private readonly LINK_THRESHOLD = 6;
  /** 待选类型的浮层 */
  private linkPicker: HTMLElement | null = null;

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

      // 透明命中区：可见线只有 1.2px，鼠标几乎点不中。
      // 在它下面垫一条 14px 宽的透明线专门接点击。
      const hitArea = svgEl('line', {
        class: 'gv-edge-hit',
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
      });
      hitArea.appendChild(svgEl('title')).textContent =
        `${edge.type}${edge.note ? `：${edge.note}` : ''}（点击可删除）`;
      hitArea.addEventListener('click', (ev) => {
        ev.stopPropagation();
        void this.deleteEdgeFromCanvas(edge);
      });
      hitArea.addEventListener('mouseenter', () => {
        line.classList.add('hover');
      });
      hitArea.addEventListener('mouseleave', () => {
        line.classList.remove('hover');
      });
      this.layerEdges.appendChild(hitArea);

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

      // 拖拽起点：从节点拖到另一个节点 = 建立关系
      g.addEventListener('pointerdown', (ev: PointerEvent) => {
        if (ev.button !== 0) return;
        ev.stopPropagation(); // 不要触发画布平移
        this.beginLink(node.id, ev);
      });

      g.addEventListener('click', (ev) => {
        ev.stopPropagation();
        // 拖拽结束时浏览器仍会补一个 click，这里必须忽略，
        // 否则「拖出连线」会顺带把当前条目详情弹出来。
        if (this.linkMoved) return;
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

  // ─────────────────────── 图内编辑 ───────────────────────

  /**
   * 屏幕坐标 → SVG 用户坐标。
   * 要考虑当前的平移与缩放，否则拖出的线会跟鼠标错位。
   */
  private clientToSvg(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.svg.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.tx) / this.scale,
      y: (clientY - rect.top - this.ty) / this.scale,
    };
  }

  /** 从某个节点开始拖出连线 */
  private beginLink(sourceId: string, ev: PointerEvent): void {
    const src = this.layout?.nodes.find((n) => n.id === sourceId);
    if (!src) return;

    this.linkSourceId = sourceId;
    this.linkMoved = false;
    const pos = this.clientToSvg(ev.clientX, ev.clientY);
    this.linkStart = pos;

    const line = svgEl('line', {
      class: 'gv-link-line',
      x1: src.x,
      y1: src.y,
      x2: pos.x,
      y2: pos.y,
    });
    this.linkLine = line;
    this.layerEdges.appendChild(line);
  }

  /** 拖动中：更新临时线，并记录是否已超过阈值 */
  private updateLink(ev: PointerEvent): void {
    if (!this.linkLine) return;
    const pos = this.clientToSvg(ev.clientX, ev.clientY);
    this.linkLine.setAttribute('x2', String(pos.x));
    this.linkLine.setAttribute('y2', String(pos.y));

    const dx = (pos.x - this.linkStart.x) * this.scale;
    const dy = (pos.y - this.linkStart.y) * this.scale;
    if (Math.hypot(dx, dy) > this.LINK_THRESHOLD) this.linkMoved = true;
  }

  /** 松开：若落在另一个节点上则弹出类型选择 */
  private endLink(ev: PointerEvent): void {
    const sourceId = this.linkSourceId;
    const moved = this.linkMoved;

    this.linkLine?.remove();
    this.linkLine = null;
    this.linkSourceId = null;
    // 浏览器在 pointerup 之后还会补一个 click。延迟清标记，
    // 让那个 click 能看到「这次是拖拽」，从而不打开条目详情。
    setTimeout(() => {
      this.linkMoved = false;
    }, 60);

    if (!sourceId || !moved) return;

    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const nodeEl = el?.closest('.gv-node') as SVGGElement | null;
    const targetId = nodeEl?.dataset.id;
    if (!targetId || targetId === sourceId) return;

    this.openLinkPicker(sourceId, targetId, ev.clientX, ev.clientY);
  }

  /** 弹出「选关系类型」浮层 */
  private openLinkPicker(fromId: string, toId: string, clientX: number, clientY: number): void {
    this.closeLinkPicker();

    const from = this.entities.find((e) => e.id === fromId);
    const to = this.entities.find((e) => e.id === toId);
    if (!from || !to) return;

    // 只列出端点类型允许的关系
    const allowed = this.types.filter(
      (t) => t.allowed === null || t.allowed.some(([a, b]) => a === from.type && b === to.type),
    );

    const rect = this.canvas.getBoundingClientRect();
    const x = Math.max(8, Math.min(clientX - rect.left, rect.width - 220));
    const y = Math.max(8, Math.min(clientY - rect.top, rect.height - 40 - allowed.length * 30));

    const picker = h(
      'div',
      { class: 'gv-picker', style: { left: `${x}px`, top: `${y}px` } },
      h('div', { class: 'gv-picker-title truncate' }, `${from.name} → ${to.name}`),
    );

    if (allowed.length === 0) {
      picker.appendChild(
        h(
          'div',
          { class: 'gv-picker-empty' },
          `「${ENTITY_TYPE_LABELS[from.type] ?? from.type}」与「${ENTITY_TYPE_LABELS[to.type] ?? to.type}」之间没有可用的关系类型`,
        ),
      );
    } else {
      for (const t of allowed) {
        picker.appendChild(
          h(
            'button',
            {
              class: 'gv-picker-btn',
              type: 'button',
              title: t.directed ? '有向关系' : '无向关系',
              onclick: () => void this.createLink(fromId, toId, t.key, t.label),
            },
            t.label,
          ),
        );
      }
    }

    picker.appendChild(
      h(
        'button',
        {
          class: 'gv-picker-cancel',
          type: 'button',
          onclick: () => this.closeLinkPicker(),
        },
        '取消',
      ),
    );

    this.canvas.appendChild(picker);
    this.linkPicker = picker;
  }

  private closeLinkPicker(): void {
    this.linkPicker?.remove();
    this.linkPicker = null;
  }

  /** 在图上创建一条关系 */
  private async createLink(
    fromId: string,
    toId: string,
    typeKey: string,
    typeLabel: string,
  ): Promise<void> {
    this.closeLinkPicker();
    const fromName = this.entities.find((e) => e.id === fromId)?.name ?? fromId;
    const toName = this.entities.find((e) => e.id === toId)?.name ?? toId;

    try {
      const created = await this.ctx.api.createRelation(fromId, { type: typeKey, to: toId });
      const history = historyFor(this.ctx.store.state.projectId ?? '');
      history.push({
        label: `新增「${typeLabel}」关系`,
        undo: async () => {
          await this.ctx.api.deleteRelation(created.id);
          await this.load();
        },
        redo: async () => {
          await this.ctx.api.createRelation(fromId, {
            id: created.id,
            type: created.type,
            to: created.to,
            since: created.since,
            until: created.until,
            reveal: created.reveal,
            weight: created.weight,
            note: created.note,
          });
          await this.load();
        },
      });
      toast(this.ctx, `已建立「${fromName} ${typeLabel} ${toName}」`, 'ok');
      await this.load();
    } catch (err) {
      toast(this.ctx, `创建失败：${errText(err)}`, 'error');
    }
  }

  /** 点击边 → 删除这条关系 */
  private async deleteEdgeFromCanvas(edge: GraphEdge): Promise<void> {
    const def = this.types.find((t) => t.key === edge.type);
    const label = def?.label ?? edge.type;
    const fromName = this.entities.find((e) => e.id === edge.from)?.name ?? edge.from;
    const toName = this.entities.find((e) => e.id === edge.to)?.name ?? edge.to;

    const ok = await confirmDanger(this.ctx, {
      title: '删除关系',
      message: `删除「${fromName} ${label} ${toName}」这条关系？${edge.note ? `\n\n备注：${edge.note}` : ''}`,
      confirmText: '删除',
    });
    if (!ok) return;

    try {
      await this.ctx.api.deleteRelation(edge.id);
      toast(this.ctx, '关系已删除', 'ok');
      await this.load();
    } catch (err) {
      toast(this.ctx, `删除失败：${errText(err)}`, 'error');
    }
  }

  private bindInteractions(): void {
    // 拖动平移
    this.svg.addEventListener('pointerdown', (ev) => {
      // 点空白先关掉类型浮层
      if (this.linkPicker) {
        this.closeLinkPicker();
      }
      if ((ev.target as Element).closest('.gv-node')) return;

      // 边的命中区不能触发画布拖拽：一旦 setPointerCapture，
      // 后续的 click 会被重定向到 SVG，边就收不到点击了（实测点了没反应）。
      if ((ev.target as Element).closest('.gv-edge-hit')) return;
      this.dragging = true;
      this.dragStart = { x: ev.clientX, y: ev.clientY, tx: this.tx, ty: this.ty };
      this.svg.setPointerCapture(ev.pointerId);
      this.svg.classList.add('dragging');
    });
    this.svg.addEventListener('pointermove', (ev) => {
      // 拖拽连线优先于画布平移
      if (this.linkLine) {
        this.updateLink(ev);
        return;
      }
      if (!this.dragging) return;
      this.tx = this.dragStart.tx + (ev.clientX - this.dragStart.x);
      this.ty = this.dragStart.ty + (ev.clientY - this.dragStart.y);
      this.applyTransform();
    });
    const endDrag = (ev: PointerEvent): void => {
      // 结束连线（若有）
      if (this.linkLine || this.linkSourceId) {
        this.endLink(ev);
        return;
      }
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
    this.closeLinkPicker();
    this._removeKey?.();
    this._removeResize?.();
    this.root.remove();
  }
}
