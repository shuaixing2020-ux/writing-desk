/**
 * 关系行的解析与序列化（纯函数，无 IO）。
 *
 * 存储形态：条目文件 frontmatter 里的 `relations: |` 多行块，每行一条关系。
 *
 * 为什么用多行块而不是嵌套 YAML：
 *   本项目的 frontmatter 解析器刻意只支持扁平键值、`[a, b]` 数组、`|` 多行块
 *   （见 server/util/frontmatter.ts 开头说明）。引入 YAML 库会让「工具没了
 *   文件就打不开」，而把结构化数据塞进标量数组会踩上转义往返的问题。
 *   多行块内容原样保存，没有转义问题，作者也能直接读写。
 *
 * 行语法：
 *   id=<关系id> <类型键> (->|<-) <对方条目id> (<对方显示名>) | <属性> | <备注>
 *
 *   `->` 表示本条目指向对方（本条目是起点），`<-` 表示对方指向本条目。
 *   关系行写在**发起操作的条目**文件里，箭头表达方向 —— 于是在 B 的页面
 *   建「A 是 B 的师父」只需要改 B 一个文件，不需要事务。
 *
 *   - 用**第一个与第二个** 「空格竖线空格」切分：第 3 段到行尾，可以含 `|`
 *   - 第 2、3 段可省略
 *   - `#` 开头是注释；空行忽略；两者都原样保留位置
 *   - 无法解析的行保存为 raw，序列化时原样输出 —— 绝不静默丢弃
 */

import type { Relation } from '../../shared/types.ts';
import { ulid } from '../util/id.ts';

/** 关系的属性键（白名单之外的键进 extra_props 保留） */
export const KNOWN_PROP_KEYS = ['since', 'until', 'reveal', 'weight'] as const;

/**
 * 一行关系。
 * - `rel`：解析成功，`from` 由所在文件决定，不写在行里
 * - `raw`：注释、空行、或无法解析的行，原样保留
 */
/** 一行关系在文件里的方向（相对所在文件的条目） */
export type LineDirection = 'out' | 'in';

/** 解析出来的一行关系：`to` 是「对方条目 id」，方向看 `direction` */
export type ParsedRelation = Omit<Relation, 'from' | 'to'> & {
  to: string;
  direction: LineDirection;
};

export type RelationLine =
  | { kind: 'rel'; rel: ParsedRelation }
  | { kind: 'raw'; text: string };

/** 生成关系 id：`r_` 前缀便于人眼区分条目 id */
export function newRelationId(): string {
  return `r_${ulid()}`;
}

/**
 * 把「空格竖线空格」切分成至多 n 段，第 n 段取到行尾。
 *
 * 不用 String.split(' | ') 是因为那会把备注里的 `|` 也切碎。
 */
function splitPipes(line: string, maxParts: number): string[] {
  const SEP = ' | ';
  const parts: string[] = [];
  let pos = 0;

  while (parts.length < maxParts - 1) {
    const idx = line.indexOf(SEP, pos);
    if (idx === -1) break;
    parts.push(line.slice(pos, idx));
    // 跳过这一段，但**不跳过整个分隔符**：连续分隔符 ' | | ' 里，
    // 第一个分隔符的尾部一个空格同时是第二个分隔符的头部，
    // 直接 +3 会把第二个分隔符吞掉。只前进到分隔符末尾的前一个字符，
    // 让下一轮从那个空格开始找。
    pos = idx + SEP.length - 1;
  }
  parts.push(line.slice(pos).replace(/^\s*\|\s*/, ''));
  return parts;
}

/** 解析属性段：`since=X until=Y weight=3` */
function parseProps(seg: string): {
  known: Partial<Pick<Relation, 'since' | 'until' | 'reveal' | 'weight'>>;
  extra: Record<string, string>;
} {
  const known: Partial<Pick<Relation, 'since' | 'until' | 'reveal' | 'weight'>> = {};
  const extra: Record<string, string> = {};

  for (const token of seg.trim().split(/\s+/)) {
    if (!token) continue;
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (!value) continue;

    if (key === 'since' || key === 'until' || key === 'reveal') {
      known[key] = value;
    } else if (key === 'weight') {
      const n = Number(value);
      if (Number.isFinite(n)) known.weight = n;
      else extra.weight = value; // 非法权重原样保留，不丢数据
    } else {
      extra[key] = value;
    }
  }
  return { known, extra };
}

/**
 * 解析单行。
 * 返回 null 表示这一行不是关系（应作为 raw 保留）。
 */
function parseLine(line: string): ParsedRelation | null {
  const parts = splitPipes(line.trim(), 3);
  const head = parts[0];
  let propSeg = parts[1] ?? '';
  // 注意用 length 判断而不是 ?? ''：备注段是空字符串时是合法形态（无备注）。
  const seg3 = parts.length >= 3 ? parts[2] : undefined;

  let note: string;
  if (seg3 !== undefined) {
    // 三段齐全：第 2 段是属性，第 3 段是备注
    note = seg3;
  } else if (propSeg && !/[\w-]+=\S/.test(propSeg)) {
    // 只有两段且第 2 段不含 key=value 形式 → 那其实是备注，不是属性
    note = propSeg;
    propSeg = '';
  } else {
    note = '';
  }

  // 主体：id=... <类型> (->|<-) <对方id> (显示名)
  // id 与类型之间至少一个空格；类型不含空格；箭头两侧可以有空格
  const m = /^id=(\S+)\s+(\S+)\s*(->|<-)\s*([0-9A-Za-z_-]+)\s*(?:\(([^)]*)\))?\s*$/.exec(head);
  if (!m) return null;

  const [, id, type, arrow, to, toName] = m;
  if (!id || !type || !to) return null;

  const { known, extra } = parseProps(propSeg);

  const rel: ParsedRelation = {
    id,
    type,
    to,
    direction: arrow === '<-' ? 'in' : 'out',
    note: note.trim(),
  };
  if (toName !== undefined) rel.to_name = toName.trim();
  if (known.since !== undefined) rel.since = known.since;
  if (known.until !== undefined) rel.until = known.until;
  if (known.reveal !== undefined) rel.reveal = known.reveal;
  if (known.weight !== undefined) rel.weight = known.weight;
  if (Object.keys(extra).length > 0) rel.extra_props = extra;

  return rel;
}

