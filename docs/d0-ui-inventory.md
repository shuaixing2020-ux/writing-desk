# D0 · UI 现状盘点（只读，不改代码）

| 项 | 值 |
|---|---|
| 盘点时间 | 2026-10-30 07:52 |
| 基线提交 | `6403ab4` 修复命令面板点不动、接入全书搜索、给图谱加显眼入口 |
| 仓库文件数 | 118 |
| 本任务改动 | **仅新增本文档**，未修改任何代码 |
| 结论时效 | 本文所有行号对应上述提交；后续改动需重新核对 |

> 标注约定：**确定** = 读到了源码；**推断** = 从调用关系推得，未直接看到；**不确定** = 无法从代码判断。

---

## 一、结论摘要（把方案的「待核对」变成事实）

| # | 方案里的待核对项 | 结论 |
|---|---|---|
| 1 | 删除路由是否用 `withSaveLock` | **没有用**。`withSaveLock` 只被保存路由（`docs.ts:281`）和关系服务（`graph/service.ts:297,557,558,645`）使用。删除路由（`docs.ts:175`）全程无锁 → **C1 必须补锁** |
| 2 | 恢复回收站后出场索引是否重建 | **会**。`syncTreeToIndex`（`routes/shared.ts:286`）对「不在索引或元数据变旧」的场景调用 `indexer.indexDoc`，而 `indexDoc` 内部会 `mentions.scanDoc`（`services/indexer.ts:57`）→ 出场统计会重新生成 |
| 3 | 现有节点接口有哪些 | **「新建 / 改名 / 移动」都已有**，见 Q6。缺的是**批量删除/批量恢复**（C1）和**同级重排语义的明确化** |
| 4 | 树上现有删除入口 | **只有右键菜单**（`tree.ts:73,81`）。没有悬停按钮、没有 Delete 键、没有多选 |
| 5 | 大纲面板能否编辑结构 | **不能**。只能写摘要 + 新建场景；标题是按钮不是输入框；无改名/缩进/提升/排序 |
| 6 | `toast` 是否支持动作按钮（撤销） | **不支持**。签名 `toast(ctx, message, kind)`（`shared.ts:414`），无第四参数 |
| 7 | 检查器能否改宽 | **不能**。宽度是固定的 CSS 变量 `--inspector-w: 300px`（`tokens.css:79`），无拖拽、无预设 |

---

## 二、逐题回答

### Q1 `shell.ts` 布局、检查器挂载、宽度、抽屉

**答案（确定）**

- 布局是三层 CSS Grid：`.app-shell` 纵向 `topbar / workspace / statusbar`；`.workspace` 横向三列
  `var(--sidebar-w) minmax(0,1fr) var(--inspector-w)`（`app.css:168`）。
- 检查器在 `shell.ts:304-312` 构造，`workspace = sidebar + editorMount + inspector`（`shell.ts:316`）；
  面板内容挂在 `inspectorBody`（`shell.ts:303`），由 app.ts 的 `mountPanel` 填充。
- 宽度来源：`tokens.css:79 --inspector-w: 300px`；`app.css:703 .inspector-inner { width: var(--inspector-w) }`；
  窄屏两档覆盖在 `app.css:1398`（280px）与 `app.css:1404`（260px）。
- **没有任何拖拽改宽**：全仓无 `role="separator"`、无 `pointerdown` 调整宽度的代码（已确认）。
- ≤960px 抽屉逻辑在 **`mobile.css:133` 起的媒体查询**（`.sidebar`/`.inspector` 改 `position: fixed`，
  `mobile.css:223,246`），行为由 `mobile.ts` 的 `matchMedia('(max-width: 960px)')` 驱动（`mobile.ts:26` 附近常量与 `MobileShell`）。

**对 L1 的影响**：改宽要动 3 处（tokens 变量、`.inspector-inner`、workspace grid 的第三列）。
建议不动 `--inspector-w` 的语义，而是新增 `--inspector-w-current` 由 JS 写入，或给 `.app-shell` 加内联变量覆盖 —— 都能避免影响 ≤960px。

### Q2 `tree.ts` 渲染、选择模型、删除入口、拖拽、tree_changed

**答案（确定）**

- 行渲染：`createTree(container, handlers)`（`tree.ts:41`），每行 `.tree-row`，
  `aria-selected` 只标当前文档（`tree.ts:289`）。
