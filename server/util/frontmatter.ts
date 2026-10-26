/**
 * 场景文件格式：Markdown 子集 + YAML 风格 frontmatter。
 *
 * 格式约束（架构 6.2）：脱离本工具也必须可读。
 * 因此只支持扁平的 key: value、数组用 [a, b]、多行文本用 | 块。
 * 不引入 YAML 库，避免"工具没了文件就打不开"。
 */

export interface Frontmatter {
  [key: string]: string | string[] | number | boolean | null | undefined;
}

const FENCE = '---';

/**
 * 解析 frontmatter + 正文。
 * 若文件不以 --- 开头，则整篇都是正文（兼容用户手工放入的 md）。
 */
export function parseFrontmatter(raw: string): { data: Frontmatter; body: string } {
  const text = raw.replace(/^\uFEFF/, ''); // 去 BOM
  if (!text.startsWith(FENCE)) {
    return { data: {}, body: text };
  }

  const lines = text.split('\n');
  // 找结束围栏
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FENCE) {
      end = i;
      break;
    }
  }
  if (end === -1) return { data: {}, body: text }; // 未闭合，按纯正文处理

  const data: Frontmatter = {};
  let i = 1;
  while (i < end) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) {
      i++;
      continue;
    }
    // 键允许中文：设定库的自定义字段常直接写「身份: 青云门弟子」
    const m = /^([^\s:#][^:]*?):\s*(.*)$/.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    const rest = m[2];

    // 多行块：key: |
    if (rest === '|' || rest === '|-' || rest === '>') {
      const buf: string[] = [];
      i++;
      while (i < end && (lines[i].startsWith('  ') || lines[i].trim() === '')) {
        buf.push(lines[i].replace(/^  /, ''));
        i++;
      }
      data[key] = buf.join('\n').replace(/\n+$/, '');
      continue;
    }

    data[key] = parseScalar(rest);
    i++;
  }

  // 正文从结束围栏之后开始，去掉紧跟的一个空行
  let bodyStart = end + 1;
  if (bodyStart < lines.length && lines[bodyStart].trim() === '') bodyStart++;
  // 去掉尾部空行：正文的规范化形态由 stringifyScene 统一负责，
  // 解析侧对齐它才能保证「读→写→读」幂等。
  const body = lines.slice(bodyStart).join('\n').replace(/\s+$/, '');

  return { data, body };
}

function parseScalar(raw: string): string | string[] | number | boolean | null {
  const v = raw.trim();

  if (v === '' || v === 'null' || v === '~') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;

  // 数组：[a, b, c]（元素可带引号）
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner).map(unquote);
  }

  // 数字
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);

  return unquote(v);
}

/** 按逗号切分，但忽略引号内的逗号 */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: string | null = null;
  for (const ch of s) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === ',') {
      out.push(buf.trim());
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function unquote(v: string): string {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const inner = s.slice(1, -1);
    return s.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n') : inner;
  }
  return s;
}

function needsQuote(v: string): boolean {
  return (
    v === '' ||
    /^[\s]|[\s]$/.test(v) ||
    /[:#\[\]{}|>&*!%@`,]/.test(v) ||
    /^-?\d+(\.\d+)?$/.test(v) ||
    ['true', 'false', 'null', '~'].includes(v)
  );
}

function serializeScalar(v: string | string[] | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    return `[${v.map((item) => (needsQuote(item) ? JSON.stringify(item) : item)).join(', ')}]`;
  }
  if (v.includes('\n')) {
    // 多行值用块标量
    return '|\n' + v.split('\n').map((l) => '  ' + l).join('\n');
  }
  return needsQuote(v) ? JSON.stringify(v) : v;
}

/** 序列化为完整文件内容（frontmatter + 空行 + 正文） */
export function stringifyScene(data: Frontmatter, body: string): string {
  const lines: string[] = [FENCE];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const ser = serializeScalar(value);
    if (ser.startsWith('|\n')) {
      lines.push(`${key}: |`);
      lines.push(ser.slice(2));
    } else if (ser === '') {
      // 空值不写，保持文件干净
      continue;
    } else {
      lines.push(`${key}: ${ser}`);
    }
  }
  lines.push(FENCE);
  lines.push('');
  // 正文保证以单个换行结尾（POSIX 文本文件约定）
  const normalized = body.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  if (normalized) lines.push(normalized);
  return lines.join('\n') + '\n';
}

/** 从 frontmatter 取字符串（缺失返回默认值） */
export function fmString(data: Frontmatter, key: string, fallback = ''): string {
  const v = data[key];
  if (v === null || v === undefined) return fallback;
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

/** 从 frontmatter 取数组 */
export function fmArray(data: Frontmatter, key: string): string[] {
  const v = data[key];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

/** 从 frontmatter 取数字 */
export function fmNumber(data: Frontmatter, key: string, fallback = 0): number {
  const v = data[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return fallback;
}
