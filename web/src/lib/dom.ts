/**
 * 极简 DOM 工具。
 *
 * 不引框架的理由：面板数量有限、更新粒度可控，手写 DOM 反而更快更稳。
 * 统一用 h() 构造，避免 innerHTML 拼接带来的 XSS 与难维护问题。
 */

type Attrs = Record<string, unknown>;
type Child = Node | string | number | null | undefined | false;

/**
 * 创建元素。
 *   h('div', { class: 'x', onclick: fn }, 'text', child)
 *   h('svg', { viewBox: '0 0 16 16', innerHTML: ICON })
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  append(el, children);
  return el;
}

export function applyAttrs(el: Element, attrs?: Attrs | null): void {
  if (!attrs) return;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class' || key === 'className') {
      el.setAttribute('class', String(value));
    } else if (key === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value as Record<string, string | number>)) {
        if (v === null || v === undefined) continue;
        if (prop.startsWith('--')) {
          (el as HTMLElement).style.setProperty(prop, String(v));
        } else {
          (el as HTMLElement).style[prop as never] = String(v) as never;
        }
      }
    } else if (key === 'dataset' && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, string>)) {
        (el as HTMLElement).dataset[k] = String(v);
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      const event = key.slice(2).toLowerCase();
      el.addEventListener(event, value as EventListener);
    } else if (key === 'html') {
      (el as HTMLElement).innerHTML = String(value);
    } else if (key === 'text') {
      el.textContent = String(value);
    } else if (key === 'value' && el instanceof HTMLInputElement) {
      el.value = String(value);
    } else if (key === 'checked' && el instanceof HTMLInputElement) {
      el.checked = Boolean(value);
    } else if (key === 'disabled' && el instanceof HTMLButtonElement) {
      el.disabled = Boolean(value);
    } else if (typeof value === 'boolean') {
      if (value) el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

function append(el: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (child instanceof Node) {
      el.appendChild(child);
    } else {
      el.appendChild(document.createTextNode(String(child)));
    }
  }
}

/** 清空并填充 */
export function mount(el: Element, ...children: Child[]): void {
  el.textContent = '';
  append(el, children);
}

/** 用 HTML 字符串构造（仅用于可信的内联 SVG 图标） */
export function icon(svg: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = svg;
  span.style.display = 'inline-flex';
  return span;
}

/** 事件委托：在容器上监听，按 data-act 分发 */
export function delegate(
  root: Element,
  eventName: string,
  handler: (act: string, el: HTMLElement, ev: Event) => void,
): () => void {
  const listener = (ev: Event) => {
    const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-act]');
    if (!target || !root.contains(target)) return;
    const act = target.dataset.act;
    if (act) handler(act, target, ev);
  };
  root.addEventListener(eventName, listener);
  return () => root.removeEventListener(eventName, listener);
}

/** 防抖 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
}

/** 节流（动画帧对齐） */
export function rafThrottle<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  let queued = false;
  let lastArgs: A;
  return (...args: A) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...lastArgs);
    });
  };
}

/** 转义 HTML（用于必须拼字符串的场景，如搜索高亮片段） */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

/** 格式化时间戳 */
export function formatTime(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  if (d.getFullYear() === now.getFullYear()) return `${mo}-${dd} ${hh}:${mm}`;
  return `${d.getFullYear()}-${mo}-${dd}`;
}

/** 相对时间 */
export function relativeTime(ts: number): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatTime(ts);
}

/** 数字加千分位 */
export function fmtNum(n: number): string {
  return n.toLocaleString('zh-CN');
}
