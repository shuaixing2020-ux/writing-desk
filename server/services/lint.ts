/**
 * 检查服务 —— 规则执行 + 忽略记录 + 结果落库（架构 7.5）。
 *
 * 三条设计约束：
 *   1. **检查永不阻塞输入**。单场景检查是同步纯计算（十几条正则），跑完就返回；
 *      全书检查一律走后台作业，带进度与取消。
 *   2. **忽略记录随项目保存**，而不是存在索引里。作者忽略一条提示是一个「编辑决定」，
 *      和正文一样珍贵；索引可以重建，这个决定不能丢。所以落在 .studio/lint-ignore.json，
 *      并且用「前后文锚点」而不是纯位置来匹配 —— 改几个字后位置会漂移，
 *      但前后文通常还在，忽略不该因此失效。
 *   3. **结果写入索引**（lint_result 表），这样重建索引后检查结果仍在，
 *      前端不需要每次打开面板都重算全书。
 */

import path from 'node:path';
import type {
  LintIgnore,
  LintIssue,
  LintResult,
  RuleDef,
  Severity,
} from '../../shared/types.ts';
import type { ProjectContext } from '../context.ts';
import type { JobContext } from '../util/job-queue.ts';
import { readJsonSafe, writeJsonAtomic } from '../util/atomic.ts';
import { runRule, type RawHit } from '../rules/builtin.ts';
import { Mutex, shortHash } from './common.ts';

const IGNORE_FILE = 'lint-ignore.json';

/** 锚点取命中前后各多少字符。太长会让轻微编辑就失配，太短容易撞车。 */
const ANCHOR_RADIUS = 10;

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

export class LintService {
  private ctx: ProjectContext;
  private mutex = new Mutex();
  private ignoreCache: LintIgnore[] | null = null;

  constructor(ctx: ProjectContext) {
    this.ctx = ctx;
  }

  private get ignoreFile(): string {
    return path.join(this.ctx.store.paths.studio, IGNORE_FILE);
  }

  // ─────────────────────────── 规则 ───────────────────────────

  async listRules(): Promise<RuleDef[]> {
    return this.ctx.rules.list();
  }

  async updateRule(ruleId: string, patch: Partial<RuleDef>): Promise<RuleDef> {
    return this.ctx.rules.update(ruleId, patch);
  }

  // ─────────────────────────── 单场景检查 ───────────────────────────

  /**
   * 检查单个场景。
   *
   * body 由调用方传入而不是自己读盘：保存路径上刚写完正文就要检查，
   * 这时候读盘拿到的可能是上一个版本，直接传内存里的内容才准。
   */
  async lintScene(docId: string, body: string): Promise<LintResult> {
    const t0 = Date.now();
    const rules = await this.ctx.rules.list();
    const ignores = await this.loadIgnores();
    const docIgnores = ignores.filter((i) => i.doc_id === docId);

    const raw = collectIssues(body, rules, { docId });
    const { issues, ignored } = applyIgnores(body, raw, docIgnores);

    this.persist(docId, issues);

    return { issues, took_ms: Date.now() - t0, ignored };
  }

