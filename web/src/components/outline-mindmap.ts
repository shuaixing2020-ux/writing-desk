/**
 * 思维导图视图（O3）。
 *
 * 和列表视图是同一棵树、同一组操作（tree-ops），只是画法不同：
 * 列表是纵向平铺，导图是从左到右的树。两者切换时选中项不变。
 *
 * 渲染方式：嵌套 DOM + CSS 画连线，不引入任何绘图库（U1）。
 * 选嵌套 DOM 而不是绝对定位 + SVG，是因为：
 *   - 节点高度随标题换行变化，绝对定位要自己量，嵌套 DOM 由浏览器排
 *   - 连线用伪元素就够，不需要维护坐标
 * 代价是缩放只能整体 transform，节点里的文字会被一起放大 —— 这正是想要的效果。
 */

import type { AppState } from '../lib/store.ts';
import type { PanelContext } from '../lib/contracts.ts';
import type { DocNode } from '../../../shared/types.ts';
import { childrenOf, nodeById } from '../lib/store.ts';
import { h, fmtNum } from '../lib/dom.ts';
import { ICONS, errText, toast } from './panels/shared.ts';
import {
  buildNavIndex,
  clampZoom,
  defaultCollapsedFor,
  fitZoomFor,
  maxDepthOf,
  navToChild,
  navToParent,
  navToSibling,
  ZOOM_STEP,
} from '../lib/mindmap-nav.ts';
import {
  createSibling,
  indent,
  moveDown as moveDownIntent,
  moveUp as moveUpIntent,
  outdent,
  type TNode,
} from '../lib/tree-ops.ts';

const KIND_LABEL: Record<DocNode['kind'], string> = {
  volume: '卷',
  chapter: '章',
  scene: '场',
};

export interface MindmapHandle {
  el: HTMLElement;
  update(state: AppState): void;
  destroy(): void;
}

function toTNodes(state: AppState, parentId: string | null = null): TNode[] {
  return childrenOf(state, parentId).map((n) => ({
    id: n.id,
    title: n.title,
    children: toTNodes(state, n.id),
  }));
}

function subtreeWords(state: AppState, node: DocNode): number {
  if (node.kind === 'scene') return node.word_count;
  let sum = 0;
  for (const k of childrenOf(state, node.id)) {
    sum += k.kind === 'scene' ? k.word_count : subtreeWords(state, k);
  }
  return sum;
}

