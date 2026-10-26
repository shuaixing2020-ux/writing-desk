/**
 * 前端字数统计 —— 与 server/util/words.ts 逐字一致。
 *
 * 为什么要在前端复制一份：作者每敲一个字都要看到即时数字，
 * 不能等一次网络往返。但两份实现一旦漂移，状态栏就会和导出报告、
 * 平台后台对不上，作者会认为工具在骗人。所以这里的算法是从服务端
 * 原样搬过来的，改任何一处都必须同步改另一边。
 */

import type { CountMode } from '../../../shared/types.ts';

/** 汉字：基本区 + 扩展 A + 兼容区 + 扩展 B..G（码点范围判断） */
function isHanziCodePoint(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意文字
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容表意文字
    (cp >= 0x20000 && cp <= 0x2a6df) || // 扩展 B
    (cp >= 0x2a700 && cp <= 0x2ebef) || // 扩展 C-F
    (cp >= 0x30000 && cp <= 0x3134f) // 扩展 G
  );
}

/** 中文标点（全角）与常见英文标点 */
const PUNCT_RE =
  /[\u3000-\u303f\uff00-\uffef\u2000-\u206f!-/:-@[-`{-~\u2018\u2019\u201c\u201d\u2014\u2026]/u;

function isPunct(ch: string): boolean {
  return PUNCT_RE.test(ch);
}

/**
 * 统计字数。
 *
 * - hanzi：只数汉字
 * - hanzi_punct：汉字 + 标点
 * - platform：所有非空白字符（含字母、数字、标点），换行与空格不算
 */
export function countWords(text: string, mode: CountMode = 'hanzi'): number {
  if (!text) return 0;

  let count = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;

    if (mode === 'hanzi') {
      if (isHanziCodePoint(cp)) count++;
      continue;
    }

    if (mode === 'hanzi_punct') {
      if (isHanziCodePoint(cp) || isPunct(ch)) count++;
      continue;
    }

    // platform：所有非空白字符都算（含字母、数字、标点），换行与空格不算
    if (!/\s/.test(ch)) count++;
  }

  return count;
}

/** 统计段落数（非空行） */
export function countParagraphs(text: string): number {
  return text.split(/\n+/).filter((line) => line.trim().length > 0).length;
}

/** 统计对话行数（以引号开头的段落），用于对白占比 */
export function countDialogueParagraphs(text: string): number {
  return text.split(/\n+/).filter((line) => /^[\s\u3000]*[“"「『]/.test(line)).length;
}

/** 字符数（不含任何空白），编辑器头部显示用 */
export function countChars(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (const ch of text) {
    if (!/\s/.test(ch)) n++;
  }
  return n;
}

/** 预计阅读时长（分钟），按中文每分钟 400 字粗算 */
export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 400));
}
