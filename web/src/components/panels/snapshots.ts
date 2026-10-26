/**
 * 版本快照面板 —— 写作工具的「后悔药」。
 *
 * 交互要点：
 *   - 列表默认看当前场景的历史，也可切到全书；
 *   - 点开差异就地展开（不弹层），新增绿/删除红，改动块内做字符级高亮；
 *   - 恢复必须二次确认，且提示「当前版本会先存一份快照」。
 */

import type { PanelContext, PanelDef, PanelInstance } from '../../lib/contracts.ts';
import type { AppState } from '../../lib/store.ts';
import type { DiffBlock, DiffResult, SnapshotMeta } from '../../../../shared/types.ts';
import { SNAPSHOT_REASON_LABELS } from '../../../../shared/types.ts';
import { h, formatTime, relativeTime } from '../../lib/dom.ts';
import {
  ICONS,
  bigIcon,
  emptyBlock,
  errText,
  fmtBytes,
  iconButton,
  loadingBlock,
  panelShell,
  confirmDanger,
  toast,
} from './shared.ts';

type Scope = 'scene' | 'book';

export const panel: PanelDef = {
  id: 'snapshots',
  title: '版本',
  icon: ICONS.snapshots,
  inInspector: true,

  mount(container: HTMLElement, ctx: PanelContext): PanelInstance {
    let scope: Scope = 'scene';
    let destroyed = false;
    let loading = false;
    let error: unknown = null;
    let items: SnapshotMeta[] = [];
    /** 当前展开差异的快照 id */
    let openId: string | null = null;
    let diffLoading = false;
    let diffError: unknown = null;
    let diff: DiffResult | null = null;
    let diffSnapshot: SnapshotMeta | null = null;

    const scopeRow = h('div', { class: 'p-chips' });
    const scopeDefs: Array<{ value: Scope; label: string }> = [
      { value: 'scene', label: '当前场景' },
      { value: 'book', label: '全书' },
    ];
    for (const s of scopeDefs) {
      const btn = h(
        'button',
        {
          class: `p-chip${s.value === scope ? ' sel' : ''}`,
          type: 'button',
          onclick: () => {
            if (scope === s.value) return;
            scope = s.value;
            openId = null;
            diff = null;
            for (const el of Array.from(scopeRow.children)) el.classList.remove('sel');
            btn.classList.add('sel');
            void load();
          },
        },
        s.label,
      );
      scopeRow.appendChild(btn);
    }

    const createBtn = iconButton(ICONS.plus, '为当前场景创建快照', () => {
      void (async () => {
        const docId = ctx.store.state.currentDocId;
        const node = ctx.store.state.nodes.find((n) => n.id === docId);
        if (!docId || !node || node.kind !== 'scene') {
          toast(ctx, '请先选中一个场景', 'warn');
          return;
        }
        try {
          await ctx.actions.createSnapshot('manual');
          toast(ctx, '已创建快照', 'ok');
          await load();
        } catch (e) {
          toast(ctx, `创建快照失败：${errText(e)}`, 'error');
        }
      })();
    });

    const shell = panelShell(container, { toolbar: scopeRow, tools: [createBtn] });
    const listHost = h('div', { class: 'p-snap-list' });
    shell.body.appendChild(listHost);

    async function load(): Promise<void> {
      if (destroyed) return;
      loading = true;
      error = null;
      render();
      try {
        const docId = scope === 'scene' ? ctx.store.state.currentDocId : undefined;
        if (scope === 'scene' && !docId) {
          items = [];
          loading = false;
          render();
          return;
        }
        const list = await ctx.api.listSnapshots(docId ?? undefined);
        if (destroyed) return;
        items = [...list].sort((a, b) => b.created_at - a.created_at);
      } catch (e) {
        if (destroyed) return;
        error = e;
        items = [];
      } finally {
        if (!destroyed) {
          loading = false;
          render();
        }
      }
    }

    function render(): void {
      if (destroyed) return;
      const scrollTop = shell.body.scrollTop;

      if (loading) {
        listHost.textContent = '';
        listHost.appendChild(loadingBlock('读取快照…'));
        return;
      }
      if (error) {
        listHost.textContent = '';
        listHost.appendChild(
          h(
            'div',
            { class: 'p-error' },
            h('div', { class: 'p-error-icon', html: ICONS.alert }),
            h('div', { class: 'p-error-msg' }, errText(error)),
            h('button', { class: 'btn sm', type: 'button', onclick: () => void load() }, '重试'),
          ),
        );
        return;
      }
      if (items.length === 0) {
        listHost.textContent = '';
        listHost.appendChild(
          emptyBlock({
            icon: bigIcon('<path d="M8 4.1V8l2.5 1.6"/><path d="M13.6 8a5.6 5.6 0 1 1-2-4.3"/>'),
            title: scope === 'scene' ? '这个场景还没有快照' : '还没有任何快照',
            hint:
              scope === 'scene'
                ? '保存时会自动留快照，也可以点上方 + 手动存一份。'
                : '写满一段时间后，这里会积累全书的历史版本。',
          }),
        );
        return;
      }

      const head = h(
        'div',
        { class: 'p-snap-head' },
        h('span', null, `${items.length} 个版本`),
        h('span', { class: 'p-dot-sep', 'aria-hidden': 'true' }),
        h('span', { class: 'p-muted-note' }, '点开看差异'),
      );

      listHost.textContent = '';
      listHost.appendChild(head);

      for (const snap of items) listHost.appendChild(renderSnap(snap));
      shell.body.scrollTop = scrollTop;
    }

    function renderSnap(snap: SnapshotMeta): HTMLElement {
      const isOpen = openId === snap.id;
      const wrap = h('div', { class: `p-snap${isOpen ? ' open' : ''}` });

      const row = h(
        'button',
        {
          class: 'p-snap-row',
          type: 'button',
          title: `${snap.doc_title} · ${formatTime(snap.created_at)}`,
          onclick: () => {
            if (isOpen) {
              openId = null;
              diff = null;
              render();
              return;
            }
            openId = snap.id;
            void loadDiff(snap.id);
          },
        },
        h('span', { class: `p-snap-dot reason-${snap.reason}` }),
        h(
          'span',
          { class: 'p-snap-main' },
          h(
            'span',
            { class: 'p-snap-title truncate' },
            scope === 'book' ? `${snap.doc_title}` : SNAPSHOT_REASON_LABELS[snap.reason],
          ),
          h(
            'span',
            { class: 'p-snap-sub' },
            `${relativeTime(snap.created_at)} · ${fmtBytes(snap.size)}`,
            snap.pinned ? ' · 已固定' : '',
          ),
        ),
        h('span', { class: `p-snap-caret${isOpen ? ' open' : ''}`, html: ICONS.chevron }),
      );
      wrap.appendChild(row);

      if (isOpen) {
        wrap.appendChild(renderDiffPanel(snap));
      }
      return wrap;
    }

    function renderDiffPanel(snap: SnapshotMeta): HTMLElement {
      const box = h('div', { class: 'p-diff' });

      if (diffLoading) {
        box.appendChild(loadingBlock('对比中…'));
        return box;
      }
      if (diffError) {
        box.appendChild(
          h(
            'div',
            { class: 'p-error compact' },
            h('div', { class: 'p-error-msg' }, errText(diffError)),
            h('button', { class: 'btn sm', type: 'button', onclick: () => void loadDiff(snap.id) }, '重试'),
          ),
        );
        return box;
      }
      if (!diff) {
        box.appendChild(loadingBlock('对比中…'));
        return box;
      }

      // 摘要
      box.appendChild(
        h(
          'div',
          { class: 'p-diff-sum' },
          h('span', { class: 'p-diff-add' }, `+${diff.stats.added}`),
          h('span', { class: 'p-diff-del' }, `-${diff.stats.removed}`),
          h('span', { class: 'p-muted-note' }, `${diff.stats.unchanged} 段未变`),
        ),
      );

      // 差异块
      const blocks = h('div', { class: 'p-diff-blocks' });
      let shown = 0;
      for (const block of diff.blocks) {
        if (block.type === 'equal') {
          // 相同块只保留上下文前后各一段，避免 300px 面板被淹没
          const idx = diff.blocks.indexOf(block);
          const nearChange = diff.blocks[idx - 1]?.type !== 'equal' || diff.blocks[idx + 1]?.type !== 'equal';
          if (!nearChange && shown > 0) continue;
        }
        if (block.type !== 'equal') shown++;
        blocks.appendChild(renderBlock(block));
      }
      if (shown === 0) {
        blocks.appendChild(h('div', { class: 'p-muted-note p-pad' }, '与当前内容没有差异。'));
      }
      box.appendChild(blocks);

      // 恢复
      box.appendChild(
        h(
          'div',
          { class: 'p-diff-actions' },
          h(
            'button',
            {
              class: 'btn sm primary',
              type: 'button',
              onclick: () => void restore(snap),
            },
            '恢复到这一版',
          ),
        ),
      );
      return box;
    }

    function renderBlock(block: DiffBlock): HTMLElement {
      const cls = block.type === 'insert' ? 'ins' : block.type === 'delete' ? 'del' : 'eq';
      const inner: Node[] = [];
      if (block.inline && block.inline.length) {
        for (const seg of block.inline) {
          if (seg.type === 'equal') inner.push(document.createTextNode(seg.text));
          else {
            const span = h('span', { class: seg.type === 'insert' ? 'i-ins' : 'i-del' });
            span.textContent = seg.text;
            inner.push(span);
          }
        }
      } else {
        inner.push(document.createTextNode(block.text));
      }
      const el = h('div', { class: `p-diff-block ${cls}` });
      el.append(...inner);
      return el;
    }

    async function loadDiff(id: string): Promise<void> {
      diffLoading = true;
      diffError = null;
      diff = null;
      diffSnapshot = null;
      render();
      try {
        const res = await ctx.api.diffSnapshot(id);
        if (destroyed || openId !== id) return;
        diff = res.diff;
        diffSnapshot = res.snapshot;
      } catch (e) {
        if (destroyed || openId !== id) return;
        diffError = e;
      } finally {
        if (!destroyed && openId === id) {
          diffLoading = false;
          render();
        }
      }
    }

    async function restore(snap: SnapshotMeta): Promise<void> {
      const ok = await confirmDanger(ctx, {
        title: '恢复到这个版本？',
        message: `将把「${snap.doc_title}」恢复到 ${formatTime(snap.created_at)}（${SNAPSHOT_REASON_LABELS[snap.reason]}）的内容。\n恢复前会自动为当前版本留一份快照，可以再退回来。`,
        confirmText: '恢复',
        danger: true,
      });
      if (!ok) return;
      try {
        await ctx.actions.restoreSnapshot(snap.id);
        toast(ctx, '已恢复，当前版本已留档', 'ok');
        openId = null;
        diff = null;
        await load();
      } catch (e) {
        toast(ctx, `恢复失败：${errText(e)}`, 'error');
      }
    }

    // 初始化
    render();
    void load();

    return {
      update(state: AppState, changed: Set<keyof AppState>): void {
        if (changed.has('currentDocId') && scope === 'scene') {
          openId = null;
          diff = null;
          void load();
          return;
        }
        if (changed.has('snapshots') && !openId) {
          // 外壳刷新了快照列表，直接采用
          items = [...state.snapshots].sort((a, b) => b.created_at - a.created_at);
          render();
        }
      },
      destroy(): void {
        destroyed = true;
        container.textContent = '';
      },
    };
  },
};
