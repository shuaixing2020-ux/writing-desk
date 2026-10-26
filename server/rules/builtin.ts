/**
 * 内置规则包 —— 中文写作的「标点 / 易错字 / 重复」检查。
 *
 * 设计取舍：
 *   1. 规则是数据（RuleDef），但**检测逻辑不是数据**。纯正则能表达的（省略号、重复标点、
 *      半角标点）做成可配置 pattern；需要看结构的（引号配对、连续段首、段长）只能是函数。
 *      让作者在 JSON 里写一个配对引号的算法不现实，也不该让用户承担这个复杂度。
 *   2. 所有规则都返回「真实命中的位置 + 原文」，前端才能把光标跳到对应字符。
 *      偏移口径是 JS 字符串下标（UTF-16），与 textarea 的 selectionStart 一致；
 *      逐字索引里用的是码点序号，两者在含 emoji 的正文里会差，但检查面板只用于跳转，
 *      用 UTF-16 才跳得准。
 *   3. 严重程度默认克制：只有「引号不成对」是 error（它真的会让读者看到错位的对话），
 *      其余 warn/info。检查器的作用是提示，不是替作者做决定。
 */

import type { RuleDef } from '../../shared/types.ts';

/** 单条规则在单个场景内的命中上限：防止病态文本把检查结果撑爆 */
export const MAX_HITS_PER_RULE = 300;

export interface RawHit {
  from: number;
  to: number;
  text: string;
  message: string;
  fix?: string;
}

export type Detector = (text: string, rule: RuleDef) => RawHit[];

export interface BuiltinRule {
  /** 内置默认值：既是最初写进 rules.json 的内容，也是「升级不覆盖用户改动」的比较基准 */
  def: RuleDef;
  detect: Detector;
}

// ─────────────────────────── 通用小工具 ───────────────────────────

/** 只保留 JS 支持的正则标志，并强制带 g（matchAll 要求） */
function buildRegex(pattern: string, flags?: string): RegExp {
  let f = (flags ?? '').replace(/[^gimsuy]/g, '');
  if (!f.includes('g')) f += 'g';
  try {
    return new RegExp(pattern, f);
  } catch {
    // 用户改坏了正则：退化成永不命中，而不是让整个检查崩掉
    return /$^/g;
  }
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const FULL_PUNCT_RE = /[\u3000-\u303f\uff00-\uffef]/;

function isChineseContext(ch: string): boolean {
  return CJK_RE.test(ch) || FULL_PUNCT_RE.test(ch);
}

/**
 * 判断用户是否**改过**这条规则的正则。
 *
 * 内置规则自带的 pattern 只是「默认值/参考写法」，用于面板展示与导出；
 * 真正生效的是专用检测函数（它能处理引号配对、段落结构等正则表达不了的事）。
 * 只有作者在 rules.json 里把 pattern 改成别的值，才完全交给正则执行。
 */
function patternOverridden(rule: RuleDef): boolean {
  if (!rule.pattern) return false;
  const builtin = BUILTIN_RULES.find((r) => r.def.id === rule.id);
  if (!builtin) return true; // 自定义规则：有 pattern 就用
  return rule.pattern !== builtin.def.pattern || (rule.flags ?? 'g') !== (builtin.def.flags ?? 'g');
}

/** 正则型规则的统一执行器：优先用用户在 rules.json 里改过的 pattern/flags */
function regexHits(
  text: string,
  rule: RuleDef,
  defaults: { pattern?: string; flags?: string; message: string; fix?: (m: RegExpExecArray) => string | undefined },
): RawHit[] {
  const re = buildRegex(rule.pattern || defaults.pattern || '$^', rule.flags || defaults.flags);
  const hits: RawHit[] = [];
  for (const m of text.matchAll(re)) {
    if (!m[0]) continue;
    const from = m.index ?? 0;
    hits.push({
      from,
      to: from + m[0].length,
      text: m[0],
      message: rule.message || defaults.message,
      fix: defaults.fix?.(m),
    });
    if (hits.length >= MAX_HITS_PER_RULE) break;
  }
  return hits;
}

/** 按字符找所有出现位置（词表规则用；避免为正则转义用户词条） */
function findAll(text: string, needle: string, limit = MAX_HITS_PER_RULE): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let at = text.indexOf(needle);
  while (at !== -1 && out.length < limit) {
    out.push(at);
    at = text.indexOf(needle, at + needle.length);
  }
  return out;
}

