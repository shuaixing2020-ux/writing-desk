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
  /**
   * AI 接入配置（架构第 0 节「AI 先不接，只预留接口」）。
   *
   * 设计红线：
   *   - enabled 默认 false，用户必须显式开启
   *   - api_key 只存本机 project.json，永不上传（本工具本就无出站请求）
   *   - 未开启时，任何 ai 相关接口都直接返回「未启用」，不会发起网络连接
   */
  ai: AiConfig;
}

/** 支持的服务商。预留扩展位，新增时只需加枚举值 + 默认 base URL */
export type AiProvider = 'deepseek' | 'moonshot' | 'openai-compatible';

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot（月之暗面）',
  'openai-compatible': '自定义（OpenAI 兼容接口）',
};

/** 各服务商默认 base URL（仅用于填充表单，不发起请求） */
export const AI_PROVIDER_DEFAULT_BASE: Record<AiProvider, string> = {
  deepseek: 'https://api.deepseek.com/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  'openai-compatible': '',
};

export interface AiConfig {
  /** 总开关，默认 false */
  enabled: boolean;
  provider: AiProvider;
  /** 接口地址，空则用服务商默认值 */
  base_url: string;
  /** 模型名，空则用服务商默认值 */
  model: string;
  /** API Key。只存本机，接口返回时打码 */
  api_key: string;
  /** 生成参数 */
  temperature: number;
  max_tokens: number;
  /** 允许的能力，逐个显式开启（默认全关） */
  features: AiFeatureToggles;
}

/** 可用的 AI 能力，每一项都可以单独开关 */
export interface AiFeatureToggles {
  /** 续写：基于上下文接续若干段 */
  continue: boolean;
  /** 润色选中的段落 */
  polish: boolean;
  /** 生成人物/地名候选名 */
  naming: boolean;
  /** 检查角色行为是否合逻辑（需人工确认，不做自动修改） */
  consistency: boolean;
}

export const AI_FEATURE_LABELS: Record<keyof AiFeatureToggles, string> = {
  continue: '续写',
  polish: '润色选中段落',
  naming: '取名建议',
  consistency: '情节与角色一致性提示',
};

export const DEFAULT_AI_CONFIG: AiConfig = {
  enabled: false,
  provider: 'deepseek',
  base_url: '',
  model: '',
  api_key: '',
  temperature: 0.8,
  max_tokens: 800,
  features: {
    continue: false,
    polish: false,
    naming: false,
    consistency: false,
  },
};

// ─────────────────────────── AI 接口（预置，未启用时不可用） ───────────────────────────

/**
 * AI 能力的统一请求。
 *
 * 即便将来真的接入，也必须满足：
 *   1. 结果只作建议展示，落盘前必须由作者确认
 *   2. 不自动改写正文
 *   3. 请求内容在界面上可见（可预览将要发送的上下文）
 */
export interface AiRequest {
  feature: keyof AiFeatureToggles;
  /** 用户指令或上下文 */
  prompt: string;
  /** 前置上下文（如当前场景正文片段） */
  context?: string;
  /** 期望风格，可选 */
  style?: string;
}

export interface AiResponse {
  text: string;
  provider: AiProvider;
  model: string;
  /** 消耗的 token（若服务商返回） */
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  /** 耗时毫秒 */
  took_ms: number;
}

/** AI 状态：前端据此决定显示「未启用」还是可用 */
export interface AiStatus {
  /** 插件式接入层是否已就绪（当前版本恒为 false = 未接入） */
  available: boolean;
  /** 用户是否已开启 */
  enabled: boolean;
  /** 缺少什么才能用 */
  missing: string[];
  /** 已启用的能力 */
  features: Array<keyof AiFeatureToggles>;
}

/**
 * AI 后端适配器接口 —— 预留给将来的实现。
 *
 * 当前没有任何实现类被实例化（agent 适配器默认不加载），
 * 所以系统不会发起任何出站网络请求。
 */
