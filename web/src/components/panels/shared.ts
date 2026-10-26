/**
 * 面板公共层 —— 8 个面板共用的骨架、图标、三态与控件。
 *
 * 为什么要抽这一层：右侧栏 300px，8 个面板如果各自实现标题栏/滚动区/
 * 加载态，样式与交互会立刻散掉。统一在这里定义，面板只关心业务内容。
 *
 * 面板容器契约（与 app.ts 约定）：
 *   - mount() 拿到的 container 高度确定，面板内部自己滚动；
 *   - 面板根节点固定 class="panel"，子结构为 header / body / footer。
 */

import type { PanelContext, ToastKind } from '../../lib/contracts.ts';
import { h, mount } from '../../lib/dom.ts';

// ─────────────────────────── 图标 ───────────────────────────

/** 统一图标外壳：16×16、stroke 风格、currentColor */
function svg(paths: string, opts: { size?: number; viewBox?: string } = {}): string {
  const size = opts.size ?? 16;
  return (
    `<svg width="${size}" height="${size}" viewBox="${opts.viewBox ?? '0 0 16 16'}" ` +
    `fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
  );
}

export const ICONS = {
  outline: svg('<path d="M3 3.5h10M3 8h10M3 12.5h6"/><circle cx="13" cy="12.5" r="1.1"/>'),
  bible: svg(
    '<path d="M3.2 2.8h6.4a2 2 0 0 1 2 2v8.4H5.2a2 2 0 0 1-2-2z"/><path d="M5.4 5.6h4.2M5.4 8.2h4.2"/>',
  ),
  search: svg('<circle cx="7.1" cy="7.1" r="4.1"/><path d="m10.2 10.2 3 3"/>'),
  lint: svg('<path d="M8 2.2 14 12.6H2z"/><path d="M8 6.2v2.9"/><circle cx="8" cy="11" r=".65" fill="currentColor" stroke="none"/>'),
  snapshots: svg('<path d="M8 4.1V8l2.5 1.6"/><path d="M13.6 8a5.6 5.6 0 1 1-2-4.3"/><path d="M13.8 2.4v3.4h-3.4"/>'),
  stats: svg('<path d="M2.6 13.4V9.2M6.2 13.4V5.6M9.8 13.4V7.4M13.4 13.4V3.2"/>'),
  inbox: svg('<path d="M2.4 8.6 4 3.2h8l1.6 5.4v3.4a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1z"/><path d="M2.4 8.6h3.2l.9 1.6h3l.9-1.6h3.2"/>'),
  settings: svg(
    '<circle cx="8" cy="8" r="2.1"/><path d="M8 2.2v1.5M8 12.3v1.5M2.2 8h1.5M12.3 8h1.5M3.9 3.9l1 1M11.1 11.1l1 1M12.1 3.9l-1 1M4.9 11.1l-1 1"/>',
  ),
  plus: svg('<path d="M8 3.2v9.6M3.2 8h9.6"/>'),
  close: svg('<path d="m4 4 8 8M12 4l-8 8"/>'),
  check: svg('<path d="m3.2 8.4 3.1 3.1 6.5-7"/>'),
  trash: svg('<path d="M3.2 4.6h9.6M6.2 4.6V3.2h3.6v1.4M4.6 4.6l.6 8.2h5.6l.6-8.2"/>'),
  refresh: svg('<path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.8"/><path d="M13.4 2.6v3.6H9.8"/>'),
  chevron: svg('<path d="m6 4 4 4-4 4"/>'),
  chevronDown: svg('<path d="m4 6 4 4 4-4"/>'),
  external: svg('<path d="M9.4 3h3.6v3.6M13 3 7.2 8.8"/><path d="M12 9.6v3a.8.8 0 0 1-.8.8H3.8a.8.8 0 0 1-.8-.8V5.2a.8.8 0 0 1 .8-.8h3"/>'),
  alert: svg('<circle cx="8" cy="8" r="5.6"/><path d="M8 5.2v3.4"/><circle cx="8" cy="10.8" r=".65" fill="currentColor" stroke="none"/>'),
  edit: svg('<path d="M11.1 2.9 13 4.8 5.6 12.2H3.7v-1.9z"/>'),
  arrowRight: svg('<path d="M3.2 8h9.2M9 4.6 12.4 8 9 11.4"/>'),
  download: svg('<path d="M8 3v7M5.2 7.6 8 10.4l2.8-2.8M3.2 12.6h9.6"/>'),
  upload: svg('<path d="M8 10.2V3M5.2 5.8 8 3l2.8 2.8M3.2 12.6h9.6"/>'),
  target: svg('<circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="2.4"/><circle cx="8" cy="8" r=".6" fill="currentColor" stroke="none"/>'),
  clock: svg('<circle cx="8" cy="8" r="5.6"/><path d="M8 4.8V8l2.2 1.4"/>'),
  book: svg('<path d="M2.8 3.2h4a1.6 1.6 0 0 1 1.6 1.6v8.4a1.2 1.2 0 0 0-1.2-1.2H2.8z"/><path d="M13.2 3.2h-4A1.6 1.6 0 0 0 7.6 4.8v8.4a1.2 1.2 0 0 1 1.2-1.2h4.4z"/>'),
  filter: svg('<path d="M2.6 3.4h10.8L9.3 8.2v4.2l-2.6 1.2V8.2z"/>'),
  quote: svg('<path d="M6.2 4.4C4.4 5.2 3.4 6.6 3.4 8.4M6.2 8.6c0 1-.6 1.6-1.4 1.6s-1.4-.6-1.4-1.5.6-1.5 1.4-1.5c.5 0 .9.2 1.1.6"/><path d="M12.8 4.4c-1.8.8-2.8 2.2-2.8 4M12.8 8.6c0 1-.6 1.6-1.4 1.6s-1.4-.6-1.4-1.5.6-1.5 1.4-1.5c.5 0 .9.2 1.1.6"/>'),
  pin: svg('<path d="M6.2 2.6h3.6l-.5 3.4 2 2.2H4.7l2-2.2z"/><path d="M8 8.2v5.2"/>'),
  layers: svg('<path d="m8 2.4 5.4 2.8L8 8 2.6 5.2z"/><path d="m2.6 8.4 5.4 2.8 5.4-2.8"/>'),
  minus: svg('<path d="M3.2 8h9.6"/>'),
} as const;

/** 空状态用的大图标 */
export function bigIcon(paths: string): string {
  return svg(paths, { size: 30 });
}

// ─────────────────────────── 面板骨架 ───────────────────────────

export interface PanelShell {
  /** 面板根节点，塞进 container */
  root: HTMLElement;
  /** 顶部工具条（搜索框、+ 按钮等；标题由外壳渲染，这里不放标题） */
  toolbar: HTMLElement;
  /** 内容区（面板自己滚动） */
  body: HTMLElement;
  /** 底部固定操作区（可不用） */
  footer: HTMLElement;
}

/**
 * 构建面板骨架。
 *
 * 标题与图标由外壳的 .inspector-head 渲染（已与 web-shell 对齐），
 * 面板内部从工具条/内容开始，避免出现两行标题。
 */
export function panelShell(
  container: HTMLElement,
  opts: { tools?: HTMLElement[]; toolbar?: HTMLElement } = {},
): PanelShell {
  container.textContent = '';
  const root = h('div', { class: 'panel' });

  const toolbar = h('div', { class: 'panel-toolbar' });
  if (opts.toolbar) toolbar.appendChild(opts.toolbar);
  if (opts.tools?.length) {
    const actions = h('div', { class: 'panel-toolbar-actions' });
    for (const t of opts.tools) actions.appendChild(t);
    toolbar.appendChild(actions);
  }
  toolbar.hidden = !opts.toolbar && !opts.tools?.length;

  const body = h('div', { class: 'panel-body' });
  const footer = h('div', { class: 'panel-foot' });
  footer.hidden = true;

  root.append(toolbar, body, footer);
  container.appendChild(root);

  return { root, toolbar, body, footer };
}

/** 面板内的分组标题 */
export function sectionTitle(text: string, opts: { hint?: string } = {}): HTMLElement {
  return h(
    'div',
    { class: 'p-section' },
    h('span', { class: 'p-section-name' }, text),
    opts.hint ? h('span', { class: 'p-section-hint' }, opts.hint) : null,
  );
}

// ─────────────────────────── 三态 ───────────────────────────

/** 加载态（占位，不打断已有内容时用 .p-loading-inline） */
export function loadingBlock(text = '加载中…'): HTMLElement {
  return h('div', { class: 'p-loading' }, h('span', { class: 'spinner' }), h('span', null, text));
}

/** 空状态：图标 + 主文案 + 引导 */
export function emptyBlock(opts: {
  icon?: string;
  title: string;
  hint?: string;
  action?: { label: string; onClick: () => void };
}): HTMLElement {
  const el = h(
    'div',
    { class: 'p-empty' },
    opts.icon ? h('div', { class: 'p-empty-icon', html: opts.icon }) : null,
    h('div', { class: 'p-empty-title' }, opts.title),
    opts.hint ? h('div', { class: 'p-empty-hint' }, opts.hint) : null,
  );
  if (opts.action) {
    el.appendChild(
      h('button', { class: 'btn sm', type: 'button', onclick: opts.action.onClick }, opts.action.label),
    );
  }
  return el;
}

/** 错误态：信息 + 重试 */
export function errorBlock(err: unknown, onRetry?: () => void): HTMLElement {
  const msg = err instanceof Error ? err.message : String(err ?? '未知错误');
  const el = h(
    'div',
    { class: 'p-error' },
    h('div', { class: 'p-error-icon', html: ICONS.alert }),
    h('div', { class: 'p-error-msg' }, msg),
  );
  if (onRetry) {
    el.appendChild(h('button', { class: 'btn sm', type: 'button', onclick: onRetry }, '重试'));
  }
  return el;
}

/**
 * 异步渲染助手：统一处理 loading / error / empty，杜绝白屏。
 * 面板各自保存一个 render 序号，避免过期响应覆盖新结果。
 */
export async function renderAsync(
  host: HTMLElement,
  task: () => Promise<HTMLElement | null>,
  opts: { loading?: string; onRetry?: () => void } = {},
): Promise<void> {
  host.textContent = '';
  host.appendChild(loadingBlock(opts.loading));
  try {
    const content = await task();
    if (!content) {
      host.textContent = '';
      return;
    }
    host.textContent = '';
    host.appendChild(content);
  } catch (err) {
    host.textContent = '';
    host.appendChild(errorBlock(err, opts.onRetry));
  }
}

// ─────────────────────────── 通用控件 ───────────────────────────

/** 图标按钮 */
export function iconButton(
  svgMarkup: string,
  title: string,
  onClick: (ev: MouseEvent) => void,
  opts: { active?: boolean; cls?: string } = {},
): HTMLButtonElement {
  const btn = h('button', {
    class: `icon-btn${opts.active ? ' active' : ''}${opts.cls ? ` ${opts.cls}` : ''}`,
    type: 'button',
    title,
    'aria-label': title,
    onclick: onClick,
  });
  btn.innerHTML = svgMarkup;
  return btn;
}

/** 文本按钮 */
export function textButton(
  label: string,
  onClick: (ev: MouseEvent) => void,
  opts: { cls?: string; title?: string } = {},
): HTMLButtonElement {
  return h(
    'button',
    {
      class: `btn sm${opts.cls ? ` ${opts.cls}` : ''}`,
      type: 'button',
      title: opts.title ?? null,
      onclick: onClick,
    },
    label,
  );
}

/** 开关（checkbox 伪装成轨道） */
export function toggle(
  checked: boolean,
  onChange: (next: boolean) => void,
  opts: { label?: string; disabled?: boolean } = {},
): HTMLElement {
  const input = h('input', {
    type: 'checkbox',
    class: 'p-switch-input',
    checked,
    disabled: opts.disabled ?? false,
  }) as HTMLInputElement;
  input.addEventListener('change', () => onChange(input.checked));
  return h(
    'label',
    { class: 'p-switch' },
    input,
    h('span', { class: 'p-switch-track', 'aria-hidden': 'true' }),
    opts.label ? h('span', { class: 'p-switch-label' }, opts.label) : null,
  );
}

/** 设置行：左标签/说明 + 右控件 */
export function settingRow(
  label: string,
  control: HTMLElement,
  opts: { hint?: string; cls?: string } = {},
): HTMLElement {
  return h(
    'div',
    { class: `p-set-row${opts.cls ? ` ${opts.cls}` : ''}` },
    h(
      'div',
      { class: 'p-set-label' },
      h('div', { class: 'p-set-name' }, label),
      opts.hint ? h('div', { class: 'p-set-hint' }, opts.hint) : null,
    ),
    h('div', { class: 'p-set-ctrl' }, control),
  );
}

/** 滑块 + 数值显示 */
export function slider(opts: {
  min: number;
  max: number;
  step: number;
  value: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}): HTMLElement {
  const fmt = opts.format ?? ((v: number) => String(v));
  const out = h('span', { class: 'p-slider-val mono' }, fmt(opts.value));
  const input = h('input', {
    type: 'range',
    class: 'p-slider',
    min: opts.min,
    max: opts.max,
    step: opts.step,
    value: opts.value,
  }) as HTMLInputElement;
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    opts.onChange(v);
  });
  return h('div', { class: 'p-slider-wrap' }, input, out);
}

/** 分段选择器（少数几个互斥选项） */
export function segmented<T extends string>(
  options: Array<{ value: T; label: string; title?: string }>,
  current: T,
  onChange: (v: T) => void,
): HTMLElement {
  const wrap = h('div', { class: 'p-seg', role: 'group' });
  for (const opt of options) {
    wrap.appendChild(
      h(
        'button',
        {
          class: `p-seg-item${opt.value === current ? ' sel' : ''}`,
          type: 'button',
          title: opt.title ?? null,
          onclick: () => {
            for (const el of Array.from(wrap.children)) el.classList.remove('sel');
            const target = wrap.querySelector(`[data-v="${CSS.escape(opt.value)}"]`);
            target?.classList.add('sel');
            onChange(opt.value);
          },
        },
        opt.label,
      ),
    );
    const last = wrap.lastElementChild as HTMLElement;
    last.dataset.v = opt.value;
  }
  return wrap;
}

/** 搜索输入（带清除） */
export function searchField(opts: {
  placeholder: string;
  value?: string;
  onInput: (v: string) => void;
  onEnter?: (v: string) => void;
}): HTMLInputElement {
  const input = h('input', {
    class: 'input p-search-input',
    type: 'search',
    placeholder: opts.placeholder,
    value: opts.value ?? '',
  }) as HTMLInputElement;
  input.addEventListener('input', () => opts.onInput(input.value));
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      opts.onEnter?.(input.value);
    }
  });
  return input;
}

// ─────────────────────────── 确认与提示 ───────────────────────────

/**
 * 危险操作二次确认。
 *
 * 走外壳的 ctx.openOverlay('confirm', payload)，payload 形状已与 web-shell 对齐：
 *   { title, message, confirmText, cancelText, danger, onConfirm, onCancel }
 * 兜底：若外壳尚未实现该弹层（#modal-root 下一帧仍为空），退回 window.confirm，
 * 保证「危险操作必须二次确认」这条红线不因并行开发时序而失效。
 */
export function confirmDanger(
  ctx: PanelContext,
  opts: { title: string; message: string; confirmText?: string; cancelText?: string; danger?: boolean },
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const fallback = () => {
      const text = `${opts.title}\n\n${opts.message}${opts.danger === false ? '' : '\n\n此操作不可撤销。'}`;
      finish(window.confirm(text));
    };

    try {
      ctx.openOverlay('confirm', {
        title: opts.title,
        message: opts.message,
        confirmText: opts.confirmText ?? '确定',
        cancelText: opts.cancelText ?? '取消',
        danger: opts.danger ?? true,
        onConfirm: () => finish(true),
        onCancel: () => finish(false),
      });
    } catch {
      fallback();
      return;
    }

    // 能力探测：外壳通常同步渲染弹层。这里给两段宽限（下一帧 + 120ms），
    // 只有两次都没看到弹层内容才判定「外壳尚未实现」，避免与外壳弹层叠加出现双确认。
    const probe = (attempt: number) => {
      if (settled) return;
      const root = document.getElementById('modal-root');
      if (root && root.childElementCount > 0) return;
      if (attempt === 0) {
        setTimeout(() => probe(1), 120);
        return;
      }
      fallback();
    };
    requestAnimationFrame(() => probe(0));

    // 极端情况下（弹层被外部关闭却没回传）不让调用方永远挂起
    setTimeout(() => finish(false), 10 * 60 * 1000);
  });
}

/** 简易提示：统一走 ctx.toast，异常时静默（提示失败不该再抛错） */
export function toast(ctx: PanelContext, message: string, kind: ToastKind = 'info'): void {
  try {
    ctx.toast(message, kind);
  } catch {
    /* ignore */
  }
}

/** 从错误里取可读信息 */
export function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? '未知错误');
}

// ─────────────────────────── 小工具 ───────────────────────────

/** 安全 HTML（只用于服务端返回的、已转义片段，如搜索 snippet） */
export function htmlBlock(html: string, cls: string): HTMLElement {
  return h('span', { class: cls, html });
}

/** 字节数可读化 */
export function fmtBytes(n: number): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 字数可读化（超过 1 万显示 x.x 万） */
export function fmtWords(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
  return n.toLocaleString('zh-CN');
}

/** 百分比 */
export function pct(ratio: number): string {
  return `${Math.round(Math.max(0, ratio) * 100)}%`;
}

/** YYYY-MM-DD（本地时区） */
export function dateKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 可复用的请求序号守卫，避免慢响应覆盖新 UI */
export function token(): { next: () => number; isCurrent: (n: number) => boolean } {
  let cur = 0;
  return {
    next: () => ++cur,
    isCurrent: (n: number) => n === cur,
  };
}

/** 清空并替换 body 内容 */
export function setBody(host: HTMLElement, ...children: Array<Node | string | null | undefined | false>): void {
  mount(host, ...children);
}