- **选择模型是单选**：只有「当前文档」一个概念，没有多选集合、没有 Ctrl/Shift 修饰键处理。
- 删除入口：**仅右键菜单**（`tree.ts:379` 打开菜单；菜单项 `删除卷`/`删除章` 在 `tree.ts:73,81`）。
  无悬停按钮；无 Delete/Backspace 键（`tree.ts:465` 的 keydown 只处理 Escape 关菜单）。
- 拖拽排序：HTML5 `dragstart/dragover/drop`（`tree.ts:388-442`），
  **只允许同层移动** `scene→chapter`、`chapter→volume`（`canDrop` 在 `tree.ts:231-233`），卷不可拖（`tree.ts:293`）；
  drop 后调 `handlers.moveNode(id, parentId, order)`。
- 响应 `tree_changed`：不在 tree.ts 内部。app.ts 的 WS 处理（`app.ts:1643`）→ `actions.refreshTree()`
  → `store.set({ nodes })` → 订阅里 `tree.update(state)`。

**对 C2 的影响**：多选是**全新能力**，不是在现有模型上扩展；需要新增 `selection: Set<string>`
（放 store 或 tree 内部）并区分「当前文档」与「选中的行」两个概念。Delete 键需要新增全局 keydown 分支，
但要避免与编辑器输入冲突（焦点在编辑器时不生效）。

### Q3 `panels/outline.ts` 渲染什么、数据来源、摘要编辑、结构操作

**答案（确定）**

- 渲染全书层级平铺列表（`flatten`，`outline.ts:23`），数据来自 `ctx.store.state`（即 app 的 nodes 数组）。
- 每行 = 标题按钮 + 摘要 `<textarea class="p-outline-summary">`（`outline.ts:178`）；
  摘要失焦保存到 `actions.updateNodeMeta(id, { summary })`（`outline.ts:203`）。
- 结构操作：**只有「新建场景」**（`outline.ts:251`）与空状态下的「新建第一卷」（`outline.ts:113`）。
  没有改名、没有缩进/提升、没有排序、没有删除。

**对 O2 的影响**：现有行是「标题按钮」，要改成「标题输入框 + 键盘操作」，
本质上是**重写 renderRow**，不是加事件。建议 O2 保留现有摘要编辑块，只替换标题部分。

### Q4 面板注册、`PanelContext` 字段、能否声明期望宽度

**答案（确定）**

- 注册：`panels/index.ts` 导出 `panels: PanelDef[]`；shell 取 `panels.filter(p => p.inInspector)` 生成标签（`shell.ts:165,279`）。
- `PanelContext`（`contracts.ts:…`）：`store` / `api` / `actions` / `toast(message,kind)` / `openOverlay(kind,payload)` / `closeOverlay()` / `refresh()`。
- **不能声明期望宽度**：`PanelDef`（`contracts.ts:32-41`）只有 `id/title/icon/inInspector/mount`。

**对 R3 的影响**：图谱面板想要「窄栏只显示图、宽栏显示图+边列表」，需要知道当前栏宽。
两条路：给 `PanelDef` 加可选 `preferredWidth`（符合 U2「只允许新增可选字段」），
或让面板监听 `.inspector-body` 的 `ResizeObserver`。**建议后者**，不碰面板契约。

### Q5 `toast` 与 `confirmDanger` 签名

**答案（确定）**

```ts
// shared.ts:414
export function toast(ctx: PanelContext, message: string, kind: ToastKind = 'info'): void;
// contracts.ts:18（PanelContext 上）
toast(message: string, kind?: ToastKind): void;
```

- **不支持动作按钮**。实现是 `overlays.toast(...)`，只有文案与类型。
- `confirmDanger`（`shared.ts:362-364`）：

```ts
export function confirmDanger(
  ctx: PanelContext,
  opts: { title: string; message: string; confirmText?: string; cancelText?: string; danger?: boolean },
): Promise<boolean>;
```
  内部优先用应用内弹层（`ctx.openOverlay('confirm', …)`），不可用时**回退 `window.confirm`**（`shared.ts:374-377`）。

**对 C2 的影响**：撤销提示需要动作按钮 → 必须扩展 toast。建议新增可选第 4 参
`opts?: { actionLabel?: string; onAction?: () => void; ms?: number }`，保持现有调用不变（向后兼容）。
注意「回退 window.confirm」意味着弹层不可用时无法带按钮，撤销提示应在这种情况下退化为纯文本 + 引导去回收站。

