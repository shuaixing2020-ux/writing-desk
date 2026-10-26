/**
 * 规则库 —— 内置规则 + 用户改动的合并层。
 *
 * 存储策略（为什么这么设计）：
 *   .studio/rules.json 里**只存用户改过的部分**（override），不存全量规则。
 *   这样应用升级时新增/修正内置规则会自然生效，不会因为文件里存着旧快照而被「冻住」。
 *   代价是每次读取要合并一次，但规则只有十几条，开销可以忽略。
 *
 *   例外：用户自建的规则（builtin=false）是完整对象，原样保存。
 *
 * 文件格式：
 *   {
 *     "version": 1,
 *     "overrides": { "punct-ellipsis": { "enabled": false }, ... },
 *     "custom": [ RuleDef, ... ],
 *     "deleted": [ "rule-id", ... ]        // 用户删除过的内置规则（升级后不再复活）
 *   }
 *
 * 注意：.studio/ 按架构约定可整体丢弃重建，所以规则文件丢了最坏情况是回到默认规则集，
 * 不会影响稿件本身。
 */

import path from 'node:path';
import type { RuleDef, Severity } from '../../shared/types.ts';
import type { ProjectContext } from '../context.ts';
import { readJsonSafe, writeJsonAtomic } from '../util/atomic.ts';
import { Mutex } from '../services/common.ts';
import { BUILTIN_RULES, cloneRule } from './builtin.ts';

const RULES_FILE = 'rules.json';
const RULES_VERSION = 1;

interface RulesFile {
  version: number;
  overrides: Record<string, Partial<RuleDef>>;
  custom: RuleDef[];
  deleted: string[];
}

const EMPTY: RulesFile = { version: RULES_VERSION, overrides: {}, custom: [], deleted: [] };

/** 用户可改的字段白名单：id / builtin 不允许改，否则规则身份就乱了 */
const EDITABLE: Array<keyof RuleDef> = [
  'name',
  'description',
  'severity',
  'scope',
  'enabled',
  'fixable',
  'pattern',
  'flags',
  'message',
  'words',
];

const SEVERITIES: Severity[] = ['info', 'warn', 'error'];

export class RuleStore {
  private ctx: ProjectContext;
  private mutex = new Mutex();
  private cache: RulesFile | null = null;

  constructor(ctx: ProjectContext) {
    this.ctx = ctx;
  }

  private get file(): string {
    return path.join(this.ctx.store.paths.studio, RULES_FILE);
  }

  /** 显式加载（路由可在打开作品时调用一次；不调用也会在首次 list 时懒加载） */
  async load(): Promise<void> {
    await this.read();
  }

  private async read(): Promise<RulesFile> {
    if (this.cache) return this.cache;
    const raw = await readJsonSafe<Partial<RulesFile>>(this.file, {});
    const file: RulesFile = {
      version: RULES_VERSION,
      overrides: sanitizeOverrides(raw.overrides),
      custom: Array.isArray(raw.custom) ? raw.custom.filter(isRuleDef).map(normalizeRule) : [],
      deleted: Array.isArray(raw.deleted) ? raw.deleted.filter((x): x is string => typeof x === 'string') : [],
    };
    this.cache = file;
    return file;
  }

  private async write(next: RulesFile): Promise<void> {
    await writeJsonAtomic(this.file, { ...next, version: RULES_VERSION });
    this.cache = next;
  }

  /** 合并后的完整规则列表：内置（应用 override / 删除）→ 自定义 */
  async list(): Promise<RuleDef[]> {
    const file = await this.read();
    const out: RuleDef[] = [];
    for (const builtin of BUILTIN_RULES) {
      const id = builtin.def.id;
      if (file.deleted.includes(id)) continue;
      const merged = { ...cloneRule(builtin.def), ...(file.overrides[id] ?? {}) };
      // 内置标记与 id 永远以代码为准
      merged.id = id;
      merged.builtin = true;
      out.push(normalizeRule(merged));
    }
    for (const custom of file.custom) out.push(normalizeRule(cloneRule(custom)));
    return out;
  }

  async get(ruleId: string): Promise<RuleDef | null> {
    const all = await this.list();
    return all.find((r) => r.id === ruleId) ?? null;
  }