// ─────────────────────────── 1. 引号不成对 ───────────────────────────

/** 成对符号：中文正文里常见的五组。缺一个都会让读者看到错位的对话。 */
const QUOTE_PAIRS: Array<{ open: string; close: string; label: string }> = [
  { open: '“', close: '”', label: '“”' },
  { open: '‘', close: '’', label: '‘’' },
  { open: '「', close: '」', label: '「」' },
  { open: '『', close: '』', label: '『』' },
  { open: '【', close: '】', label: '【】' },
];

const CLOSE_TO_OPEN = new Map(QUOTE_PAIRS.map((p) => [p.close, p]));
const OPEN_TO_CLOSE = new Map(QUOTE_PAIRS.map((p) => [p.open, p]));

function detectUnpairedQuotes(text: string, rule: RuleDef): RawHit[] {
  const hits: RawHit[] = [];
  const stack: Array<{ open: string; pos: number }> = [];

  let pos = 0;
  for (const ch of text) {
    const opener = OPEN_TO_CLOSE.get(ch);
    if (opener) {
      stack.push({ open: ch, pos });
    } else {
      const pair = CLOSE_TO_OPEN.get(ch);
      if (pair) {
        const top = stack[stack.length - 1];
        if (top && top.open === pair.open) {
          stack.pop();
        } else if (top && top.open !== pair.open) {
          // 嵌套错位：例如「“「」”」，报在右引号上，提示缺哪个
          hits.push({
            from: pos,
            to: pos + 1,
            text: ch,
            message: `引号配对错位：此处应为「${OPEN_TO_CLOSE.get(top.open)?.close ?? '?'}」，却遇到「${ch}」`,
          });
        } else {
          hits.push({
            from: pos,
            to: pos + 1,
            text: ch,
            message: `多余的右引号「${ch}」：前面没有对应的「${pair.open}」`,
          });
        }
      }
    }
    pos += ch.length;
    if (hits.length >= MAX_HITS_PER_RULE) break;
  }

  for (const left of stack) {
    const pair = OPEN_TO_CLOSE.get(left.open);
    hits.push({
      from: left.pos,
      to: left.pos + 1,
      text: left.open,
      message: `引号未闭合：缺少对应的「${pair?.close ?? '?'}」`,
    });
  }

  hits.sort((a, b) => a.from - b.from);
  return hits.slice(0, MAX_HITS_PER_RULE).map((h) => ({ ...h, message: rule.message || h.message }));
}

// ─────────────────────────── 2. 省略号 ───────────────────────────

function detectEllipsis(text: string, rule: RuleDef): RawHit[] {
  // 用户改了 pattern 就完全交给他，内置的多写法识别让位
  if (patternOverridden(rule)) {
    return regexHits(text, rule, { message: '省略号应写作「……」', fix: () => '……' });
  }

  const hits: RawHit[] = [];
  const push = (from: number, len: number, message: string): void => {
    hits.push({ from, to: from + len, text: text.slice(from, from + len), message: rule.message || message, fix: '……' });
  };

  for (const m of text.matchAll(/\.{2,}/g)) push(m.index ?? 0, m[0].length, '省略号应写作「……」，不是连续英文句点');
  for (const m of text.matchAll(/。{2,}/g)) push(m.index ?? 0, m[0].length, '省略号应写作「……」，不是连续句号');
  for (const m of text.matchAll(/[·•・]{2,}/g)) push(m.index ?? 0, m[0].length, '省略号应写作「……」，不是间隔号');
  // 单个 … 也是错的：中文省略号固定六点（两个 U+2026）
  for (const m of text.matchAll(/…+/g)) {
    if (m[0].length === 1) push(m.index ?? 0, 1, '省略号应是「……」两个六点符号，此处只有一个');
  }

  hits.sort((a, b) => a.from - b.from);
  return hits.slice(0, MAX_HITS_PER_RULE);
}

// ─────────────────────────── 3. 破折号 ───────────────────────────

