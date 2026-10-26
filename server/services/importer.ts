/**
 * 导入服务 —— 把外部 txt / md 切章写进项目（架构 7.7）。
 *
 * 为什么「先预览再写入」：切章规则永远不可能对所有来源都对。
 * 让作者在写入磁盘前看到「切成几章、每章多少字、第一段长什么样」，
 * 比写完之后在树里删一堆错章节便宜得多。
 *
 * 编码问题：前端把文件内容当字符串发过来（api 契约如此），所以这里要能从
 * 「已经解错的字符串」里尽可能救回原文：
 *   - 如果是 UTF-8 解 GBK 字节：会出现大量 U+FFFD（不可逆，如实报告乱码）
 *   - 如果是 latin1 解 GBK 字节（前端用 FileReader.readAsBinaryString 时）：
 *     可以按字节回推，再用 TextDecoder('gb18030') 还原
 * 两种都试一遍，取「中文更多、乱码更少」的结果。
 */

import type { ImportPreview } from '../../shared/types.ts';
import type { ProjectContext } from '../context.ts';
import type { JobContext } from '../util/job-queue.ts';
import { countWords } from '../util/words.ts';
import { countCodePoints } from './common.ts';

/** 单场景字数上限：超过就按段落切成多个场景文件，避免一个文件几十万字打开卡顿 */
const MAX_SCENE_CHARS = 4000;

/** 预览里展示的段落数 */
const PREVIEW_PARAS = 6;

export interface ImportInput {
  filename: string;
  content: string;
  volume_title?: string;
}

export interface ImportOutcome {
  scenes: number;
  words: number;
}

interface Chapter {
  index: number;
  /** 原始标题行（可能是「第一章 雨夜」） */
  title: string;
  /** 正文（不含标题行） */
  body: string;
}

// ─────────────────────────── 章节识别规则 ───────────────────────────

/** 第X章 / 第X节 / 第X回 / 第X卷 / 第X部，X 为中文数字或阿拉伯数字 */
const RE_CHAPTER_CN =
  /^[\s\u3000]*(第[\s\u3000]*[0-9零一二三四五六七八九十百千万两〇]{1,12}[\s\u3000]*[章节回卷部篇话集])[\s\u3000]*[、.．:：]?[\s\u3000]*(.*)$/;

/** Chapter 12 / CHAPTER XII */
const RE_CHAPTER_EN = /^[\s\u3000]*(chapter|CHAPTER|Chapter)[\s\u3000]+([0-9]{1,4}|[IVXLC]{1,8})\b[\s\u3000]*[.:：-]?[\s\u3000]*(.*)$/;

/** 纯数字标题行：`12` / `12.` / `12、` / `第12章`（上面已覆盖） */
const RE_CHAPTER_NUM = /^[\s\u3000]*([0-9]{1,4})[\s\u3000]*[、.．:：]?[\s\u3000]*(.*)$/;

/** 中文序号行：`一、` / `十二、` */
const RE_CHAPTER_CN_NUM = /^[\s\u3000]*([零一二三四五六七八九十百]{1,6})[\s\u3000]*[、.．:：][\s\u3000]*(.*)$/;

