/**
 * 右侧面板汇总 —— 外壳唯一的面板入口。
 *
 * 契约：必须导出 `panels: PanelDef[]`，app.ts 会
 *   import { panels } from './components/panels/index.ts'
 * 并按 id 注册。顺序即 inspector 顶部 tab 的显示顺序：
 * 写作时最常用的在左，维护类（设置）在右。
 */

import type { PanelDef } from '../../lib/contracts.ts';
import { panel as outlinePanel } from './outline.ts';
import { panel as biblePanel } from './bible.ts';
import { panel as graphPanel } from './graph.ts';
import { panel as searchPanel } from './search.ts';
import { panel as lintPanel } from './lint.ts';
import { panel as snapshotsPanel } from './snapshots.ts';
import { panel as statsPanel } from './stats.ts';
import { panel as inboxPanel } from './inbox.ts';
import { panel as settingsPanel } from './settings.ts';

export const panels: PanelDef[] = [
  outlinePanel,
  biblePanel,
  graphPanel,
  searchPanel,
  lintPanel,
  snapshotsPanel,
  statsPanel,
  inboxPanel,
  settingsPanel,
];

export default panels;