function detectDash(text: string, rule: RuleDef): RawHit[] {
  if (patternOverridden(rule)) {
    return regexHits(text, rule, { message: '破折号应写作「——」', fix: () => '——' });
  }

  const hits: RawHit[] = [];
  const push = (from: number, len: number, message: string): void => {
    hits.push({ from, to: from + len, text: text.slice(from, from + len), message: rule.message || message, fix: '——' });
  };

  for (const m of text.matchAll(/-{2,}/g)) push(m.index ?? 0, m[0].length, '破折号应写作「——」，不是两个英文连字符');
  for (const m of text.matchAll(/[─━]{2,}/g)) push(m.index ?? 0, m[0].length, '破折号应写作「——」，不是制表符横线');
  // 单个 — 是常见的输入错误（少打一个）
  for (const m of text.matchAll(/—+/g)) {
    if (m[0].length === 1) push(m.index ?? 0, 1, '破折号应写作「——」两个，此处只有一个');
  }

  hits.sort((a, b) => a.from - b.from);
  return hits.slice(0, MAX_HITS_PER_RULE);
}

// ─────────────────────────── 4. 重复标点 ───────────────────────────

function detectDuplicatePunct(text: string, rule: RuleDef): RawHit[] {
  return regexHits(text, rule, {
    pattern: '([！？，、；：～!?])\\1+',
    message: '重复标点：连续多个相同标点，保留一个即可',
    fix: (m) => m[0][0],
  });
}

// ─────────────────────────── 5. 全半角混用 ───────────────────────────

const HALF_TO_FULL: Record<string, string> = {
  ',': '，',
  '.': '。',
  '?': '？',
  '!': '！',
  ':': '：',
  ';': '；',
};

/**
 * 半角标点出现在中文语境里。
 *
 * 不能简单正则：`3.14`、`10:30`、`e.g.` 都是合法的半角；
 * 所以要求「相邻至少有一个中文字符或全角标点」，并且排除小数、时间、省略号。
 */
function detectHalfwidth(text: string, rule: RuleDef): RawHit[] {
  if (patternOverridden(rule)) {
    return regexHits(text, rule, { message: '中文语境应使用全角标点' });
  }

  const hits: RawHit[] = [];
  const chars = Array.from(text); // 按码点切，位置另行换算
  // 建立「码点下标 → UTF-16 下标」映射，因为 LintIssue 用 UTF-16 偏移
  const offsets: number[] = [];
  {
    let acc = 0;
    for (const ch of chars) {
      offsets.push(acc);
      acc += ch.length;
    }
    offsets.push(acc);
  }

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const full = HALF_TO_FULL[ch];
    if (!full) continue;

    const prev = i > 0 ? chars[i - 1] : '';
    const next = i + 1 < chars.length ? chars[i + 1] : '';
    const prevDigit = /[0-9]/.test(prev);
    const nextDigit = /[0-9]/.test(next);

    // 小数点 / 时间 / 版本号 / 英文缩写：两侧都是数字或 ASCII，不动
    if (prevDigit && nextDigit) continue;
    if (ch === '.' && (prev === '.' || next === '.')) continue; // 省略号归 ellipsis 规则
    if (prev === '.' || next === '.') continue;
    if (/[A-Za-z]/.test(prev) || /[A-Za-z]/.test(next)) {
      // 英文单词里的标点（如 `don't`）不动；但「word，中文」这种已经被全角处理
      if (!isChineseContext(prev) && !isChineseContext(next)) continue;
    }

    // 至少一侧是中文（另一侧允许是数字/英文/边界）
    if (!isChineseContext(prev) && !isChineseContext(next)) continue;

    const from = offsets[i];
    hits.push({
      from,
      to: from + ch.length,
      text: ch,
      message: rule.message || `中文语境应使用全角标点「${full}」`,
      fix: full,
    });
    if (hits.length >= MAX_HITS_PER_RULE) break;
  }

  return hits;
}

// ─────────────────────────── 6. 中文之间的多余空格 ───────────────────────────

function detectChineseSpace(text: string, rule: RuleDef): RawHit[] {
  return regexHits(text, rule, {
    pattern: '([\\u3400-\\u4dbf\\u4e00-\\u9fff])[ \\t\\u00a0\\u3000]+(?=[\\u3400-\\u4dbf\\u4e00-\\u9fff])',
    message: '中文之间不应有空格',
    fix: (m) => m[1],
  });
}

// ─────────────────────────── 7. 常见错别字 ───────────────────────────