/** Markdown 标题：# 第一章 / ## 雨夜 */
const RE_MD_HEADING = /^[\s\u3000]*(#{1,3})[\s\u3000]+(.+)$/;

const TITLE_MAX_LEN = 40;

/**
 * 判断一行是不是章节标题。
 * 返回 null 表示不是；否则返回 { title, rule }。
 */
function matchChapterTitle(line: string): { title: string; rule: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // 太长的一定是正文（有的正文段落以「第一」开头）
  if (countCodePoints(trimmed) > 60) return null;

  const cn = RE_CHAPTER_CN.exec(trimmed);
  if (cn) {
    const title = cn[2]?.trim();
    return { title: title ? `${cn[1]} ${title}` : cn[1], rule: '第X章' };
  }

  const en = RE_CHAPTER_EN.exec(trimmed);
  if (en) {
    const title = en[3]?.trim();
    return { title: title ? `${en[1]} ${en[2]} ${title}` : `${en[1]} ${en[2]}`, rule: 'Chapter N' };
  }

  const md = RE_MD_HEADING.exec(trimmed);
  if (md) {
    const title = md[2].trim();
    if (countCodePoints(title) <= TITLE_MAX_LEN) return { title, rule: 'Markdown 标题' };
  }

  // 数字行/中文序号行：要求很短，否则会误伤正文
  if (countCodePoints(trimmed) <= TITLE_MAX_LEN) {
    const num = RE_CHAPTER_NUM.exec(trimmed);
    if (num) {
      const title = num[2]?.trim();
      return { title: title ? `第${num[1]}章 ${title}` : `第${num[1]}章`, rule: '数字行' };
    }
    const cnNum = RE_CHAPTER_CN_NUM.exec(trimmed);
    if (cnNum) {
      const title = cnNum[2]?.trim();
      return { title: title ? `${cnNum[1]}、${title}` : `${cnNum[1]}、`, rule: '中文序号行' };
    }
  }

  return null;
}

interface SplitResult {
  chapters: Chapter[];
  /** 用到的切分规则（写进预览，让作者知道系统怎么理解的） */
  rule: string;
}

/**
 * 切章。优先级：显式章节标题 > 数字/中文序号行 > 空行分隔。
 *
 * 空行分隔是兜底：既没有标题也没有序号时，按「连续多个空行」分段；
 * 再不行就整篇一章。宁可切得粗，也不要把正文切碎。
 */
export function splitChapters(text: string): SplitResult {
  const normalized = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ');

  const lines = normalized.split('\n');

  // 第一遍：找出所有标题行（跳过文件开头的空行）
  const marks: Array<{ line: number; title: string; rule: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const hit = matchChapterTitle(lines[i]);
    if (hit) marks.push({ line: i, title: hit.title, rule: hit.rule });
  }

  // 标题必须占一定比例，否则是正文里的「第一章」这种引用，不能切
  if (marks.length >= 2 && marks.length >= lines.length * 0.005) {
    const chapters: Chapter[] = [];
    // 第一个标题之前的内容：如果是正文就并入第一章前（作为序章）
    const prefaceEnd = marks[0].line;
    const preface = lines.slice(0, prefaceEnd).join('\n').trim();

    for (let i = 0; i < marks.length; i++) {
      const start = marks[i].line + 1;
      const end = i + 1 < marks.length ? marks[i + 1].line : lines.length;
      const body = lines.slice(start, end).join('\n').trim();
      chapters.push({
        index: i + 1,
        title: marks[i].title,
        body: i === 0 && preface ? `${preface}\n\n${body}`.trim() : body,
      });
    }
    return { chapters, rule: `按章节标题切分（${marks[0].rule}，识别 ${marks.length} 处）` };
  }

  // 兜底一：连续 2 个以上空行分段，每段视作一章
  const blocks = normalized
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (blocks.length >= 2) {
    // 段落太短说明不是章，只是排版空行 —— 那就整篇一章
    const avg = blocks.reduce((s, b) => s + countCodePoints(b), 0) / blocks.length;
    if (avg >= 120) {
      return {
        chapters: blocks.map((body, i) => ({
          index: i + 1,
          title: `第${i + 1}节`,
          body,
        })),
        rule: '未识别到章节标题，按空行分隔切分',
      };
    }
  }

  // 兜底二：整篇一章
  const whole = normalized.trim();
  return {
    chapters: whole ? [{ index: 1, title: '全文', body: whole }] : [],
    rule: '未识别到章节标记，整篇作为一章导入',
  };
}

// ─────────────────────────── 编码识别 ───────────────────────────

interface Decoded {
  text: string;
  encoding: string;
  garbled: boolean;
}

const REPLACEMENT = '\uFFFD';

function cjkRatio(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let total = 0;
  for (const ch of text) {
    total++;
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x3000 && cp <= 0x303f) ||
      (cp >= 0xff00 && cp <= 0xffef)
    ) {
      cjk++;
    }
  }
  return total === 0 ? 0 : cjk / total;
}

function replacementRatio(text: string): number {
  if (!text) return 0;
  let bad = 0;
  let total = 0;
  for (const ch of text) {
    total++;
    if (ch === REPLACEMENT) bad++;
  }
  return total === 0 ? 0 : bad / total;
}

/** latin1 字符串 → 原始字节（只有全部码点 ≤ 0xFF 时才可行） */
function latin1ToBytes(text: string): Uint8Array | null {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) return null;
    out[i] = code;
  }
  return out;
}

