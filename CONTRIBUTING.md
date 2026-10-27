# 贡献指南

感谢愿意帮忙。这是一个个人维护的中文写作工具，优先保证「稿件安全」和「长期可维护」，
功能数量不是目标。

---

## 最重要的红线

动手前请先读 [AGENTS.md](AGENTS.md)。里面是硬约束，摘要如下：

1. **所有文件写入必须走 `writeFileAtomic`**。禁止 `fs.writeFile` 直接写稿件或配置。
2. **禁止「先删后写」**。替换内容用原子写覆盖。
3. **保存路径上不允许做重活**。索引、检查、导出、备份全部走后台作业队列。
4. **不得修改 frontmatter 既有字段语义**（`id` / `title` / `status` / `order` / `rev` / `hash`）。
5. **不做任何出站网络请求**。无统计、无崩溃上报、无字体 CDN、无模型调用。
6. **`shared/types.ts` 是前后端唯一类型真相**，改动前想清楚两侧影响。

任何可能损坏数据的改动，必须在测试里先证明不丢内容。

---

## 开发环境

需要 **Node.js ≥ 22.18**（用到内建 `node:sqlite` 与原生 TypeScript 类型擦除，两者都是从 22.18 起默认可用）。
推荐用 Node 24（CI 与日常开发都在这个版本上跑）。

```bash
git clone https://github.com/shuaixing2020-ux/writing-desk.git
cd writing-desk
npm install
npm run build
npm run seed     # 生成示例作品，方便看效果
npm start
```

打开 http://127.0.0.1:7788。

前端改动可以开监听：

```bash
npm run build:watch    # 另开一个终端
```

---

## 提交前必须通过

```bash
npm run typecheck      # 类型检查，必须 0 错误
npm test               # 单元测试（41 项）
npm run build          # 前端构建
npm run selfcheck      # 集成自检（30 项，会真实起服务跑 HTTP）
npm run test:e2e       # 端到端（改了保存/编辑器/关键流程时必须跑）
```

移动端改动额外跑（需服务已在 7788 运行）：

```bash
node tests/e2e/mobile-e2e.mjs    # 7 种设备视口 + 抽屉 + 触摸目标 + 手机写作，17 项
```

**涉及保存逻辑的改动，必须确认端到端测试里的「刷新后内容恢复」用例通过。**
那是这个产品的底线用例。

端到端测试需要一个 Chromium。`npm install` 不会自动下载浏览器，首次运行前执行：

```bash
npx playwright install chromium
```

脚本本身会按「环境变量 `E2E_CHROME` → 系统 Chrome → Playwright 缓存」的顺序找浏览器，
所以装了 Chrome 的机器通常不需要额外下载。

---

## 代码风格

- **Node 原生 TypeScript**：import 必须带 `.ts` 后缀；服务端无编译步骤
- **不能用 `enum`**（tsconfig 开了 `erasableSyntaxOnly`），用 `const` 对象 + 联合类型
- 类型导入写 `import type`（开了 `verbatimModuleSyntax`）
- 前端用原生 DOM，不引框架。工具函数在 `web/src/lib/dom.ts`
- **注释写「为什么」，不写「是什么」**。中文注释
- 服务端只用 `node:` 内建模块与已声明依赖，不引入需要原生编译的包

### UI 约定

- 只用设计令牌（`web/src/styles/tokens.css` 的 `--xxx`），不写死颜色
- 暖纸色系，动效克制（120–320ms）
- 不用 emoji 当图标，用内联 SVG（16×16，`stroke="currentColor"`，`stroke-width="1.7"`）
- 危险操作必须二次确认
- 中文输入法优先：`compositionstart` 到 `compositionend` 期间不触发保存或检查

### 响应式

- 断点：`≥1181` 桌面宽屏 / `961–1180` 桌面窄屏 / `≤960` 单栏 + 抽屉 + 底部导航
- 触摸设备上可点击元素 ≥ 40px，输入框 16px（避免 iOS 自动放大）
- 新增布局改动请在 375 / 393 / 744 / 820 / 1280 五个宽度下自查

---

## 提 PR

1. 一个 PR 做一件事，不要混入无关重构
2. 说明「为什么」而不只是「改了什么」
3. 附上你跑过的验证命令与结果
4. 涉及界面的改动附截图
5. 新功能请同步更新 README 的功能列表与「已知限制」

CI（`.github/workflows/ci.yml`）会在 Node 22 / 24 上跑 `typecheck`、`test`、`build`、`selfcheck`，
并单独跑一个真实浏览器的端到端 job。PR 上就能看到结果，不用等维护者本地复现。

## 报 Bug

用 [issue 模板](.github/ISSUE_TEMPLATE/bug_report.md)，请包含：

- 复现步骤
- 期望行为 vs 实际行为
- Node 版本与操作系统
- 浏览器版本（前端问题）
- **如果是稿件相关问题，先备份你的作品文件夹再操作**

## 提功能建议

先开 issue 讨论，不要直接写实现。这个项目刻意保持范围克制 ——
「不做 AI」和「不做协同」是设计决策，不是待办事项。