  /**
   * 全书检查（后台作业）。
   *
   * 逐场景跑，进度按场景数推进；场景内的忽略与单场景检查共用同一套逻辑，
   * 所以「我忽略过这一条」在全书检查里同样生效。
   * 书级规则（scope='book'）在拼起来的全文上跑一次，再把偏移映射回所属场景。
   */
  async lintAll(job?: JobContext): Promise<LintResult> {
    const t0 = Date.now();
    const rules = await this.ctx.rules.list();
    const sceneRules = rules.filter((r) => r.enabled && r.scope !== 'book');
    const bookRules = rules.filter((r) => r.enabled && r.scope === 'book');
    const ignores = await this.loadIgnores();

    const tree = await this.ctx.store.readTree();
    const scenes = tree.nodes.filter((n) => n.kind === 'scene');
    const total = scenes.length || 1;

    const all: LintIssue[] = [];
    let ignored = 0;
    // 正文只读一遍：书级规则需要把它们拼起来，重复读盘在 300 万字项目上是秒级浪费
    const segments: Array<{ docId: string; docTitle: string; start: number; body: string }> = [];
    let cursor = 0;

    for (let i = 0; i < scenes.length; i++) {
      job?.throwIfCancelled();
      const node = scenes[i];
      const scene = await this.ctx.store.readScene(node.id);
      if (!scene) continue;

      segments.push({ docId: node.id, docTitle: node.title, start: cursor, body: scene.body });
      cursor += scene.body.length + 2; // +2 对应拼接时的 \n\n

      const raw = collectIssues(scene.body, sceneRules, {
        docId: node.id,
        docTitle: node.title,
      });
      const docIgnores = ignores.filter((ig) => ig.doc_id === node.id);
      const result = applyIgnores(scene.body, raw, docIgnores);
      all.push(...result.issues);
      ignored += result.ignored;
      this.persist(node.id, result.issues);

      if (i % 10 === 0 || i === scenes.length - 1) {
        job?.progress(((i + 1) / total) * 0.9, `检查 ${i + 1}/${scenes.length} 个场景`);
      }
    }

    // 书级规则：把全部正文拼起来，用每段的起始偏移把命中还原到场景
    if (bookRules.length > 0) {
      job?.throwIfCancelled();
      job?.progress(0.92, '检查全书规则');
      const joined = segments.map((s) => s.body).join('\n\n');

      for (const rule of bookRules) {
        for (const hit of runRule(joined, rule)) {
          const seg = findSegment(segments, hit.from);
          if (!seg) continue;
          const from = hit.from - seg.start;
          const to = hit.to - seg.start;
          if (from < 0 || from > seg.body.length) continue;
          const issue = makeIssue(rule, hit, from, to, seg.docId, seg.docTitle);
          const docIgnores = ignores.filter((ig) => ig.doc_id === seg.docId);
          const kept = applyIgnores(seg.body, [issue], docIgnores);
          if (kept.issues.length > 0) all.push(issue);
          else ignored += 1;
        }
      }
    }

    all.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.from - b.from);
    job?.progress(1, '检查完成');
    return { issues: all, took_ms: Date.now() - t0, ignored };
  }

  /** 写入索引。索引可重建，写失败只记日志，不影响检查结果返回。 */
  private persist(docId: string, issues: LintIssue[]): void {
    try {
      this.ctx.index.replaceLintResults(
        docId,
        issues.map((i) => ({
          rule_id: i.rule_id,
          from_pos: i.from,
          to_pos: i.to,
          text: i.text,
          message: i.message,
          severity: i.severity,
        })),
      );
    } catch (err) {
      console.error(`[lint] 写入索引失败（不影响检查结果）:`, err);
    }
  }

  // ─────────────────────────── 忽略记录 ───────────────────────────

  async listIgnores(): Promise<LintIgnore[]> {
    if (this.ignoreCache) return [...this.ignoreCache];
    const raw = await readJsonSafe<LintIgnore[]>(this.ignoreFile, []);
    this.ignoreCache = Array.isArray(raw) ? raw.filter(isIgnore) : [];
    return [...this.ignoreCache];
  }

  private async loadIgnores(): Promise<LintIgnore[]> {
    return this.listIgnores();
  }

  private async saveIgnores(list: LintIgnore[]): Promise<void> {
    await writeJsonAtomic(this.ignoreFile, list);
    this.ignoreCache = list;
  }

  /**
   * 忽略一条检查结果。
   *
   * 记录里同时存 text 和 anchor：text 用于「同一条规则下这段文字」，anchor 用于
   * 「还是原来那一处」。只存位置会在编辑后错位，只存文字会误伤同文的其它位置。
   */
  async ignore(issue: LintIssue, body?: string): Promise<LintIgnore> {
    return this.mutex.run(async () => {
      const docId = issue.doc_id ?? '';
      const text = body ?? (await this.ctx.store.readScene(docId))?.body ?? '';
      const anchor = makeAnchor(text, issue.from, issue.to, issue.text);
      const record: LintIgnore = {
        rule_id: issue.rule_id,
        doc_id: docId,
        text: issue.text,
        anchor,
      };

      const list = await this.loadIgnores();
      const dup = list.some(
        (i) => i.rule_id === record.rule_id && i.doc_id === record.doc_id && i.anchor === record.anchor,
      );
      if (!dup) {
        list.push(record);
        await this.saveIgnores(list);
      }
      return record;
    });
  }

  /** 取消忽略：按 rule + doc + 文本定位（前端只有文本，没有位置） */
  async unignore(ruleId: string, docId: string, text: string): Promise<void> {
    return this.mutex.run(async () => {
      const list = await this.loadIgnores();
      const next = list.filter(
        (i) => !(i.rule_id === ruleId && i.doc_id === docId && (text === '' || i.text === text)),
      );
      if (next.length !== list.length) await this.saveIgnores(next);
    });
  }

  /** 清空忽略记录（可按场景） */
  async clearIgnores(docId?: string): Promise<void> {
    return this.mutex.run(async () => {
      const list = await this.loadIgnores();
      const next = docId ? list.filter((i) => i.doc_id !== docId) : [];
      await this.saveIgnores(next);
    });
  }

  /** 外部改了忽略文件后强制重读 */
  invalidate(): void {
    this.ignoreCache = null;
  }
}