### Q6 `routes/docs.ts` 节点相关路由

**答案（确定）**

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| GET | `/api/projects/:pid/tree`（`docs.ts:47`） | — | `DocTree` |
| POST | `/api/projects/:pid/nodes`（`docs.ts:56`） | `{ kind, parent_id, title }` | `DocNode` |
| PATCH | `/api/projects/:pid/nodes/:id`（`docs.ts:81`） | 改名或元数据（title/status/summary/pov/time/tags/plotlines） | `DocNode` 或 `{ok}` |
| POST | `/api/projects/:pid/nodes/:id/move`（`docs.ts:159`） | `{ parent_id, order }` | `{ ok: true }` |
| DELETE | `/api/projects/:pid/nodes/:id`（`docs.ts:175`） | — | `{ ok: true, deleted: number }` |
| GET | `/api/projects/:pid/scenes/:id`（`docs.ts:226`） | — | `SceneContent` |
| POST | `/api/projects/:pid/scenes/:id`（`docs.ts:237`） | `{ body, base_rev }` | `SaveSceneResponse` |

补充（确定）：
- `move` **同时支持跨父移动与同父重排**：`ProjectStore.moveNode` 内若目标目录相同则只调 `renumberSiblings`（`project.ts` 的 moveNode 分支）。
- **没有**批量删除、批量恢复、同级「上下移」专用接口（后者可用 move 实现）。
- 删除路由**返回 `{ok, deleted}`，不含回收站 id** —— 与方案判断一致。

**对 C1 的影响**：接口清单确认，只需加两个批量接口；**O1 可能不需要新增后端接口**（新建/改名/移动都有）。
但 `POST /nodes` 的 body 没有 `index`，新建只能追加到末尾 —— O1 的 `createSibling(index)` 需要
「新建后立刻 move」两步，或给 `POST /nodes` 增加可选 `index`（向后兼容）。

### Q7 `readTree` 顺序、标题来源、改名是否改文件名

**答案（确定）**

- 顺序：`nodes.sort` 按 `parent_id` 分组后按 `order` 再按标题（`project.ts:279`）；
  `order` 取自 frontmatter `order`，**缺失时回退文件名前缀**（`project.ts:356,384` → `parseOrderPrefix`）。
- 标题：frontmatter `title`，缺失时回退文件名去前缀（`project.ts:356,378-384`）。
- **改名会改文件名/目录名**：`containerFileName(kind, order, title)` 生成 `v01-标题` / `c001-标题` / `s0001-标题.md`（`project.ts:481`），
  重排时前缀序号也会变（`renumberSiblings`，`project.ts:667-712`）。

**对 C1 的影响（重要）**：顺序**由文件名前缀与 frontmatter order 共同决定**，且二者会被重排逻辑同步改写。
因此「删除后按原顺序恢复」**不能用 `_trash.json` 里记的序号**（序号会被别人重排改掉），
而应当：**整目录移走 → 恢复时原样移回**，文件名前缀本身就带顺序，天然保持相对位置。
若同一父目录下的兄弟被单独删除，其余兄弟的前缀不变（现有 `renumberSiblings` 只在显式重排时触发），
恢复回去后同名文件已不存在，直接放回原位即可。**结论：C1 无需在 `_trash.json` 里加 `order_index`**。

### Q8 恢复回收站后出场识别是否重跑

**答案（确定，含一条链路说明）**

`trash.ts` 恢复路由 → `syncTreeToIndex(ctx)`（`routes/shared.ts:286`）
→ 对 `getDoc` 为空或元数据不一致的场景调用 `ctx.indexer.indexDoc(node)`（`shared.ts:299`）
→ `IndexerService.indexDoc` 末尾 `await this.ctx.mentions.scanDoc(node.id, scene.body)`（`services/indexer.ts:57`）。

删除时 `trash.ts` 会 `ctx.indexer.removeDoc(item.id)` 清掉索引，所以恢复时 `indexed` 为空 → 必然 `stale` → 必然重扫。
**结论：恢复后出场统计会正确重建，无需额外补接口。**（C1 的对应验收项可通过「删除→恢复→查出场次数」验证。）