  /**
   * 更新规则。内置规则写 override，自定义规则原地改。
   * 返回合并后的规则（调用方直接回给前端）。
   */
  async update(ruleId: string, patch: Partial<RuleDef>): Promise<RuleDef> {
    return this.mutex.run(async () => {
      const file = await this.read();
      const clean = pickEditable(patch);

      const builtin = BUILTIN_RULES.find((r) => r.def.id === ruleId);
      if (builtin) {
        if (file.deleted.includes(ruleId)) {
          // 删掉的内置规则又被更新：视为恢复
          file.deleted = file.deleted.filter((x) => x !== ruleId);
        }
        file.overrides[ruleId] = { ...(file.overrides[ruleId] ?? {}), ...clean };
        await this.write(file);
        const merged = { ...cloneRule(builtin.def), ...file.overrides[ruleId] };
        merged.id = ruleId;
        merged.builtin = true;
        return normalizeRule(merged);
      }

      const idx = file.custom.findIndex((r) => r.id === ruleId);
      if (idx === -1) throw new Error(`规则不存在：${ruleId}`);
      const next: RuleDef = normalizeRule({ ...file.custom[idx], ...clean, id: ruleId, builtin: false });
      file.custom[idx] = next;
      await this.write(file);
      return next;
    });
  }

  /** 新建自定义规则（id 由调用方给或自动生成） */
  async add(rule: Partial<RuleDef> & { id: string }): Promise<RuleDef> {
    return this.mutex.run(async () => {
      const file = await this.read();
      const exists =
        BUILTIN_RULES.some((r) => r.def.id === rule.id) || file.custom.some((r) => r.id === rule.id);
      if (exists) throw new Error(`规则 id 已存在：${rule.id}`);
      const next = normalizeRule({
        id: rule.id,
        name: rule.name ?? rule.id,
        description: rule.description ?? '',
        severity: rule.severity ?? 'warn',
        scope: rule.scope ?? 'scene',
        enabled: rule.enabled ?? true,
        fixable: rule.fixable ?? false,
        builtin: false,
        pattern: rule.pattern,
        flags: rule.flags,
        message: rule.message,
        words: rule.words,
      });
      file.custom.push(next);
      await this.write(file);
      return next;
    });
  }

  /** 删除规则：内置的记为 deleted（可恢复），自定义的直接移除 */
  async remove(ruleId: string): Promise<void> {
    return this.mutex.run(async () => {
      const file = await this.read();
      if (BUILTIN_RULES.some((r) => r.def.id === ruleId)) {
        if (!file.deleted.includes(ruleId)) file.deleted.push(ruleId);
        delete file.overrides[ruleId];
      } else {
        file.custom = file.custom.filter((r) => r.id !== ruleId);
      }
      await this.write(file);
    });
  }

  /** 恢复内置规则到出厂默认（清 override + 取消删除标记） */
  async reset(ruleId?: string): Promise<void> {
    return this.mutex.run(async () => {
      const file = await this.read();
      if (ruleId) {
        delete file.overrides[ruleId];
        file.deleted = file.deleted.filter((x) => x !== ruleId);
      } else {
        file.overrides = {};
        file.deleted = [];
      }
      await this.write(file);
    });
  }

  /** 配置变更后强制重读（外部改了 rules.json 时用） */
  invalidate(): void {
    this.cache = null;
  }
}

// ─────────────────────────── 内部工具 ───────────────────────────

function pickEditable(patch: Partial<RuleDef>): Partial<RuleDef> {
  const out: Partial<RuleDef> = {};
  for (const key of EDITABLE) {
    const value = patch[key];
    if (value === undefined) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

function sanitizeOverrides(raw: unknown): Record<string, Partial<RuleDef>> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, Partial<RuleDef>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    out[key] = pickEditable(value as Partial<RuleDef>);
  }
  return out;
}

function isRuleDef(v: unknown): v is RuleDef {
  return !!v && typeof v === 'object' && typeof (v as RuleDef).id === 'string';
}

/** 兜底修正非法字段，保证下游（正则编译、前端渲染）不会因为一条坏规则崩掉 */
function normalizeRule(rule: RuleDef): RuleDef {
  const severity: Severity = SEVERITIES.includes(rule.severity) ? rule.severity : 'warn';
  return {
    ...rule,
    name: rule.name || rule.id,
    description: rule.description ?? '',
    severity,
    scope: rule.scope === 'book' ? 'book' : 'scene',
    enabled: rule.enabled !== false,
    fixable: rule.fixable === true,
    builtin: rule.builtin === true,
    pattern: typeof rule.pattern === 'string' ? rule.pattern : undefined,
    flags: typeof rule.flags === 'string' ? rule.flags : undefined,
    message: typeof rule.message === 'string' ? rule.message : undefined,
    words: Array.isArray(rule.words) ? rule.words.map(String) : undefined,
  };
}
