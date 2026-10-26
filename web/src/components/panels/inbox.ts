/**
 * 灵感箱 —— 写作时的「碎片暂存」。
 *
 * 为什么单独一个面板：作者经常有半句话、一个意象、一个转折点，
 * 它们不属于任何章节。强行让作者先归类再记录，最后就是记不下来。
 * 所以这里只有一个输入框，Enter 即存，不打断。
 */

import type { PanelContext, PanelDef, PanelInstance } from '../../lib/contracts.ts';
import type { AppState } from '../../lib/store.ts';
import { h, relativeTime, formatTime } from '../../lib/dom.ts';
import {
  ICONS,
  bigIcon,
  emptyBlock,
  errText,
  loadingBlock,
  panelShell,
  confirmDanger,
  toast,
} from './shared.ts';

interface InboxEntry {
  id: string;
  text: string;
  created_at: number;
}

export const panel: PanelDef = {
  id: 'inbox',
  title: '灵感箱',
  icon: ICONS.inbox,
  inInspector: true,

  mount(container: HTMLElement, ctx: PanelContext): PanelInstance {
    let destroyed = false;
    let loading = false;
    let error: unknown = null;
    let items: InboxEntry[] = [];
    let saving = false;

    const input = h('textarea', {
      class: 'textarea p-inbox-input',
      rows: 2,
      placeholder: '记一句灵感，Enter 保存（Shift+Enter 换行）',
      spellcheck: false,
    }) as HTMLTextAreaElement;

    const saveBtn = h('button', { class: 'btn sm primary', type: 'button', onclick: () => void submit() }, '记下');

    const composer = h('div', { class: 'p-inbox-composer' }, input, h('div', { class: 'p-inbox-bar' }, h('span', { class: 'p-inbox-hint' }, '不分类，先存下'), saveBtn));

    const shell = panelShell(container, { toolbar: composer });
    const listHost = h('div', { class: 'p-inbox-list' });
    shell.body.appendChild(listHost);

    // 输入框随内容增高（最多 6 行，再高就内部滚动）
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        void submit();
      }
    });

    async function submit(): Promise<void> {
      const text = input.value.trim();
      if (!text || saving) return;
      saving = true;
      saveBtn.disabled = true;
      try {
        await ctx.actions.addInbox(text);
        input.value = '';
        input.style.height = 'auto';
        await load();
        input.focus();
      } catch (e) {
        toast(ctx, `保存失败：${errText(e)}`, 'error');
      } finally {
        saving = false;
        saveBtn.disabled = false;
      }
    }

    async function load(): Promise<void> {
      if (destroyed) return;
      loading = true;
      error = null;
      render();
      try {
        const list = await ctx.api.listInbox();
        if (destroyed) return;
        items = [...list].sort((a, b) => b.created_at - a.created_at);
      } catch (e) {
        if (destroyed) return;
        error = e;
      } finally {
        if (!destroyed) {
          loading = false;
          render();
        }
      }
    }

    async function remove(entry: InboxEntry): Promise<void> {
      const ok = await confirmDanger(ctx, {
        title: '删除这条灵感？',
        message: entry.text.length > 60 ? `${entry.text.slice(0, 60)}…` : entry.text,
        confirmText: '删除',
      });
      if (!ok) return;
      try {
        await ctx.api.deleteInbox(entry.id);
        items = items.filter((i) => i.id !== entry.id);
        render();
        toast(ctx, '已删除', 'ok');
      } catch (e) {
        toast(ctx, `删除失败：${errText(e)}`, 'error');
      }
    }

    function render(): void {
      if (destroyed) return;
      const scrollTop = shell.body.scrollTop;

      if (loading && items.length === 0) {
        listHost.textContent = '';
        listHost.appendChild(loadingBlock('读取灵感箱…'));
        return;
      }
      if (error && items.length === 0) {
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
            icon: bigIcon('<path d="M2.4 8.6 4 3.2h8l1.6 5.4v3.4a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1z"/>'),
            title: '灵感箱是空的',
            hint: '想到什么先记下来——一句对话、一个场景、一个转折。不用分类，回头再整理。',
          }),
        );
        return;
      }

      listHost.textContent = '';
      for (const entry of items) listHost.appendChild(renderEntry(entry));
      shell.body.scrollTop = scrollTop;
    }

    function renderEntry(entry: InboxEntry): HTMLElement {
      const row = h('div', { class: 'p-inbox-item' });
      row.appendChild(
        h(
          'div',
          { class: 'p-inbox-text' },
          // 保留换行的纯文本，绝不用 innerHTML
          ...entry.text.split('\n').flatMap((line, i) => (i === 0 ? [line] : [h('br'), line])),
        ),
      );
      row.appendChild(
        h(
          'div',
          { class: 'p-inbox-meta' },
          h('span', { class: 'p-inbox-time', title: formatTime(entry.created_at) }, relativeTime(entry.created_at)),
          h(
            'button',
            {
              class: 'p-inbox-del',
              type: 'button',
              title: '删除',
              'aria-label': '删除这条灵感',
              onclick: () => void remove(entry),
            },
            h('span', { html: ICONS.trash }),
          ),
        ),
      );
      return row;
    }

    render();
    void load();
    setTimeout(() => input.focus(), 30);

    return {
      update(_state: AppState, _changed: Set<keyof AppState>): void {
        // 灵感箱的数据不经过全局 store，面板自己维护；无状态需要响应。
      },
      destroy(): void {
        destroyed = true;
        container.textContent = '';
      },
    };
  },
};