/**
 * 解析整块文本为行数组。
 * 空行与注释、无法解析的行都作为 raw 保留原样（位置不变）。
 */
export function parseRelations(block: string): RelationLine[] {
  if (!block) return [];
  const lines = block.replace(/\r\n/g, '\n').split('\n');
  const out: RelationLine[] = [];

  for (const raw of lines) {
    const trimmed = raw.trim();

    // 空行与注释：原样保留（注意保留原始缩进，序列化时不要"重整"）
    if (trimmed === '' || trimmed.startsWith('#')) {
      out.push({ kind: 'raw', text: raw });
      continue;
    }

    const rel = parseLine(trimmed);
    if (rel) out.push({ kind: 'rel', rel });
    else out.push({ kind: 'raw', text: raw }); // 无法解析 → 原样保留
  }

  return out;
}

/** 序列化单个关系为一行（规范化形式） */
export function stringifyRelation(rel: ParsedRelation): string {
  const arrow = rel.direction === 'in' ? '<-' : '->';
  let line = `id=${rel.id} ${rel.type} ${arrow} ${rel.to}`;
  if (rel.to_name) line += ` (${rel.to_name})`;

  const props: string[] = [];
  if (rel.since) props.push(`since=${rel.since}`);
  if (rel.until) props.push(`until=${rel.until}`);
  if (rel.reveal) props.push(`reveal=${rel.reveal}`);
  if (rel.weight !== undefined && rel.weight !== null) props.push(`weight=${rel.weight}`);
  // 未知属性按原顺序追加，不丢
  for (const [k, v] of Object.entries(rel.extra_props ?? {})) {
    props.push(`${k}=${v}`);
  }

  if (props.length > 0) line += ` | ${props.join(' ')}`;
  // 没有属性时只有一个管道，解析侧会把「只含文字的段」识别为备注。
  // 不再输出 ' | | 备注' 这种空属性段 —— 连续分隔符本身就有歧义。
  if (rel.note) line += ` | ${rel.note}`;
  return line;
}

/**
 * 序列化为多行块文本。
 * raw 行逐字输出，rel 行输出规范化形式。
 */
export function stringifyRelations(lines: RelationLine[]): string {
  // 去掉首尾的空 raw 行，避免文件里出现大片空白；中间的空行保留（是作者的分组意图）
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].kind === 'raw' && (lines[start] as { text: string }).text.trim() === '') {
    start++;
  }
  while (end > start && lines[end - 1].kind === 'raw' && (lines[end - 1] as { text: string }).text.trim() === '') {
    end--;
  }

  return lines
    .slice(start, end)
    .map((l) => (l.kind === 'rel' ? stringifyRelation(l.rel) : l.text))
    .join('\n');
}

/** 只取可用的关系（丢掉 raw 行），便于业务逻辑使用 */
export function relationsOnly(lines: RelationLine[]): ParsedRelation[] {
  return lines
    .filter((l): l is { kind: 'rel'; rel: ParsedRelation } => l.kind === 'rel')
    .map((l) => l.rel);
}

/**
 * 把「文件里的相对行」还原成「规范关系方向」。
 * direction=out 表示本条目是起点，in 表示本条目是终点。
 */
export function canonicalize(
  ownerId: string,
  rel: ParsedRelation,
): { from: string; to: string } {
  return rel.direction === 'in' ? { from: rel.to, to: ownerId } : { from: ownerId, to: rel.to };
}

/**
 * 把「规范关系」写成某个文件里的一行。
 * 关系行始终写在发起操作的条目文件里，箭头表达方向。
 */
export function lineFor(ownerId: string, rel: Relation): ParsedRelation {
  const { from, to } = rel;
  const base = {
    id: rel.id,
    type: rel.type,
    note: rel.note ?? '',
    ...(rel.since ? { since: rel.since } : {}),
    ...(rel.until ? { until: rel.until } : {}),
    ...(rel.reveal ? { reveal: rel.reveal } : {}),
    ...(rel.weight !== undefined && rel.weight !== null ? { weight: rel.weight } : {}),
    ...(rel.extra_props ? { extra_props: rel.extra_props } : {}),
  };

  if (from === ownerId) {
    return {
      ...base,
      to,
      direction: 'out',
      ...(rel.to_name ? { to_name: rel.to_name } : {}),
    };
  }
  // 本条目是终点：写成 `<- 对方`
  return { ...base, to: from, direction: 'in' };
}

/** 判断某个 raw 行是否"看起来像关系但解析失败"（用于 lint 报告，与普通注释区分） */
export function looksLikeBrokenRelation(line: RelationLine): boolean {
  if (line.kind !== 'raw') return false;
  const t = line.text.trim();
  if (!t || t.startsWith('#')) return false;
  // 含有 id= 或 -> 却没解析成功，多半是写错了
  return t.includes('id=') || t.includes('->') || t.includes('<-');
}
