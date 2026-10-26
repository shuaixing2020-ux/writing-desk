/**
 * 稳定 ID 生成：ULID 风格（时间有序 + 随机）。
 * 时间有序让快照列表天然按时间排列，无需额外索引。
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32，去掉 I L O U

function encodeTime(now: number, len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    out = ENCODING[now % 32] + out;
    now = Math.floor(now / 32);
  }
  return out;
}

function randomChars(len: number): string {
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += ENCODING[bytes[i] % 32];
  return out;
}

/** 26 字符 ULID */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now, 10) + randomChars(16);
}

/** 短 id（用于作业、快照等非关键标识） */
export function shortId(len = 12): string {
  return randomChars(len);
}

/**
 * 文件名安全的 slug：保留中文、字母、数字、连字符，其余转连字符。
 * 中文文件名是允许的（macOS/Linux/Windows 均支持 UTF-8 文件名），
 * 只替换路径分隔符、控制字符与 Windows 保留字符。
 */
export function safeName(title: string, maxLen = 40): string {
  const cleaned = String(title ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // 按码点截断，避免切坏代理对
  const chars = Array.from(cleaned);
  const cut = chars.length > maxLen ? chars.slice(0, maxLen).join('') : cleaned;
  return cut.length > 0 ? cut : 'untitled';
}

/** 零填充序号，用于文件名前缀排序（v01 / c001 / s0001） */
export function pad(n: number, width: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(width, '0');
}
