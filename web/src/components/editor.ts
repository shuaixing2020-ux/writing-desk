/**
 * 正文编辑器 —— 段落式 contenteditable，纯文本（plaintext-only）。
 *
 * 为什么不是富文本（Tiptap/ProseMirror）：
 *   稿件是 Markdown 真相。任何 HTML↔Markdown 往返都会静默丢东西（空格、全角标点、
 *   软换行），而「稿件永不丢」是产品的最高优先级。这里让 DOM 只承担「显示」，
 *   数据永远是纯文本，转换只有一条单向路径：DOM → 文本。
 *
 * 为什么每段一个 <div> 而不是一个 contenteditable 里塞整篇：
 *   中文写作必须有段首缩进与段间距，只有块级元素能做；而且逐段能让光标定位、
 *   检查结果高亮、打字机模式都精确到「行」。
 *
 * 结构由我们完全接管：Enter / Backspace / Delete / 粘贴 / 拖放都拦截后自己改 DOM，
 * 不让浏览器产生嵌套 <div>。撤销也用自己维护的快照栈 —— 因为手工改 DOM 会让
 * 浏览器原生撤销栈错乱，作者按 ⌘Z 必须可靠。
 */

import type { CountMode, DocNode, DocStatus } from '../../../shared/types.ts';
import { DOC_STATUS_LABELS, DOC_STATUSES } from '../../../shared/types.ts';
import { h, mount } from '../lib/dom.ts';
import { countDialogueParagraphs, countParagraphs, countWords } from '../lib/words.ts';
import { ICONS } from './shell.ts';

export interface EditorStats {
  words: number;
  paragraphs: number;
  dialogue: number;
}

export interface EditorHandlers {
  /** 内容变化（未去抖）：app 负责 markDirty + 统计刷新 */
  onChange(): void;
  /** 失焦等需要立即落盘的时机 */
  onBlur(): void;
  /** 场景标题被改 */
  onTitleChange(title: string): void;
  /** 场景状态被改 */
  onStatusChange(status: DocStatus): void;
  toast(message: string, kind?: 'ok' | 'warn' | 'error' | 'info'): void;
}

export interface EditorContext {
  projectId: string;
  doc: DocNode | null;
  /** 面包屑文本 */
  path: string;
  countMode: CountMode;
  /**
   * 要装载的正文。只有切换文档时才需要传：同文档的后续 update 传了也会被忽略，
   * 避免外部刷新把作者正在敲的字冲掉。
   */
  body?: string;
}

export interface EditorHandle {
  el: HTMLElement;
  getValue(): string;
  /**
   * 在光标处插入文本（AI 建议落盘的唯一入口）。
   * 由作者显式点击触发，不自动改写正文。
   */
  insertText(text: string): void;
  setContext(ctx: EditorContext): void;
  focus(): void;
  revealRange(from: number, to: number): void;
  getStats(): EditorStats;
  /** 与服务端已保存版本是否一致 */
  isDirty(): boolean;
  /** 服务端确认落盘：更新「干净」基准 */
  markSaved(body?: string): void;
  /**
   * 用服务端返回的权威内容覆盖编辑器（如标点自动规整的结果）。
   *
   * 只在「作者没有继续输入」时调用，否则会吞掉正在敲的字。
   * 会保留光标位置，避免跳到最后。
   */
  setValue(body: string): void;
  /** 立刻记住光标位置（切文档前调用，避免丢位置） */
  saveCaret(): void;
  setTypewriter(on: boolean): void;
  destroy(): void;
}

// ─────────────────────── 纯函数：段落 ⇄ 文本 ───────────────────────

/** 把一个段落元素的内容读成纯文本（<br> → \n，忽略任何标签） */
function paraText(el: HTMLElement): string {
  let out = '';
  const walk = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      out += n.textContent ?? '';
      return;
    }
    if (n.nodeName === 'BR') {
      out += '\n';
      return;
    }
    if (n.nodeType === Node.ELEMENT_NODE) {
      for (const c of Array.from(n.childNodes)) walk(c);
    }
  };
  for (const c of Array.from(el.childNodes)) walk(c);
  // 浏览器会给「光标在最后一行」补一个 <br> 作为占位，它不是用户输入的换行
  if (out.endsWith('\n')) out = out.slice(0, -1);
  return out;
}

