/**
 * 统计面板 —— 目标、打卡与「这本书的形状」。
 *
 * 写作工具最容易劝退的地方是「今天写了多少」看不见。
 * 这里把三件事放一起：今日目标（最需要即时反馈）、近两周趋势（坚持感）、
 * 全书与当前场景的构成（掌控感）。
 */

import type { PanelContext, PanelDef, PanelInstance } from '../../lib/contracts.ts';
import type { AppState } from '../../lib/store.ts';
import type { DailyStat, DocStatus, GoalProgress } from '../../../../shared/types.ts';
import { COUNT_MODE_LABELS, DOC_STATUS_LABELS } from '../../../../shared/types.ts';
import { statusCounts, totalWords } from '../../lib/store.ts';
import { h, fmtNum } from '../../lib/dom.ts';
import { ICONS, emptyBlock, errText, loadingBlock, panelShell, toast } from './shared.ts';

/** 前端即时口径：与 server/util/words.ts 的 hanzi 档一致，只用于当前场景预览 */
function countHanzi(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0x20000 && cp <= 0x2a6df) ||
      (cp >= 0x2a700 && cp <= 0x2ebef) ||
      (cp >= 0x30000 && cp <= 0x3134f)
    ) {
      n++;
    }
  }
  return n;
}

function paragraphsOf(text: string): number {
  return text.split(/\n+/).filter((l) => l.trim().length > 0).length;
}

function dialogueOf(text: string): number {
  return text.split(/\n+/).filter((l) => /^[\s\u3000]*[“"「『]/.test(l)).length;
}

function ring(ratio: number): SVGSVGElement {
  const size = 84;
  const stroke = 7;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, ratio));
  const ns = 'http://www.w3.org/2000/svg';

  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('class', 'p-ring');

  const bg = document.createElementNS(ns, 'circle');
  bg.setAttribute('cx', String(size / 2));
  bg.setAttribute('cy', String(size / 2));
  bg.setAttribute('r', String(r));
  bg.setAttribute('fill', 'none');
  bg.setAttribute('stroke', 'var(--paper-4)');
  bg.setAttribute('stroke-width', String(stroke));
  svg.appendChild(bg);

  const fg = document.createElementNS(ns, 'circle');
  fg.setAttribute('cx', String(size / 2));
  fg.setAttribute('cy', String(size / 2));
  fg.setAttribute('r', String(r));
  fg.setAttribute('fill', 'none');
  fg.setAttribute('stroke', ratio >= 1 ? 'var(--ok)' : 'var(--accent)');
  fg.setAttribute('stroke-width', String(stroke));
  fg.setAttribute('stroke-linecap', 'round');
  fg.setAttribute('stroke-dasharray', `${c * clamped} ${c}`);
  fg.setAttribute('transform', `rotate(-90 ${size / 2} ${size / 2})`);
  fg.setAttribute('class', 'p-ring-fill');
  svg.appendChild(fg);

  return svg;
}

