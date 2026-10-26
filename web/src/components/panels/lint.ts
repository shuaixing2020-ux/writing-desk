/**
 * 检查面板 —— 当前场景的标点/错别字/重复问题，以及全书检查入口。
 *
 * 设计取舍：默认只检查当前场景。全书检查是后台作业，结果会很大，
 * 300px 放不下；这里给出「检查全书」的入口与进度，结果回落到当前场景视图。
 */

import type { PanelContext, PanelDef, PanelInstance } from '../../lib/contracts.ts';
import type { AppState } from '../../lib/store.ts';
import type { Job, LintIssue, RuleDef, Severity } from '../../../../shared/types.ts';
import { h } from '../../lib/dom.ts';
import {
  ICONS,
  bigIcon,
  emptyBlock,
  errText,
  iconButton,
  loadingBlock,
  panelShell,
  toast,
  toggle,
} from './shared.ts';

const SEVERITY_LABEL: Record<Severity, string> = { error: '错误', warn: '警告', info: '提示' };
const SEVERITY_ORDER: Severity[] = ['error', 'warn', 'info'];

/** 忽略记录：服务端目前没有 lint-ignore 的写接口，先本地持久化，避免刷屏。 */
const IGNORE_KEY = 'writingdesk:lint-ignored';

function ignoreKeyOf(issue: LintIssue): string {
  return `${issue.doc_id ?? ''}|${issue.rule_id}|${issue.text}`;
}