/**
 * 内置错别字表（左错右对）。
 *
 * 只收「写错了就是错的」形近/音近字，不收「的地得」「他她它」这类需要语法判断的
 * ——后者由下面的启发式兜底，且只提示不自动改。
 */
const TYPO_WORDS: string[] = [
  '做为→作为', '作饭→做饭', '作梦→做梦', '做品→作品', '做者→作者', '做用→作用', '做业→作业',
  '在次→再次', '在来→再来', '在说→再说', '在见→再见', '在会→再会', '在接→再接',
  '既使→即使', '以经→已经', '以经→已经', '已后→以后', '因该→应该', '应刻→应该',
  '部份→部分', '连系→联系', '记念→纪念', '佩带→佩戴', '修练→修炼', '锻练→锻炼',
  '精采→精彩', '安祥→安详', '按装→安装', '布署→部署', '重迭→重叠', '凑和→凑合',
  '担搁→耽搁', '防碍→妨碍', '幅射→辐射', '回亿→回忆', '坚苦→艰苦', '娇健→矫健',
  '精萃→精粹', '痉孪→痉挛', '决对→绝对', '空闭→空闲', '腊烛→蜡烛', '立既→立即',
  '联帮→联邦', '另人→令人', '录相→录像', '漫延→蔓延', '迷语→谜语', '磨菇→蘑菇',
  '涅磐→涅槃', '偶而→偶尔', '凭添→平添', '起迄→起讫', '气慨→气概', '亲蜜→亲密',
  '清淅→清晰', '趋使→驱使', '溶入→融入', '闪铄→闪烁', '上叙→上述', '松驰→松弛',
  '随既→随即', '坦护→袒护', '陶治→陶冶', '通霄→通宵', '图径→途径', '往反→往返',
  '忘想→妄想', '委糜→萎靡', '无耐→无奈', '消毁→销毁', '严竣→严峻', '摇蓝→摇篮',
  '一副眼镜→一副眼镜', '一但→一旦', '一张一驰→一张一弛', '异口同生→异口同声',
  '忧柔寡断→优柔寡断', '原形必露→原形毕露', '再所不惜→在所不惜', '暂露头角→崭露头角',
  '责无旁代→责无旁贷', '坐阵→坐镇', '迫不急待→迫不及待', '甘败下风→甘拜下风',
  '一如继往→一如既往', '拾人牙惠→拾人牙慧', '走头无路→走投无路', '直接了当→直截了当',
];

/** 「的」误作「地」：状语位置。只查常见方式副词，宁缺勿滥。 */
const DE_AS_DI_RE =
  /(认真|慢慢|轻轻|悄悄|静静|缓缓|默默|匆匆|飞快|愤怒|高兴|伤心|激动|小心|仔细|努力|拼命|大声|小声|低声|冷冷|淡淡|狠狠|死死|紧紧|偷偷|暗自|随手|随口|顺势|故意|假装|咬牙|狠狠)的(?=(走|跑|说|看|想|笑|叫|喊|站|坐|拿|放|点|摇|叹|问|答|道|望|盯|转|推|拉|抬|低|闭|睁|握|捏|咬|听|读|写|吃|喝|睡|醒|哭|骂|打|踢|跳|冲|退|靠|躺|蹲|跪|挥|甩|扫|摸|碰|抓|抱|背|扛|拖|扔|丢|递|接|收|关|开|敲|砸|撕|踩|踏|跨|绕|穿|躲|藏|逃|追|赶|挡|拦|扶|搂|亲|吻|扑|滚|爬|跌|摔|喘|抖|颤|哼|吼|喃))/g;

/** 「的」误作「得」：补语位置。 */
const DE_AS_DE_RE =
  /(说|做|写|跑|唱|画|打|干|学|长|活|睡|吃|喝|想|走|飞|笑|哭|叫|喊|来|去|看|听)的(?=(很|非常|太|极|十分|不行|要命|厉害|好看|好听))/g;

