/**
 * 移动端交互层。
 *
 * 桌面端三栏在手机上换成：单栏编辑器 + 左右抽屉 + 底部导航。
 *
 * 为什么单独成模块：
 *   shell.ts 是桌面布局的装配代码，把触摸手势、抽屉开合、媒体查询监听
 *   塞进去会让它变成两种形态的混合体，后续维护会很容易踩到对方的假设。
 *   这里只做「移动端形态」这一件事，桌面端完全不加载它的行为。
 *
 * 关键约束：
 *   - 抽屉开合只改 .app-shell 上的 class，布局由 mobile.css 负责
 *   - 不直接操作 store 的 sidebarOpen/inspectorOpen（那是桌面语义），
 *     而是用独立的 drawer 状态，避免桌面状态机与移动形态互相污染
 *   - 所有触摸监听用 passive 或显式 preventDefault，避免拖拽时页面抖动
 */

import type { AppState, Store } from '../lib/store.ts';

/**
 * 移动端断点，必须与 mobile.css 的 960px 一致。
 *
 * 取 960 而非 760：820px 的 iPad Air 用三栏时编辑器只剩 262px，
 * 中文正文一屏不到 20 字，已不可写作。宁可让平板也用抽屉。
 */
export const MOBILE_BREAKPOINT = 960;

export type DrawerSide = 'sidebar' | 'inspector' | null;

export interface MobileHandlers {
  /** 切到某篇文档后收起抽屉（手机上选完就该看到正文） */
  onDrawerClose(): void;
  onToggleSidebar(): void;
  onToggleInspector(): void;
  onOpenSearch(): void;
  onOpenInbox(): void;
  onOpenSettings(): void;
  onSave(): void;
  onToggleFocus(): void;
}

export interface MobileNavItem {
  id: string;
  label: string;
  /** 内联 SVG 字符串 */
  icon: string;
  onClick(): void;
}

/**
 * 判断当前是否移动端形态。
 * 用 matchMedia 而不是 window.innerWidth：它能在旋转屏幕、
 * 拖拽窗口、平板分屏时自动更新，且不需要监听 resize 节流。
 */
export function isMobileViewport(): boolean {
  return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
}

export class MobileShell {
  private store: Store;
  private handlers: MobileHandlers;
  private root: HTMLElement | null = null;
  private scrim: HTMLElement | null = null;
  private nav: HTMLElement | null = null;
  private navButtons = new Map<string, HTMLButtonElement>();
  private navDots = new Map<string, HTMLElement>();
  private drawer: DrawerSide = null;
  private mql: MediaQueryList;
  private cleanups: Array<() => void> = [];
  private touchStartX = 0;
  private touchStartY = 0;
  private touchTracking = false;