/**
 * 正文拆段。
 *
 * 规则：段落之间恰好是两个换行。所以 "a\n\n\n\nb" 是「a / 空段 / b」——
 * 空行本身就是作者的内容（网文里常用空段做场景切换），必须原样保留。
 * 拆分用精确的 /\n\n/ 而不是 /\n+/，这样 join('\n\n') 一定还原原文，
 * 打开编辑器永远不会改动稿件（「稿件永不丢」的底线）。
 *
 * 单个换行留在段落内部（软换行），由 CSS 的 pre-wrap 呈现。
 */
function splitBody(body: string): string[] {
  if (body === '') return [''];
  const paras = body.split('\n\n');
  // 首尾的纯空白段没有语义（服务端读回时也会剥掉尾部换行），去掉避免出现幽灵空行
  while (paras.length > 1 && paras[0].trim() === '') paras.shift();
  while (paras.length > 1 && paras[paras.length - 1].trim() === '') paras.pop();
  if (paras.length === 0) paras.push('');
  return paras;
}

function makePara(text: string): HTMLDivElement {
  const div = document.createElement('div');
  div.className = 'para';
  if (text === '') {
    div.appendChild(document.createElement('br'));
  } else {
    div.textContent = text;
  }
  return div;
}

/** 段落内字符偏移（<br> 记 1 个字符） */
function nodeLen(n: Node): number {
  if (n.nodeType === Node.TEXT_NODE) return (n.textContent ?? '').length;
  if (n.nodeName === 'BR') return 1;
  let sum = 0;
  for (const c of Array.from(n.childNodes)) sum += nodeLen(c);
  return sum;
}

/** 光标位置 → 段落内字符偏移 */
function offsetInPara(para: HTMLElement, target: Node, targetOffset: number): number {
  let acc = 0;
  let result = -1;
  const visit = (n: Node): boolean => {
    if (n === target) {
      if (n.nodeType === Node.TEXT_NODE) {
        result = acc + targetOffset;
        return true;
      }
      for (let i = 0; i < targetOffset && i < n.childNodes.length; i++) acc += nodeLen(n.childNodes[i]);
      result = acc;
      return true;
    }
    if (n.nodeType === Node.TEXT_NODE) {
      acc += (n.textContent ?? '').length;
      return false;
    }
    if (n.nodeName === 'BR') {
      acc += 1;
      return false;
    }
    for (const c of Array.from(n.childNodes)) if (visit(c)) return true;
    return false;
  };
  visit(para);
  return result >= 0 ? result : acc;
}

/** 段落内字符偏移 → DOM 位置 */
function positionInPara(para: HTMLElement, offset: number): { node: Node; offset: number } {
  let acc = 0;
  let found: { node: Node; offset: number } | null = null;

  const visit = (n: Node): boolean => {
    if (n.nodeType === Node.TEXT_NODE) {
      const len = (n.textContent ?? '').length;
      if (offset <= acc + len) {
        found = { node: n, offset: Math.max(0, offset - acc) };
        return true;
      }
      acc += len;
      return false;
    }
    if (n.nodeName === 'BR') {
      const parent = n.parentNode!;
      const idx = Array.prototype.indexOf.call(parent.childNodes, n) as number;
      if (offset === acc) {
        found = { node: parent, offset: idx };
        return true;
      }
      acc += 1;
      if (offset === acc) {
        found = { node: parent, offset: idx + 1 };
        return true;
      }
      return false;
    }
    for (const c of Array.from(n.childNodes)) if (visit(c)) return true;
    return false;
  };
  visit(para);
  return found ?? { node: para, offset: para.childNodes.length };
}

// ─────────────────────── 编辑器 ───────────────────────

