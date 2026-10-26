/**
 * 写作台 · 前后端共享类型契约
 *
 * 这是前后端唯一的类型真相。任何一侧改动都必须先改这里。
 * 所有 ID 均为字符串（ULID 或 stable id），所有时间戳为毫秒 epoch。
 */

// ─────────────────────────── 基础 ───────────────────────────

export type DocStatus = 'idea' | 'draft' | 'revising' | 'final' | 'published';

export const DOC_STATUSES: DocStatus[] = ['idea', 'draft', 'revising', 'final', 'published'];

export const DOC_STATUS_LABELS: Record<DocStatus, string> = {
  idea: '构思',
  draft: '草稿',
  revising: '修改中',
  final: '定稿',
  published: '已发布',
};

/** 文档树节点类型：卷 / 章 / 场景 */
export type NodeKind = 'volume' | 'chapter' | 'scene';

export const NODE_KIND_LABELS: Record<NodeKind, string> = {
  volume: '卷',
  chapter: '章',
  scene: '场景',
};

/** 字数统计口径（架构 7.3） */
export type CountMode = 'hanzi' | 'hanzi_punct' | 'platform';

export const COUNT_MODE_LABELS: Record<CountMode, string> = {
  hanzi: '仅汉字',
  hanzi_punct: '汉字+标点',
  platform: '平台口径（含标点空格）',
};

/** 作品模式（架构第 4 节） */
export type WorkMode = 'webnovel' | 'publish' | 'script';

export const WORK_MODE_LABELS: Record<WorkMode, string> = {
  webnovel: '网文连载',
  publish: '出版向',
  script: '剧本/互动',
};

/** 设定库条目类型 */
export type EntityType =
  | 'character'
  | 'place'
  | 'faction'
  | 'item'
  | 'term'
  | 'event'
  | string; // 允许自定义

export const ENTITY_TYPE_LABELS: Record<string, string> = {
  character: '角色',
  place: '地点',
  faction: '势力',
  item: '物品',
  term: '术语/体系',
  event: '事件',
};

/** 检查结果严重程度 */
export type Severity = 'info' | 'warn' | 'error';

// ─────────────────────────── 项目 ───────────────────────────

export interface ProjectMeta {
  id: string;
  schema_version: number;
  title: string;
  author: string;
  mode: WorkMode;
  count_mode: CountMode;
  /** 每日目标字数 */
  daily_goal: number;
  created_at: number;
  updated_at: number;
  /** 平台排版预设 */
  typeset: TypesetPreset;
  /** 局域网设置（架构 7.9） */
  lan: { enabled: boolean };
  /** 是否允许「全半角标点自动规整」 */
  auto_punct: boolean;
}

export interface TypesetPreset {
  /** 段首缩进（全角空格数，导出时套用，不污染源文件） */
  indent: number;
  /** 段间是否空行 */
  paragraph_gap: boolean;
  /** 章节标题格式模板，{n} 为序号，{title} 为标题 */
  chapter_title: string;
}

export const DEFAULT_TYPESET: TypesetPreset = {
  indent: 2,
  paragraph_gap: true,
  chapter_title: '第{n}章 {title}',
};

export interface ProjectSummary {
  id: string;
  title: string;
  author: string;
  mode: WorkMode;
  count_mode: CountMode;
  daily_goal: number;
  updated_at: number;
  /** 全书字数（按 count_mode 口径） */
  word_count: number;
  /** 场景数 */
  scene_count: number;
  path: string;
}

// ─────────────────────────── 文档树 ───────────────────────────

/** 树节点。卷/章为容器，场景持有正文。 */
export interface DocNode {
  id: string;
  kind: NodeKind;
  title: string;
  /** 父节点 id，卷为 null */
  parent_id: string | null;
  /** 同级排序，越小越前 */
  order: number;
  status: DocStatus;
  /** 摘要（大纲视图显示） */
  summary: string;
  /** 字数（按项目 count_mode） */
  word_count: number;
  updated_at: number;
  /** 场景专有：正文所在文件相对路径 */
  file?: string;
  /** 场景专有：视角人物 */
  pov?: string;
  /** 场景专有：故事内时间 */
  time?: string;
  tags?: string[];
  plotlines?: string[];
  /** 内容哈希，用于快照去重与冲突检测 */
  hash?: string;
  /** 修订号，用于乐观并发（架构 7.8） */
  rev?: number;
}

/** 完整树（一次返回，前端自建索引） */
export interface DocTree {
  nodes: DocNode[];
}