### Q9 `withSaveLock` 定义、使用方、删除路由是否使用

**答案（确定）**

- 定义：`server/routes/docs.ts:446`，`export function withSaveLock<T>(ctx, docId, fn)`，按「项目根 + docId」串行化。
- 使用方：
  - 场景保存 `docs.ts:281`
  - 关系服务 `graph/service.ts:297`（mutateRelations）、`557/558`（reverse 双锁，按 id 排序避免死锁）、`645`（retarget）
- **删除路由未使用**（`docs.ts:175` 起整段无 `withSaveLock`）。

**对 C1 的影响（关键）**：现在删除与保存可以交错。虽然 app 层 `deleteNode` 动作会先 `await saveNow()`（见 Q10），
但服务端没有兜底。**C1 的删除/恢复必须在 `withSaveLock` 内**，且因为要锁多个文档，
建议按 docId 排序逐个获取，或在项目级加一把 `treeLock`（新增，但要与 `withSaveLock` 语义一致、避免与保存死锁）。

### Q10 编辑器未保存正文的冲刷、外部保存入口、当前文档被删

**答案（确定）**

- `EditorHandle`（`editor.ts:55`）暴露：`getValue / setContext / focus / revealRange / getStats / isDirty / markSaved / saveCaret / setTypewriter / destroy`。
  **没有 flush/save 方法** —— 编辑器不负责落盘。
- 保存由 app.ts 的 `saveNow()`（`app.ts:397`）驱动：去抖 2s、失焦、切文档、`beforeunload` 都会触发。
- **删除当前文档的处理已有**：`app.ts` 的 `deleteNode` 动作在删除前 `await saveNow()`（冲刷未保存正文），
  删除后若删的是当前文档，则 `selectDoc(firstSceneId(...))`，没有可切的就 `currentDocId: null` + 清空编辑器。

**对 C2 的影响**：C2 可以直接复用 `saveNow()`，无需新增编辑器接口。但要注意
`app.ts` 的 `deleteNode` 是**单个 id + 必弹确认**的旧语义，C2 需要新增批量版本，不能改旧动作的对外行为（避免破坏现有右键菜单）。

### Q11 `store.ts` 状态形状与 `tree_changed` 刷新链路

**答案（确定）**

- `AppState`（`store.ts:71`）关键字段：`nodes: DocNode[]`、`currentDocId: string | null`、`collapsed: Set<string>`、
  `rightPanel`、`entities`、`saveState` 等。**没有「多选集合」字段**。
- 刷新链路：WS 事件 `tree_changed`（`app.ts:1643`，且校验 `project_id` 与当前作品一致）
  → `actions.refreshTree()`（`app.ts:1856`）→ `store.set({ nodes })` → 订阅回调里 `tree.update` + `syncPanel`。

**对 C2/O2 的影响**：多选与「大纲选中项」都需要新的状态。建议放 `store`（新增可选字段，U2 允许），
否则两个组件（tree 与 outline）无法共享选中项。

### Q12 `mobile.ts` 现有手势

**答案（确定）**

- 只有一种：**屏幕左右边缘（28px 内）向内滑动打开对应抽屉**（`mobile.ts:146-167`，`edge = 28`），
  用 `touchstart/touchend` + 位移阈值（横向 ≥60px 且大于纵向 1.6 倍）。
- 另有：Esc 关抽屉、`resize` 回桌面时自动关抽屉、`matchMedia` 变化同步。
- **没有**行长按、行左滑、多选手势。

**对 C3 的影响**：左滑删除会与「右边缘左滑开右侧抽屉」冲突。需限定：行内左滑只在**行元素上**起始、
且起点不在边缘 28px 内；或者只在 `x < innerWidth - 28` 时启用行手势。

### Q13 现有 e2e 结构

**答案（确定）**

- 单文件 `tests/e2e/run-e2e.mjs`，自建临时数据目录 + 自带服务器（`spawn` + `finally` 清理）。
- 结构：`check(name, fn)` 累积 pass/fail（`run-e2e.mjs:38`），`main()` 里按【1】API 契约…【3】关系图谱 分段（`125` 起）。
- 新增用例方式：在对应段落里 `await check('标题', async () => { … })`，用 `page.*` 操作 + `assert/assertEq`。
- 现有 22 项；`mobile-e2e.mjs` 是独立文件（17 项，自建测试作品并在结束时删除）。

