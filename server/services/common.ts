/**
 * 服务层内部共用的小工具。
 *
 * 只放「三个以上服务都要用、且与业务无关」的东西：
 * 互斥锁、时间戳格式、路径判断、字符计数。
 * 业务逻辑一律留在各自服务里，避免这里变成一个什么都往里塞的杂物间。
 */

import path from 'node:path';

/**
 * 串行化异步写操作。
 *
 * 为什么需要：快照索引、检查忽略表、备份配置都是「读 JSON → 改 → 写 JSON」，
 * 两个请求同时进来会互相覆盖（后写的把先写的改动吞掉）。
 * 服务层的写操作本身很快，用一把简单的尾随 Promise 锁足够。
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => {});
    return result;
  }
}

/** 文件名友好的本地时间戳：20261027-183000（快照、导出、备份文件名共用） */
export function formatStamp(ts: number = Date.now()): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 按码点计数（与字数口径、字符偏移口径一致，避免把代理对算成两个字符） */
export function countCodePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** 路径统一成正斜杠，便于写进 JSON / tar / zip / URL */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * target 是否在 root 之内（含 root 本身）。
 * 用于下载防目录穿越、备份目录自包含检查。
 */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 按 UTF-8 字节上限截断字符串，且不切断多字节字符（tar 头只有 100 字节） */
export function fitBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}

/** XML/HTML 转义（epub 的 xhtml、opf、ncx 共用） */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 稳定短哈希（djb2 → base36），用于生成可复现的 issue id */
export function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}