function detectTypos(text: string, rule: RuleDef): RawHit[] {
  const hits: RawHit[] = [];
  const words = rule.words && rule.words.length > 0 ? rule.words : TYPO_WORDS;

  for (const entry of words) {
    if (!entry) continue;
    // 支持三种写法：`错`、`错→对`、`错=>对`；允许用户自己补词表
    const arrow = entry.includes('→') ? '→' : entry.includes('=>') ? '=>' : null;
    const wrong = arrow ? entry.split(arrow)[0].trim() : entry.trim();
    const right = arrow ? entry.split(arrow)[1]?.trim() : undefined;
    if (!wrong || wrong === right) continue;

    for (const at of findAll(text, wrong)) {
      hits.push({
        from: at,
        to: at + wrong.length,
        text: wrong,
        message: rule.message || (right ? `疑似错别字「${wrong}」，建议改为「${right}」` : `疑似易混词「${wrong}」，请确认用词`),
        fix: right,
      });
      if (hits.length >= MAX_HITS_PER_RULE) break;
    }
  }

  // 的地得启发式：只提示，不给自动修复（中文语法判断交给作者）
  for (const m of text.matchAll(DE_AS_DI_RE)) {
    const from = m.index ?? 0;
    hits.push({
      from,
      to: from + m[0].length,
      text: m[0],
      message: rule.message || `状语位置宜用「地」：「${m[1]}地${m[2] ?? ''}…」`,
    });
    if (hits.length >= MAX_HITS_PER_RULE) break;
  }
  for (const m of text.matchAll(DE_AS_DE_RE)) {
    const from = m.index ?? 0;
    hits.push({
      from,
      to: from + m[0].length,
      text: m[0],
      message: rule.message || `补语位置宜用「得」：「${m[1]}得…」`,
    });
    if (hits.length >= MAX_HITS_PER_RULE) break;
  }

  hits.sort((a, b) => a.from - b.from);
  return hits.slice(0, MAX_HITS_PER_RULE);
}

// ─────────────────────────── 8. 相邻重复 ───────────────────────────

/** 几乎不可能是有意重复的功能字；「好好」「慢慢」这类刻意叠词不在其中 */
const ADJACENT_DEFAULT =
  '([的地得着了过是在和与也就都又很更最吗呢吧啊呀哦嗯我你他她它])\\1+|' +
  '(然后|但是|因为|所以|而且|于是|接着|忽然|突然|虽然|如果|只是|已经|自己|我们|你们|他们|她们|这个|那个|就是|不是|没有|什么|怎么)\\2';

function detectAdjacentRepeat(text: string, rule: RuleDef): RawHit[] {
  return regexHits(text, rule, {
    pattern: ADJACENT_DEFAULT,
    message: '相邻重复用词',
    fix: (m) => m[1] ?? m[2],
  });
}

// ─────────────────────────── 9. 连续段首重复 ───────────────────────────

const LEAD_STRIP_RE = /^[\s\u3000“”‘’「」『』【】（）()《》〈〉—…·!！?？,，.。;；:：、]+/;

/** 取一段的「句首」：去掉前导引号空白后，最多 4 个字，遇到标点截断 */
function sentenceHead(para: string): string {
  const trimmed = para.replace(LEAD_STRIP_RE, '');
  const chars = Array.from(trimmed);
  let out = '';
  for (const ch of chars) {
    if (out.length >= 4) break;
    if (/[，。！？；：、,.!?;:“”‘’「」『』\s\u3000—…]/.test(ch)) break;
    out += ch;
  }
  return out;
}

function detectRepeatedStart(text: string, rule: RuleDef): RawHit[] {
  const hits: RawHit[] = [];
  // 阈值：连续多少段算重复。允许用户用 words[0] 覆盖（默认 3）
  const minRun = Math.max(2, Number(rule.words?.[0] ?? 3) || 3);
  // 句首比较长度：默认看前 2 个字。只看 1 个字会误报太多（「他…」「她…」交替），
  // 要求 4 个字全同又几乎不会命中（后面接的谓语很少一模一样）。words[1] 可调。
  const keyLen = Math.max(1, Number(rule.words?.[1] ?? 2) || 2);

  const lines = text.split('\n');
  let offset = 0;
  const heads: Array<{ head: string; key: string; from: number; para: string }> = [];
  for (const line of lines) {
    const from = offset;
    offset += line.length + 1; // +1 是被吃掉的 \n
    if (!line.trim()) continue;
    const head = sentenceHead(line);
    if (head.length < keyLen) continue;
    heads.push({
      head,
      key: head.slice(0, keyLen),
      from: from + (line.length - line.trimStart().length),
      para: line,
    });
  }

  let i = 0;
  while (i < heads.length) {
    let j = i + 1;
    while (j < heads.length && heads[j].key === heads[i].key) j++;
    const run = j - i;
    if (run >= minRun) {
      const first = heads[i];
      hits.push({
        from: first.from,
        to: first.from + first.head.length,
        text: first.head,
        message: rule.message || `连续 ${run} 段都以「${first.head}」开头，建议变化句式`,
      });
    }
    i = j;
  }

  return hits.slice(0, MAX_HITS_PER_RULE);
}

