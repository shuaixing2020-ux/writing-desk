/**
 * 大纲面板 —— 右侧栏的「结构视图」，可逐行编辑（O2）。
 *
 * 与左侧目录的分工：左边是「找东西、拖来拖去」，右边是「按顺序连续写结构」。
 * 所以这里行首标类型、标题就是输入框、Enter 直接往下续，不用先点按钮。
 *
 * 编辑模型（重要）：
 *   不在本地改树。所有结构操作都翻译成 Intent（tree-ops）→ 调接口 → 刷新。
 *   服务端是唯一真相，失败时界面本来就没变，天然满足「乐观更新可回滚」。
 *   代价是每次操作要等一次往返，对本地单机服务来说是毫秒级。
 *
 * 重绘与输入：
 *   正在输入标题/摘要时收到 tree_changed 不能重绘，否则会把光标和刚打的字冲掉。
 *   这里用 pendingRerender 暂存，失焦提交后再刷。
 */

import type { PanelContext, PanelDef, PanelInstance } from '../../lib/contracts.ts';
import type { AppState } from '../../lib/store.ts';
import type { DocNode } from '../../../../shared/types.ts';
import { DOC_STATUS_LABELS } from '../../../../shared/types.ts';
import { childrenOf } from '../../lib/store.ts';
import { h, fmtNum } from '../../lib/dom.ts';
import { ICONS, emptyBlock, errText, panelShell, toast } from './shared.ts';
import { createMindmap, type MindmapHandle } from '../outline-mindmap.ts';
import { loadPrefs, savePrefs, type OutlineMode } from '../../lib/ui-prefs.ts';
import {
  createSibling,
  indent,
  moveDown as moveDownIntent,
  moveUp as moveUpIntent,
  outdent,
  type Intent,
  type TNode,
} from '../../lib/tree-ops.ts';

interface OutlineRow {
  node: DocNode;
  depth: number;
}

const KIND_LABEL: Record<DocNode['kind'], string> = {
  volume: '卷',
  chapter: '章',
  scene: '场',
};

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

/** 把状态转成 tree-ops 需要的纯结构树 */
function toTNodes(state: AppState, parentId: string | null = null): TNode[] {
  return childrenOf(state, parentId).map((n) => ({
    id: n.id,
    title: n.title,
    children: toTNodes(state, n.id),
  }));
}