export function createMindmap(ctx: PanelContext): MindmapHandle {
  /** 折叠的节点 */
  const collapsed = new Set<string>();
  let collapsedInit = false;
  let zoom = 1;
  let state: AppState | null = null;
  /** 键盘操作的目标节点；与「当前文档」不同：当前文档决定正文与右侧面板 */
  let focusedId: string | null = null;
  /** 就地改名的节点 */
  let renaming: { id: string; value: string } | null = null;
  /** 重绘后要滚动到可见的节点 */
  let scrollToId: string | null = null;

  const tree = h('div', { class: 'mm-tree' });
  const canvas = h('div', { class: 'mm-canvas' }, tree);

  const zoomLabel = h('span', { class: 'mm-zoom-label mono' }, '100%');
  const toolbar = h(
    'div',
    { class: 'mm-toolbar' },
    h('button', { class: 'icon-btn', type: 'button', title: '缩小', html: ICONS.minus, onclick: () => setZoom(zoom - ZOOM_STEP) }),
    h('button', { class: 'icon-btn', type: 'button', title: '放大', html: ICONS.plus, onclick: () => setZoom(zoom + ZOOM_STEP) }),
    h('button', { class: 'mm-fit', type: 'button', title: '适应窗口', onclick: () => fit() }, '适应'),
    zoomLabel,
  );

  const el = h('div', { class: 'mm-root' }, toolbar, canvas);

  function setZoom(next: number): void {
    zoom = clampZoom(next);
    tree.style.transform = `scale(${zoom})`;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }

  function fit(): void {
    if (!state) return;
    setZoom(fitZoomFor(maxDepthOf(state.nodes)));
    canvas.scrollTo({ left: 0, top: 0 });
  }

  // Ctrl/Cmd + 滚轮缩放
  canvas.addEventListener(
    'wheel',
    (ev: WheelEvent) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      setZoom(zoom + (ev.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
    },
    { passive: false },
  );

  // ─────────────── 键盘（与列表视图对等） ───────────────

  function focusNode(id: string, scroll = true): void {
    focusedId = id;
    if (scroll) scrollToId = id;
    render();
  }

  async function runAction(fn: () => Promise<void>, focusId: string): Promise<void> {
    try {
      await fn();
    } catch (e) {
      toast(ctx, `操作失败：${errText(e)}`, 'error');
    }
    focusNode(focusId);
  }

  /** 在节点之后新建同级，并直接进入改名状态 */
  async function createSiblingAfter(id: string): Promise<void> {
    if (!state) return;
    const intent = createSibling(toTNodes(state), id)[0];
    if (!intent || intent.op !== 'create') return;
    try {
      const newId = await ctx.actions.createNodeAt(intent.kind, intent.parentId, '', intent.index);
      if (newId) {
        collapsed.delete(intent.parentId ?? '');
        focusedId = newId;
        renaming = { id: newId, value: '' };
        render();
      }
    } catch (e) {
      toast(ctx, `新建失败：${errText(e)}`, 'error');
    }
  }

  async function commitRename(node: DocNode): Promise<void> {
    const draft = renaming?.id === node.id ? renaming.value.trim() : '';
    renaming = null;
    if (!draft || draft === node.title) {
      render();
      return;
    }
    try {
      await ctx.actions.renameNode(node.id, draft);
    } catch (e) {
      toast(ctx, `改名失败：${errText(e)}`, 'error');
    }
    render();
  }

  el.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.isComposing) return;
    if (!state || !focusedId) return;
    const activeIsInput = (ev.target as HTMLElement)?.tagName === 'INPUT';
    if (activeIsInput) {
      // 输入框里的 Enter/Esc 由输入框自己处理
      return;
    }

    const index = buildNavIndex(state.nodes);
    const node = nodeById(state, focusedId);
    if (!node) return;

    if (ev.key === 'ArrowRight') {
      ev.preventDefault();
      if (collapsed.has(node.id)) {
        collapsed.delete(node.id);
        render();
        return;
      }
      const child = navToChild(index, node.id, collapsed);
      if (child) focusNode(child);
      return;
    }
    if (ev.key === 'ArrowLeft') {
      ev.preventDefault();
      const parent = navToParent(index, node.id);
      if (parent) focusNode(parent);
      return;
    }
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (ev.altKey) {
        const tnodes = toTNodes(state);
        const intent = ev.key === 'ArrowUp' ? moveUpIntent(tnodes, node.id) : moveDownIntent(tnodes, node.id);
        if (!intent) {
          toast(ctx, ev.key === 'ArrowUp' ? '已经在最前面' : '已经在最后面', 'warn');
          return;
        }
        void runAction(() => ctx.actions.moveNode(node.id, intent[0].op === 'move' ? intent[0].parentId : null, (intent[0] as { index: number }).index + 1), node.id);
        return;
      }
      const sib = navToSibling(index, node.id, ev.key === 'ArrowUp' ? -1 : 1);
      if (sib) focusNode(sib);
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      void createSiblingAfter(node.id);
      return;
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      ev.preventDefault();
      ctx.actions.deleteNodes([node.id]);
      return;
    }
    if (ev.key === 'F2' || (node && ev.key === 'Enter' && ev.altKey)) {
      ev.preventDefault();
      renaming = { id: node.id, value: node.title };
      render();
      return;
    }
    if (ev.key === 'Tab') {
      ev.preventDefault();
      const tnodes = toTNodes(state);
      const intent = ev.shiftKey ? outdent(tnodes, node.id) : indent(tnodes, node.id);
      if (!intent) {
        toast(ctx, ev.shiftKey ? '已经是第一级，无法再提升' : '已经是最后一级，或没有上一个兄弟可挂靠', 'warn');
        return;
      }
      toast(ctx, '暂不支持层级变化：降级/提升会改变类型（章↔场景），需要数据迁移', 'warn');
    }
  });

  // ─────────────── 渲染 ───────────────

  function renderNode(node: DocNode, depth: number): HTMLElement {
    const kids = childrenOf(state!, node.id);
    const isCollapsed = collapsed.has(node.id);
    const isCurrent = state!.currentDocId === node.id;
    const isFocused = focusedId === node.id;

    const isRenaming = renaming?.id === node.id;
    const titleEl = isRenaming
      ? (h('input', {
          class: 'mm-rename',
          type: 'text',
          value: renaming!.value,
          oninput: (ev: Event) => {
            if (renaming) renaming.value = (ev.target as HTMLInputElement).value;
          },
          onkeydown: (ev: KeyboardEvent) => {
            if (ev.isComposing) return;
            if (ev.key === 'Enter') {
              ev.preventDefault();
              ev.stopPropagation();
              void (async () => {
                await commitRename(node);
                await createSiblingAfter(node.id);
              })();
            } else if (ev.key === 'Escape') {
              ev.preventDefault();
              ev.stopPropagation();
              renaming = null;
              render();
            }
          },
          onblur: () => {
            if (renaming?.id === node.id) void commitRename(node);
          },
        }) as HTMLInputElement)
      : h('span', { class: 'mm-title truncate' }, node.title);

    const toggle = kids.length
      ? h(
          'button',
          {
            class: 'mm-toggle',
            type: 'button',
            title: isCollapsed ? '展开' : '收起',
            html: isCollapsed ? ICONS.arrowRight : ICONS.chevronDown,
            onclick: (ev: MouseEvent) => {
              ev.stopPropagation();
              if (isCollapsed) collapsed.delete(node.id);
              else collapsed.add(node.id);
              render();
            },
          },
        )
      : h('span', { class: 'mm-toggle placeholder' });

    const words = subtreeWords(state!, node);
    const capsule = h(
      'div',
      {
        class: `mm-capsule k-${node.kind}${isCurrent ? ' current' : ''}${isFocused ? ' focused' : ''}`,
        dataset: { id: node.id },
        tabIndex: 0,
        title: node.summary ? `${node.title}\n\n${node.summary}` : node.title,
        onclick: (ev: MouseEvent) => {
          ev.stopPropagation();
          focusedId = node.id;
          (ev.currentTarget as HTMLElement).focus();
          void ctx.actions.selectDoc(node.id).catch(() => {});
          render();
        },
        ondblclick: (ev: MouseEvent) => {
          ev.stopPropagation();
          renaming = { id: node.id, value: node.title };
          render();
        },
      },
      toggle,
      h('span', { class: `mm-kind k-${node.kind}` }, KIND_LABEL[node.kind]),
      titleEl,
      words > 0 ? h('span', { class: 'mm-words mono' }, fmtNum(words)) : null,
    );

    const wrap = h(
      'div',
      { class: `mm-node d${Math.min(depth, 2)}${isCollapsed ? ' collapsed' : ''}` },
      capsule,
    );

    if (kids.length && !isCollapsed) {
      const childBox = h('div', { class: 'mm-children' });
      for (const child of kids) childBox.appendChild(renderNode(child, depth + 1));
      wrap.appendChild(childBox);
    }
    return wrap;
  }

  function render(): void {
    if (!state) return;
    tree.textContent = '';
    const roots = childrenOf(state, null);
    for (const root of roots) tree.appendChild(renderNode(root, 0));
    tree.style.transform = `scale(${zoom})`;

    // 把焦点节点滚进视野
    if (scrollToId) {
      const target = tree.querySelector<HTMLElement>(`.mm-capsule[data-id="${CSS.escape(scrollToId)}"]`);
      scrollToId = null;
      target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    // 重绘后把焦点还给当前节点：否则方向键会打到 body 上，快捷键全失效
    if (!renaming && focusedId) {
      const active = document.activeElement as HTMLElement | null;
      const lost = !active || active === document.body || !active.closest('.mm-root');
      if (lost) {
        tree.querySelector<HTMLElement>(`.mm-capsule[data-id="${CSS.escape(focusedId)}"]`)?.focus();
      } else if (!active.closest('.mm-root')) {
        tree.querySelector<HTMLElement>(`.mm-capsule[data-id="${CSS.escape(focusedId)}"]`)?.focus();
      }
    }

    // 正在改名：把输入框聚焦并全选
    if (renaming) {
      const input = tree.querySelector<HTMLInputElement>('.mm-rename');
      if (input && document.activeElement !== input) {
        input.focus();
        input.select();
      }
    }
  }

  return {
    el,
    update(next: AppState) {
      const prevCurrent = state?.currentDocId ?? null;
      state = next;
      if (!collapsedInit) {
        collapsedInit = true;
        for (const id of defaultCollapsedFor(next.nodes)) collapsed.add(id);
      }
      if (!focusedId) focusedId = next.currentDocId ?? childrenOf(next, null)[0]?.id ?? null;
      // 切换章节（比如在正文里跳转）时，把当前节点滚进视野
      if (next.currentDocId && next.currentDocId !== prevCurrent) {
        focusedId = next.currentDocId;
        scrollToId = next.currentDocId;
        // 顺带展开它的祖先，否则滚过去也看不见
        let cursor = nodeById(next, next.currentDocId)?.parent_id ?? null;
        let guard = 0;
        while (cursor && guard++ < 20) {
          collapsed.delete(cursor);
          cursor = nodeById(next, cursor)?.parent_id ?? null;
        }
      }
      // 节点被删掉后焦点要落到树上还存在的某个节点
      if (focusedId && !nodeById(next, focusedId)) {
        focusedId = next.currentDocId ?? childrenOf(next, null)[0]?.id ?? null;
      }
      render();
    },
    destroy() {
      el.remove();
    },
  };
}
