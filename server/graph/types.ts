/**
 * 关系类型注册表。
 *
 * 内置一份默认值（覆盖小说创作最常见的关系），
 * 作者可以在 `bible/_relation_types.json` 里覆盖或新增。
 * 文件名以 `_` 开头 —— 现有的 listEntities 本来就会跳过这类文件，不会当成条目。
 *
 * 降级策略：配置文件不存在 → 用默认值；JSON 损坏 → 用默认值 + 返回 warnings。
 * 绝不因为一个配置文件坏了就让设定库打不开。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { EntityType, RelationTypeDef } from '../../shared/types.ts';

/** 端点约束里用到的简写：允许的类型集合 */
type EndpointRule = { from: EntityType[]; to: EntityType[] };

interface BuiltinTypeDef extends RelationTypeDef {
  /** 内部用的端点约束，序列化到 RelationTypeDef 时转成 allowed 数组 */
  endpoints?: EndpointRule;
}

/**
 * 内置类型默认值。
 *
 * `exclusive_with` 只用于界面提示（"同时存在敌对与盟友，确认一下"），不拒绝写入 ——
 * 小说里关系反转本来就是常见剧情，工具不该拦。
 */
const BUILTIN: BuiltinTypeDef[] = [
  {
    key: 'mentor',
    label: '师徒',
    inverse_label: '徒弟',
    directed: true,
    allowed: [['character', 'character']],
    acyclic: true,
    exclusive_with: [],
  },
  {
    key: 'kin',
    label: '亲属',
    inverse_label: '亲属',
    directed: false,
    allowed: [['character', 'character']],
    acyclic: false,
    exclusive_with: [],
  },
  {
    key: 'love',
    label: '情感',
    inverse_label: '情感',
    directed: false,
    allowed: [['character', 'character']],
    acyclic: false,
    exclusive_with: [],
  },
  {
    key: 'ally',
    label: '盟友',
    inverse_label: '盟友',
    directed: false,
    allowed: [
      ['character', 'character'],
      ['character', 'faction'],
      ['faction', 'character'],
      ['faction', 'faction'],
    ],
    acyclic: false,
    exclusive_with: ['enemy'],
  },
  {
    key: 'enemy',
    label: '敌对',
    inverse_label: '敌对',
    directed: false,
    allowed: [
      ['character', 'character'],
      ['character', 'faction'],
      ['faction', 'character'],
      ['faction', 'faction'],
    ],
    acyclic: false,
    exclusive_with: ['ally'],
  },
  {
    key: 'member_of',
    label: '隶属',
    inverse_label: '成员',
    directed: true,
    allowed: [
      ['character', 'faction'],
      ['faction', 'faction'],
    ],
    acyclic: false,
    exclusive_with: [],
  },
  {
    key: 'located_at',
    label: '位于',
    inverse_label: '容纳',
    directed: true,
    allowed: [
      ['character', 'place'],
      ['faction', 'place'],
      ['event', 'place'],
    ],
    acyclic: false,
    exclusive_with: [],
  },
  {
    key: 'participates',
    label: '参与',
    inverse_label: '参与者',
    directed: true,
    allowed: [['character', 'event']],
    acyclic: false,
    exclusive_with: [],
  },
  {
    key: 'causes',
    label: '导致',
    inverse_label: '起因于',
    directed: true,
    allowed: [['event', 'event']],
    acyclic: true,
    exclusive_with: [],
  },
  {
    key: 'owns',
    label: '拥有',
    inverse_label: '归属于',
    directed: true,
    allowed: [
      ['character', 'item'],
      ['faction', 'item'],
    ],
    acyclic: false,
    exclusive_with: [],
  },
];

/** 配置文件相对项目根的位置 */
export const RELATION_TYPES_FILE = path.join('bible', '_relation_types.json');

export interface RelationTypeTable {
  /** key → 定义 */
  byKey: Map<string, RelationTypeDef>;
  /** 中文显示名或 key → key，便于在文件里写「师徒」也能识别 */
  byLabel: Map<string, string>;
  /** 加载过程中的问题（JSON 损坏、被忽略的非法条目） */
  warnings: string[];
}

function toDef(raw: BuiltinTypeDef): RelationTypeDef {
  const def: RelationTypeDef = {
    key: raw.key,
    label: raw.label,
    inverse_label: raw.inverse_label,
    directed: raw.directed,
    allowed: raw.allowed ?? null,
    acyclic: raw.acyclic,
    exclusive_with: raw.exclusive_with ?? [],
  };
  return def;
}

/** 默认注册表（不读文件），测试与快速判断用 */
export function defaultRelationTypes(): RelationTypeTable {
  const byKey = new Map<string, RelationTypeDef>();
  const byLabel = new Map<string, string>();
  for (const raw of BUILTIN) {
    const def = toDef(raw);
    byKey.set(def.key, def);
    byLabel.set(def.label, def.key);
    byLabel.set(def.key, def.key);
  }
  return { byKey, byLabel, warnings: [] };
}