**对 C2/O2/R2 的影响**：加用例成本低；但注意 e2e 里**已有的树操作断言是单选语义**，改造 tree.ts 时要保证旧用例仍过。

---

## 三、对任务书范围声明的修订建议

| 任务 | 方案预期 | 依据 D0 的修订 |
|---|---|---|
| C1 | 改 `project.ts` / `docs.ts` / `trash.ts` / `types.ts` | 确认。**另需**：删除/恢复要引入与 `withSaveLock` 一致的锁（Q9）；**不需要**给 `_trash.json` 加 `order_index`（Q7） |
| C2 | 改 `tree.ts` / `api.ts` / `shared.ts`(toast) / `app.css` | 确认。**另需**：`store.ts` 加多选字段（Q2/Q11）；新增批量删除的 app action（不动旧 `deleteNode`） |
| L1 | 改 `shell.ts` / `app.css` / `tokens.css` | 确认。建议不改 `--inspector-w` 语义，避免影响 ≤960px 的三档覆盖（Q1） |
| O1 | 可能需补后端接口 | **大概率不需要**（Q6：新建/改名/移动都有）。仅需决定「新建时指定 index」：加可选 `index` 或分两步 |
| O2 | 改 `outline.ts` 等 | 确认，但工作量是**重写行渲染**（Q3），不是加事件 |
| O3 | 新增 mindmap 组件 | 确认。建议不引入图形库的要求已满足（现有 SVG/DOM 足够） |
| R3 | 可能需整图接口 | 确认需要（现有只有按条目查关系，无整图）。栏宽感知建议用 `ResizeObserver` 而非改 `PanelDef`（Q4） |

---

## 四、不确定 / 需要人工确认的点

| # | 事项 | 为什么不确定 |
|---|---|---|
| 1 | 拖拽改宽的「手感」 | 代码层面可行，但阈值、吸附、反馈需要人工验收（U8 禁止模型代判） |
| 2 | 多选与「当前文档」的视觉区分 | 现有 `.tree-row` 只有 `aria-selected` 一种高亮样式；多选态需要新样式，是否够区分需人工看 |
| 3 | 撤销提示是否遮挡内容 | `toast` 固定在底部居中（`base.css .toast-wrap`），加按钮后宽度变化，需人工确认 |
| 4 | 导图在 300 节点下的实际流畅度 | 渲染策略可行，但真机帧率需实测 |
| 5 | 同一父目录下「部分兄弟被删后恢复」的排序 | 推断为「文件名前缀天然保持」（Q7），但现有 `renumberSiblings` 在何种操作下触发需实测确认边界 |

---

## 五、第 7 节命令的输出要点

方案第 7 节列的命令，其关键输出已体现在上面的逐题回答中；此处补充命令本身的结论：

| 命令 | 输出要点 |
|---|---|
| `cat shell.ts` | 三栏 grid，`inspector` 在 `shell.ts:304`，无拖拽改宽 |
| `cat tree.ts` | 单选、右键菜单删除、HTML5 拖拽仅同层（`tree.ts:231`） |
| `cat panels/outline.ts panels/index.ts` | 大纲只读摘要+新建场景；面板数组顺序即标签顺序 |
| `cat contracts.ts store.ts` | `PanelDef` 无宽度字段；`AppState` 无多选字段 |
| `sed -n 1,160p overlays.ts mobile.ts` | toast 无动作按钮；mobile 只有边缘滑动开抽屉 |
| `grep routes/docs.ts` | 7 条路由，见 Q6 表 |
| `readTree` | 顺序 = parent + order（frontmatter，回退文件名前缀） |
| `syncTreeToIndex` | 会触发 `indexDoc` → `scanDoc`（出场重建） |
| `panels/shared.ts` | `toast(ctx,msg,kind)`、`confirmDanger(ctx,opts)`，均无动作按钮 |

---

## 六、下一步

D0 完成。按任务书第四部分，**待复核通过后**再启动 C 线 / L1 / O 线 / R 线。
建议复核时优先确认两处与方案预期有出入的地方：

1. **C1 需要补锁**（方案只说要「确认保存锁语义」，实际是**没有锁**）
2. **O1 不需要补后端接口**（方案预期可能要补，实际新建/改名/移动都已具备）
