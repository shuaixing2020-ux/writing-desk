# 写作台

**本地优先的中文小说写作工作台。** 数据全部在你自己的电脑上，Markdown 即真相，不联网、不调用 AI。

面向中文小说作者（网文连载为主），同时兼顾出版向写作。跑在浏览器里，服务在你本机。

[![CI](https://github.com/shuaixing2020-ux/writing-desk/actions/workflows/ci.yml/badge.svg)](https://github.com/shuaixing2020-ux/writing-desk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

![主界面](docs/screenshots/main.png)

---

## 为什么做这个

写长篇小说时，工具选型的风险不在功能多少，而在**稿件会不会丢**、**十年后还能不能打开**。

现有工具的问题：

- 云写作平台：断网就写不了，平台改规则你的稿子就受限，导出还要付费
- 桌面软件（novelWriter、Manuskript）：成熟但绑定桌面，手机上写不了
- 通用笔记软件：没有卷章结构、没有设定库、字数口径和发布平台对不上

写作台的选择是：**正文存成普通 Markdown 文件**，数据库只是加速索引（删了自动重建）。
所以你随时可以带着文件夹走，用任何编辑器打开，用 Git 管理，或者只是拷到 U 盘。

---

## 核心特性

### 稿件永不丢（最高优先级）

- **原子写**：写临时文件 → fsync → rename 替换。断电或崩溃时，文件要么是旧版本、要么是新版本，永不半写
- **自动保存**：停止输入 2 秒后保存；切换章节、切走窗口、关闭页面立即保存
- **本地草稿兜底**：未确认保存的内容先写进浏览器本地，服务重启或浏览器崩溃后能恢复
- **崩溃测试**：单元测试里反复在写入过程中并发写同一文件，验证内容永远是某个完整版本

### 中文写作优化

- **输入法兼容**：拼音组字期间不触发保存与检查，不吞字、不跳光标
- **字数口径三档**：仅汉字 / 汉字+标点 / 平台口径，状态栏常显，全书与导出共用同一实现
- **中文搜索**：逐字索引，两个字的人名（如「林远」）也能搜到 —— FTS5 的 trigram 分词器做不到这点
- **中文排版**：段首缩进用样式实现（不往正文塞空格）、智能标点、全半角规整
- **规则检查**：引号配对（含嵌套）、省略号/破折号写法、重复标点、全半角混用、常见错别字、相邻重复词、段落过长、对白引号风格混用

### 结构化写作

- 卷 → 章 → 场景三级结构，拖拽排序、状态流转（构思/草稿/修改中/定稿/已发布）
- 大纲视图，每个单元可写摘要
- 设定库：角色、地点、势力、物品、术语、事件，支持别名与自定义字段
- **出场识别**：正文里的名称自动识别，条目页显示「出现在哪些章节、几次、首次与最近出场」
- 反向引用可点击跳转到正文位置

### 版本与安全

- 内容寻址快照（相同内容只存一份，压缩去重）
- 段落级 + 字符级差异对比
- 恢复到任意历史版本，恢复前自动给当前版本存一份
- 删除进回收站，可恢复
- 定时整项目备份（tar.gz，系统 tar 可直接解压）

### 导入导出

- 导入：txt（自动切章，先预览确认）、md、docx；支持 GBK 编码检测
- 导出：txt（可套用平台排版预设）、md、docx、epub
- 范围：全书 / 某卷 / 某章

### 手机可用

- 响应式布局：≤960px 切换为单栏 + 抽屉 + 底部导航
- 触摸目标 ≥ 40px，输入框 16px（避免 iOS 自动放大）
- 适配 iPhone 刘海与 Home Indicator 安全区
- 边缘滑动打开抽屉
- 通过局域网访问，手机上记灵感、读稿、改错字

<p align="center">
  <img src="docs/screenshots/mobile.png" width="260" alt="手机端写作">
  <img src="docs/screenshots/mobile-drawer.png" width="260" alt="手机端抽屉">
</p>

---

## 快速开始

**要求 Node.js ≥ 22.6**（用到内建 `node:sqlite` 与原生 TypeScript 类型擦除）。开发环境为 Node 24。

```bash
git clone https://github.com/shuaixing2020-ux/writing-desk.git
cd writing-desk

npm run serve
```

首次运行会自动安装依赖、构建前端，然后启动服务：

```
写作台 · 本地部署
▸ 启动服务：http://127.0.0.1:7788
```

浏览器打开 **http://127.0.0.1:7788** 即可。服务端没有编译步骤，`node server/main.ts` 直接跑。

### 分步方式

```bash
npm install       # 安装依赖
npm run build     # 构建前端到 web/dist
npm start         # 启动服务
```

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WD_PORT` | `7788` | 服务端口 |
| `WD_DATA_DIR` | `<项目>/data/projects` | 作品数据根目录 |
| `WD_LAN` | 未设置 | 设为 `1` 开放局域网访问（会打印安全提示） |

```bash
WD_PORT=8899 npm start
WD_DATA_DIR=~/写作 npm start
WD_LAN=1 npm start   # 手机同 Wi-Fi 可访问
```

> **局域网安全提示**：开启后同一 Wi-Fi 下的其他人只要知道地址就能读到你的稿件。
> 默认只监听 `127.0.0.1`，只在需要时临时开启，不要在公共 Wi-Fi 下使用。

---

## 你的数据长什么样

每部作品是一个普通文件夹：

```
data/projects/我的小说/
├─ project.json              作品设置（字数口径、每日目标、排版预设）
├─ manuscript/               正文
│  └─ v01-第一卷/
│     └─ c001-开篇/
│        └─ s0001-雨夜.md    ← 一个场景一个文件
├─ bible/                    设定库
│  └─ characters/林远.md
├─ notes/  inbox/            笔记、灵感
└─ .studio/                  运行时（索引、快照、回收站）
   └─ index.sqlite           ← 删掉也没关系，会自动重建
```

一个场景文件长这样：

```markdown
---
id: 01M5X6EBTGXY3H0T28Z0SG9PY2
title: 雨夜来客
order: 1
status: draft
rev: 2
words: 110
---

夜雨敲窗，山门外一片寂静。

“师父，我回来了。”
```

**身份靠 frontmatter 里的 `id`，不靠文件名。** 改名、移动、重排都不会破坏引用。
`.studio/` 整个目录都可以丢弃重建 —— 如果某个数据只能存在这里，说明设计错了。

---

## 更多截图

| 设定库 | 规则检查 |
|---|---|
| ![设定库](docs/screenshots/bible.png) | ![检查](docs/screenshots/lint.png) |

| 统计与目标 | 深色主题 |
|---|---|
| ![统计](docs/screenshots/stats.png) | ![深色](docs/screenshots/dark.png) |

---

## 技术栈

| 层 | 选择 | 理由 |
|---|---|---|
| 服务端 | Node.js + 原生 TypeScript | 无编译步骤，`node server/main.ts` 直接运行 |
| Web 框架 | Fastify 5 | 轻量、插件机制清晰 |
| 前端 | 原生 TypeScript + DOM | 无框架、无虚拟 DOM，构建链只有 esbuild |
| 数据库 | `node:sqlite`（Node 内建） | 零依赖、零运维，不需要编译原生模块 |
| 全文索引 | 逐字索引（SQLite 表） | 2 字中文词可命中；trigram 分词器做不到 |
| 编辑器 | contenteditable 纯文本 | Markdown 源码可直接编辑，无富文本往返风险 |
| 差异 | diff-match-patch | 段落级 + 字符级 |
| 文档导出 | docx 库 + 自写 epub | epub 自打包，零额外依赖 |
| 测试 | node:test + Playwright | 单元 + 真实浏览器端到端 |

### 两个刻意的技术取舍

**1. 纯文本编辑器而非富文本**

架构方案原本建议 ProseMirror。实际选择纯文本，因为正文以 Markdown 存储，
富文本需要 HTML ↔ Markdown 双向转换 —— 任何一次转换不完美，都会在保存时静默损坏原文。
「稿件永不丢」是第一原则，所以选了零转换风险的路线。代价是没有所见即所得的格式按钮，
对以叙事文字为主的小说影响很小。

**2. 逐字索引而非 FTS5 trigram**

实测 FTS5 的 trigram 分词器对 2 字中文词（最常见的人名长度）完全失效。
改用逐字建索引 + 锚点验证，任意长度子串都能命中，300 万字规模实测 3ms。

---

## 项目结构

```
writing-desk/
├─ server/                 服务端（Node 原生 TS，无编译）
│  ├─ main.ts              启动入口
│  ├─ routes/              REST 路由
│  ├─ services/            领域服务（快照/检查/出场/导入导出/备份）
│  ├─ store/project.ts     项目文件夹读写（原子写）
│  ├─ db/index.ts          SQLite 索引与中文搜索
│  ├─ rules/               检查规则包
│  └─ util/                原子写、frontmatter、字数、作业队列
├─ shared/types.ts         前后端共享类型（唯一真相）
├─ web/                    前端
│  ├─ src/lib/             API 客户端、状态、DOM 工具
│  ├─ src/components/      外壳、文档树、编辑器、面板、移动端
│  └─ src/styles/          设计令牌与样式
├─ tests/                  单元测试 + 端到端测试
├─ scripts/                启动、构建、自检、示例数据
└─ data/projects/          你的作品（已 gitignore）
```

---

## 开发

| 命令 | 作用 |
|---|---|
| `npm run serve` | 一键启动（自动装依赖 + 构建 + 启动） |
| `npm start` | 只启动服务 |
| `npm run dev` | 启动并监听后端变化自动重启 |
| `npm run build` | 构建前端 |
| `npm run build:watch` | 监听前端源码自动重建 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | 单元测试（26 项） |
| `npm run test:e2e` | 端到端测试（真实浏览器，16 项） |
| `npm run selfcheck` | 集成自检（28 项，含真实 HTTP） |
| `npm run seed` | 生成示例作品 |

移动端专项测试：

```bash
node tests/e2e/mobile-e2e.mjs   # 需服务已在 7788 运行
```

改动合入前请确保 `typecheck`、`test`、`build` 全绿。
涉及保存逻辑的改动必须额外确认端到端测试里的「刷新后内容恢复」用例通过。

代码约定见 [AGENTS.md](AGENTS.md)，贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 与同类工具的差异

| | 写作台 | novelWriter | Manuskript |
|---|---|---|---|
| 形态 | 浏览器（本机服务） | 桌面 Qt | 桌面 Qt |
| 手机可用 | ✅ 局域网 | ❌ | ❌ |
| 存储格式 | Markdown + frontmatter | 纯文本 + 元数据头 | 自有格式 |
| 中文优化 | ✅ 字数口径/搜索/标点/输入法 | 部分 | 部分 |
| 设定库 | ✅ 别名 + 出场识别 | 基础 | ✅ 完整 |
| 许可 | MIT | GPLv3 | GPLv3 |

只借鉴了 novelWriter 与 Manuskript 的「文件即真相」思路，未复制其代码。

---

## 已知限制

如实说明当前没做的事：

- **手机端是在线形态**：安装成 PWA、离线暂存需要 HTTPS 方案（架构方案 7.9），未实现
- **局域网无登录体系**：靠「默认只监听本机 + 显式开启」控制，没有配对令牌
- **伏笔与时间线**：数据层已备，UI 未做
- **剧本模式（Fountain）与互动叙事**：未实现
- **单作者**：不做实时协同。多标签页同时编辑用「修订号 + 冲突副本」处理
- **不含 AI**：按设计不接入任何模型，系统不发起任何出站网络请求

---

## 许可

[MIT](LICENSE)