function tryDecode(bytes: Uint8Array, label: string): string | null {
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 从「已经是字符串」的内容里识别编码。
 *
 * 契约上 content 是 string（前端读文件后发 JSON），所以这里做的是**补救**：
 * 如果字符串看起来像被错误解码的字节流，尽量还原成正确的中文。
 */
export function detectEncoding(input: string | Uint8Array): Decoded {
  if (input instanceof Uint8Array) {
    const utf8 = tryDecode(input, 'utf-8');
    if (utf8 !== null) return { text: utf8, encoding: 'UTF-8', garbled: false };
    const gbk = tryDecode(input, 'gb18030');
    if (gbk !== null) {
      return { text: gbk, encoding: 'GBK/GB18030（已自动转换）', garbled: false };
    }
    const loose = new TextDecoder('utf-8').decode(input);
    return { text: loose, encoding: '未知（按 UTF-8 尽力解码）', garbled: replacementRatio(loose) > 0.002 };
  }

  const text = input;

  // 情况 A：含替换字符 —— 说明前端按 UTF-8 解了非 UTF-8 字节，信息已丢。
  // 只能如实报告乱码，让作者用「另存为 UTF-8」重来。
  const badRatio = replacementRatio(text);
  if (badRatio > 0.002) {
    // 若整篇几乎全是可打印的 latin1 字符，也许还有救（见情况 B）
    const bytes = latin1ToBytes(text);
    if (bytes) {
      const gbk = tryDecode(bytes, 'gb18030');
      if (gbk && cjkRatio(gbk) > cjkRatio(text) + 0.1) {
        return { text: gbk, encoding: 'GBK/GB18030（从乱码还原）', garbled: false };
      }
    }
    return { text, encoding: '疑似 GBK（乱码，建议另存为 UTF-8 后重试）', garbled: true };
  }

  // 情况 B：没有替换字符，但中文字符比例极低、又有很多高位拉丁字符 → 可能是 latin1 解 GBK。
  // 判定门槛设得保守：解出来必须「大部分是中文」，否则宁可当成正常文本。
  // （英文重音字符如 café 也会被尝试，但 gb18030 的 fatal 解码多半直接失败，不会误判。）
  if (text.length >= 6) {
    const cjk = cjkRatio(text);
    let highLatin = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      if (code >= 0x80 && code <= 0xff) highLatin++;
    }
    const highRatio = highLatin / text.length;
    if (cjk < 0.05 && highRatio > 0.15) {
      const bytes = latin1ToBytes(text);
      if (bytes) {
        const gbk = tryDecode(bytes, 'gb18030');
        if (gbk && cjkRatio(gbk) > 0.3 && cjkRatio(gbk) > cjk + 0.1) {
          return { text: gbk, encoding: 'GBK/GB18030（已自动转换）', garbled: false };
        }
      }
    }
  }

  // 情况 C：正常文本
  return { text, encoding: 'UTF-8', garbled: false };
}

// ─────────────────────────── 服务 ───────────────────────────

export class ImportService {
  private ctx: ProjectContext;

  constructor(ctx: ProjectContext) {
    this.ctx = ctx;
  }

  /** 预览：不写盘，只告诉作者会切成什么样 */
  async preview(filename: string, content: string): Promise<ImportPreview> {
    const decoded = detectEncoding(content);
    const { chapters, rule } = splitChapters(decoded.text);
    const meta = await this.ctx.store.readMeta();

    const list = chapters.map((c) => ({
      index: c.index,
      title: c.title || `第${c.index}节`,
      words: countWords(c.body, meta.count_mode),
    }));

    const previewParas = decoded.text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .slice(0, PREVIEW_PARAS)
      .join('\n');

    return {
      chapters: list,
      total_words: list.reduce((s, c) => s + c.words, 0),
      encoding: decoded.encoding,
      garbled: decoded.garbled,
      rule,
      preview: previewParas.slice(0, 600),
    };
  }

