/**
 * 大纲面板 —— 右侧栏的「结构视图」。
 *
 * 为什么不做成文档树：左侧已经是操作树（拖拽、改名、删除）。
 * 大纲视图回答的是另一个问题：「这本书现在什么形状」——
 * 所以这里平铺全书层级，重点放在摘要、字数与状态，可读性优先于操作密度。
 */

import type { PanelContext, PanelDef, PanelInstance } from '../../lib/contracts.ts';
import type { AppState } from '../../lib/store.ts';
import type { DocNode } from '../../../../shared/types.ts';
import { DOC_STATUS_LABELS } from '../../../../shared/types.ts';
import { childrenOf } from '../../lib/store.ts';
import { h, fmtNum } from '../../lib/dom.ts';
import { ICONS, emptyBlock, errText, panelShell, toast } from './shared.ts';

interface OutlineRow {
  node: DocNode;
  depth: number;
}

/** 深度优先展开（大纲不折叠：作者需要一眼看到全书结构） */
function flatten(state: AppState): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const walk = (parentId: string | null, depth: number): void => {
    for (const child of childrenOf(state, parentId)) {
      rows.push({ node: child, depth });
      if (child.kind !== 'scene') walk(child.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

/** 容器节点自身 word_count 可能为 0，这里按子树求和，避免显示成空 */
function subtreeWords(state: AppState, node: DocNode): number {
  if (node.kind === 'scene') return node.word_count;
  const walk = (id: string): number => {
    const kids = childrenOf(state, id);
    let sum = 0;
    for (const k of kids) sum += k.kind === 'scene' ? k.word_count : walk(k.id);
    return sum;
  };
  return walk(node.id);
}

function subtreeScenes(state: AppState, node: DocNode): number {
  if (node.kind === 'scene') return 1;
  const walk = (id: string): number => {
    let sum = 0;
    for (const k of childrenOf(state, id)) sum += k.kind === 'scene' ? 1 : walk(k.id);
    return sum;
  };
  return walk(node.id);
}

function autoGrow(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

export const panel: PanelDef = {
  id: 'outline',
  title: '大纲',
  icon: ICONS.outline,
  inInspector: true,

  mount(container: HTMLElement, ctx: PanelContext): PanelInstance {
    const shell = panelShell(container, {
      tools: [
        (() => {
          const btn = h('button', {
            class: 'icon-btn',
            type: 'button',
            title: '新建场景',
            'aria-label': '新建场景',
            onclick: () => void createSceneAtCurrent(ctx),
          });
          btn.innerHTML = ICONS.plus;
          return btn;
        })(),
      ],
    });

    /** 摘要输入框获得焦点时暂缓重绘，否则会把正在输入的内容冲掉 */
    let pendingRerender = false;
    let lastState: AppState | null = null;
    let lastRenderedKey = '';

    const summaryHost = h('div', { class: 'p-outline-summary-host' });
    shell.body.appendChild(summaryHost);

    function isEditingSummary(): boolean {
      const active = document.activeElement;
      return !!active && active.classList.contains('p-outline-summary');
    }

    function render(state: AppState): void {
      lastState = state;
      const rows = flatten(state);
      const scrollTop = shell.body.scrollTop;

      if (rows.length === 0) {
        summaryHost.textContent = '';
        shell.body.textContent = '';
        shell.body.appendChild(
          emptyBlock({
            icon: ICONS.outline,
            title: '还没有任何结构',
            hint: '先建一卷，再往下拆章与场景。大纲会随写作自动更新字数。',
            action: {
              label: '新建第一卷',
              onClick: () => void ctx.actions.createNode('volume', null, '第一卷').catch((e: unknown) => toast(ctx, errText(e), 'error')),
            },
          }),
        );
        return;
      }

      const sceneCount = state.nodes.filter((n) => n.kind === 'scene').length;
      const words = state.nodes.filter((n) => n.kind === 'scene').reduce((s, n) => s + n.word_count, 0);

      const head = h(
        'div',
        { class: 'p-outline-meta' },
        h('span', null, `${sceneCount} 个场景`),
        h('span', { class: 'p-dot-sep', 'aria-hidden': 'true' }),
        h('span', { class: 'mono' }, `${fmtNum(words)} 字`),
      );

      const list = h('div', { class: 'p-outline-list' });
      for (const row of rows) {
        list.appendChild(renderRow(row, state, ctx, () => render(lastState ?? state)));
      }

      shell.body.textContent = '';
      shell.body.append(head, list);
      shell.body.scrollTop = scrollTop;

      // 重绘后重新计算摘要高度（textarea 无内容时高度会塌）
      for (const ta of Array.from(list.querySelectorAll<HTMLTextAreaElement>('.p-outline-summary'))) {
        autoGrow(ta);
      }
    }

    function renderRow(
      row: OutlineRow,
      state: AppState,
      ctx2: PanelContext,
      rerender: () => void,
    ): HTMLElement {
      const { node, depth } = row;
      const isCurrent = state.currentDocId === node.id;
      const words = node.kind === 'scene' ? node.word_count : subtreeWords(state, node);
      const scenes = node.kind === 'scene' ? 0 : subtreeScenes(state, node);

      const titleBtn = h(
        'button',
        {
          class: `p-outline-title${isCurrent ? ' current' : ''}`,
          type: 'button',
          title: node.title,
          style: { paddingLeft: `${8 + depth * 14}px` },
          onclick: () => {
            void ctx2.actions.selectDoc(node.id).catch((e: unknown) => toast(ctx2, errText(e), 'error'));
          },
        },
        node.kind === 'scene'
          ? h('span', { class: `dot ${node.status}`, title: DOC_STATUS_LABELS[node.status] })
          : h('span', { class: 'p-outline-kind', html: ICONS.chevronDown }),
        h('span', { class: 'p-outline-name truncate' }, node.title),
        node.kind === 'scene'
          ? h('span', { class: `p-outline-status s-${node.status}` }, DOC_STATUS_LABELS[node.status])
          : h('span', { class: 'p-outline-count' }, `${scenes} 场`),
        h('span', { class: 'p-outline-words mono' }, fmtNum(words)),
      );

      const summary = h('textarea', {
        class: 'p-outline-summary',
        rows: 1,
        placeholder: depth === 0 ? '这一卷要写什么…' : '摘要…',
        value: node.summary ?? '',
        spellcheck: false,
        // 缩进量同时从宽度里扣掉，否则 textarea 会撑出横向滚动条
        style: {
          marginLeft: `${8 + depth * 14}px`,
          width: `calc(100% - ${8 + depth * 14 + 8}px)`,
        },
      }) as HTMLTextAreaElement;
      summary.style.marginLeft = `${8 + depth * 14}px`;

      summary.addEventListener('input', () => autoGrow(summary));
      summary.addEventListener('blur', () => {
        const next = summary.value.trim();
        if (next === (node.summary ?? '')) {
          if (pendingRerender) {
            pendingRerender = false;
            if (lastState) render(lastState);
          }
          return;
        }
        void ctx2.actions
          .updateNodeMeta(node.id, { summary: next })
          .then(() => {
            if (pendingRerender) {
              pendingRerender = false;
              if (lastState) render(lastState);
            }
          })
          .catch((e: unknown) => {
            toast(ctx2, `摘要保存失败：${errText(e)}`, 'error');
            summary.value = node.summary ?? '';
            autoGrow(summary);
          });
      });
      // Cmd/Ctrl+Enter 立即失焦保存，符合写作时「写完一句就走」的习惯
      summary.addEventListener('keydown', (ev) => {
        if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
          ev.preventDefault();
          summary.blur();
        }
      });

      const wrap = h('div', { class: `p-outline-item d${Math.min(depth, 3)}${isCurrent ? ' current' : ''}` });
      wrap.append(titleBtn, summary);
      // rerender 参数保留给未来的「就地刷新」；当前由 blur 回调直接处理
      void rerender;
      return wrap;
    }

    async function createSceneAtCurrent(c: PanelContext): Promise<void> {
      const state = c.store.state;
      const current = state.nodes.find((n) => n.id === state.currentDocId) ?? null;
      // 新场景落在当前节点所在章下；没有上下文就落第一卷，再没有就提示先建卷
      let parentId: string | null = null;
      if (current) {
        if (current.kind === 'chapter') parentId = current.id;
        else if (current.kind === 'scene') parentId = current.parent_id;
        else parentId = current.id;
      }
      if (!parentId) {
        const firstChapter = state.nodes.find((n) => n.kind === 'chapter');
        const firstVolume = state.nodes.find((n) => n.kind === 'volume');
        parentId = firstChapter?.id ?? firstVolume?.id ?? null;
      }
      if (!parentId) {
        toast(c, '请先在左侧新建一卷', 'warn');
        return;
      }
      try {
        await c.actions.createNode('scene', parentId, '新场景');
      } catch (e) {
        toast(c, `新建场景失败：${errText(e)}`, 'error');
      }
    }

    function stateKey(state: AppState): string {
      // 只把影响大纲显示的数据纳入 key，避免保存状态变化导致无谓重绘
      return [
        state.nodes.length,
        state.currentDocId ?? '',
        ...state.nodes.map((n) => `${n.id}:${n.title}:${n.summary}:${n.word_count}:${n.status}:${n.parent_id}:${n.order}`),
      ].join('|');
    }

    render(ctx.store.state);
    lastRenderedKey = stateKey(ctx.store.state);

    return {
      update(state: AppState, changed: Set<keyof AppState>): void {
        if (!changed.has('nodes') && !changed.has('currentDocId')) return;
        const key = stateKey(state);
        if (key === lastRenderedKey) return;
        lastRenderedKey = key;
        if (isEditingSummary()) {
          pendingRerender = true;
          return;
        }
        render(state);
      },
      destroy(): void {
        container.textContent = '';
      },
    };
  },
};