/** 场景正文读取结果 */
export interface SceneContent {
  id: string;
  /** Markdown 子集正文（不含 frontmatter） */
  body: string;
  rev: number;
  hash: string;
  updated_at: number;
}

// ─────────────────────────── 设定库 ───────────────────────────

export interface Entity {
  id: string;
  type: EntityType;
  name: string;
  aliases: string[];
  /** 自定义字段（题材模板可扩展） */
  fields: Record<string, string>;
  /** 描述正文 */
  description: string;
  created_at: number;
  updated_at: number;
}

/** 出场记录 */
export interface Mention {
  entity_id: string;
  entity_name: string;
  doc_id: string;
  doc_title: string;
  count: number;
  /** 首次出现字符偏移 */
  first_pos: number;
  /** 最近出现字符偏移 */
  last_pos: number;
}

export interface EntityDetail extends Entity {
  mentions: Mention[];
  total_count: number;
  first_doc: { doc_id: string; doc_title: string } | null;
  last_doc: { doc_id: string; doc_title: string } | null;
}

// ─────────────────────────── 搜索 ───────────────────────────

export interface SearchHit {
  doc_id: string;
  doc_title: string;
  /** 卷/章路径，如「第一卷 / 第一章」 */
  path: string;
  /** 命中片段，含 <mark> 高亮 */
  snippet: string;
  /** 命中次数 */
  count: number;
  kind: 'scene' | 'entity' | 'note';
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  total: number;
  /** 耗时毫秒 */
  took_ms: number;
}

// ─────────────────────────── 快照 / 版本 ───────────────────────────

export interface SnapshotMeta {
  id: string;
  doc_id: string;
  doc_title: string;
  hash: string;
  size: number;
  created_at: number;
  /** 保存原因：auto / manual / import / delete / restore / conflict */
  reason: SnapshotReason;
  /** 是否永久保留（重大节点） */
  pinned: boolean;
}

export type SnapshotReason =
  | 'auto'
  | 'manual'
  | 'import'
  | 'delete'
  | 'restore'
  | 'conflict'
  | 'close';

export const SNAPSHOT_REASON_LABELS: Record<SnapshotReason, string> = {
  auto: '自动',
  manual: '手动',
  import: '导入前',
  delete: '删除前',
  restore: '恢复前',
  conflict: '冲突',
  close: '关闭作品',
};

export interface SnapshotContent {
  id: string;
  body: string;
  meta: SnapshotMeta;
}

/** 段落级差异块 */
export interface DiffBlock {
  type: 'equal' | 'insert' | 'delete';
  text: string;
  /** 字符级高亮区间（相对该块） */
  inline?: Array<{ type: 'equal' | 'insert' | 'delete'; text: string }>;
}

export interface DiffResult {
  blocks: DiffBlock[];
  stats: { added: number; removed: number; unchanged: number };
}

// ─────────────────────────── 回收站 ───────────────────────────

export interface TrashItem {
  id: string;
  doc_id: string;
  title: string;
  kind: NodeKind;
  /** 原始父节点路径描述 */
  path: string;
  deleted_at: number;
  /** 过期时间（保留期可配置） */
  expires_at: number;
  /** 是否为容器（删除卷/章时整棵子树） */
  is_container: boolean;
  /** 子树节点数 */
  child_count: number;
}

// ─────────────────────────── 检查引擎 ───────────────────────────

export interface LintIssue {
  id: string;
  rule_id: string;
  rule_name: string;
  severity: Severity;
  /** 文档 id，全书检查时有效 */
  doc_id?: string;
  doc_title?: string;
  /** 正文中字符偏移 */
  from: number;
  to: number;
  /** 命中的原文 */
  text: string;
  message: string;
  /** 是否可自动修复 */
  fixable: boolean;
  /** 修复建议 */
  fix?: string;
}

export interface RuleDef {
  id: string;
  name: string;
  description: string;
  severity: Severity;
  /** 作用范围 */
  scope: 'scene' | 'book';
  enabled: boolean;
  fixable: boolean;
  /** 内置规则不可删除 */
  builtin: boolean;
  /** 正则规则：pattern + flags */
  pattern?: string;
  flags?: string;
  message?: string;
  /** 是否为词表规则（word list） */
  words?: string[];
}

export interface LintResult {
  issues: LintIssue[];
  /** 检查耗时 */
  took_ms: number;
  /** 被忽略的条数 */
  ignored: number;
}

