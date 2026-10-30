/**
 * 弹层系统：toast / 确认框 / 输入框 / 命令面板 / 作品切换。
 *
 * 所有弹层共用一个遮罩栈（#modal-root）：Esc 只关最上面一层，关闭后焦点回到
 * 触发元素 —— 键盘作者不该因为弹了个框就找不到光标。
 */

import type { ProjectSummary } from '../../../shared/types.ts';
import { WORK_MODE_LABELS } from '../../../shared/types.ts';
import type { ToastAction, ToastKind } from '../lib/contracts.ts';
import { fmtNum, h, mount, relativeTime } from '../lib/dom.ts';
import { ICONS } from './shell.ts';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作：确认按钮用红色 */
  danger?: boolean;
  onConfirm?: () => void | Promise<void>;
  onCancel?: () => void;
}

export interface PromptOptions {
  title: string;
  label?: string;
  value?: string;
  placeholder?: string;
  multiline?: boolean;
  confirmText?: string;
  /** 返回 false 表示校验失败，弹层不关 */
  onSubmit?: (value: string) => void | boolean | Promise<void | boolean>;
}

export interface CommandItem {
  id: string;
  title: string;
  /** 分组名，如「文件」「视图」 */
  group?: string;
  hint?: string;
  icon?: string;
  keywords?: string;
  run: () => void | Promise<void>;
}

/** 命令面板里的全书搜索结果行 */
export interface PaletteHit {
  doc_id: string;
  doc_title: string;
  /** scene = 正文场景；entity = 设定条目 */
  kind: 'scene' | 'entity';
  path: string;
  /** 命中片段（含 <mark> 高亮） */
  snippet: string;
  count: number;
}

export interface CommandPaletteOptions {
  items: CommandItem[];
  /** 全文搜索；返回命中的场景 */
  onSearch?: (query: string) => Promise<PaletteHit[]>;
  /** 选中某个命中结果（跳转并定位） */
  onPickHit?: (hit: PaletteHit, query: string) => void | Promise<void>;
}

export interface ProjectSwitchOptions {
  projects: ProjectSummary[];
  currentId: string | null;
  onPick: (id: string) => void;
  onCreate: () => void;
}

export interface OpenModalOptions {
  title?: string;
  width?: number;
  /** 无外框（命令面板这类自带头部的用） */
  bare?: boolean;
  onClose?: () => void;
}

export interface Overlays {
  toast(message: string, kind?: ToastKind, ms?: number, action?: ToastAction): void;
  confirm(opts: ConfirmOptions): Promise<boolean>;
  prompt(opts: PromptOptions): Promise<string | null>;
  commandPalette(opts: CommandPaletteOptions): void;
  projectSwitcher(opts: ProjectSwitchOptions): void;
  /** 通用弹层：kind 由调用方约定，render 负责内容 */
  open(
    kind: string,
    render: (body: HTMLElement, close: () => void) => void,
    opts?: OpenModalOptions,
  ): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

/** 极简模糊匹配：先看子串，再看字符子序列；返回得分，0 表示不匹配 */
function fuzzyScore(text: string, query: string): number {
  if (!query) return 1;
  const t = text.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx * 4 + (idx === 0 ? 200 : 0);
  // 子序列：按匹配跨度与断点数扣分
  let ti = 0;
  let first = -1;
  let last = -1;
  let gaps = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    if (first < 0) first = found;
    if (last >= 0 && found !== last + 1) gaps++;
    last = found;
    ti = found + 1;
  }
  return Math.max(1, 500 - (last - first) * 3 - gaps * 10);
}

interface Layer {
  kind: string;
  overlay: HTMLElement;
  onClose?: () => void;
}

