/**
 * 左侧文档树：卷 / 章 / 场景三级。
 *
 * 交互取舍：
 *   - 整棵树一次重绘（几百个节点以内，DOM 重建比 diff 更简单可靠）；
 *     但重绘会打断正在进行的重命名，所以重命名状态单独保存、重绘后恢复。
 *   - 拖拽用 HTML5 drag&drop，只允许「同类型同层级」移动：场景进章、章进卷。
 *     服务端 ProjectStore.moveNode 也是这个约束，前端提前拦住能给出更好的提示。
 */

import type { DocNode, DocStatus } from '../../../shared/types.ts';
import { DOC_STATUS_LABELS, DOC_STATUSES, NODE_KIND_LABELS } from '../../../shared/types.ts';
import { fmtNum, h, mount } from '../lib/dom.ts';
import type { AppState } from '../lib/store.ts';
import { childrenOf, nodeById, visibleNodes } from '../lib/store.ts';
import { ICONS } from './shell.ts';

export interface TreeHandlers {
  selectDoc(docId: string): void;
  createNode(kind: 'volume' | 'chapter' | 'scene', parentId: string | null, title?: string): void;
  renameNode(docId: string, title: string): void;
  deleteNode(docId: string): void;
  moveNode(docId: string, parentId: string, order: number): void;
  updateNodeMeta(docId: string, patch: Partial<Pick<DocNode, 'status' | 'summary'>>): void;
  toggleCollapse(docId: string): void;
  toast(message: string, kind?: 'ok' | 'warn' | 'error' | 'info'): void;
}

export interface TreeHandle {
  /** 挂载到侧栏头部的新建按钮区域 */
  mountHeadActions(container: HTMLElement): void;
  update(state: AppState): void;
  destroy(): void;
}

interface DragState {
  id: string;
  kind: DocNode['kind'];
}

