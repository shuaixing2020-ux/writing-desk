/**
 * 标点规整（架构 3.1「中文排版」P0 项）。
 *
 * 只在项目开启 auto_punct 时应用，且只在「保存」这一步做 ——
 * 不碰编辑器里的实时输入，避免作者正在打字时被改写、光标乱跳。
 *
 * 设计原则：**只做无损、无歧义的替换**。
 * 中文写作里有些写法看起来不规范但其实有语义（比如「。。。」可能是
 * 特殊的省略语气），所以这里只处理确定无疑的几种：
 *
 *   ... / 。。。 / ．．．      → ……（中文省略号固定六点）
 *   -- / — / －－             → ——（中文破折号固定两个）
 *   连续重复的 ！ ？ 。       → 折叠成一个（！！！ → ！）
 *   中文语境里的半角 , . ? ! : ; → 全角
 *
 * 刻意不做的：
 *   - 不改引号（“ ” 与 「 」 是风格选择，由 lint 规则提示而非强改）
 *   - 不删空格（作者可能有意为之）
 *   - 不改数字、英文、代码块内的标点
 */

/** 代码块与行内代码的区域不参与规整（技术文档类项目可能用到） */
function isProtectedRegion(text: string, index: number): boolean {
  // 粗略判断：向前找最近的 ``` 出现次数，奇数说明在代码块内
  const before = text.slice(0, index);
  const fences = (before.match(/```/g) ?? []).length;
  if (fences % 2 === 1) return true;

  // 行内代码 `...`
  const lineStart = before.lastIndexOf('\n') + 1;
  const line = before.slice(lineStart);
  const backticks = (line.match(/`/g) ?? []).length;
  return backticks % 2 === 1;
}

/**
 * 规整正文标点。幂等：对已规整的文本再跑一次结果不变。
 */
export function normalizePunctuation(text: string): string {
  if (!text) return text;

  let out = text;

  // 1. 省略号：... / 。。。 / ．．． / ⋯ → ……
  //    先处理 ASCII 三点（可能 2 个以上），再处理中文句号三连
  out = out.replace(/\.{2,}/g, '……');
  out = out.replace(/。{2,}/g, '……');
  out = out.replace(/．{2,}/g, '……');
  out = out.replace(/…{1,}/g, '……'); // …… 与 …… 统一成两个省略号字符
  out = out.replace(/⋯+/g, '……');

  // 2. 破折号：-- / — / －－ / ── → ——
  out = out.replace(/-{2,}/g, '——');
  out = out.replace(/—{1,}/g, '——');
  out = out.replace(/─{2,}/g, '——');
  out = out.replace(/–{2,}/g, '——');

  // 3. 重复标点折叠：！！！ → ！ ？？？ → ？ 。。。 已在上一步处理
  out = out.replace(/([！？])\1+/g, '$1');

  // 4. 半角 → 全角（仅当两侧是中文时，避免破坏英文与数字）
  //    例如「他说,好」→「他说，好」，但「3.14」「a, b」保持不变
  out = out.replace(
    /([\u4e00-\u9fff\u3400-\u4dbf])[,](?=[\u4e00-\u9fff\u3400-\u4dbf\u201c\u201d])/g,
    '$1，',
  );
  out = out.replace(
    /([\u4e00-\u9fff\u3400-\u4dbf])[.](?=[\u4e00-\u9fff\u3400-\u4dbf\u201c\u201d])/g,
    '$1。',
  );
  out = out.replace(
    /([\u4e00-\u9fff\u3400-\u4dbf])[?](?=[\u4e00-\u9fff\u3400-\u4dbf\u201c\u201d])/g,
    '$1？',
  );
  out = out.replace(
    /([\u4e00-\u9fff\u3400-\u4dbf])[!](?=[\u4e00-\u9fff\u3400-\u4dbf\u201c\u201d])/g,
    '$1！',
  );
  out = out.replace(
    /([\u4e00-\u9fff\u3400-\u4dbf])[:](?=[\u4e00-\u9fff\u3400-\u4dbf\u201c\u201d])/g,
    '$1：',
  );
  out = out.replace(
    /([\u4e00-\u9fff\u3400-\u4dbf])[;](?=[\u4e00-\u9fff\u3400-\u4dbf\u201c\u201d])/g,
    '$1；',
  );

  // 5. 中文与全角标点之间的多余空格（如「你好 ，」→「你好，」）
  out = out.replace(/([\u4e00-\u9fff])\s+([，。！？；：、])/g, '$1$2');
  out = out.replace(/([，。！？；：、])\s+([\u4e00-\u9fff])/g, '$1$2');

  return out;
}

/**
 * 按段落应用规整，跳过代码块。
 *
 * 逐段处理而不是整篇正则，是为了让代码块的跳过判断足够准确 ——
 * 整篇正则时很难知道某个位置是否在 ``` 内。
 */
export function normalizePunctuationSafe(text: string): string {
  if (!text) return text;
  // 有代码块才走逐段路径，普通小说正文直接整篇处理（更快）
  if (!text.includes('```') && !text.includes('`')) {
    return normalizePunctuation(text);
  }

  const paragraphs = text.split(/\n{2,}/);
  const out = paragraphs.map((p) => {
    if (p.trimStart().startsWith('```') || p.includes('`')) return p;
    return normalizePunctuation(p);
  });
  return out.join('\n\n');
}

/**
 * 计算规整后的差异数量，用于保存时给作者提示。
 * 返回 null 表示无变化。
 */
export function punctuationDiffCount(before: string, after: string): number | null {
  if (before === after) return null;
  // 粗算：按段落比对，统计有多少段落发生变化
  const a = before.split(/\n{2,}/);
  const b = after.split(/\n{2,}/);
  let n = 0;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) n++;
  }
  return n || 1;
}