/** 忽略记录随项目保存（架构 7.5） */
export interface LintIgnore {
  rule_id: string;
  doc_id: string;
  text: string;
  /** 位置锚点：前后文，位置变化仍可匹配 */
  anchor: string;
}

// ─────────────────────────── 统计与目标 ───────────────────────────

export interface DailyStat {
  date: string; // YYYY-MM-DD
  words: number;
  /** 写作时长（秒） */
  seconds: number;
}

export interface GoalProgress {
  date: string;
  goal: number;
  written: number;
  /** 0..1，可 >1 */
  ratio: number;
  /** 连续打卡天数 */
  streak: number;
  /** 近 N 天 */
  recent: DailyStat[];
  /** 全书字数 */
  total_words: number;
}

// ─────────────────────────── 备份 ───────────────────────────

export interface BackupTarget {
  id: string;
  dir: string;
  enabled: boolean;
  /** 保留份数 */
  keep: number;
  /** 间隔分钟 */
  interval_min: number;
  last_run: number | null;
  last_file: string | null;
  last_error: string | null;
}

export interface BackupResult {
  target_id: string;
  file: string;
  size: number;
  took_ms: number;
}

// ─────────────────────────── 导入导出 ───────────────────────────

export interface ImportPreview {
  /** 检测到的章节 */
  chapters: Array<{ index: number; title: string; words: number }>;
  total_words: number;
  /** 编码 */
  encoding: string;
  /** 疑似乱码 */
  garbled: boolean;
  /** 切分规则描述 */
  rule: string;
  /** 预览前若干段 */
  preview: string;
}

export type ExportFormat = 'txt' | 'md' | 'docx' | 'epub';

export interface ExportRequest {
  format: ExportFormat;
  /** 范围：全书 / 某卷 / 某章 */
  scope: 'book' | 'volume' | 'chapter';
  scope_id?: string;
  /** 是否套用平台排版预设 */
  typeset: boolean;
}

export interface ExportResult {
  file: string;
  size: number;
  chapters: number;
  words: number;
  took_ms: number;
}

// ─────────────────────────── 后台作业 ───────────────────────────

export type JobKind =
  | 'rebuild_index'
  | 'book_lint'
  | 'export'
  | 'backup'
  | 'import'
  | 'scan_mentions';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  /** 0..1 */
  progress: number;
  message: string;
  created_at: number;
  finished_at: number | null;
  error: string | null;
  /** 结果载荷（导出文件、统计等） */
  result: unknown;
}

// ─────────────────────────── 灵感箱 / 笔记 ───────────────────────────

export interface InboxItem {
  id: string;
  text: string;
  created_at: number;
  /** 已归档到哪 */
  archived_to?: { kind: 'scene' | 'entity' | 'note'; id: string } | null;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  /** 关联的文档或条目 */
  linked?: { kind: 'scene' | 'entity'; id: string } | null;
  created_at: number;
  updated_at: number;
}

// ─────────────────────────── 伏笔 / 时间线 ───────────────────────────

export interface Foreshadow {
  id: string;
  /** 埋设文档 */
  setup_doc_id: string;
  setup_title: string;
  /** 计划回收文档（可空=未定） */
  payoff_doc_id: string | null;
  payoff_title: string | null;
  /** 实际回收文档 */
  resolved_doc_id: string | null;
  description: string;
  /** 超过多少章未回收提醒 */
  alert_after: number;
  status: 'open' | 'resolved' | 'abandoned';
  created_at: number;
}

export interface TimelineEvent {
  id: string;
  title: string;
  /** 故事内时间描述 */
  time_label: string;
  /** 排序用数值 */
  time_value: number | null;
  doc_ids: string[];
  description: string;
}

// ─────────────────────────── WebSocket 事件 ───────────────────────────

export type WsEvent =
  | { type: 'job'; job: Job }
  | { type: 'tree_changed'; project_id: string }
  | { type: 'doc_changed'; doc_id: string; rev: number }
  | { type: 'index_rebuilt' }
  | { type: 'ping'; t: number };

// ─────────────────────────── API 信封 ───────────────────────────

export interface ApiError {
  error: string;
  code?: string;
  /** 冲突时的当前版本，供前端提示 */
  current?: SceneContent;
}

export interface SaveSceneRequest {
  body: string;
  /** 客户端持有的修订号；落后则触发冲突副本 */
  base_rev: number;
}

export interface SaveSceneResponse {
  rev: number;
  hash: string;
  updated_at: number;
  word_count: number;
  /** 若发生冲突，返回冲突副本信息 */
  conflict?: { snapshot_id: string; message: string };
}