interface ConfigEntry {
  key?: string;
  label?: string;
  inverse_label?: string;
  directed?: boolean;
  allowed?: Array<[string, string]> | null;
  acyclic?: boolean;
  exclusive_with?: string[];
  /** 删除一个内置类型（作者不想要） */
  disabled?: boolean;
}

function isEntityType(v: unknown): v is EntityType {
  return typeof v === 'string' && v.length > 0;
}

/**
 * 从项目根目录加载类型表。
 *
 * 合并规则：内置默认 → 配置文件按 key 覆盖/新增/禁用。
 * 配置文件里的非法条目跳过并记 warning，不中断加载。
 */
export async function loadRelationTypes(root: string): Promise<RelationTypeTable> {
  const table = defaultRelationTypes();
  const file = path.join(root, RELATION_TYPES_FILE);

  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return table;
    table.warnings.push(`读取关系类型配置失败：${(err as Error).message}`);
    return table;
  }

  let entries: unknown;
  try {
    const parsed = JSON.parse(text) as { types?: unknown } | unknown[];
    entries = Array.isArray(parsed) ? parsed : (parsed as { types?: unknown })?.types;
  } catch (err) {
    table.warnings.push(`关系类型配置不是合法 JSON，已回退默认值：${(err as Error).message}`);
    return table;
  }

  if (!Array.isArray(entries)) {
    table.warnings.push('关系类型配置格式不正确（应为数组或 { types: [...] }），已回退默认值');
    return table;
  }

  for (const [i, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object') {
      table.warnings.push(`第 ${i + 1} 项不是对象，已跳过`);
      continue;
    }
    const e = entry as ConfigEntry;
    const key = typeof e.key === 'string' ? e.key.trim() : '';
    if (!key) {
      table.warnings.push(`第 ${i + 1} 项缺少 key，已跳过`);
      continue;
    }

    if (e.disabled) {
      table.byKey.delete(key);
      // byLabel 里指向该 key 的条目也一并清掉
      for (const [label, k] of [...table.byLabel]) {
        if (k === key) table.byLabel.delete(label);
      }
      continue;
    }

    const base = table.byKey.get(key);
    const allowed: RelationTypeDef['allowed'] =
      e.allowed === null
        ? null
        : Array.isArray(e.allowed)
          ? e.allowed
              .filter((pair): pair is [string, string] => Array.isArray(pair) && pair.length === 2 && isEntityType(pair[0]) && isEntityType(pair[1]))
              .map(([a, b]) => [a, b] as [EntityType, EntityType])
          : (base?.allowed ?? null);

    const def: RelationTypeDef = {
      key,
      label: typeof e.label === 'string' && e.label.trim() ? e.label.trim() : (base?.label ?? key),
      inverse_label:
        typeof e.inverse_label === 'string' && e.inverse_label.trim()
          ? e.inverse_label.trim()
          : (base?.inverse_label ?? base?.label ?? key),
      directed: typeof e.directed === 'boolean' ? e.directed : (base?.directed ?? true),
      allowed,
      acyclic: typeof e.acyclic === 'boolean' ? e.acyclic : (base?.acyclic ?? false),
      exclusive_with: Array.isArray(e.exclusive_with)
        ? e.exclusive_with.filter((x): x is string => typeof x === 'string')
        : (base?.exclusive_with ?? []),
    };

    table.byKey.set(key, def);
    table.byLabel.set(def.label, key);
    table.byLabel.set(key, key);
  }

  return table;
}

/**
 * 把文件里写的「类型」解析成注册表键。
 * 支持写 key（mentor）或中文显示名（师徒）。
 */
export function resolveTypeKey(table: RelationTypeTable, raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (table.byKey.has(t)) return t;
  const byLabel = table.byLabel.get(t);
  return byLabel ?? null;
}

/** 取某个类型定义 */
export function getTypeDef(table: RelationTypeTable, raw: string): RelationTypeDef | null {
  const key = resolveTypeKey(table, raw);
  return key ? (table.byKey.get(key) ?? null) : null;
}

/**
 * 判断一个端点组合是否被允许。
 * `allowed === null` 表示不限类型。
 */
export function isEndpointAllowed(def: RelationTypeDef, fromType: EntityType, toType: EntityType): boolean {
  if (def.allowed === null) return true;
  return def.allowed.some(([a, b]) => a === fromType && b === toType);
}

/** 生成「允许的组合」的可读文本，用于报错信息 */
export function describeAllowed(def: RelationTypeDef): string {
  if (def.allowed === null) return '不限类型';
  return def.allowed.map(([a, b]) => `${a}→${b}`).join('、');
}
