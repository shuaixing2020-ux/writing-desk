/**
 * 搜索面板 —— 全项目正文 / 设定检索。
 *
 * 搜索是这个工具里最高频的「回忆」动作：作者写到一半要确认
 * 「上次那个玉佩叫什么」。所以交互优先：Cmd+Enter 触发、结果即点即到。
 */

import type { PanelContext, PanelDef, PanelInstance } from '../../lib/contracts.ts';
import type { AppState } from '../../lib/store.ts';
import type { SearchHit, SearchResult } from '../../../../shared/types.ts';
import { h, fmtNum } from '../../lib/dom.ts';
import {
  ICONS,
  bigIcon,
  emptyBlock,
  errText,
  loadingBlock,
  panelShell,
  searchField,
  toast,
} from './shared.ts';

type Kind = 'all' | 'scene' | 'entity';

export const panel: PanelDef = {
  id: 'search',
  title: '搜索',
  icon: ICONS.search,
  inInspector: true,

  mount(container: HTMLElement, ctx: PanelContext): PanelInstance {
    let kind: Kind = 'all';
    let lastQuery = '';
    let destroyed = false;
    let seq = 0;
    let result: SearchResult | null = null;
    let loading = false;
    let error: unknown = null;

    const input = searchField({
      placeholder: '搜索正文与设定…',
      onInput: () => {
        /* 输入不即时搜，避免每键一次全库扫描；回车或 Cmd+Enter 触发 */
      },
      onEnter: (v) => void runSearch(v),
    });
    input.setAttribute('aria-label', '搜索关键词');

    // Cmd/Ctrl+Enter 也触发（与全局搜索习惯一致）
    input.addEventListener('keydown', (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
        ev.preventDefault();
        void runSearch(input.value);
      }
    });

    const kindRow = h('div', { class: 'p-chips p-search-kinds' });
    const kinds: Array<{ value: Kind; label: string }> = [
      { value: 'all', label: '全部' },
      { value: 'scene', label: '正文' },
      { value: 'entity', label: '设定' },
    ];
    for (const k of kinds) {
      kindRow.appendChild(
        h(
          'button',
          {
            class: `p-chip${k.value === kind ? ' sel' : ''}`,
            type: 'button',
            onclick: () => {
              kind = k.value;
              for (const el of Array.from(kindRow.children)) el.classList.remove('sel');
              const target = Array.from(kindRow.children).find(
                (el) => (el as HTMLElement).dataset.k === k.value,
              );
              target?.classList.add('sel');
              if (lastQuery) void runSearch(lastQuery);
            },
          },
          k.label,
        ),
      );
      const last = kindRow.lastElementChild as HTMLElement;
      last.dataset.k = k.value;
    }

    const shell = panelShell(container, { toolbar: input });
    shell.body.appendChild(kindRow);

    const resultHost = h('div', { class: 'p-search-results' });
    shell.body.appendChild(resultHost);

    // 搜索面板自己拉取结果，不依赖 store.search（外壳负责 store 是可选路径）
    async function runSearch(raw: string): Promise<void> {
      const q = raw.trim();
      if (!q) {
        lastQuery = '';
        result = null;
        error = null;
        render();
        return;
      }
      lastQuery = q;
      const mySeq = ++seq;
      loading = true;
      error = null;
      render();
      try {
        const res = await ctx.api.search(q, { kind: kind === 'all' ? undefined : kind, limit: 60 });
        if (destroyed || mySeq !== seq) return;
        result = res;
      } catch (err) {
        if (destroyed || mySeq !== seq) return;
        error = err;
        result = null;
      } finally {
        if (!destroyed && mySeq === seq) {
          loading = false;
          render();
        }
      }
    }

    function render(): void {
      if (destroyed) return;
      // 保留滚动位置：翻结果时不要跳回顶部
      const scrollTop = shell.body.scrollTop;

      if (loading) {
        resultHost.textContent = '';
        resultHost.appendChild(loadingBlock('检索中…'));
        return;
      }
      if (error) {
        resultHost.textContent = '';
        resultHost.appendChild(
          h(
            'div',
            { class: 'p-error' },
            h('div', { class: 'p-error-icon', html: ICONS.alert }),
            h('div', { class: 'p-error-msg' }, errText(error)),
            h('button', { class: 'btn sm', type: 'button', onclick: () => void runSearch(lastQuery) }, '重试'),
          ),
        );
        return;
      }
      if (!lastQuery) {
        resultHost.textContent = '';
        resultHost.appendChild(
          emptyBlock({
            icon: bigIcon('<circle cx="7.1" cy="7.1" r="4.1"/><path d="m10.2 10.2 3 3"/>'),
            title: '搜索整本书',
            hint: '输入关键词后按 Enter。搜正文可定位到具体句子，搜设定可找到角色与地点。',
          }),
        );
        return;
      }
      if (!result || result.hits.length === 0) {
        resultHost.textContent = '';
        resultHost.appendChild(
          emptyBlock({
            icon: ICONS.search,
            title: `没有找到「${lastQuery}」`,
            hint: '试试更短的关键词，或切换到「设定」检索条目名与别名。',
          }),
        );
        return;
      }

      const head = h(
        'div',
        { class: 'p-search-head' },
        h('span', null, `${fmtNum(result.total)} 条结果`),
        h('span', { class: 'p-dot-sep', 'aria-hidden': 'true' }),
        h('span', { class: 'mono' }, `${result.took_ms} ms`),
      );

      const list = h('div', { class: 'p-hit-list' });
      for (const hit of result.hits) list.appendChild(renderHit(hit));

      resultHost.textContent = '';
      resultHost.append(head, list);
      shell.body.scrollTop = scrollTop;
    }

    function renderHit(hit: SearchHit): HTMLElement {
      const kindBadge =
        hit.kind === 'entity' ? 'badge accent' : hit.kind === 'note' ? 'badge info' : 'badge';
      const kindText = hit.kind === 'entity' ? '设定' : hit.kind === 'note' ? '笔记' : '正文';

      return h(
        'button',
        {
          class: 'p-hit',
          type: 'button',
          onclick: () => {
            if (hit.kind === 'entity') {
              ctx.actions.jumpToEntity(hit.doc_id);
              return;
            }
            // snippet 里的 <mark> 位置无法精确映射回正文字符偏移，
            // 因此按标题 + 关键词在正文里做一次定位（revealInEditor 支持 0,0 兜底）。
            void (async () => {
              try {
                await ctx.actions.jumpToDoc(hit.doc_id);
                const body = ctx.store.state.scene?.body ?? '';
                const at = body.toLowerCase().indexOf(lastQuery.toLowerCase());
                if (at >= 0) await ctx.actions.revealInEditor(hit.doc_id, at, at + lastQuery.length);
              } catch (e) {
                toast(ctx, errText(e), 'error');
              }
            })();
          },
        },
        h(
          'div',
          { class: 'p-hit-head' },
          h('span', { class: 'p-hit-title truncate' }, hit.doc_title),
          h('span', { class: kindBadge }, kindText),
          h('span', { class: 'p-hit-count mono' }, `${hit.count}`),
        ),
        hit.path ? h('div', { class: 'p-hit-path truncate' }, hit.path) : null,
        // snippet 由服务端转义并插入 <mark>，属于受信任的结构化片段
        h('div', { class: 'p-hit-snippet', html: hit.snippet }),
      );
    }

    render();
    // 打开搜索面板时自动聚焦，省一次点击
    setTimeout(() => input.focus(), 30);

    return {
      update(state: AppState, changed: Set<keyof AppState>): void {
        // 当前场景切换不影响已有结果；若外壳把 store.search 更新了，这里同步一次
        if (!changed.has('search')) return;
        const ext = state.search;
        if (!ext || !lastQuery) return;
        if (ext.query !== lastQuery) return;
        result = ext;
        render();
      },
      destroy(): void {
        destroyed = true;
        container.textContent = '';
      },
    };
  },
};