  constructor(store: Store, handlers: MobileHandlers) {
    this.store = store;
    this.handlers = handlers;
    this.mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`);
  }

  /** 挂载到 app-shell 元素上（在 shell 渲染完成后调用） */
  mount(root: HTMLElement, navItems: MobileNavItem[]): void {
    this.root = root;

    // 遮罩：点击关闭抽屉
    this.scrim = document.createElement('div');
    this.scrim.className = 'drawer-scrim';
    this.scrim.setAttribute('aria-hidden', 'true');
    this.scrim.addEventListener('click', () => this.closeDrawer());
    root.appendChild(this.scrim);

    // 底部导航
    this.nav = document.createElement('nav');
    this.nav.className = 'mobile-nav';
    this.nav.setAttribute('aria-label', '移动端导航');
    for (const item of navItems) {
      const btn = document.createElement('button');
      btn.className = 'mobile-nav-btn';
      btn.type = 'button';
      btn.dataset.nav = item.id;
      btn.setAttribute('aria-label', item.label);
      btn.innerHTML = `${item.icon}<span>${item.label}</span>`;

      // 保存按钮上的状态圆点
      if (item.id === 'save') {
        const dot = document.createElement('span');
        dot.className = 'mn-dot';
        btn.appendChild(dot);
        this.navDots.set(item.id, dot);
      }

      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        item.onClick();
      });
      this.nav.appendChild(btn);
      this.navButtons.set(item.id, btn);
    }
    root.appendChild(this.nav);

    // 媒体查询变化：进出移动形态时清理抽屉状态
    const onMqlChange = () => {
      if (!this.mql.matches) this.closeDrawer();
      this.syncVisibility();
    };
    this.mql.addEventListener('change', onMqlChange);
    this.cleanups.push(() => this.mql.removeEventListener('change', onMqlChange));

    this.setupGestures();
    this.syncVisibility();

    // 初始状态同步
    this.update(this.store.state, new Set());
  }

  private setupGestures(): void {
    if (!this.root) return;

    // 从屏幕边缘向右滑打开侧栏，向左滑打开面板
    const onTouchStart = (ev: TouchEvent) => {
      if (!this.mql.matches) return;
      if (ev.touches.length !== 1) return;
      const t = ev.touches[0];
      this.touchStartX = t.clientX;
      this.touchStartY = t.clientY;
      // 只在靠近边缘时启动跟踪，避免和正文滚动冲突
      const edge = 28;
      this.touchTracking =
        this.drawer === null && (t.clientX <= edge || t.clientX >= window.innerWidth - edge);
    };

    const onTouchEnd = (ev: TouchEvent) => {
      if (!this.touchTracking || !this.mql.matches) {
        this.touchTracking = false;
        return;
      }
      this.touchTracking = false;
      const t = ev.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - this.touchStartX;
      const dy = t.clientY - this.touchStartY;
      // 横向位移要明显大于纵向，否则视为滚动
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.6) return;

      const edge = 28;
      if (dx > 0 && this.touchStartX <= edge) {
        this.openDrawer('sidebar');
      } else if (dx < 0 && this.touchStartX >= window.innerWidth - edge) {
        this.openDrawer('inspector');
      }
    };

    this.root.addEventListener('touchstart', onTouchStart, { passive: true });
    this.root.addEventListener('touchend', onTouchEnd, { passive: true });
    this.cleanups.push(() => {
      this.root?.removeEventListener('touchstart', onTouchStart);
      this.root?.removeEventListener('touchend', onTouchEnd);
    });

    // Esc 关闭抽屉（外接键盘 / iPad）
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && this.drawer) {
        ev.stopPropagation();
        this.closeDrawer();
      }
    };
    document.addEventListener('keydown', onKey, true);
    this.cleanups.push(() => document.removeEventListener('keydown', onKey, true));

    // 旋转屏幕后如果变成桌面形态，关掉抽屉
    const onResize = () => {
      if (!this.mql.matches && this.drawer) this.closeDrawer();
    };
    window.addEventListener('resize', onResize);
    this.cleanups.push(() => window.removeEventListener('resize', onResize));
  }

  openDrawer(side: Exclude<DrawerSide, null>): void {
    if (!this.mql.matches) return;
    this.drawer = side;
    this.applyDrawerClass();
    // 抽屉打开时把焦点移到第一个可聚焦元素，方便键盘/读屏用户
    const target =
      side === 'sidebar'
        ? this.root?.querySelector<HTMLElement>('.sidebar')
        : this.root?.querySelector<HTMLElement>('.inspector');
    if (target) {
      const focusable = target.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      focusable?.focus({ preventScroll: true });
    }
  }

  closeDrawer(): void {
    if (!this.drawer) return;
    this.drawer = null;
    this.applyDrawerClass();
  }

  toggleDrawer(side: Exclude<DrawerSide, null>): void {
    if (this.drawer === side) this.closeDrawer();
    else this.openDrawer(side);
  }

  get currentDrawer(): DrawerSide {
    return this.drawer;
  }

  private applyDrawerClass(): void {
    if (!this.root) return;
    const open = this.drawer !== null;
    this.root.classList.toggle('mobile-drawer-open', open);
    this.root.classList.toggle('mobile-drawer-sidebar', this.drawer === 'sidebar');
    this.root.classList.toggle('mobile-drawer-inspector', this.drawer === 'inspector');
    // 抽屉打开时禁止背景滚动（iOS 需要同时设 overflow 与 touch-action）
    document.body.style.overflow = open ? 'hidden' : '';
    this.syncNavActive();
  }

  /** 桌面形态下隐藏遮罩与底部导航（CSS 也管，这里保证 DOM 不拦截事件） */
  private syncVisibility(): void {
    const mobile = this.mql.matches;
    if (this.scrim) this.scrim.style.display = mobile ? '' : 'none';
    if (this.nav) this.nav.style.display = mobile ? 'flex' : 'none';
    if (!mobile) this.closeDrawer();
  }

  /** store 变化时更新底部导航的激活态与保存指示 */
  update(state: AppState, changed: Set<keyof AppState>): void {
    if (changed.has('saveState')) {
      const dot = this.navDots.get('save');
      if (dot) {
        dot.className = 'mn-dot';
        const s = state.saveState;
        if (s === 'dirty') dot.classList.add('dirty');
        else if (s === 'error' || s === 'conflict') dot.classList.add('error');
        else if (s === 'saving') dot.classList.add('saving');
      }
    }
    if (changed.has('rightPanel') || changed.has('inspectorOpen')) {
      this.syncNavActive();
    }
    if (changed.has('settings')) {
      this.syncNavActive();
    }
  }

  private syncNavActive(): void {
    // 「稿件」在抽屉打开时高亮；「面板」在面板抽屉打开或面板可见时高亮
    const outlineBtn = this.navButtons.get('outline');
    if (outlineBtn) {
      outlineBtn.classList.toggle('active', this.drawer === 'sidebar');
    }
    const panelBtn = this.navButtons.get('panel');
    if (panelBtn) {
      panelBtn.classList.toggle(
        'active',
        this.drawer === 'inspector' ||
          (this.store.state.inspectorOpen && this.store.state.rightPanel !== 'none'),
      );
    }
  }

  destroy(): void {
    for (const fn of this.cleanups) {
      try {
        fn();
      } catch {
        /* 忽略 */
      }
    }
    this.cleanups = [];
    this.scrim?.remove();
    this.nav?.remove();
    this.scrim = null;
    this.nav = null;
    this.root = null;
    document.body.style.overflow = '';
  }
}

// ─────────────────────── 底部导航图标 ───────────────────────

const svg = (paths: string): string =>
  `<svg width="21" height="21" viewBox="0 0 16 16" fill="none" stroke="currentColor" ` +
  `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const MOBILE_ICONS = {
  outline: svg('<path d="M3 3.5h10M3 8h10M3 12.5h6"/>'),
  panel: svg(
    '<rect x="2.2" y="2.8" width="11.6" height="10.4" rx="1.6"/><path d="M9.8 2.8v10.4"/>',
  ),
  search: svg('<circle cx="7.1" cy="7.1" r="4.1"/><path d="m10.2 10.2 3 3"/>'),
  inbox: svg(
    '<path d="M2.4 8.6 4 3.2h8l1.6 5.4v3.4a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1z"/><path d="M2.4 8.6h3.2l.9 1.6h3l.9-1.6h3.2"/>',
  ),
  settings: svg(
    '<circle cx="8" cy="8" r="2.1"/><path d="M8 2.2v1.5M8 12.3v1.5M2.2 8h1.5M12.3 8h1.5M3.9 3.9l1 1M11.1 11.1l1 1M12.1 3.9l-1 1M4.9 11.1l-1 1"/>',
  ),
  save: svg('<path d="M3.2 2.8h7l2.6 2.6v7.8H3.2z"/><path d="M5.6 2.8v3.4h4.2V2.8"/><path d="M5.6 13.2V9.4h4.8v3.8"/>'),
};

/** 构造移动端底部导航项（由 app.ts 传入真实动作） */
export function buildMobileNav(handlers: MobileHandlers, actions: {
  openOutline(): void;
  openPanel(): void;
}): MobileNavItem[] {
  return [
    { id: 'outline', label: '稿件', icon: MOBILE_ICONS.outline, onClick: () => actions.openOutline() },
    { id: 'search', label: '搜索', icon: MOBILE_ICONS.search, onClick: () => handlers.onOpenSearch() },
    { id: 'save', label: '保存', icon: MOBILE_ICONS.save, onClick: () => handlers.onSave() },
    { id: 'panel', label: '面板', icon: MOBILE_ICONS.panel, onClick: () => actions.openPanel() },
    { id: 'inbox', label: '灵感', icon: MOBILE_ICONS.inbox, onClick: () => handlers.onOpenInbox() },
  ];
}