// ─────────────────────────── 10. 段落过长 ───────────────────────────

function detectLongParagraph(text: string, rule: RuleDef): RawHit[] {
  const hits: RawHit[] = [];
  // 阈值：默认 300 字，允许用户用 words[0] 覆盖
  const limit = Math.max(50, Number(rule.words?.[0] ?? 300) || 300);

  const lines = text.split('\n');
  let offset = 0;
  for (const line of lines) {
    const from = offset;
    offset += line.length + 1;
    const para = line.trim();
    if (!para) continue;
    // 用平台口径（不计空白）近似手机屏幕上的字符数
    let chars = 0;
    for (const ch of para) if (!/\s/.test(ch)) chars++;
    if (chars <= limit) continue;
    hits.push({
      from,
      to: from + line.length,
      text: para.length > 24 ? para.slice(0, 24) + '…' : para,
      message: rule.message || `本段约 ${chars} 字，超过 ${limit} 字，手机阅读易疲劳，建议分段`,
    });
    if (hits.length >= MAX_HITS_PER_RULE) break;
  }

  return hits;
}

// ─────────────────────────── 11. 对白引号风格混用 ───────────────────────────

function detectQuoteStyleMix(text: string, rule: RuleDef): RawHit[] {
  const curly = findAll(text, '“', 5000);
  const corner = findAll(text, '「', 5000);
  if (curly.length === 0 || corner.length === 0) return [];

  // 少数派才报，避免一本书里两种都用时把大半正文标红
  const minorityIsCurly = curly.length < corner.length;
  const positions = minorityIsCurly ? curly : corner;
  const minorityLabel = minorityIsCurly ? '“”' : '「」';
  const majorityLabel = minorityIsCurly ? '「」' : '“”';

  return positions.slice(0, MAX_HITS_PER_RULE).map((from) => ({
    from,
    to: from + 1,
    text: text.slice(from, from + 1),
    message:
      rule.message ||
      `对白引号风格混用：全书「${majorityLabel}」${Math.max(curly.length, corner.length)} 处、「${minorityLabel}」${positions.length} 处，建议统一`,
  }));
}

// ─────────────────────────── 规则包 ───────────────────────────