export function createOverlays(opts: { modalRoot: HTMLElement; toastWrap: HTMLElement }): Overlays {
  const layers: Layer[] = [];
  let lastFocus: HTMLElement | null = null;

  // ─────────────── toast ───────────────

  const toast = (
    message: string,
    kind: ToastKind = 'info',
    ms = 2800,
    action?: ToastAction,
  ): void => {
    const iconMap: Record<ToastKind, string> = {
      ok: ICONS.checkCircle,
      warn: ICONS.alert,
      error: ICONS.alert,
      info: ICONS.info,
    };
    const el = h(
      'div',
      { class: `toast ${kind}${action ? ' has-action' : ''}` },
      h('span', { class: 'toast-icon', html: iconMap[kind] }),
      h('span', { class: 'toast-msg' }, message),
      action
        ? h(
            'button',
            {
              class: 'toast-action',
              type: 'button',
              onclick: (ev: MouseEvent) => {
                // 点按钮不能同时触发「点提示关闭」
                ev.stopPropagation();
                clearTimeout(timer);
                leave();
                action.onClick();
              },
            },
            action.label,
          )
        : null,
    );
    opts.toastWrap.appendChild(el);
    const leave = (): void => {
      if (!el.isConnected) return;
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 220);
    };
    const timer = setTimeout(leave, ms);
    el.addEventListener('click', () => {
      clearTimeout(timer);
      leave();
    });
  };

  // ─────────────── 层管理 ───────────────

  const close = (): void => {
    const layer = layers.pop();
    if (!layer) return;
    layer.overlay.remove();
    try {
      layer.onClose?.();
    } catch (err) {
      console.error('[overlays] onClose 异常:', err);
    }
    document.body.classList.toggle('has-overlay', layers.length > 0);
    if (layers.length === 0 && lastFocus?.isConnected) {
      lastFocus.focus({ preventScroll: true });
      lastFocus = null;
    }
  };

  const push = (kind: string, overlay: HTMLElement, onClose?: () => void): void => {
    if (layers.length === 0) {
      lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    layers.push({ kind, overlay, onClose });
    opts.modalRoot.appendChild(overlay);
    document.body.classList.add('has-overlay');
  };

  const open = (
    kind: string,
    render: (body: HTMLElement, closeFn: () => void) => void,
    options: OpenModalOptions = {},
  ): void => {
    const body = h('div', { class: 'modal-body' });
    const closeFn = (): void => close();

    let content: HTMLElement;
    if (options.bare) {
      content = body;
      body.classList.add('modal-body-bare');
    } else {
      const closeBtn = h('button', {
        class: 'icon-btn',
        'aria-label': '关闭',
        title: '关闭（Esc）',
        html: ICONS.x,
        onclick: closeFn,
      });
      content = h(
        'div',
        { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': options.title ?? kind },
        options.title
          ? h('div', { class: 'modal-header' }, h('h2', null, options.title), closeBtn)
          : h('div', { class: 'modal-header modal-header-bare' }, h('span', { class: 'grow' }), closeBtn),
        body,
      );
      if (options.width) content.style.width = `min(${options.width}px, 92vw)`;
      content.tabIndex = -1;
    }

    const overlay = h(
      'div',
      {
        class: 'overlay',
        onmousedown: (ev: MouseEvent) => {
          // 只有点在遮罩本身才关闭：拖选文字时鼠标移出弹框不该误关
          if (ev.target === overlay) closeFn();
        },
      },
      content,
    );

    push(kind, overlay, options.onClose);
    render(body, closeFn);

    requestAnimationFrame(() => {
      const target =
        overlay.querySelector<HTMLElement>('.cmdk-input') ??
        overlay.querySelector<HTMLElement>('.modal-body input, .modal-body textarea') ??
        overlay.querySelector<HTMLElement>('.modal-footer .btn.primary') ??
        content;
      target?.focus({ preventScroll: true });
    });
  };

  // ─────────────── confirm ───────────────

  const confirm = (o: ConfirmOptions): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      open(
        'confirm',
        (body, closeFn) => {
          const okBtn = h('button', { class: `btn ${o.danger ? 'danger' : 'primary'}` }, o.confirmText ?? '确定');
          const cancelBtn = h('button', { class: 'btn' }, o.cancelText ?? '取消');

          const doCancel = (): void => {
            finish(false);
            o.onCancel?.();
            closeFn();
          };
          const doConfirm = async (): Promise<void> => {
            okBtn.disabled = true;
            cancelBtn.disabled = true;
            try {
              await o.onConfirm?.();
              finish(true);
              closeFn();
            } catch (err) {
              toast((err as Error).message || '操作失败', 'error');
              okBtn.disabled = false;
              cancelBtn.disabled = false;
            }
          };

          okBtn.addEventListener('click', () => void doConfirm());
          cancelBtn.addEventListener('click', doCancel);
          body.append(
            h(
              'div',
              { class: `confirm-body${o.danger ? ' danger' : ''}` },
              h('div', { class: 'confirm-mark', html: o.danger ? ICONS.alert : ICONS.info }),
              h(
                'div',
                { class: 'confirm-text' },
                o.message
                  ? h('p', { class: 'confirm-message' }, o.message)
                  : h('p', { class: 'confirm-message muted' }, '此操作需要确认。'),
              ),
            ),
            h('div', { class: 'modal-footer' }, cancelBtn, okBtn),
          );
          requestAnimationFrame(() => okBtn.focus());
        },
        {
          title: o.title,
          width: 460,
          onClose: () => {
            // Esc / 点遮罩关闭 → 按取消处理
            if (!settled) {
              finish(false);
              o.onCancel?.();
            }
          },
        },
      );
    });

  // ─────────────── prompt ───────────────

  const prompt = (o: PromptOptions): Promise<string | null> =>
    new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      open(
        'prompt',
        (body, closeFn) => {
          const input = o.multiline
            ? h('textarea', { class: 'textarea', rows: 4, placeholder: o.placeholder ?? '' })
            : h('input', { class: 'input', type: 'text', placeholder: o.placeholder ?? '' });
          input.value = o.value ?? '';
          const okBtn = h('button', { class: 'btn primary' }, o.confirmText ?? '确定');
          const cancelBtn = h('button', { class: 'btn' }, '取消');
          const errLine = h('div', { class: 'field-error hidden' });

          const submit = async (): Promise<void> => {
            const value = input.value;
            okBtn.disabled = true;
            try {
              if (o.onSubmit) {
                const result = await o.onSubmit(value);
                if (result === false) {
                  errLine.textContent = '内容不合法，请检查后重试';
                  errLine.classList.remove('hidden');
                  okBtn.disabled = false;
                  return;
                }
              }
              finish(value);
              closeFn();
            } catch (err) {
              errLine.textContent = (err as Error).message || '提交失败';
              errLine.classList.remove('hidden');
              okBtn.disabled = false;
            }
          };

          okBtn.addEventListener('click', () => void submit());
          cancelBtn.addEventListener('click', () => {
            finish(null);
            closeFn();
          });
          input.addEventListener('keydown', (ev) => {
            const kev = ev as KeyboardEvent;
            if (kev.key === 'Enter' && !o.multiline && !kev.isComposing) {
              kev.preventDefault();
              void submit();
            }
          });

          body.append(
            h(
              'div',
              { class: 'prompt-body' },
              o.label ? h('label', { class: 'prompt-label' }, o.label) : null,
              input,
              errLine,
            ),
            h('div', { class: 'modal-footer' }, cancelBtn, okBtn),
          );
          requestAnimationFrame(() => {
            input.focus();
            if (input instanceof HTMLInputElement) input.select();
          });
        },
        {
          title: o.title,
          width: 460,
          onClose: () => finish(null),
        },
      );
    });

  // ─────────────── 命令面板 ───────────────

  /**
   * 命令面板。
   *
   * 除了执行命令，还接入了**全书搜索**：
   * 输入正文关键词会同时列出命中的场景，选中即跳转并定位。
   * 早先的版本占位符写着「搜索全书」但实际只过滤命令 —— UI 承诺了没做的事，
   * 作者搜场景名却一无所获，看起来像「点不进去」。
   */
  const commandPalette = (o: CommandPaletteOptions): void => {
    open(
      'command',
      (body, closeFn) => {
        const input = h('input', {
          class: 'cmdk-input',
          type: 'text',
          placeholder: '输入命令名，或输入正文关键词搜索全书…',
          'aria-label': '命令搜索',
          spellcheck: 'false',
        }) as HTMLInputElement;
        const list = h('div', { class: 'cmdk-list' });
        const foot = h(
          'div',
          { class: 'cmdk-foot' },
          h('span', null, h('kbd', null, '↑'), h('kbd', null, '↓'), ' 选择'),
          h('span', null, h('kbd', null, '↵'), ' 执行'),
          h('span', null, h('kbd', null, 'Esc'), ' 关闭'),
        );

        /** 命令匹配结果 */
        let filtered: CommandItem[] = [];
        /** 全书搜索命中的场景 */
        let hits: PaletteHit[] = [];
        /** 当前查询词（跳转定位时要用） */
        let query = '';
        /** 搜索请求序号：丢弃过期响应，避免快速输入时结果错乱 */
        let searchSeq = 0;
        let searchTimer: ReturnType<typeof setTimeout> | null = null;
        let sel = 0;

        /** 统一的行列表：命令在前，搜索结果在后 */
        const rows = (): Array<{ kind: 'cmd'; item: CommandItem } | { kind: 'hit'; hit: PaletteHit }> => [
          ...filtered.map((item) => ({ kind: 'cmd' as const, item })),
          ...hits.map((hit) => ({ kind: 'hit' as const, hit })),
        ];

        /**
         * 只更新选中高亮，不重建 DOM。
         *
         * 早先的实现在 hover 时调用 paint() 整表重建，
         * 正在被点击的那个元素会在 mousedown 与 click 之间被销毁，
         * 于是点击永远落空（实测「点了没反应」）。
         */
        const updateSelection = (): void => {
          for (const node of list.querySelectorAll<HTMLElement>('.cmdk-item')) {
            node.classList.toggle('sel', Number(node.dataset.index) === sel);
          }
          list.querySelector('.cmdk-item.sel')?.scrollIntoView({ block: 'nearest' });
        };

        /** 执行某一行 */
        const activate = (index: number): void => {
          const row = rows()[index];
          if (!row) return;
          closeFn();
          if (row.kind === 'cmd') {
            void row.item.run();
          } else {
            void o.onPickHit?.(row.hit, query);
          }
        };

        const paint = (): void => {
          mount(list);
          const all = rows();

          if (all.length === 0) {
            list.append(
              h(
                'div',
                { class: 'empty' },
                h('span', { html: ICONS.search }),
                h('div', null, query ? '没有匹配的命令或正文' : '没有可用的命令'),
                h('div', { class: 'tiny' }, '换个关键词，或检查作品是否已打开'),
              ),
            );
            return;
          }

          let lastGroup = '';
          all.forEach((row, index) => {
            const group = row.kind === 'cmd' ? (row.item.group ?? '') : '正文';
            if (group && group !== lastGroup) {
              lastGroup = group;
              list.append(h('div', { class: 'cmdk-group' }, group));
            }

            const isCmd = row.kind === 'cmd';
            const icon = isCmd ? row.item.icon : ICONS.file;
            const title = isCmd ? row.item.title : row.hit.doc_title;
            const hint = isCmd ? row.item.hint : row.hit.path;

            list.append(
              h(
                'div',
                {
                  class: `cmdk-item${index === sel ? ' sel' : ''}${isCmd ? '' : ' is-hit'}`,
                  dataset: { index: String(index) },
                  onmouseenter: () => {
                    if (sel === index) return;
                    sel = index;
                    updateSelection();
                  },
                  onclick: (ev: MouseEvent) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    activate(index);
                  },
                },
                icon ? h('span', { class: 'cmdk-icon', html: icon }) : null,
                h(
                  'span',
                  { class: 'cmdk-text' },
                  h('span', { class: 'cmdk-title' }, title),
                  // 搜索结果多一行命中片段，带 <mark> 高亮
                  !isCmd && row.hit.snippet
                    ? h('span', { class: 'cmdk-sub', html: row.hit.snippet })
                    : null,
                ),
                hint ? h('span', { class: 'kbd' }, hint) : null,
              ),
            );
          });
          updateSelection();
        };

        /** 触发全书搜索（防抖，丢弃过期响应） */
        const runSearch = (q: string): void => {
          if (searchTimer) clearTimeout(searchTimer);
          const trimmed = q.trim();
          // 先取到局部变量：闭包里访问 o.onSearch 会丢掉非空窄化
          const searchFn = o.onSearch;

          if (!trimmed || !searchFn) {
            hits = [];
            paint();
            return;
          }

          searchTimer = setTimeout(() => {
            const seq = ++searchSeq;
            void searchFn(trimmed)
              .then((result) => {
                if (seq !== searchSeq) return; // 过期响应，丢弃
                hits = result;
                if (sel >= filtered.length) sel = 0;
                paint();
              })
              .catch(() => {
                if (seq !== searchSeq) return;
                hits = [];
                paint();
              });
          }, 200);
        };

        const refilter = (): void => {
          query = input.value;
          const q = query;
          filtered = o.items
            .map((item) => ({
              item,
              score: Math.max(
                fuzzyScore(item.title, q),
                item.keywords ? fuzzyScore(item.keywords, q) * 0.8 : 0,
                item.group ? fuzzyScore(item.group, q) * 0.4 : 0,
              ),
            }))
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .map((x) => x.item);
          sel = 0;
          runSearch(q);
          paint();
        };

        input.addEventListener('input', refilter);
        input.addEventListener('keydown', (ev) => {
          const kev = ev as KeyboardEvent;
          if (kev.isComposing) return;
          const count = rows().length;
          if (kev.key === 'ArrowDown') {
            kev.preventDefault();
            sel = Math.min(sel + 1, Math.max(0, count - 1));
            updateSelection();
          } else if (kev.key === 'ArrowUp') {
            kev.preventDefault();
            sel = Math.max(sel - 1, 0);
            updateSelection();
          } else if (kev.key === 'Enter') {
            kev.preventDefault();
            activate(sel);
          }
        });

        body.append(h('div', { class: 'cmdk' }, input, list, foot));
        // 初始化：显示全部命令（去掉空查询时的搜索）
        refilter();
        requestAnimationFrame(() => input.focus());
      },
      { bare: true },
    );
  };

  // ─────────────── 作品切换 ───────────────

  const projectSwitcher = (o: ProjectSwitchOptions): void => {
    open(
      'projects',
      (body, closeFn) => {
        const list = h('div', { class: 'project-list' });
        if (o.projects.length === 0) {
          list.append(
            h(
              'div',
              { class: 'empty' },
              h('span', { html: ICONS.book }),
              h('div', null, '还没有任何作品'),
              h('div', { class: 'tiny' }, '新建一个作品开始写作，稿件会保存在本机 data/projects 下'),
            ),
          );
        }
        for (const p of o.projects) {
          const active = p.id === o.currentId;
          list.append(
            h(
              'button',
              {
                class: `project-row${active ? ' active' : ''}`,
                onclick: () => {
                  closeFn();
                  o.onPick(p.id);
                },
              },
              h('span', { class: 'pr-icon', html: ICONS.bookOpen }),
              h(
                'span',
                { class: 'pr-main' },
                h('span', { class: 'pr-title truncate' }, p.title),
                h(
                  'span',
                  { class: 'pr-sub' },
                  `${WORK_MODE_LABELS[p.mode] ?? p.mode} · ${fmtNum(p.word_count)} 字 · ${p.scene_count} 个场景 · ${relativeTime(p.updated_at)}`,
                ),
              ),
              active
                ? h('span', { class: 'badge accent' }, '当前')
                : h('span', { class: 'pr-go', html: ICONS.arrowRight }),
            ),
          );
        }
        body.append(
          list,
          h(
            'div',
            { class: 'modal-footer' },
            h(
              'button',
              {
                class: 'btn primary',
                onclick: () => {
                  closeFn();
                  o.onCreate();
                },
              },
              h('span', { class: 'btn-icon', html: ICONS.plus }),
              '新建作品',
            ),
          ),
        );
      },
      { title: '切换作品', width: 560 },
    );
  };

  // Esc 关闭最上层；捕获阶段拦截，避免同时触发全局快捷键
  const onKeydown = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape' || layers.length === 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    close();
  };
  window.addEventListener('keydown', onKeydown, true);

  return {
    toast,
    confirm,
    prompt,
    commandPalette,
    projectSwitcher,
    open,
    close,
    isOpen: () => layers.length > 0,
    destroy: () => {
      window.removeEventListener('keydown', onKeydown, true);
      while (layers.length) close();
    },
  };
}
