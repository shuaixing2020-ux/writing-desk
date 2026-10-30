/**
 * 界面偏好（并排工作台用）。
 *
 * 存的是「作者怎么摆这个工作台」：检查器多宽、开没开、上次看的是哪个面板。
 * 这不是稿件数据，丢了最多是重新拖一次，所以放浏览器本地存储、不进项目文件。
 *
 * 三个约束：
 *   1. 读写全部 try/catch —— 隐私模式或存储被禁用时，界面不能跟着挂
 *   2. 宽度必须钳制 —— 再宽的检查器也不能把正文挤没
 *   3. 解析必须容错 —— 旧版本/被手改过的 JSON 都不能让应用起不来
 */

export const UI_PREFS_KEY = 'wd.ui.v1';

/** 检查器宽度下限：再窄就放不下面板内容 */
export const MIN_INSPECTOR_W = 300;
/** 检查器宽度上限：再宽正文就没法写了 */
export const MAX_INSPECTOR_W = 720;
/** 正文最小宽度：低于这个值读起来就难受了 */
export const MIN_EDITOR_W = 560;
/** 目录宽度（与 tokens.css 的 --sidebar-w 一致） */
export const SIDEBAR_W = 260;

/** 两档预设：窄栏 / 宽栏 */
export const PRESET_NARROW = 380;
export const PRESET_WIDE = 560;

export type OutlineMode = 'list' | 'map';

export interface UiPrefs {
  inspectorWidth: number;
  inspectorOpen: boolean;
  lastPanel: string | null;
  focusMode: boolean;
  outlineMode: OutlineMode;
}

export const DEFAULT_PREFS: UiPrefs = {
  inspectorWidth: PRESET_NARROW,
  inspectorOpen: true,
  lastPanel: null,
  focusMode: false,
  outlineMode: 'list',
};

/**
 * 把宽度钳制到「既在 [300,720] 内，又给正文留够 minEditor」的范围。
 *
 * 放不下时的取值：先尽量满足 minEditor；如果窗口小到连下限都放不下，
 * 就退到可用最大值但不低于 300 —— 此时正文会被压缩，这是作者自己
 * 把窗口拉这么小的必然结果，不能反过来把检查器变成负数。
 */
export function clampInspectorWidth(
  w: number,
  viewport: number,
  minEditor: number = MIN_EDITOR_W,
  sidebarW: number = SIDEBAR_W,
): number {
  // 非有限数（NaN/Infinity）经 Math.min/max 会一路传播成 NaN，
  // 最终把 style 写成 "NaNpx"，检查器直接消失。先挡掉。
  const safeW = Number.isFinite(w) ? w : MIN_INSPECTOR_W;
  const safeViewport = Number.isFinite(viewport) ? viewport : MIN_INSPECTOR_W + sidebarW + minEditor;

  const available = safeViewport - sidebarW - minEditor;
  const upper = Math.min(MAX_INSPECTOR_W, Math.max(MIN_INSPECTOR_W, available));
  const lower = MIN_INSPECTOR_W;
  const clamped = Math.max(lower, Math.min(upper, Math.round(safeW)));
  return clamped;
}

/** 解析持久化的偏好；损坏、缺字段、类型不对都回退默认值，绝不抛错 */
export function parsePrefs(raw: string | null): UiPrefs {
  if (!raw) return { ...DEFAULT_PREFS };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_PREFS };
  }
  if (!data || typeof data !== 'object') return { ...DEFAULT_PREFS };
  const o = data as Record<string, unknown>;

  const width = typeof o.inspectorWidth === 'number' && Number.isFinite(o.inspectorWidth)
    ? o.inspectorWidth
    : DEFAULT_PREFS.inspectorWidth;

  return {
    // 这里只做「是否可接受」的判断；视口相关的钳制交给调用方（它才知道窗口多大）
    inspectorWidth: Math.max(MIN_INSPECTOR_W, Math.min(MAX_INSPECTOR_W, Math.round(width))),
    inspectorOpen: typeof o.inspectorOpen === 'boolean' ? o.inspectorOpen : DEFAULT_PREFS.inspectorOpen,
    lastPanel: typeof o.lastPanel === 'string' ? o.lastPanel : null,
    focusMode: typeof o.focusMode === 'boolean' ? o.focusMode : DEFAULT_PREFS.focusMode,
    outlineMode: o.outlineMode === 'map' ? 'map' : 'list',
  };
}

/** 最小可用的存储接口，方便测试注入，也兼容 localStorage 不可用的环境 */
export interface PrefStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 读取偏好：任何异常都退回默认值 */
export function loadPrefs(storage?: PrefStorage | null): UiPrefs {
  try {
    const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!s) return { ...DEFAULT_PREFS };
    return parsePrefs(s.getItem(UI_PREFS_KEY));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** 保存偏好：失败静默（存不了偏好不该打断写作） */
export function savePrefs(prefs: UiPrefs, storage?: PrefStorage | null): void {
  try {
    const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!s) return;
    s.setItem(UI_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* 存储不可用：本次会话内仍然生效，只是刷新后恢复默认 */
  }
}

/** 键盘方向键调整步长 */
export const WIDTH_STEP = 16;

/** 方向键调整后的宽度（已钳制） */
export function stepInspectorWidth(
  current: number,
  delta: -1 | 1,
  viewport: number,
): number {
  return clampInspectorWidth(current + delta * WIDTH_STEP, viewport);
}