export const BUILTIN_RULES: BuiltinRule[] = [
  {
    def: {
      id: 'punct-unpaired-quote',
      name: '引号不成对',
      description: '检查 “ ”、「 」、『 』、【 】、‘ ’ 是否成对。引号错位会让读者看不出哪句是对话。',
      severity: 'error',
      scope: 'scene',
      enabled: true,
      fixable: false,
      builtin: true,
    },
    detect: detectUnpairedQuotes,
  },
  {
    def: {
      id: 'punct-ellipsis',
      name: '省略号写法',
      description: '中文省略号固定写作「……」（两个六点符号）。检出 ...、。。。、单个 … 等写法。',
      severity: 'warn',
      scope: 'scene',
      enabled: true,
      fixable: true,
      builtin: true,
      pattern: '\\.{2,}',
      flags: 'g',
    },
    detect: detectEllipsis,
  },
  {
    def: {
      id: 'punct-dash',
      name: '破折号写法',
      description: '中文破折号写作「——」（两个 U+2014）。检出 --、单个 —、制表符横线。',
      severity: 'warn',
      scope: 'scene',
      enabled: true,
      fixable: true,
      builtin: true,
      pattern: '-{2,}',
      flags: 'g',
    },
    detect: detectDash,
  },
  {
    def: {
      id: 'punct-duplicate',
      name: '重复标点',
      description: '连续的相同标点（！！、？？、，，、；；）只保留一个。',
      severity: 'warn',
      scope: 'scene',
      enabled: true,
      fixable: true,
      builtin: true,
      pattern: '([！？，、；：～!?])\\1+',
      flags: 'g',
    },
    detect: detectDuplicatePunct,
  },
  {
    def: {
      id: 'punct-halfwidth',
      name: '全半角混用',
      description: '中文语境里出现半角 , . ? ! : ; 时提示改成全角。自动跳过小数、时间、英文缩写。',
      severity: 'warn',
      scope: 'scene',
      enabled: true,
      fixable: true,
      builtin: true,
    },
    detect: detectHalfwidth,
  },
  {
    def: {
      id: 'punct-space',
      name: '中文间多余空格',
      description: '两个中文字符之间夹了空格或全角空格。正文缩进应由排版样式实现，不写进正文。',
      severity: 'info',
      scope: 'scene',
      enabled: true,
      fixable: true,
      builtin: true,
      pattern: '([\\u3400-\\u4dbf\\u4e00-\\u9fff])[ \\t\\u00a0\\u3000]+(?=[\\u3400-\\u4dbf\\u4e00-\\u9fff])',
      flags: 'g',
    },
    detect: detectChineseSpace,
  },
  {
    def: {
      id: 'typo-common',
      name: '常见错别字',
      description:
        '内置错别字表（形近/音近字），并启发式提示「的地得」误用。只提示不自动改。' +
        '词表可在 rules.json 的 words 里增删，写法：`错字` 或 `错字→正确写法`。',
      severity: 'warn',
      scope: 'scene',
      enabled: true,
      fixable: false,
      builtin: true,
      words: TYPO_WORDS,
    },
    detect: detectTypos,
  },
  {
    def: {
      id: 'repeat-adjacent',
      name: '相邻重复用词',
      description: '「的的」「了了」「然后然后」这类手滑重复。刻意叠词（慢慢、好好）不会命中。',
      severity: 'warn',
      scope: 'scene',
      enabled: true,
      fixable: true,
      builtin: true,
      pattern: ADJACENT_DEFAULT,
      flags: 'g',
    },
    detect: detectAdjacentRepeat,
  },
  {
    def: {
      id: 'repeat-sentence-start',
      name: '连续段首重复',
      description: '连续 3 段以上以相同开头，读起来会像复读。阈值可改：rules.json 的 words[0]（默认 3）。',
      severity: 'info',
      scope: 'scene',
      enabled: true,
      fixable: false,
      builtin: true,
      words: ['3'],
    },
    detect: detectRepeatedStart,
  },
  {
    def: {
      id: 'length-paragraph',
      name: '段落过长',
      description: '单段超过 300 字，手机阅读容易看串行。阈值可改：rules.json 的 words[0]（默认 300）。',
      severity: 'info',
      scope: 'scene',
      enabled: true,
      fixable: false,
      builtin: true,
      words: ['300'],
    },
    detect: detectLongParagraph,
  },
  {
    def: {
      id: 'dialogue-quote-style',
      name: '对白引号风格混用',
      description: '同一本书里既用「“”」又用「「」」。只提示少数派，避免大面积标红。',
      severity: 'info',
      scope: 'scene',
      enabled: true,
      fixable: false,
      builtin: true,
    },
    detect: detectQuoteStyleMix,
  },
];

/** 按 id 取内置检测函数（自定义规则没有函数，只能走 pattern） */
const DETECTORS = new Map<string, Detector>(BUILTIN_RULES.map((r) => [r.def.id, r.detect]));

function getDetector(ruleId: string): Detector | null {
  return DETECTORS.get(ruleId) ?? null;
}

/** 自定义规则（用户手写 JSON）只有 pattern 可用 */
function detectByPattern(text: string, rule: RuleDef): RawHit[] {
  if (!rule.pattern) return [];
  return regexHits(text, rule, { pattern: rule.pattern, message: rule.message || rule.name || '命中自定义规则' });
}

/** 对一条规则跑检测：内置走函数，自定义走正则 */
export function runRule(text: string, rule: RuleDef): RawHit[] {
  if (!rule.enabled) return [];
  const detector = getDetector(rule.id);
  if (detector) return detector(text, rule);
  return detectByPattern(text, rule);
}

export function cloneRule(rule: RuleDef): RuleDef {
  return {
    ...rule,
    words: rule.words ? [...rule.words] : undefined,
  };
}