function loadIgnored(): Set<string> {
  try {
    const raw = localStorage.getItem(IGNORE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(arr) ? (arr as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveIgnored(set: Set<string>): void {
  try {
    localStorage.setItem(IGNORE_KEY, JSON.stringify([...set]));
  } catch {
    /* 配额满时忽略：忽略记录不是关键数据 */
  }
}

export const panel: PanelDef = {
  id: 'lint',
  title: '检查',
  icon: ICONS.lint,
  inInspector: true,

  mount(container: HTMLElement, ctx: PanelContext): PanelInstance {
    let destroyed = false;
    let loading = false;
    let error: unknown = null;
    let issues: LintIssue[] = [];
    let ignored = loadIgnored();
    let showIgnored = false;
    let rulesOpen = false;
    let lastDocId: string | null = null;
    let bookJob: Job | null = null;

    const ignoredBtn = iconButton(
      ICONS.filter,
      '显示/隐藏已忽略',
      () => {
        showIgnored = !showIgnored;
        ignoredBtn.classList.toggle('active', showIgnored);
        render();
      },
      { active: showIgnored },
    );

    const shell = panelShell(container, {
      tools: [
        ignoredBtn,
        (() => {
          const btn = iconButton(ICONS.refresh, '重新检查当前场景', () => void runLint());
          return btn;
        })(),
      ],
    });

    const body = h('div', { class: 'p-lint' });
    shell.body.appendChild(body);

    async function runLint(): Promise<void> {
      const docId = ctx.store.state.currentDocId;
      const node = ctx.store.state.nodes.find((n) => n.id === docId);
      if (!docId || !node || node.kind !== 'scene') {
        lastDocId = docId;
        issues = [];
        error = null;
        loading = false;
        render();
        return;
      }
      lastDocId = docId;
      loading = true;
      error = null;
      render();
      try {
        const res = await ctx.api.lintScene(docId);
        if (destroyed) return;
        issues = res.issues;
      } catch (err) {
        if (destroyed) return;
        error = err;
        issues = [];
      } finally {
        if (!destroyed) {
          loading = false;
          render();
        }
      }
    }

    async function runBookLint(): Promise<void> {
      try {
        const job = await ctx.api.lintBook();
        bookJob = job;
        toast(ctx, '全书检查已开始，可在状态栏查看进度', 'info');
        render();
        void ctx.actions.refreshJobs().catch(() => {});
      } catch (e) {
        toast(ctx, `启动全书检查失败：${errText(e)}`, 'error');
      }
    }

    function render(): void {
      if (destroyed) return;
      const state = ctx.store.state;
      const node = state.nodes.find((n) => n.id === state.currentDocId) ?? null;
      const scrollTop = shell.body.scrollTop;
      body.textContent = '';

      // 当前没有选中场景
      if (!node || node.kind !== 'scene') {
        body.appendChild(
          emptyBlock({
            icon: bigIcon('<path d="M8 2.2 14 12.6H2z"/><path d="M8 6.2v2.9"/>'),
            title: '先选中一个场景',
            hint: '检查针对当前场景正文。在左侧选一个场景，或直接开始写。',
          }),
        );
        body.appendChild(renderBookCard());
        body.appendChild(renderRules());
        return;
      }

      body.appendChild(
        h(
          'div',
          { class: 'p-lint-head' },
          h('div', { class: 'p-lint-doc truncate', title: node.title }, node.title),
          h('div', { class: 'p-lint-actions' }, h('span', { class: 'p-muted-note' }, `${node.word_count} 字`)),
        ),
      );

      if (loading) {
        body.appendChild(loadingBlock('检查中…'));
      } else if (error) {
        body.appendChild(
          h(
            'div',
            { class: 'p-error' },
            h('div', { class: 'p-error-icon', html: ICONS.alert }),
            h('div', { class: 'p-error-msg' }, errText(error)),
            h('button', { class: 'btn sm', type: 'button', onclick: () => void runLint() }, '重试'),
          ),
        );
      } else {
        const visible = issues.filter((i) => (showIgnored ? true : !ignored.has(ignoreKeyOf(i))));
        const hiddenCount = issues.length - issues.filter((i) => !ignored.has(ignoreKeyOf(i))).length;

        // 严重程度汇总
        const counts: Record<Severity, number> = { error: 0, warn: 0, info: 0 };
        for (const i of visible) counts[i.severity]++;
        const sum = h('div', { class: 'p-sev-sum' });
        for (const sev of SEVERITY_ORDER) {
          sum.appendChild(
            h(
              'span',
              { class: `p-sev p-sev-${sev}` },
              h('span', { class: 'p-sev-dot' }),
              `${SEVERITY_LABEL[sev]} ${counts[sev]}`,
            ),
          );
        }
        body.appendChild(sum);

        if (visible.length === 0) {
          body.appendChild(
            emptyBlock({
              icon: bigIcon('<path d="m3.2 8.4 3.1 3.1 6.5-7"/>'),
              title: issues.length === 0 ? '这一段很干净' : '没有待处理问题',
              hint:
                issues.length === 0
                  ? '标点、错别字、重复用词都没有明显问题。继续写。'
                  : `已忽略 ${hiddenCount} 条，点右上角筛子图标可查看。`,
            }),
          );
        } else {
          const list = h('div', { class: 'p-issue-list' });
          for (const issue of visible) list.appendChild(renderIssue(issue, node.id));
          body.appendChild(list);
        }
      }

      body.appendChild(renderBookCard());
      body.appendChild(renderRules());
      shell.body.scrollTop = scrollTop;
    }

    function renderIssue(issue: LintIssue, docId: string): HTMLElement {
      const isIgnored = ignored.has(ignoreKeyOf(issue));
      const row = h('div', { class: `p-issue sev-${issue.severity}${isIgnored ? ' ignored' : ''}` });

      const main = h(
        'button',
        {
          class: 'p-issue-main',
          type: 'button',
          title: issue.message,
          onclick: () => {
            void ctx.actions
              .revealInEditor(issue.doc_id ?? docId, issue.from, issue.to)
              .catch((e: unknown) => toast(ctx, errText(e), 'error'));
          },
        },
        h(
          'div',
          { class: 'p-issue-top' },
          h('span', { class: `p-issue-sev sev-${issue.severity}` }, SEVERITY_LABEL[issue.severity]),
          h('span', { class: 'p-issue-rule truncate' }, issue.rule_name),
          issue.fixable ? h('span', { class: 'p-issue-fix' }, '可修') : null,
        ),
        h('div', { class: 'p-issue-text' }, issue.text || '（空白）'),
        h('div', { class: 'p-issue-msg' }, issue.message),
      );

      const ignoreBtn = h(
        'button',
        {
          class: 'p-issue-ignore',
          type: 'button',
          title: isIgnored ? '取消忽略' : '忽略这一条',
          onclick: (ev: MouseEvent) => {
            ev.stopPropagation();
            if (isIgnored) ignored.delete(ignoreKeyOf(issue));
            else ignored.add(ignoreKeyOf(issue));
            saveIgnored(ignored);
            render();
          },
        },
        isIgnored ? '恢复' : '忽略',
      );

      row.append(main, ignoreBtn);
      return row;
    }

    function renderBookCard(): HTMLElement {
      const card = h('div', { class: 'p-card' });
      const running = bookJob && (bookJob.status === 'running' || bookJob.status === 'queued');
      card.appendChild(
        h(
          'div',
          { class: 'p-card-head' },
          h('span', { class: 'p-card-title' }, '全书检查'),
          h('span', { class: 'p-card-sub' }, running ? '进行中' : '后台作业'),
        ),
      );
      card.appendChild(
        h(
          'div',
          { class: 'p-card-text' },
          running
            ? `正在检查全书… ${Math.round((bookJob?.progress ?? 0) * 100)}%`
            : '一次扫描全书，按规则找出跨场景的重复与标点问题。',
        ),
      );
      if (running) {
        card.appendChild(
          h('div', { class: 'p-progress' }, h('div', { class: 'p-progress-fill', style: { width: `${Math.round((bookJob?.progress ?? 0) * 100)}%` } })),
        );
      }
      card.appendChild(
        h(
          'button',
          {
            class: 'btn sm block',
            type: 'button',
            disabled: !!running,
            onclick: () => void runBookLint(),
          },
          running ? '检查进行中…' : '检查全书',
        ),
      );
      return card;
    }

    function renderRules(): HTMLElement {
      const state = ctx.store.state;
      const wrap = h('div', { class: 'p-rules' });
      const head = h(
        'button',
        { class: 'p-collapse-head', type: 'button', onclick: () => { rulesOpen = !rulesOpen; render(); } },
        h('span', { class: `p-collapse-caret${rulesOpen ? ' open' : ''}`, html: ICONS.chevron }),
        h('span', { class: 'p-collapse-title' }, '检查规则'),
        h('span', { class: 'p-collapse-count' }, `${state.rules.filter((r) => r.enabled).length}/${state.rules.length}`),
      );
      wrap.appendChild(head);

      if (!rulesOpen) return wrap;

      if (state.rules.length === 0) {
        wrap.appendChild(
          h(
            'div',
            { class: 'p-card-text' },
            '规则尚未加载。',
            h(
              'button',
              {
                class: 'btn sm',
                type: 'button',
                style: { marginLeft: '6px' },
                onclick: () => void ctx.actions.refreshRules().catch((e: unknown) => toast(ctx, errText(e), 'error')),
              },
              '加载规则',
            ),
          ),
        );
        return wrap;
      }

      const list = h('div', { class: 'p-rule-list' });
      for (const rule of state.rules) list.appendChild(renderRule(rule));
      wrap.appendChild(list);
      return wrap;
    }

    function renderRule(rule: RuleDef): HTMLElement {
      const row = h('div', { class: `p-rule${rule.enabled ? '' : ' off'}` });
      row.appendChild(
        toggle(
          rule.enabled,
          (next) => {
            void (async () => {
              try {
                await ctx.api.updateRule(rule.id, { enabled: next });
                await ctx.actions.refreshRules();
                if (next) void runLint();
                else render();
              } catch (e) {
                toast(ctx, `规则保存失败：${errText(e)}`, 'error');
                render();
              }
            })();
          },
        ),
      );
      row.appendChild(
        h(
          'div',
          { class: 'p-rule-main' },
          h('div', { class: 'p-rule-name' }, rule.name),
          h('div', { class: 'p-rule-desc' }, rule.description),
        ),
      );
      row.appendChild(h('span', { class: `p-rule-sev sev-${rule.severity}` }, SEVERITY_LABEL[rule.severity]));
      return row;
    }

    // 初始化
    render();
    void runLint();
    if (ctx.store.state.rules.length === 0) {
      void ctx.actions.refreshRules().catch(() => {});
    }

    return {
      update(state: AppState, changed: Set<keyof AppState>): void {
        if (changed.has('currentDocId')) {
          issues = [];
          error = null;
          void runLint();
          return;
        }
        if (changed.has('jobs')) {
          const job = [...state.jobs]
            .filter((j) => j.kind === 'book_lint')
            .sort((a, b) => b.created_at - a.created_at)[0];
          if (job) {
            const prev = bookJob;
            bookJob = job;
            if (prev && prev.status !== job.status && job.status === 'done') {
              toast(ctx, '全书检查完成', 'ok');
              void runLint();
            }
            if (prev && prev.status !== job.status && job.status === 'failed') {
              toast(ctx, `全书检查失败：${job.error ?? '未知原因'}`, 'error');
            }
            render();
          }
          return;
        }
        if (changed.has('rules')) {
          render();
          return;
        }
        if (changed.has('scene') && state.scene && state.scene.id === lastDocId) {
          // 保存后内容变化，结果可能过期；不自动重跑，避免打字时反复检查
          return;
        }
      },
      destroy(): void {
        destroyed = true;
        container.textContent = '';
      },
    };
  },
};