/** 容器节点自身 word_count 可能为 0，这里按子树求和，避免显示成空 */
function subtreeWords(state: AppState, node: DocNode): number {
  if (node.kind === 'scene') return node.word_count;
  const walk = (id: string): number => {
    let sum = 0;
    for (const k of childrenOf(state, id)) sum += k.kind === 'scene' ? k.word_count : walk(k.id);
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

    /** 正在输入的标题草稿；提交后清空 */
    let titleDraft: { id: string; value: string } | null = null;
    /** 重绘后要放回焦点的行 */
    let focusAfterRender: { id: string; selectAll?: boolean } | null = null;
    /**
     * 上一次聚焦的行。
     * 结构操作会触发两次重绘（操作本身一次、服务端 tree_changed 一次），
     * 第一次已经聚焦了新行，第二次重绘会把 DOM 换掉导致焦点掉到 body。
     * 所以记住 id，重绘后发现焦点丢了就放回去。
     */
    let lastFocusId: string | null = null;
    /** 新建出来、还没被作者改动过的行：重绘后仍要全选，否则打字会变成追加 */
    let selectAllId: string | null = null;
    let pendingRerender = false;
    let lastState: AppState | null = null;
    let lastRenderedKey = '';

    // ── 视图切换：列表 / 思维导图（O3/O4） ──
    const isNarrowScreen = (): boolean => window.matchMedia('(max-width: 960px)').matches;
    let mode: OutlineMode = isNarrowScreen() ? 'list' : loadPrefs().outlineMode;
    let mindmap: MindmapHandle | null = null;

    const listBtn = h('button', { class: 'p-outline-mode', type: 'button' }, '列表');
    const mapBtn = h('button', { class: 'p-outline-mode', type: 'button' }, '导图');
    const modeBar = h('div', { class: 'p-outline-modes', role: 'tablist' }, listBtn, mapBtn);
    const content = h('div', { class: 'p-outline-content' });

    const syncModeButtons = (): void => {
      listBtn.classList.toggle('active', mode === 'list');
      mapBtn.classList.toggle('active', mode === 'map');
      listBtn.setAttribute('aria-selected', String(mode === 'list'));
      mapBtn.setAttribute('aria-selected', String(mode === 'map'));
      // 手机上只提供列表视图
      modeBar.classList.toggle('hidden', isNarrowScreen());
    };

    const setMode = (next: OutlineMode): void => {
      if (isNarrowScreen() && next === 'map') return;
      if (mode === next) return;
      mode = next;
      savePrefs({ ...loadPrefs(), outlineMode: next });
      syncModeButtons();
      if (lastState) render(lastState);
    };

    listBtn.addEventListener('click', () => setMode('list'));
    mapBtn.addEventListener('click', () => setMode('map'));

    // 快捷键 ⌘⇧O：在大纲面板里切换列表 / 导图
    const onToggleMode = (): void => {
      setMode(mode === 'map' ? 'list' : 'map');
    };
    window.addEventListener('writingdesk:toggle-outline-mode', onToggleMode);

    // 检查器变宽/变窄后重新判断「面板偏窄」提示
    const onWidthChanged = (): void => {
      if (mode !== 'map' || !lastState) return;
      // 宽度事件是在样式生效前发出的，此刻 clientWidth 还是旧值。
      // 等下一帧再量一次，否则「切到宽栏」之后提示不会消失。
      requestAnimationFrame(() => {
        const hint = content.querySelector<HTMLElement>('.mm-narrow-hint');
        if (hint) hint.classList.toggle('hidden', content.clientWidth >= 480);
      });
    };
    window.addEventListener('writingdesk:inspector-width', onWidthChanged);
    window.addEventListener('resize', onWidthChanged);

    shell.body.appendChild(modeBar);
    shell.body.appendChild(content);
    shell.body.appendChild(h('div', { class: 'p-outline-summary-host' }));

    const activeEl = (): HTMLElement | null => document.activeElement as HTMLElement | null;
    const isEditingTitle = (): boolean => !!activeEl()?.classList.contains('p-outline-name');
    const isEditingSummary = (): boolean => !!activeEl()?.classList.contains('p-outline-summary');
    const isEditingAny = (): boolean => isEditingTitle() || isEditingSummary();

    /**
     * 需要重绘但正在输入：先记下来，失焦后补。
     *
     * 必须延后一拍：失焦发生在「点向另一个输入框」的瞬间，
     * 如果同步重绘，会把作者正要点的那个元素从 DOM 里换掉，
     * 点击就落空了（真实手感问题，不是测试问题）。
     */
    const afterEdit = (): void => {
      if (!pendingRerender) return;
      pendingRerender = false;
      setTimeout(() => {
        if (!pendingRerender && lastState && !isEditingAny()) render(lastState);
      }, 0);
    };

    function focusRow(id: string, selectAll = false): void {
      focusAfterRender = { id, selectAll };
      if (selectAll) selectAllId = id;
    }

    // ─────────────── 结构操作 ───────────────

    /** 执行一个意图；失败由 API 层提示，这里只负责把焦点放回去 */
    async function runIntent(intent: Intent, focusId: string): Promise<void> {
      try {
        if (intent.op === 'create') {
          const newId = await ctx.actions.createNodeAt(
            intent.kind,
            intent.parentId,
            intent.title,
            intent.index,
          );
          if (newId) focusRow(newId, true);
        } else if (intent.op === 'move') {
          await ctx.actions.moveNode(intent.id, intent.parentId, intent.index + 1);
          focusRow(focusId);
        } else {
          await ctx.actions.renameNode(intent.id, intent.title);
          focusRow(focusId);
        }
      } catch (e) {
        toast(ctx, `操作失败：${errText(e)}`, 'error');
        focusRow(focusId);
      }
      if (lastState) render(lastState);
    }

    async function commitTitle(node: DocNode, input: HTMLInputElement): Promise<void> {
      const draft = titleDraft?.id === node.id ? titleDraft.value : input.value;
      const next = draft.trim();
      titleDraft = null;
      if (!next || next === node.title) {
        input.value = node.title;
        afterEdit();
        return;
      }
      try {
        await ctx.actions.renameNode(node.id, next);
      } catch (e) {
        input.value = node.title;
        toast(ctx, `改名失败：${errText(e)}`, 'error');
      }
      afterEdit();
    }

    // ─────────────── 键盘 ───────────────

    function rowOrder(state: AppState): string[] {
      return flatten(state).map((r) => r.node.id);
    }

    function moveFocus(state: AppState, fromId: string, delta: -1 | 1): void {
      const order = rowOrder(state);
      const at = order.indexOf(fromId);
      const nextId = order[at + delta];
      if (nextId) focusRow(nextId);
      if (lastState) render(lastState);
    }

    /** Tab / Shift+Tab：层级变化意味着类型变化，暂不支持（需要数据迁移） */
    function explainIndentGap(state: AppState, id: string, wantDeeper: boolean): void {
      const tree = toTNodes(state);
      const intent = wantDeeper ? indent(tree, id) : outdent(tree, id);
      if (!intent) {
        toast(
          ctx,
          wantDeeper
            ? '已经是最后一级，或本来就没有上一个兄弟可挂靠'
            : '已经是第一级，无法再提升',
          'warn',
        );
        return;
      }
      toast(
        ctx,
        wantDeeper
          ? '暂不支持降级：降一级会改变类型（章变场景），需要数据迁移'
          : '暂不支持提升：升一级会改变类型（场景变章），需要数据迁移',
        'warn',
      );
    }

    // ─────────────── 渲染 ───────────────

    function render(state: AppState): void {
      lastState = state;
      syncModeButtons();

      // 导图模式：交给独立组件，列表 DOM 整体让位
      if (mode === 'map' && !isNarrowScreen()) {
        content.textContent = '';
        // 检查器太窄时导图看不清：给一条提示 + 一键切宽栏（O4）。
        // 宽度要等布局完成才读得到，所以先挂上、下一帧再决定显示与否。
        const hint = h(
          'div',
          { class: 'mm-narrow-hint hidden' },
          h('span', null, '面板偏窄，导图看不清'),
          h(
            'button',
            {
              class: 'btn sm',
              type: 'button',
              onclick: () => {
                window.dispatchEvent(
                  new CustomEvent('writingdesk:set-inspector-width', { detail: { width: 560 } }),
                );
              },
            },
            '切到宽栏',
          ),
        );
        content.appendChild(hint);
        requestAnimationFrame(() => {
          if (content.isConnected) hint.classList.toggle('hidden', content.clientWidth >= 480);
        });

        if (!mindmap) mindmap = createMindmap(ctx);
        content.appendChild(mindmap.el);
        mindmap.update(state);
        lastRenderedKey = stateKey(state);
        return;
      }
      if (mindmap) {
        mindmap.destroy();
        mindmap = null;
      }

      const rows = flatten(state);
      const scrollTop = content.scrollTop;
      const nodes = state.nodes;

      if (rows.length === 0) {
        content.textContent = '';
        content.appendChild(
          emptyBlock({
            icon: ICONS.outline,
            title: '还没有任何结构',
            hint: '先建一卷，再往下拆章与场景。大纲会随写作自动更新字数。',
            action: {
              label: '新建第一卷',
              onClick: () =>
                void ctx.actions
                  .createNode('volume', null, '第一卷')
                  .catch((e: unknown) => toast(ctx, errText(e), 'error')),
            },
          }),
        );
        return;
      }

      const sceneCount = nodes.filter((n) => n.kind === 'scene').length;
      const words = nodes.filter((n) => n.kind === 'scene').reduce((s, n) => s + n.word_count, 0);

      const head = h(
        'div',
        { class: 'p-outline-meta' },
        h('span', null, `${sceneCount} 个场景`),
        h('span', { class: 'p-dot-sep', 'aria-hidden': 'true' }),
        h('span', { class: 'mono' }, `${fmtNum(words)} 字`),
      );

      const list = h('div', { class: 'p-outline-list' });
      for (const row of rows) {
        list.appendChild(renderRow(row, state));
      }

      content.textContent = '';
      content.append(head, list);
      content.scrollTop = scrollTop;

      for (const ta of Array.from(list.querySelectorAll<HTMLTextAreaElement>('.p-outline-summary'))) {
        autoGrow(ta);
      }

      // 结构操作后把焦点还给被操作的行（U3）。
      // 两种情况都要管：显式请求的下一站，以及重绘把焦点弄丢后回到原来那一行。
      const explicit = focusAfterRender;
      focusAfterRender = null;
      const active = document.activeElement as HTMLElement | null;
      const focusLost = !active || active === document.body || !active.closest('.p-outline-list');
      const desired = explicit?.id ?? (focusLost ? lastFocusId : null);

      if (desired) {
        const input = list.querySelector<HTMLInputElement>(
          `.p-outline-name[data-id="${CSS.escape(desired)}"]`,
        );
        if (input) {
          input.focus();
          if (selectAllId === desired) input.select();
          lastFocusId = desired;
        }
      }
    }

    function renderRow(row: OutlineRow, state: AppState): HTMLElement {
      const { node, depth } = row;
      const isCurrent = state.currentDocId === node.id;
      const words = node.kind === 'scene' ? node.word_count : subtreeWords(state, node);
      const scenes = node.kind === 'scene' ? 0 : subtreeScenes(state, node);
      const indentPx = 8 + depth * 14;

      // ── 标题输入框 ──
      const input = h('input', {
        class: 'p-outline-name',
        type: 'text',
        value: titleDraft?.id === node.id ? titleDraft.value : node.title,
        title: node.title,
        spellcheck: false,
        dataset: { id: node.id, kind: node.kind },
        style: {
          marginLeft: `${indentPx}px`,
          width: `calc(100% - ${indentPx + 92}px)`,
        },
      }) as HTMLInputElement;

      input.addEventListener('focus', () => {
        lastFocusId = node.id;
        titleDraft = { id: node.id, value: input.value };
        if (!isCurrent) {
          void ctx.actions.selectDoc(node.id).catch(() => {
            /* 打不开正文不影响改名 */
          });
        }
      });

      input.addEventListener('input', () => {
        titleDraft = { id: node.id, value: input.value };
        // 已经开始改了，就别再全选覆盖他的输入
        if (selectAllId === node.id) selectAllId = null;
      });

      input.addEventListener('blur', () => {
        // 重绘会把旧输入框从 DOM 里摘掉，浏览器随即补一个 blur。
        // 那不是「作者离开了这一行」，不能当成失焦处理：
        // 否则会清掉待全选标记、还会拿旧草稿去提交一次改名。
        if (!input.isConnected) return;
        if (selectAllId === node.id) selectAllId = null;
        if (titleDraft?.id === node.id) void commitTitle(node, input);
        else afterEdit();
      });

      input.addEventListener('keydown', (ev: KeyboardEvent) => {
        if (ev.isComposing) return;
        const st = lastState;
        if (!st) return;

        // Enter：先提交改名，再在下方新建同级
        if (ev.key === 'Enter' && !ev.altKey) {
          ev.preventDefault();
          void (async () => {
            if (titleDraft?.id === node.id) await commitTitle(node, input);
            const intents = createSibling(toTNodes(st), node.id);
            if (intents.length > 0) await runIntent(intents[0], node.id);
          })();
          return;
        }

        // Esc：放弃本次改动
        if (ev.key === 'Escape') {
          ev.preventDefault();
          titleDraft = null;
          input.value = node.title;
          input.blur();
          return;
        }

        // 空行 Backspace = 删除（走 C2 的批量删除与撤销）
        if (ev.key === 'Backspace' && input.value === '') {
          ev.preventDefault();
          titleDraft = null;
          ctx.actions.deleteNodes([node.id]);
          return;
        }

        // Alt + 上下：调整顺序
        if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
          ev.preventDefault();
          const tree = toTNodes(st);
          const intent = ev.key === 'ArrowUp' ? moveUpIntent(tree, node.id) : moveDownIntent(tree, node.id);
          if (!intent) {
            toast(ctx, ev.key === 'ArrowUp' ? '已经在最前面' : '已经在最后面', 'warn');
            return;
          }
          void runIntent(intent[0], node.id);
          return;
        }

        // 上下：在行间移动焦点
        if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
          ev.preventDefault();
          void (async () => {
            if (titleDraft?.id === node.id) await commitTitle(node, input);
            moveFocus(st, node.id, ev.key === 'ArrowUp' ? -1 : 1);
          })();
          return;
        }

        // Tab / Shift+Tab：跨层级会改变类型，当前不支持
        if (ev.key === 'Tab') {
          ev.preventDefault();
          explainIndentGap(st, node.id, !ev.shiftKey);
        }
      });

      // ── 行头：类型 + 标题 + 统计 ──
      const kindLabel = h('span', { class: `p-outline-kind-label k-${node.kind}` }, KIND_LABEL[node.kind]);
      const stat =
        node.kind === 'scene'
          ? h('span', { class: `p-outline-status s-${node.status}` }, DOC_STATUS_LABELS[node.status])
          : h('span', { class: 'p-outline-count' }, `${scenes} 场`);
      const wordEl = h('span', { class: 'p-outline-words mono' }, fmtNum(words));

      const headRow = h(
        'div',
        { class: 'p-outline-head-row', style: { paddingLeft: '0' } },
        kindLabel,
        input,
        stat,
        wordEl,
      );

      // 点行（非输入框区域）也切到该文档
      headRow.addEventListener('click', (ev) => {
        if ((ev.target as HTMLElement) === input) return;
        input.focus();
      });

      // ── 摘要（沿用原有编辑方式）──
      const summary = h('textarea', {
        class: 'p-outline-summary',
        rows: 1,
        placeholder: depth === 0 ? '这一卷要写什么…' : '摘要…',
        value: node.summary ?? '',
        spellcheck: false,
        style: {
          marginLeft: `${indentPx}px`,
          width: `calc(100% - ${indentPx + 8}px)`,
        },
      }) as HTMLTextAreaElement;

      summary.addEventListener('input', () => autoGrow(summary));
      summary.addEventListener('blur', () => {
        const next = summary.value.trim();
        if (next === (node.summary ?? '')) {
          afterEdit();
          return;
        }
        void ctx.actions
          .updateNodeMeta(node.id, { summary: next })
          .then(() => afterEdit())
          .catch((e: unknown) => {
            toast(ctx, `摘要保存失败：${errText(e)}`, 'error');
            summary.value = node.summary ?? '';
            autoGrow(summary);
          });
      });
      summary.addEventListener('keydown', (ev) => {
        if (ev.isComposing) return;
        if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
          ev.preventDefault();
          summary.blur();
        }
      });

      const wrap = h('div', {
        class: `p-outline-item d${Math.min(depth, 3)}${isCurrent ? ' current' : ''}`,
      });
      wrap.append(headRow, summary);
      return wrap;
    }

    async function createSceneAtCurrent(c: PanelContext): Promise<void> {
      const state = c.store.state;
      const current = state.nodes.find((n) => n.id === state.currentDocId) ?? null;
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
      return [
        state.nodes.length,
        state.currentDocId ?? '',
        ...state.nodes.map(
          (n) => `${n.id}:${n.title}:${n.summary}:${n.word_count}:${n.status}:${n.parent_id}:${n.order}`,
        ),
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
        lastState = state;
        // 正在输入时不重绘：否则光标与刚打的字都会被冲掉
        if (isEditingAny()) {
          pendingRerender = true;
          return;
        }
        render(state);
      },
      destroy(): void {
        window.removeEventListener('writingdesk:toggle-outline-mode', onToggleMode);
        window.removeEventListener('writingdesk:inspector-width', onWidthChanged);
        window.removeEventListener('resize', onWidthChanged);
        mindmap?.destroy();
        mindmap = null;
        container.textContent = '';
      },
    };
  },
};