// ─────────────────────────── 纯函数部分 ───────────────────────────

interface IssueContext {
  docId: string;
  docTitle?: string;
}

function collectIssues(body: string, rules: RuleDef[], ctx: IssueContext): LintIssue[] {
  const out: LintIssue[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    let hits: RawHit[];
    try {
      hits = runRule(body, rule);
    } catch (err) {
      // 单条规则炸了不能拖垮整次检查（用户可能写坏了自定义正则）
      console.error(`[lint] 规则 ${rule.id} 执行失败:`, err);
      continue;
    }
    for (const hit of hits) {
      out.push(makeIssue(rule, hit, hit.from, hit.to, ctx.docId, ctx.docTitle));
    }
  }
  out.sort((a, b) => a.from - b.from || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return out;
}

function makeIssue(
  rule: RuleDef,
  hit: RawHit,
  from: number,
  to: number,
  docId: string,
  docTitle?: string,
): LintIssue {
  const issue: LintIssue = {
    id: shortHash(`${rule.id}|${docId}|${from}|${to}`),
    rule_id: rule.id,
    rule_name: rule.name,
    severity: rule.severity,
    from,
    to,
    text: hit.text,
    message: hit.message,
    fixable: rule.fixable,
  };
  if (docId) issue.doc_id = docId;
  if (docTitle) issue.doc_title = docTitle;
  if (rule.fixable && hit.fix !== undefined) issue.fix = hit.fix;
  return issue;
}

/** 过滤掉命中忽略记录的条目，返回保留项与被忽略数量 */
function applyIgnores(
  body: string,
  issues: LintIssue[],
  ignores: LintIgnore[],
): { issues: LintIssue[]; ignored: number } {
  if (ignores.length === 0) return { issues, ignored: 0 };
  const kept: LintIssue[] = [];
  let ignored = 0;
  for (const issue of issues) {
    if (ignores.some((ig) => matchesIgnore(body, issue, ig))) ignored++;
    else kept.push(issue);
  }
  return { issues: kept, ignored };
}

/**
 * 锚点格式：`前文⟪原文⟫后文`（前后各 ANCHOR_RADIUS 个字符）。
 * 可读性优先 —— 作者打开 lint-ignore.json 能看懂自己忽略了什么。
 */
function makeAnchor(body: string, from: number, to: number, text: string): string {
  // 归一化尾部空白：检查时用的 body 可能带尾随换行（编辑器原文），
  // 而从磁盘读回的正文已被规范化掉尾部空白。不归一化的话，
  // 「忽略」写入时和「过滤」读取时算出的锚点会差一个换行，忽略就失效了。
  const text0 = body.replace(/\s+$/, '');
  const pre = text0.slice(Math.max(0, from - ANCHOR_RADIUS), Math.max(0, from));
  const post = text0.slice(Math.min(text0.length, to), Math.min(text0.length, to + ANCHOR_RADIUS));
  return `${pre}⟪${text}⟫${post}`;
}

function matchesIgnore(body: string, issue: LintIssue, ig: LintIgnore): boolean {
  if (ig.rule_id !== issue.rule_id) return false;
  if (issue.doc_id && ig.doc_id !== issue.doc_id) return false;
  if (ig.text !== issue.text) return false;
  // 位置变了但前后文还在 → 仍视为同一条（这是锚点存在的意义）
  return makeAnchor(body, issue.from, issue.to, issue.text) === ig.anchor;
}

/** 在拼接文本里找到命中位置所属的场景 */
function findSegment<T extends { start: number; body: string }>(segments: T[], pos: number): T | null {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = segments[mid];
    const end = seg.start + seg.body.length;
    if (pos < seg.start) hi = mid - 1;
    else if (pos > end) lo = mid + 1;
    else return seg;
  }
  return null;
}

function isIgnore(v: unknown): v is LintIgnore {
  if (!v || typeof v !== 'object') return false;
  const i = v as LintIgnore;
  return typeof i.rule_id === 'string' && typeof i.doc_id === 'string' && typeof i.text === 'string';
}