  /**
   * 执行导入。
   *
   * 步骤：
   *   1. 解码 + 切章（与预览同一套逻辑，保证「看到什么就导入什么」）
   *   2. 对即将被写入的位置做 import 快照（架构 7.1 第 6 条：导入前一份）
   *   3. 建卷 → 逐章建「章 + 场景」→ 写正文
   *   4. 每个场景写完立刻增量更新索引，导入完成后搜索/出场马上可用
   *
   * 中途取消：已写入的章节保留（它们是完整的文件），作业标记为取消，
   * 作者可以在树里看到导入了多少 —— 比「回滚一半」更可预期，也不会丢内容。
   */
  async run(job: JobContext, input: ImportInput): Promise<ImportOutcome> {
    const decoded = detectEncoding(input.content);
    const { chapters } = splitChapters(decoded.text);
    if (chapters.length === 0) throw new Error('没有可导入的内容（文件为空或无法识别编码）');

    const volumeTitle = (input.volume_title || deriveVolumeTitle(input.filename)).trim();

    job.note('导入前快照');
    await this.snapshotBeforeImport(job);

    job.note('创建卷');
    const volume = await this.ctx.store.createNode({
      kind: 'volume',
      parent_id: null,
      title: volumeTitle,
    });

    let scenes = 0;
    let words = 0;
    const total = chapters.length;

    for (let i = 0; i < chapters.length; i++) {
      job.throwIfCancelled();
      const chapter = chapters[i];
      const chapterTitle = chapter.title || `第${chapter.index}章`;

      const chapterNode = await this.ctx.store.createNode({
        kind: 'chapter',
        parent_id: volume.id,
        title: chapterTitle,
      });

      const parts = splitLongBody(chapter.body);
      for (let p = 0; p < parts.length; p++) {
        job.throwIfCancelled();
        const sceneTitle = parts.length === 1 ? chapterTitle : `${chapterTitle}（${p + 1}）`;
        const sceneNode = await this.ctx.store.createNode({
          kind: 'scene',
          parent_id: chapterNode.id,
          title: sceneTitle,
        });
        const result = await this.ctx.store.writeScene(sceneNode.id, parts[p], 1);
        words += result.word_count;
        scenes++;
        await this.indexScene(sceneNode.id);
      }

      job.progress(((i + 1) / total) * 0.98, `导入 ${i + 1}/${total} 章`);
    }

    job.progress(1, '导入完成');
    return { scenes, words };
  }

  /** 导入前给「已有正文」各做一份快照：导入是批量写入，必须留退路 */
  private async snapshotBeforeImport(job: JobContext): Promise<void> {
    const tree = await this.ctx.store.readTree();
    const scenes = tree.nodes.filter((n) => n.kind === 'scene');
    for (let i = 0; i < scenes.length; i++) {
      job.throwIfCancelled();
      const node = scenes[i];
      const scene = await this.ctx.store.readScene(node.id);
      if (!scene || !scene.body.trim()) continue;
      await this.ctx.snapshots.create(node.id, node.title, scene.body, 'import');
      if (scenes.length > 30 && i % 10 === 0) {
        job.progress((i / scenes.length) * 0.1, `导入前快照 ${i + 1}/${scenes.length}`);
      }
    }
  }

  /** 导入后增量更新索引（失败不中断导入：索引可重建，正文已落盘） */
  private async indexScene(docId: string): Promise<void> {
    try {
      const tree = await this.ctx.store.readTree();
      const node = tree.nodes.find((n) => n.id === docId);
      if (node) await this.ctx.indexer.indexDoc(node);
    } catch (err) {
      console.error('[import] 增量更新索引失败:', err);
    }
  }
}

// ─────────────────────────── 内部工具 ───────────────────────────

/** 卷名：优先用文件名（去掉扩展名与常见后缀），否则用「导入 YYYY-MM-DD」 */
function deriveVolumeTitle(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '').trim();
  const cleaned = base
    .replace(/[（(](全本|完本|txt|TXT|精校|校对|完结)[）)]/g, '')
    .replace(/[_]+/g, ' ')
    .trim();
  if (cleaned && countCodePoints(cleaned) <= 20) return cleaned;
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `导入 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 超长章节按段落切成多个场景。
 * 在段落边界切，绝不切断段落中间 —— 断在句子中间对作者毫无价值。
 */
function splitLongBody(body: string): string[] {
  const text = body.trim();
  if (!text) return [''];
  if (countCodePoints(text) <= MAX_SCENE_CHARS) return [text];

  const paras = text.split(/\n{2,}/);
  const out: string[] = [];
  let buf: string[] = [];
  let len = 0;

  for (const para of paras) {
    const n = countCodePoints(para);
    if (len > 0 && len + n > MAX_SCENE_CHARS) {
      out.push(buf.join('\n\n'));
      buf = [];
      len = 0;
    }
    buf.push(para);
    len += n;
  }
  if (buf.length > 0) out.push(buf.join('\n\n'));
  return out.length > 0 ? out : [text];
}