export const panel: PanelDef = {
  id: 'stats',
  title: '统计',
  icon: ICONS.stats,
  inInspector: true,

  mount(container: HTMLElement, ctx: PanelContext): PanelInstance {
    let destroyed = false;
    let loading = false;
    let error: unknown = null;
    let goal: GoalProgress | null = ctx.store.state.goal;

    const shell = panelShell(container);
    const body = h('div', { class: 'p-stats' });
    shell.body.appendChild(body);

    async function load(): Promise<void> {
      if (destroyed) return;
      loading = true;
      error = null;
      render();
      try {
        const g = await ctx.api.getGoal();
        if (destroyed) return;
        goal = g;
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

    function render(): void {
      if (destroyed) return;
      const state = ctx.store.state;
      const scrollTop = shell.body.scrollTop;
      body.textContent = '';

      if (loading && !goal) {
        body.appendChild(loadingBlock('统计中…'));
        return;
      }
      if (error && !goal) {
        body.appendChild(
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

      const mode = state.project?.count_mode ?? 'hanzi';
      const g = goal;
      const total = g?.total_words ?? totalWords(state);
      const scenes = state.nodes.filter((n) => n.kind === 'scene').length;

      // ── 今日目标 ──
      const written = g?.written ?? 0;
      const goalWords = g?.goal ?? state.project?.daily_goal ?? 3000;
      const ratio = g?.ratio ?? (goalWords > 0 ? written / goalWords : 0);

      const goalCard = h('div', { class: 'p-goal' });
      goalCard.appendChild(ring(ratio));
      goalCard.appendChild(
        h(
          'div',
          { class: 'p-goal-info' },
          h('div', { class: 'p-goal-label' }, '今日进度'),
          h(
            'div',
            { class: 'p-goal-num' },
            h('span', { class: 'mono' }, fmtNum(written)),
            h('span', { class: 'p-goal-of' }, ` / ${fmtNum(goalWords)} 字`),
          ),
          h(
            'div',
            { class: 'p-goal-sub' },
            ratio >= 1 ? '目标达成，收工也安心' : `还差 ${fmtNum(Math.max(0, goalWords - written))} 字`,
          ),
          h(
            'div',
            { class: 'p-goal-streak' },
            h('span', { class: 'p-streak-icon', html: ICONS.target }),
            h('span', null, g?.streak ? `连续写作 ${g.streak} 天` : '今天开个头，连击从 1 开始'),
          ),
        ),
      );
      body.appendChild(goalCard);

      // ── 近 14 天 ──
      body.appendChild(h('div', { class: 'p-group-title' }, h('span', null, '近 14 天'), h('span', { class: 'p-group-n' }, '每日字数')));
      body.appendChild(renderBars(g?.recent ?? []));

      // ── 全书 ──
      body.appendChild(h('div', { class: 'p-group-title' }, h('span', null, '全书'), h('span', { class: 'p-group-n' }, COUNT_MODE_LABELS[mode])));
      const kpi = h('div', { class: 'p-kpi-grid' });
      kpi.appendChild(kpiCell('总字数', fmtNum(total), mode === 'hanzi' ? '汉字' : '按当前口径'));
      kpi.appendChild(kpiCell('场景', fmtNum(scenes), '可独立编辑'));
      kpi.appendChild(kpiCell('章节', fmtNum(state.nodes.filter((n) => n.kind === 'chapter').length), ''));
      kpi.appendChild(kpiCell('卷', fmtNum(state.nodes.filter((n) => n.kind === 'volume').length), ''));
      body.appendChild(kpi);

      // ── 状态分布 ──
      const counts = statusCounts(state);
      const sceneTotal = Object.values(counts).reduce((a, b) => a + b, 0);
      if (sceneTotal > 0) {
        const dist = h('div', { class: 'p-dist' });
        const bar = h('div', { class: 'p-dist-bar' });
        for (const st of ['idea', 'draft', 'revising', 'final', 'published'] as DocStatus[]) {
          const n = counts[st];
          if (!n) continue;
          bar.appendChild(
            h('span', {
              class: `p-dist-seg st-${st}`,
              style: { width: `${(n / sceneTotal) * 100}%` },
              title: `${DOC_STATUS_LABELS[st]} ${n}`,
            }),
          );
        }
        dist.appendChild(bar);
        const legend = h('div', { class: 'p-dist-legend' });
        for (const st of ['idea', 'draft', 'revising', 'final', 'published'] as DocStatus[]) {
          const n = counts[st];
          if (!n) continue;
          legend.appendChild(
            h(
              'span',
              { class: 'p-dist-item' },
              h('span', { class: `p-dist-dot st-${st}` }),
              `${DOC_STATUS_LABELS[st]} ${n}`,
            ),
          );
        }
        dist.appendChild(legend);
        body.appendChild(dist);
      } else {
        body.appendChild(
          emptyBlock({
            icon: ICONS.stats,
            title: '还没有场景',
            hint: '建一个场景开始写，这里会显示状态分布。',
          }),
        );
      }

      // ── 当前场景 ──
      const cur = state.nodes.find((n) => n.id === state.currentDocId);
      if (cur && cur.kind === 'scene') {
        const text = state.scene?.id === cur.id ? state.scene.body : '';
        const paras = paragraphsOf(text);
        const dialogs = dialogueOf(text);
        body.appendChild(h('div', { class: 'p-group-title' }, h('span', null, '当前场景'), h('span', { class: 'p-group-n truncate' }, cur.title)));
        const sceneKpi = h('div', { class: 'p-kpi-grid' });
        sceneKpi.appendChild(kpiCell('字数', fmtNum(cur.word_count), text ? `即时 ${fmtNum(countHanzi(text))}` : '已保存'));
        sceneKpi.appendChild(kpiCell('段落', fmtNum(paras), '非空行'));
        sceneKpi.appendChild(kpiCell('对白', paras ? `${Math.round((dialogs / paras) * 100)}%` : '—', `${dialogs} 段`));
        sceneKpi.appendChild(kpiCell('状态', DOC_STATUS_LABELS[cur.status], ''));
        body.appendChild(sceneKpi);
      }

      // 底部刷新
      body.appendChild(
        h(
          'div',
          { class: 'p-stats-foot' },
          h(
            'button',
            {
              class: 'btn sm ghost',
              type: 'button',
              onclick: () => {
                void load();
                void ctx.actions.refreshGoal().catch(() => {});
              },
            },
            '刷新统计',
          ),
        ),
      );

      shell.body.scrollTop = scrollTop;
    }

    function kpiCell(label: string, value: string, sub: string): HTMLElement {
      return h(
        'div',
        { class: 'p-kpi' },
        h('div', { class: 'p-kpi-value mono' }, value),
        h('div', { class: 'p-kpi-label' }, label),
        sub ? h('div', { class: 'p-kpi-sub truncate' }, sub) : null,
      );
    }

    function renderBars(recent: DailyStat[]): HTMLElement {
      // 补齐 14 天（服务端可能只返回有记录的天）
      const byDate = new Map(recent.map((d) => [d.date, d]));
      const days: DailyStat[] = [];
      const today = new Date();
      for (let i = 13; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        days.push(byDate.get(key) ?? { date: key, words: 0, seconds: 0 });
      }
      const max = Math.max(1, ...days.map((d) => d.words));
      const goalWords = goal?.goal ?? ctx.store.state.project?.daily_goal ?? 3000;
      const goalLine = Math.min(1, goalWords / max);

      const wrap = h('div', { class: 'p-bars' });
      const chart = h('div', { class: 'p-bars-chart' });
      if (goalWords > 0 && goalWords <= max) {
        chart.appendChild(h('div', { class: 'p-bars-goal', style: { bottom: `${goalLine * 100}%` } }));
      }
      for (const d of days) {
        const hPct = (d.words / max) * 100;
        const isToday = d === days[days.length - 1];
        const bar = h('div', {
          class: `p-bar${d.words === 0 ? ' zero' : ''}${isToday ? ' today' : ''}${d.words >= goalWords && goalWords > 0 ? ' hit' : ''}`,
          style: { height: `${Math.max(d.words > 0 ? 4 : 2, hPct)}%` },
          title: `${d.date} · ${fmtNum(d.words)} 字`,
        });
        chart.appendChild(bar);
      }
      wrap.appendChild(chart);

      const axis = h('div', { class: 'p-bars-axis' });
      for (const d of days) {
        const dayNum = Number(d.date.slice(8, 10));
        axis.appendChild(
          h('span', { class: `p-bars-tick${d === days[days.length - 1] ? ' today' : ''}` }, dayNum % 2 === 1 ? String(dayNum) : ''),
        );
      }
      wrap.appendChild(axis);

      const sum = days.reduce((s, d) => s + d.words, 0);
      const activeDays = days.filter((d) => d.words > 0).length;
      wrap.appendChild(
        h(
          'div',
          { class: 'p-bars-sum' },
          h('span', null, `14 天 ${fmtNum(sum)} 字`),
          h('span', { class: 'p-dot-sep', 'aria-hidden': 'true' }),
          h('span', null, `写作 ${activeDays} 天`),
        ),
      );
      return wrap;
    }

    render();
    void load();

    return {
      update(state: AppState, changed: Set<keyof AppState>): void {
        if (changed.has('goal')) {
          goal = state.goal;
          render();
          return;
        }
        if (changed.has('nodes') || changed.has('currentDocId') || changed.has('scene')) {
          // 字数变化频繁，用轻量渲染即可（这里整体重绘，面板内容有限）
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