export function createEditor(container: HTMLElement, handlers: EditorHandlers): EditorHandle {
  let ctx: EditorContext = { projectId: '', doc: null, path: '', countMode: 'hanzi' };
  let savedBody = '';
  let typewriter = false;
  let composing = false;

  // 撤销栈：{body, caret}
  interface Snap {
    body: string;
    caret: number;
  }
  let undoStack: Snap[] = [];
  let redoStack: Snap[] = [];
  let lastSnapAt = 0;
  let lastBody = '';

  // ── DOM ──
  const crumbs = h('div', { class: 'editor-crumbs' });
  const titleInput = h('input', {
    class: 'editor-title',
    type: 'text',
    placeholder: '场景标题',
    spellcheck: 'false',
    'aria-label': '场景标题',
  });
  const statusSelect = h('select', { class: 'status-select', 'aria-label': '场景状态' }) as HTMLSelectElement;
  for (const s of DOC_STATUSES) {
    statusSelect.append(h('option', { value: s }, DOC_STATUS_LABELS[s]));
  }
  const headWords = h('span', { class: 'em-item em-words' }, '0 字');
  const headMeta = h('div', { class: 'editor-meta' }, statusSelect, headWords);
  const head = h('div', { class: 'editor-head' }, crumbs, titleInput, headMeta);

  const surface = h('div', { class: 'editor-surface', role: 'textbox', 'aria-multiline': 'true' });
  // plaintext-only 能挡住浏览器注入 <b>/<span>；老浏览器不支持时退回 true，
  // 但粘贴/拖放仍然会被我们拦截，所以数据侧不会脏。
  const plaintextOk = (() => {
    const probe = document.createElement('div');
    probe.setAttribute('contenteditable', 'plaintext-only');
    return probe.contentEditable === 'plaintext-only';
  })();
  surface.setAttribute('contenteditable', plaintextOk ? 'plaintext-only' : 'true');
  surface.setAttribute('spellcheck', 'false');
  surface.setAttribute('autocorrect', 'off');
  surface.setAttribute('autocapitalize', 'off');
  surface.setAttribute('data-placeholder', '从这里开始写。Enter 分段，⌘S 保存。');

  const paper = h('div', { class: 'editor-paper' }, surface, h('div', { class: 'editor-end' }));
  const scroll = h('div', { class: 'editor-scroll' }, paper);

  const emptyState = h('div', { class: 'editor-empty hidden' });

  // 外壳已经提供了 .editor-col 容器，这里用 .editor-root 避免重复类名导致的选择器歧义
  const el = h('section', { class: 'editor-root' }, head, scroll, emptyState);

  container.textContent = '';
  container.appendChild(el);

  // ── 序列化 ──

  const serialize = (): string => {
    const paras: string[] = [];
    for (const child of Array.from(surface.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const elNode = child as HTMLElement;
        if (elNode.tagName === 'BR') {
          paras.push('');
        } else {
          paras.push(paraText(elNode));
        }
      } else if (child.nodeType === Node.TEXT_NODE) {
        const t = child.textContent ?? '';
        if (t) paras.push(t);
      }
    }
    while (paras.length > 1 && paras[paras.length - 1].trim() === '') paras.pop();
    while (paras.length > 1 && paras[0].trim() === '') paras.shift();
    return paras.join('\n\n');
  };

  const renderBody = (body: string): void => {
    mount(surface);
    for (const text of splitBody(body)) surface.appendChild(makePara(text));
    if (!surface.firstChild) surface.appendChild(makePara(''));
    updateEmptyFlag();
  };

  const updateEmptyFlag = (): void => {
    const empty = serialize() === '';
    surface.classList.toggle('is-empty', empty);
    el.classList.toggle('is-empty-doc', empty);
  };

  // ── 统计 ──

  let stats: EditorStats = { words: 0, paragraphs: 0, dialogue: 0 };

  const refreshStats = (): void => {
    const body = serialize();
    stats = {
      words: countWords(body, ctx.countMode),
      paragraphs: countParagraphs(body),
      dialogue: countDialogueParagraphs(body),
    };
    headWords.textContent = `${stats.words.toLocaleString('zh-CN')} 字`;
    headWords.title = `${stats.words} 字 · ${stats.paragraphs} 段 · 对白 ${stats.dialogue} 段`;
  };

  // ── 光标 ──

  const caretKey = (): string => `writingdesk:caret:${ctx.projectId}:${ctx.doc?.id ?? ''}`;
  const scrollKey = (): string => `writingdesk:scroll:${ctx.projectId}:${ctx.doc?.id ?? ''}`;

  const currentPara = (): HTMLElement | null => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    let node: Node | null = sel.getRangeAt(0).startContainer;
    while (node && node !== surface) {
      if (node instanceof HTMLElement && node.classList.contains('para')) return node;
      node = node.parentNode;
    }
    return null;
  };

  const getCaret = (): number => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return 0;
    const range = sel.getRangeAt(0);
    if (!surface.contains(range.startContainer)) return 0;
    let offset = 0;
    for (const child of Array.from(surface.childNodes)) {
      if (child === range.startContainer || child.contains(range.startContainer)) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          const para = child as HTMLElement;
          offset += offsetInPara(para, range.startContainer, range.startOffset);
        }
        return offset;
      }
      if (child.nodeType === Node.ELEMENT_NODE) offset += paraText(child as HTMLElement).length;
      offset += 2; // 段落分隔 \n\n
    }
    return offset;
  };

  const setCaretAt = (offset: number): void => {
    let acc = 0;
    const children = Array.from(surface.childNodes).filter((n) => n.nodeType === Node.ELEMENT_NODE);
    if (children.length === 0) return;
    for (const child of children) {
      const para = child as HTMLElement;
      const len = paraText(para).length;
      if (offset <= acc + len) {
        const pos = positionInPara(para, Math.max(0, offset - acc));
        const range = document.createRange();
        try {
          range.setStart(pos.node, Math.min(pos.offset, pos.node.nodeType === Node.TEXT_NODE ? (pos.node.textContent ?? '').length : pos.node.childNodes.length));
          range.collapse(true);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        } catch {
          /* 位置失效时放弃，不抛错打断输入 */
        }
        return;
      }
      acc += len + 2;
    }
    // 超出末尾：放到最后一段末尾
    const last = children[children.length - 1] as HTMLElement;
    const pos = positionInPara(last, paraText(last).length);
    const range = document.createRange();
    range.setStart(pos.node, pos.offset);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };

  const rememberCaret = (): void => {
    try {
      sessionStorage.setItem(caretKey(), String(getCaret()));
      localStorage.setItem(scrollKey(), String(scroll.scrollTop));
    } catch {
      /* 隐私模式下 storage 可能不可用，忽略 */
    }
  };

  // ── 打字机模式 ──

  let typewriterQueued = false;
  const typewriterTick = (): void => {
    if (!typewriter) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0).cloneRange();
    range.collapse(true);
    let rect = range.getBoundingClientRect();
    if (rect.height === 0) {
      // 空段落时 rect 可能为空，用段落元素的矩形兜底
      const para = currentPara();
      if (para) rect = para.getBoundingClientRect();
    }
    if (rect.height === 0) return;
    const box = scroll.getBoundingClientRect();
    const target = box.top + box.height * 0.42;
    const delta = rect.top - target;
    if (Math.abs(delta) > 6) scroll.scrollTop += delta;
  };

  const scheduleTypewriter = (): void => {
    if (typewriterQueued) return;
    typewriterQueued = true;
    requestAnimationFrame(() => {
      typewriterQueued = false;
      typewriterTick();
    });
  };

  // ── 变更通知 ──

  /** 把「当前状态」压入撤销栈（在变更之前调用） */
  const pushUndo = (structural: boolean): void => {
    const body = serialize();
    const now = Date.now();
    // 连续打字合成一步：隔 500ms 或结构变化（分段/合并/粘贴）才另起一步
    if (!structural && now - lastSnapAt <= 500 && undoStack.length > 0) {
      lastSnapAt = now;
      return;
    }
    undoStack.push({ body, caret: getCaret() });
    if (undoStack.length > 200) undoStack.shift();
    redoStack = [];
    lastSnapAt = now;
  };

  const afterChange = (structural: boolean): void => {
    const body = serialize();
    if (body !== lastBody) {
      lastBody = body;
    }
    updateEmptyFlag();
    refreshStats();
    rememberCaret();
    handlers.onChange();
    scheduleTypewriter();
  };

  // ── 结构修复：浏览器偶尔还是会插出嵌套块，这里把它拍平 ──

  const ensureStructure = (): boolean => {
    let dirty = false;
    for (const child of Array.from(surface.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child.textContent ?? '';
        if (t) {
          const para = makePara(t);
          surface.replaceChild(para, child);
          dirty = true;
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const elNode = child as HTMLElement;
        if (elNode.tagName === 'BR') {
          surface.replaceChild(makePara(''), elNode);
          dirty = true;
        } else if (elNode.tagName !== 'DIV') {
          const para = makePara(elNode.textContent ?? '');
          surface.replaceChild(para, elNode);
          dirty = true;
        } else {
          // 段落内部出现任何元素（嵌套块、<b>/<span>/<a>…）：一律拉平成纯文本。
          // 稿件是纯文本真相，DOM 里绝不允许残留富文本节点。
          const nested = elNode.querySelector('div, p, li, h1, h2, h3, blockquote, pre, b, i, u, s, strong, em, span, a, font, mark');
          if (nested) {
            const text = paraText(elNode);
            elNode.replaceWith(makePara(text));
            dirty = true;
          }
        }
      }
    }
    if (surface.childNodes.length === 0) {
      surface.appendChild(makePara(''));
      dirty = true;
    }
    return dirty;
  };

  /** 结构被修复后光标会丢，用字符偏移复原 */
  const repairPreservingCaret = (): void => {
    const caret = getCaret();
    if (ensureStructure()) setCaretAt(caret);
  };

  // ── 输入 ──

  surface.addEventListener('compositionstart', () => {
    composing = true;
    surface.classList.add('composing');
  });

  surface.addEventListener('compositionend', () => {
    composing = false;
    surface.classList.remove('composing');
    // 输入法上屏后才算一次真正的变更
    repairPreservingCaret();
    afterChange(false);
  });

  surface.addEventListener('input', (ev) => {
    if (composing || (ev as InputEvent).isComposing) return;
    // 普通打字：撤销栈按 500ms 分组，这里只在组起点压一次（pushUndo 内部判断）
    if (undoStack.length === 0 || Date.now() - lastSnapAt > 500) {
      // 需要「变更前」的文本，所以用上一次记录的 lastBody 作为快照
      undoStack.push({ body: lastBody, caret: 0 });
      if (undoStack.length > 200) undoStack.shift();
      redoStack = [];
      lastSnapAt = Date.now();
    }
    repairPreservingCaret();
    afterChange(false);
  });

  surface.addEventListener('blur', () => {
    if (composing) return;
    rememberCaret();
    handlers.onBlur();
  });

  // ── 键盘：Enter / Backspace / Delete / Tab / 撤销 ──

  const splitAtCaret = (): void => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) {
      range.deleteContents();
      range.collapse(true);
    }
    let para = currentPara();
    if (!para) {
      // 光标不在段落里（例如刚清空）：兜底新建一段
      const p = makePara('');
      surface.appendChild(p);
      setCaretAt(serialize().length);
      return;
    }
    pushUndo(true);
    const offset = offsetInPara(para, range.startContainer, range.startOffset);
    const text = paraText(para);
    const before = text.slice(0, offset);
    const after = text.slice(offset);
    const p1 = makePara(before);
    const p2 = makePara(after);
    para.replaceWith(p1, p2);
    setCaret(p2, 0);
    afterChange(true);
  };

  const setCaret = (para: HTMLElement, offset: number): void => {
    const pos = positionInPara(para, offset);
    const range = document.createRange();
    const maxOffset =
      pos.node.nodeType === Node.TEXT_NODE ? (pos.node.textContent ?? '').length : pos.node.childNodes.length;
    try {
      range.setStart(pos.node, Math.min(pos.offset, maxOffset));
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    } catch {
      /* ignore */
    }
  };

  const mergeBackward = (): void => {
    const para = currentPara();
    if (!para) return;
    pushUndo(true);
    const prev = para.previousElementSibling as HTMLElement | null;
    if (!prev) return;
    const prevText = paraText(prev);
    const text = paraText(para);
    prev.textContent = prevText + text;
    if (prevText + text === '') prev.appendChild(document.createElement('br'));
    const caret = prevText.length;
    para.remove();
    setCaret(prev, caret);
    afterChange(true);
  };

  const mergeForward = (): void => {
    const para = currentPara();
    if (!para) return;
    pushUndo(true);
    const next = para.nextElementSibling as HTMLElement | null;
    if (!next) return;
    const text = paraText(para);
    const nextText = paraText(next);
    para.textContent = text + nextText;
    if (text + nextText === '') para.appendChild(document.createElement('br'));
    const caret = text.length;
    next.remove();
    setCaret(para, caret);
    afterChange(true);
  };

  const insertTextAtCaret = (text: string): void => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  };

  const insertLines = (lines: string[]): void => {
    if (lines.length === 0) return;
    pushUndo(true);
    // 第一行插到当前光标处，其余每行新起一段
    const first = lines[0];
    if (first) insertTextAtCaret(first);
    for (let i = 1; i < lines.length; i++) {
      splitAtCaret();
      if (lines[i]) insertTextAtCaret(lines[i]);
    }
    afterChange(true);
  };

  const undo = (): void => {
    const snap = undoStack.pop();
    if (!snap) {
      handlers.toast('没有更多可撤销的编辑', 'info');
      return;
    }
    redoStack.push({ body: serialize(), caret: getCaret() });
    applyBody(snap.body, snap.caret);
    lastBody = serialize();
    updateEmptyFlag();
    refreshStats();
    handlers.onChange();
  };

  const redo = (): void => {
    const snap = redoStack.pop();
    if (!snap) {
      handlers.toast('没有更多可重做的编辑', 'info');
      return;
    }
    undoStack.push({ body: serialize(), caret: getCaret() });
    applyBody(snap.body, snap.caret);
    lastBody = serialize();
    updateEmptyFlag();
    refreshStats();
    handlers.onChange();
  };

  surface.addEventListener('keydown', (ev) => {
    if (ev.isComposing || composing || ev.keyCode === 229) return;

    const mod = ev.metaKey || ev.ctrlKey;

    if (mod && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      if (ev.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && ev.key.toLowerCase() === 'y') {
      ev.preventDefault();
      redo();
      return;
    }
    if (mod && ev.key.toLowerCase() === 'a') {
      // 全选只选正文，不把标题栏也选进去
      ev.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(surface);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      return;
    }

    if (ev.key === 'Enter' && !mod) {
      ev.preventDefault();
      if (ev.shiftKey) {
        pushUndo(false);
        insertTextAtCaret('\n');
        afterChange(false);
      } else {
        splitAtCaret();
      }
      return;
    }

    if (ev.key === 'Backspace' && !mod) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && sel.getRangeAt(0).collapsed) {
        const para = currentPara();
        if (para) {
          const range = sel.getRangeAt(0);
          const offset = offsetInPara(para, range.startContainer, range.startOffset);
          if (offset === 0) {
            const prev = para.previousElementSibling;
            if (prev) {
              ev.preventDefault();
              // 空段落直接删掉，否则与前一段合并
              if (paraText(para) === '') {
                const caret = paraText(prev as HTMLElement).length;
                para.remove();
                setCaret(prev as HTMLElement, caret);
                afterChange(true);
              } else {
                mergeBackward();
              }
              return;
            }
          }
        }
      }
      return;
    }

    if (ev.key === 'Delete' && !mod) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && sel.getRangeAt(0).collapsed) {
        const para = currentPara();
        if (para) {
          const range = sel.getRangeAt(0);
          const offset = offsetInPara(para, range.startContainer, range.startOffset);
          if (offset === paraText(para).length && para.nextElementSibling) {
            ev.preventDefault();
            mergeForward();
            return;
          }
        }
      }
      return;
    }

    if (ev.key === 'Tab' && !mod) {
      ev.preventDefault();
      if (ev.shiftKey) {
        // 反缩进：去掉行首最多两个全角空格
        const para = currentPara();
        if (!para) return;
        const text = paraText(para);
        const stripped = text.replace(/^(\u3000\u3000|\u3000| {2}| {4})/, '');
        if (stripped !== text) {
          pushUndo(true);
          const caret = Math.max(0, getCaret() - (text.length - stripped.length));
          para.textContent = stripped;
          if (stripped === '') para.appendChild(document.createElement('br'));
          setCaret(para, Math.min(caret, stripped.length));
          afterChange(true);
        }
      } else {
        pushUndo(false);
        insertTextAtCaret('\u3000\u3000');
        afterChange(false);
      }
      return;
    }

    if (ev.key === 'Escape') {
      // 让键盘用户能离开正文：Esc 收起到标题栏
      surface.blur();
    }
  });

  // ── 粘贴 / 拖放：一律按纯文本处理 ──

  surface.addEventListener('paste', (ev) => {
    ev.preventDefault();
    pushUndo(true);
    const text = ev.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    const lines = text
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/\s+$/, ''))
      .filter((line, i, arr) => line.trim() !== '' || (i > 0 && i < arr.length - 1));
    // 段落化：连续空行折叠成一个空段
    const normalized: string[] = [];
    for (const line of lines) {
      if (line.trim() === '' && (normalized.length === 0 || normalized[normalized.length - 1] === '')) continue;
      normalized.push(line);
    }
    while (normalized.length > 0 && normalized[normalized.length - 1] === '') normalized.pop();
    if (normalized.length === 0) return;
    if (normalized.length === 1 && normalized[0].indexOf('\n') < 0) {
      insertTextAtCaret(normalized[0]);
      afterChange(false);
    } else {
      insertLines(normalized);
    }
  });

  surface.addEventListener('drop', (ev) => {
    // 拖进来的 HTML 会带样式，统一降级成纯文本
    const text = ev.dataTransfer?.getData('text/plain') ?? '';
    if (!text) return;
    ev.preventDefault();
    const caretRange = document.caretRangeFromPoint?.(ev.clientX, ev.clientY);
    if (caretRange) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(caretRange);
    }
    insertTextAtCaret(text.replace(/\r\n?/g, '\n').replace(/\n+/g, '\n'));
    afterChange(false);
  });

  surface.addEventListener('dragover', (ev) => {
    // 阻止浏览器默认的富文本拖放
    if (ev.dataTransfer?.types.includes('Files')) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  });

  // ── 选区变化：记忆光标 + 打字机 ──

  let caretSaveTimer: ReturnType<typeof setTimeout> | null = null;
  document.addEventListener('selectionchange', onSelectionChange);
  function onSelectionChange(): void {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    if (!surface.contains(sel.getRangeAt(0).startContainer)) return;
    scheduleTypewriter();
    // 光标位置要跟着选区走，而不是只在改内容时记：作者常常只挪光标就切文档
    if (caretSaveTimer) clearTimeout(caretSaveTimer);
    caretSaveTimer = setTimeout(() => {
      caretSaveTimer = null;
      rememberCaret();
    }, 200);
  }

  // ── 标题 / 状态 ──

  titleInput.addEventListener('keydown', (ev) => {
    if (ev.isComposing) return;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      titleInput.blur();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      titleInput.value = ctx.doc?.title ?? '';
      titleInput.blur();
    }
  });
  titleInput.addEventListener('blur', () => {
    const value = titleInput.value.trim();
    if (ctx.doc && value && value !== ctx.doc.title) handlers.onTitleChange(value);
    else if (!value) titleInput.value = ctx.doc?.title ?? '';
  });

  statusSelect.addEventListener('change', () => {
    handlers.onStatusChange(statusSelect.value as DocStatus);
  });

  // ── 对外 API ──

  const applyBody = (body: string, caret?: number): void => {
    renderBody(body);
    lastBody = serialize();
    refreshStats();
    if (caret !== undefined) setCaretAt(caret);
    updateEmptyFlag();
  };

  /** 空状态：没选中文档时给引导，不要留白 */
  const renderEmptyState = (): void => {
    head.classList.add('hidden');
    scroll.classList.add('hidden');
    emptyState.classList.remove('hidden');
    mount(
      emptyState,
      h('div', { class: 'empty-illustration', html: ICONS.feather }),
      h('div', { class: 'empty-title' }, '还没有选中场景'),
      h('div', { class: 'empty-hint' }, '在左侧稿件树里选一个场景开始写，或新建一个。'),
    );
    mount(surface);
  };

  /** 换文档时整体装载：正文、标题、状态、光标、滚动位置 */
  const loadDoc = (body: string): void => {
    const doc = ctx.doc;
    if (!doc) {
      renderEmptyState();
      return;
    }
    head.classList.remove('hidden');
    scroll.classList.remove('hidden');
    emptyState.classList.add('hidden');

    crumbs.textContent = ctx.path || doc.title;
    titleInput.value = doc.title;
    statusSelect.value = doc.status;
    statusSelect.className = `status-select status-${doc.status}`;

    // 容器节点（卷/章）没有正文，编辑器只显示占位说明
    const readOnly = doc.kind !== 'scene';
    surface.setAttribute('contenteditable', readOnly ? 'false' : plaintextOk ? 'plaintext-only' : 'true');
    el.classList.toggle('is-container-doc', readOnly);

    applyBody(readOnly ? '' : body);
    savedBody = readOnly ? '' : body;
    lastBody = savedBody;

    // 恢复上次的光标与滚动位置
    let caret = 0;
    try {
      caret = Number(sessionStorage.getItem(caretKey()) ?? '0') || 0;
      scroll.scrollTop = Number(localStorage.getItem(scrollKey()) ?? '0') || 0;
    } catch {
      /* ignore */
    }
    requestAnimationFrame(() => {
      if (caret > 0) setCaretAt(caret);
      if (typewriter) typewriterTick();
    });
  };

  /**
   * 更新上下文。
   * 同一份文档时只刷新外壳信息，绝不重设正文 —— 否则正在输入的中文会被打断。
   */
  const setContext = (next: EditorContext): void => {
    const docChanged = next.doc?.id !== ctx.doc?.id;
    const prevPath = ctx.path;
    ctx = { projectId: next.projectId, doc: next.doc, path: next.path, countMode: next.countMode };

    if (docChanged) {
      // 切文档：撤销栈属于上一份稿子，必须清空
      undoStack = [];
      redoStack = [];
      lastSnapAt = 0;
      loadDoc(next.body ?? '');
      return;
    }

    if (!next.doc) {
      renderEmptyState();
      return;
    }

    if (prevPath !== ctx.path) crumbs.textContent = ctx.path || next.doc.title;
    if (document.activeElement !== titleInput) titleInput.value = next.doc.title;
    statusSelect.value = next.doc.status;
    statusSelect.className = `status-select status-${next.doc.status}`;

    // 外部改了正文（如恢复快照）：只在编辑器没有焦点时套用，避免吞掉作者正在敲的字
    if (
      next.body !== undefined &&
      next.body !== serialize() &&
      !surface.contains(document.activeElement)
    ) {
      applyBody(next.body);
      savedBody = next.body;
      lastBody = next.body;
    }
    refreshStats();
  };

  const getValue = (): string => serialize();

  return {
    el,
    getValue,
    /**
     * 在光标处插入文本。
     *
     * 用 execCommand('insertText') 而不是直接改 DOM：它会走浏览器原生的
     * 编辑管线，撤销栈、input 事件、中文输入法状态都能保持正确。
     * 兜底才用 Range 插一段文本节点并手工派发 input。
     */
    insertText: (text: string) => {
      if (!text) return;
      surface.focus({ preventScroll: false });

      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) {
        // 没有光标：落到正文末尾
        const range = document.createRange();
        range.selectNodeContents(surface);
        range.collapse(false);
        sel?.removeAllRanges();
        sel?.addRange(range);
      }

      let ok = false;
      try {
        ok = document.execCommand('insertText', false, text);
      } catch {
        ok = false;
      }

      if (!ok) {
        const active = window.getSelection();
        const range = active && active.rangeCount > 0 ? active.getRangeAt(0) : null;
        if (range) {
          range.deleteContents();
          const node = document.createTextNode(text);
          range.insertNode(node);
          range.setStartAfter(node);
          range.collapse(true);
          active?.removeAllRanges();
          active?.addRange(range);
          surface.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        }
      }
    },
    setContext,
    focus: () => {
      surface.focus({ preventScroll: false });
      const body = serialize();
      if (body === '') setCaretAt(0);
    },
    revealRange: (from, to) => {
      const body = serialize();
      const start = Math.max(0, Math.min(from, body.length));
      const end = Math.max(start, Math.min(to, body.length));
      // 字符偏移 → 段落 + 段内偏移
      const paras = Array.from(surface.childNodes).filter((n) => n.nodeType === Node.ELEMENT_NODE) as HTMLElement[];
      let acc = 0;
      let startPara: HTMLElement | null = null;
      let startOffset = 0;
      let endPara: HTMLElement | null = null;
      let endOffset = 0;
      for (const para of paras) {
        const len = paraText(para).length;
        const segStart = acc;
        const segEnd = acc + len;
        if (!startPara && start <= segEnd) {
          startPara = para;
          startOffset = start - segStart;
        }
        if (end >= segStart && end <= segEnd) {
          endPara = para;
          endOffset = end - segStart;
          break;
        }
        acc = segEnd + 2;
      }
      if (!startPara) {
        startPara = paras[paras.length - 1] ?? null;
        startOffset = startPara ? paraText(startPara).length : 0;
      }
      if (!endPara) {
        endPara = startPara;
        endOffset = startPara ? paraText(startPara).length : 0;
      }
      if (!startPara || !endPara) return;

      surface.focus({ preventScroll: true });
      const a = positionInPara(startPara, startOffset);
      const b = positionInPara(endPara, endOffset);
      const range = document.createRange();
      try {
        range.setStart(a.node, a.offset);
        range.setEnd(b.node, b.offset);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      } catch {
        return;
      }

      // 滚动到可见（约 1/3 处），并短暂高亮命中的段落
      const rect = range.getBoundingClientRect();
      const box = scroll.getBoundingClientRect();
      if (rect.top < box.top + 40 || rect.bottom > box.bottom - 40) {
        scroll.scrollTop += rect.top - box.top - box.height * 0.32;
      }
      for (const para of [startPara, endPara]) {
        para.classList.remove('reveal-flash');
        void para.offsetWidth;
        para.classList.add('reveal-flash');
        setTimeout(() => para.classList.remove('reveal-flash'), 1400);
      }
      afterChange(false);
    },
    getStats: () => stats,
    isDirty: () => serialize() !== savedBody,
    markSaved: (body?: string) => {
      savedBody = body ?? serialize();
    },
    setValue: (body: string) => {
      // 保留光标：规整只改标点，字符数变化很小，用当前偏移近似即可。
      // 直接 applyBody 会把光标丢到末尾，作者会以为跳行了。
      const caret = getCaret();
      applyBody(body, caret);
      savedBody = body;
      lastBody = body;
    },
    saveCaret: () => rememberCaret(),
    setTypewriter: (on: boolean) => {
      typewriter = on;
      el.classList.toggle('typewriter', on);
      if (on) typewriterTick();
    },
    destroy: () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      container.textContent = '';
    },
  };
}
