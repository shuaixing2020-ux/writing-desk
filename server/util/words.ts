/**
 * 字数口径（架构 7.3）。
 *
 * 三档：仅汉字 / 汉字+标点 / 平台口径（含标点与空格）。
 * 全书统计、章节统计、每日目标、导出报告必须共用这一处实现，
 * 否则作者会发现工具数字和发布平台对不上。
 */

import type { CountMode } from '../../shared/types.ts';

// 汉字：基本区 + 扩展A + 兼容区 + 扩展B..F（用码点范围判断，正则里写全太啰嗦）
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
 * - platform：汉字 + 标点 + 空格换行以外的可见字符，且把连续空白折叠为 1
 *   （起点/番茄等平台口径通常按"字符数（不计空格）"或"含空格"两种；
 *    这里取含标点与可见符号、不计换行的通用口径）
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
  return text
    .split(/\n+/)
    .filter((line) => /^[\s\u3000]*[“"「『]/.test(line)).length;
}