export function createTree(container: HTMLElement, handlers: TreeHandlers): TreeHandle {
  const list = h('div', { class: 'tree', role: 'tree' });
  container.textContent = '';
  container.appendChild(list);

  let state: AppState | null = null;
  /** 正在内联重命名的节点（重绘时恢复输入框与光标） */
  let editing: { id: string; draft: string } | null = null;
  let drag: DragState | null = null;
  let dropTarget: { el: HTMLElement; parentId: string; order: number } | null = null;
  let menuEl: HTMLElement | null = null;
  let headActionsEl: HTMLElement | null = null;

  // ─────────────── 上下文菜单 ───────────────

  const closeMenu = (): void => {
    menuEl?.remove();
    menuEl = null;
  };

  const openMenu = (ev: MouseEvent, node: DocNode | null): void => {
    closeMenu();
    type MenuEntry = { kind: 'item'; label: string; icon?: string; danger?: boolean; run: () => void } | { kind: 'sep' };
    const items: MenuEntry[] = [];
    const sep: MenuEntry = { kind: 'sep' };

    if (node) {
      if (node.kind === 'volume') {
        items.push(
          { kind: 'item', label: '新建章', icon: ICONS.folder, run: () => handlers.createNode('chapter', node.id) },
          sep,
          { kind: 'item', label: '重命名', icon: ICONS.pencil, run: () => startRename(node.id) },
          { kind: 'item', label: '删除卷', icon: ICONS.trash, danger: true, run: () => handlers.deleteNode(node.id) },
        );
      } else if (node.kind === 'chapter') {
        items.push(
          { kind: 'item', label: '新建场景', icon: ICONS.file, run: () => handlers.createNode('scene', node.id) },
          { kind: 'item', label: '在下方新建章', icon: ICONS.folder, run: () => handlers.createNode('chapter', node.parent_id) },
          sep,
          { kind: 'item', label: '重命名', icon: ICONS.pencil, run: () => startRename(node.id) },
          { kind: 'item', label: '删除章', icon: ICONS.trash, danger: true, run: () => handlers.deleteNode(node.id) },
        );
      } else {
        items.push(
          { kind: 'item', label: '重命名', icon: ICONS.pencil, run: () => startRename(node.id) },
          { kind: 'item', label: '在下方新建场景', icon: ICONS.plus, run: () => handlers.createNode('scene', node.parent_id) },
        );
      }

      items.push(sep);
      items.push({
        kind: 'item',
        label: `状态：${DOC_STATUS_LABELS[node.status]}`,
        icon: ICONS.info,
        run: () => {
          // 状态项本身是子菜单的入口，这里用循环切换（比嵌套菜单更快）
          const idx = DOC_STATUSES.indexOf(node.status);
          const next = DOC_STATUSES[(idx + 1) % DOC_STATUSES.length];
          handlers.updateNodeMeta(node.id, { status: next });
        },
      });
    } else {
      items.push(
        { kind: 'item', label: '新建卷', icon: ICONS.layers, run: () => handlers.createNode('volume', null) },
        { kind: 'item', label: '新建章（当前卷）', icon: ICONS.folder, run: () => createChapterSmart() },
        { kind: 'item', label: '新建场景（当前章）', icon: ICONS.file, run: () => createSceneSmart() },
      );
    }

    const menu = h('div', { class: 'ctx-menu', role: 'menu' });
    for (const item of items) {
      if (item.kind === 'sep') {
        menu.append(h('div', { class: 'ctx-sep' }));
        continue;
      }
      menu.append(
        h(
          'button',
          {
            class: `ctx-item${item.danger ? ' danger' : ''}`,
            role: 'menuitem',
            onclick: () => {
              closeMenu();
              item.run();
            },
          },
          h('span', { class: 'ctx-icon', html: item.icon ?? ICONS.chevronRight }),
          h('span', { class: 'ctx-label' }, item.label),
        ),
      );
    }

    // 场景的状态用子菜单更清晰：这里直接展开成一列状态项
    if (node) {
      const statusWrap = h('div', { class: 'ctx-sub' });
      for (const status of DOC_STATUSES) {
        statusWrap.append(
          h(
            'button',
            {
              class: `ctx-item${status === node.status ? ' active' : ''}`,
              role: 'menuitem',
              onclick: () => {
                closeMenu();
                handlers.updateNodeMeta(node.id, { status });
              },
            },
            h('span', { class: 'dot', style: { background: `var(--status-${status})` } }),
            h('span', { class: 'ctx-label' }, DOC_STATUS_LABELS[status]),
            status === node.status ? h('span', { class: 'ctx-check', html: ICONS.check }) : null,
          ),
        );
      }
      const firstSep = menu.querySelector('.ctx-sep');
      if (firstSep) menu.insertBefore(statusWrap, firstSep);
    }

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const x = Math.min(ev.clientX, window.innerWidth - rect.width - 8);
    const y = Math.min(ev.clientY, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(8, x)}px`;
    menu.style.top = `${Math.max(8, y)}px`;
    menuEl = menu;
  };

  const createChapterSmart = (): void => {
    if (!state) return;
    const cur = nodeById(state, state.currentDocId);
    const vol = cur ? (cur.kind === 'volume' ? cur : cur.kind === 'chapter' ? nodeById(state, cur.parent_id) : nodeById(state, nodeById(state, cur.parent_id)?.parent_id ?? null)) : null;
    const volumes = childrenOf(state, null).filter((n) => n.kind === 'volume');
    const target = vol ?? volumes[volumes.length - 1] ?? null;
    if (!target) {
      handlers.toast('请先新建一个卷', 'warn');
      return;
    }
    handlers.createNode('chapter', target.id);
  };

  const createSceneSmart = (): void => {
    if (!state) return;
    const cur = nodeById(state, state.currentDocId);
    let chapter: DocNode | null = null;
    if (cur) {
      chapter = cur.kind === 'chapter' ? cur : cur.kind === 'scene' ? nodeById(state, cur.parent_id) : null;
    }
    if (!chapter) {
      const volumes = childrenOf(state, null).filter((n) => n.kind === 'volume');
      const lastVol = volumes[volumes.length - 1];
      const chapters = lastVol ? childrenOf(state, lastVol.id).filter((n) => n.kind === 'chapter') : [];
      chapter = chapters[chapters.length - 1] ?? null;
    }
    if (!chapter) {
      handlers.toast('请先新建一章', 'warn');
      return;
    }
    handlers.createNode('scene', chapter.id);
  };

  // ─────────────── 内联重命名 ───────────────

  const startRename = (id: string): void => {
    const node = state ? nodeById(state, id) : null;
    if (!node) return;
    editing = { id, draft: node.title };
    paint();
    const input = list.querySelector<HTMLInputElement>(`[data-rename="${CSS.escape(id)}"]`);
    input?.focus();
    input?.select();
  };

  const commitRename = (): void => {
    if (!editing) return;
    const { id, draft } = editing;
    const node = state ? nodeById(state, id) : null;
    editing = null;
    if (node && draft.trim() && draft.trim() !== node.title) {
      handlers.renameNode(id, draft.trim());
    } else {
      paint();
    }
  };

  const cancelRename = (): void => {
    editing = null;
    paint();
  };

  // ─────────────── 拖拽 ───────────────

  const canDrop = (dragKind: DocNode['kind'], targetKind: DocNode['kind']): boolean => {
    if (dragKind === 'scene') return targetKind === 'chapter';
    if (dragKind === 'chapter') return targetKind === 'volume';
    return false; // 卷不支持移动（服务端同样拒绝）
  };

  const clearDropMarks = (): void => {
    list.querySelectorAll('.drop-into, .drop-before, .drop-after').forEach((el) => {
      el.classList.remove('drop-into', 'drop-before', 'drop-after');
    });
    dropTarget = null;
  };

  // ─────────────── 渲染 ───────────────

  const paint = (): void => {
    if (!state) return;
    const scrollTop = container.scrollTop;
    mount(list);

    const rows = visibleNodes(state);
    if (rows.length === 0) {
      list.append(
        h(
          'div',
          { class: 'empty tree-empty' },
          h('span', { html: ICONS.bookOpen }),
          h('div', { class: 'empty-title' }, '还没有任何稿件'),
          h('div', { class: 'empty-hint' }, '从「新建卷」开始：卷 → 章 → 场景，场景里写正文。'),
          h(
            'button',
            { class: 'btn sm primary', onclick: () => handlers.createNode('volume', null) },
            h('span', { class: 'btn-icon', html: ICONS.plus }),
            '新建第一卷',
          ),
        ),
      );
      container.scrollTop = 0;
      return;
    }

    for (const { node, depth } of rows) {
      const isCur = node.id === state.currentDocId;
      const isContainer = node.kind !== 'scene';
      const collapsed = state.collapsed.has(node.id);
      const childCount = isContainer ? childrenOf(state, node.id).length : 0;
      const isEditing = editing?.id === node.id;

      const row = h('div', {
        class: [
          'tree-row',
          `kind-${node.kind}`,
          isCur ? 'current' : '',
          collapsed ? 'collapsed' : '',
        ]
          .filter(Boolean)
          .join(' '),
        role: 'treeitem',
        'aria-selected': isCur ? 'true' : 'false',
        'aria-expanded': isContainer ? String(!collapsed) : null,
        tabIndex: isCur ? 0 : -1,
        dataset: { id: node.id, kind: node.kind, depth: String(depth) },
        draggable: node.kind === 'volume' ? 'false' : 'true',
        style: { paddingLeft: `${6 + depth * 14}px` },
      });

      // 折叠箭头
      const twisty = h('button', {
        class: `tree-twisty${isContainer ? '' : ' leaf'}`,
        tabIndex: -1,
        'aria-hidden': isContainer ? null : 'true',
        html: isContainer ? (collapsed ? ICONS.chevronRight : ICONS.chevronDown) : '',
        onclick: (ev: MouseEvent) => {
          ev.stopPropagation();
          if (isContainer) handlers.toggleCollapse(node.id);
        },
      });
      row.append(twisty);

      // 状态点
      row.append(h('span', { class: `dot ${node.status}`, title: DOC_STATUS_LABELS[node.status] }));

      // 标题 / 重命名输入框
      if (isEditing) {
        const input = h('input', {
          class: 'tree-rename',
          type: 'text',
          value: editing!.draft,
          dataset: { rename: node.id },
          oninput: (ev: Event) => {
            if (editing) editing.draft = (ev.target as HTMLInputElement).value;
          },
          onkeydown: (ev: KeyboardEvent) => {
            if (ev.isComposing) return;
            if (ev.key === 'Enter') {
              ev.preventDefault();
              commitRename();
            } else if (ev.key === 'Escape') {
              ev.preventDefault();
              ev.stopPropagation();
              cancelRename();
            }
          },
          onblur: () => {
            // 失焦即提交：作者按 Tab 或点别处时不该丢掉刚敲的名字
            if (editing) commitRename();
          },
          onclick: (ev: MouseEvent) => ev.stopPropagation(),
        });
        row.append(input);
      } else {
        const titleEl = h('span', { class: 'tree-title truncate' }, node.title);
        row.append(titleEl);
        // 场景的字数；容器显示子项计数
        if (node.kind === 'scene') {
          row.append(h('span', { class: 'tree-words tabular' }, node.word_count > 0 ? fmtNum(node.word_count) : ''));
        } else {
          row.append(h('span', { class: 'tree-count tabular' }, childCount > 0 ? String(childCount) : ''));
        }
      }

      // 容器行悬停时出现的「新建」快捷按钮
      if (isContainer && !isEditing) {
        const addTitle = node.kind === 'volume' ? '新建章' : '新建场景';
        row.append(
          h('button', {
            class: 'tree-add',
            title: addTitle,
            'aria-label': addTitle,
            html: ICONS.plus,
            onclick: (ev: MouseEvent) => {
              ev.stopPropagation();
              handlers.createNode(node.kind === 'volume' ? 'chapter' : 'scene', node.id);
            },
          }),
        );
      }

      // 点击选择
      row.addEventListener('click', (ev) => {
        if (isEditing) return;
        if ((ev.target as HTMLElement).closest('.tree-twisty, .tree-add')) return;
        handlers.selectDoc(node.id);
      });
      row.addEventListener('dblclick', (ev) => {
        ev.preventDefault();
        startRename(node.id);
      });
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!isCur) handlers.selectDoc(node.id);
        openMenu(ev, node);
      });

      // ── 拖拽源 ──
      if (node.kind !== 'volume') {
        row.addEventListener('dragstart', (ev) => {
          if (isEditing) {
            ev.preventDefault();
            return;
          }
          drag = { id: node.id, kind: node.kind };
          ev.dataTransfer?.setData('text/plain', node.id);
          if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
          row.classList.add('dragging');
        });
        row.addEventListener('dragend', () => {
          drag = null;
          row.classList.remove('dragging');
          clearDropMarks();
        });
      }

      // ── 放置目标 ──
      if (node.kind !== 'scene') {
        row.addEventListener('dragover', (ev) => {
          if (!drag || drag.id === node.id || !canDrop(drag.kind, node.kind)) return;
          ev.preventDefault();
          if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';

          const rect = row.getBoundingClientRect();
          const ratio = (ev.clientY - rect.top) / rect.height;
          clearDropMarks();

          // 章的上下边缘：作为同级插入（换卷）；中间：放进该章
          if (drag.kind === 'chapter' && node.kind === 'volume') {
            row.classList.add(ratio < 0.5 ? 'drop-before' : 'drop-after');
            const siblings = childrenOf(state!, node.parent_id);
            const order = ratio < 0.5 ? node.order : node.order + 1;
            dropTarget = { el: row, parentId: node.parent_id ?? '', order };
            void siblings;
          } else if (drag.kind === 'scene' && node.kind === 'chapter') {
            row.classList.add('drop-into');
            const siblings = childrenOf(state!, node.id).filter((n) => n.kind === 'scene');
            dropTarget = { el: row, parentId: node.id, order: siblings.length + 1 };
          }
        });
        row.addEventListener('dragleave', (ev) => {
          if (row.contains(ev.relatedTarget as Node | null)) return;
          row.classList.remove('drop-into', 'drop-before', 'drop-after');
        });
        row.addEventListener('drop', (ev) => {
          ev.preventDefault();
          const target = dropTarget;
          const source = drag;
          clearDropMarks();
          row.classList.remove('drop-into', 'drop-before', 'drop-after');
          if (!source || !target) return;
          if (source.id === node.id) return;
          handlers.moveNode(source.id, target.parentId, target.order);
          drag = null;
        });
      }

      list.append(row);
    }

    // 空白区域：右键出新建菜单，点击取消选中态焦点
    container.scrollTop = scrollTop;
  };

  list.addEventListener('contextmenu', (ev) => {
    if ((ev.target as HTMLElement).closest('.tree-row')) return;
    ev.preventDefault();
    openMenu(ev, null);
  });

  // 点击空白处 / 滚动时关闭上下文菜单
  const onDocPointerDown = (ev: MouseEvent): void => {
    if (menuEl && !menuEl.contains(ev.target as Node)) closeMenu();
  };
  const onScroll = (): void => closeMenu();
  const onResize = (): void => closeMenu();
  const onKeydown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') closeMenu();
  };
  document.addEventListener('mousedown', onDocPointerDown, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('keydown', onKeydown);

  const mountHeadActions = (head: HTMLElement): void => {
    headActionsEl?.remove();
    const wrap = h('div', { class: 'tree-head-actions' });
    wrap.append(
      h('button', {
        class: 'icon-btn',
        title: '新建卷',
        'aria-label': '新建卷',
        html: ICONS.plus,
        onclick: () => handlers.createNode('volume', null),
      }),
      h('button', {
        class: 'icon-btn',
        title: '更多（在树上右键）',
        'aria-label': '更多',
        html: ICONS.dots,
        onclick: (ev: MouseEvent) => {
          const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
          openMenu({ clientX: rect.right - 4, clientY: rect.bottom + 4 } as MouseEvent, null);
        },
      }),
    );
    head.append(wrap);
    headActionsEl = wrap;
  };

  return {
    mountHeadActions,
    update: (next: AppState) => {
      state = next;
      paint();
    },
    destroy: () => {
      closeMenu();
      document.removeEventListener('mousedown', onDocPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKeydown);
      container.textContent = '';
    },
  };
}

/** 状态色（与 base.css 的 .dot.xxx 保持一致，供右键菜单内联使用） */
export const STATUS_VARS: Record<DocStatus, string> = {
  idea: 'var(--ink-4)',
  draft: 'var(--info)',
  revising: 'var(--warn)',
  final: 'var(--ok)',
  published: 'var(--accent)',
};

export { NODE_KIND_LABELS };