export interface AiAdapter {
  readonly provider: AiProvider;
  /** 生成文本。实现方负责超时、重试与错误信息中文化 */
  generate(req: AiRequest, config: AiConfig): Promise<AiResponse>;
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

// ─────────────────────────── 关系图谱 ───────────────────────────

/**
 * 一条关系。
 *
 * 存储位置：起点条目的 frontmatter `relations: |` 多行块里，每行一条。
 * `from` 由所在文件决定，不写在行里 —— 这样改文件名不会让关系失效。
 *
 * since / until / reveal 存的是**文档 id**（章或场景），显示时才换算成「第 N 章」。
 * 存序号会在作者调整章节顺序后全部指错。
 */
export interface Relation {
  /** 关系 id，形如 r_01J... */
  id: string;
  /** 类型键（注册表里的 key） */
  type: string;
  /** 起点条目 id */
  from: string;
  /** 终点条目 id */
  to: string;
  /** 终点显示名，仅用于人眼阅读；以 id 为准，保存时自动刷新 */
  to_name?: string;
  /** 成立锚点（文档 id） */
  since?: string;
  /** 结束锚点（文档 id） */
  until?: string;
  /** 读者得知锚点（文档 id） */
  reveal?: string;
  /** 权重，用于图布局 */
  weight?: number;
  /** 备注，可含任意字符（包括 | 和 ->） */
  note: string;
  /** 无法识别的属性键原样保留 */
  extra_props?: Record<string, string>;
}

/** 关系类型定义 */
export interface RelationTypeDef {
  key: string;
  /** 显示名，如「师徒」 */
  label: string;
  /** 反向显示名，如「徒弟」 */
  inverse_label: string;
  /** 是否有方向。无向关系（朋友、亲属）在两个方向上语义相同 */
  directed: boolean;
  /** 允许的端点类型组合；null 表示不限 */
  allowed: Array<[EntityType, EntityType]> | null;
  /** 是否禁止成环（如「导致」） */
  acyclic: boolean;
  /** 与之语义冲突的类型（如 ally 与 enemy），仅用于提示，不拒绝 */
  exclusive_with: string[];
}

/** 新增关系的入参 */
export interface RelationInput {
  /**
   * 关系 id。仅用于「撤销删除」时按原 id 恢复 ——
   * 其他场景应留空，由服务端生成（r_ + ulid）。
   */
  id?: string;
  /** 类型键或中文显示名 */
  type: string;
  /** 目标条目 id */
  to: string;
  since?: string;
  until?: string;
  reveal?: string;
  weight?: number;
  note?: string;
}

/**
 * 修改关系的入参。
 *
 * 注意：**不含 `to` 与方向** —— 重连端点、反转方向都要改两个条目文件
 * （起点的行 + 终点的反向视角），属于跨多文件操作，等有了多文件事务日志再做。
 */
export interface RelationPatch {
  type?: string;
  since?: string | null;
  until?: string | null;
  reveal?: string | null;
  weight?: number | null;
  note?: string;
}

/** 条目详情里的关系视图 */
export interface RelationView {
  /** 该条目指向别人（存在自己的文件里） */
  out: Array<Relation & { dangling?: boolean }>;
  /** 别人指向该条目（从索引里反查） */
  in: Array<Relation & { dangling?: boolean }>;
}

/** 图谱一致性检查问题 */
export interface GraphLintIssue {
  code:
    | 'relation_dangling_target'
    | 'relation_anchor_missing'
    | 'relation_duplicate'
    | 'relation_unparsable_line'
    | 'relation_unknown_type';
  severity: 'warn' | 'error';
  /** 出问题的条目 id */
  entity_id: string;
  entity_name?: string;
  relation_id?: string;
  /** 相关行文本或说明 */
  detail: string;
  /** 在 relations 块里的行号（从 1 开始），仅有行级问题时提供 */
  line_no?: number;
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
  /**
   * 项目开启「标点自动规整」且本次保存确实改动了标点时，
   * 返回规整后的正文。前端必须用它同步编辑器显示，
   * 否则作者看到的内容与磁盘不一致，下次保存会把规整结果覆盖回去。
   */
  body?: string;
}
