/**
 * 导出服务 —— 把项目导出成作者真正能交出去的文件（架构 7.7）。
 *
 * 四种格式的取舍：
 *   - txt：网文平台投稿/发布的主力格式。**排版预设在这里生效**，但只作用于导出结果，
 *     不污染源文件 —— 源文件永远是不带缩进的 Markdown 子集（架构 6.2）。
 *   - md：给写作者自己留的完整备份，保留标题层级与分隔线。
 *   - docx：出版向。用 docx 库生成真正的 Word 文档（可再编辑），不是伪装的 html。
 *   - epub：自写 zip（见 archive.ts），生成 EPUB 3 结构。手机阅读器可打开。
 *
 * 所有格式都走同一个「文档收集 → 按范围过滤 → 渲染」流程，
 * 保证「导出章数与字数与源一致」这条验收标准对所有格式成立。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AlignmentType,
  Document,
  HeadingLevel,
  LineRuleType,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';
import type {
  DocNode,
  ExportRequest,
  ExportResult,
  ProjectMeta,
  TypesetPreset,
} from '../../shared/types.ts';
import type { ProjectContext } from '../context.ts';
import type { JobContext } from '../util/job-queue.ts';
import { ensureDir, writeFileAtomic } from '../util/atomic.ts';
import { countWords } from '../util/words.ts';
import { safeName } from '../util/id.ts';
import { buildZip, type ArchiveEntry } from './archive.ts';
import { formatStamp, toPosix, xmlEscape } from './common.ts';

/** 导出物存放目录（相对项目 root，供下载路由使用） */
const EXPORT_DIR = '.studio/exports';

interface CollectedScene {
  docId: string;
  title: string;
  body: string;
  words: number;
  /** 所属章标题 */
  chapter: string;
  /** 所属卷标题 */
  volume: string;
  /** 章节序号（从 1 开始，用于 {n} 占位） */
  chapterIndex: number;
}

interface CollectedChapter {
  title: string;
  index: number;
  volume: string;
  scenes: CollectedScene[];
  words: number;
}

export class ExportService {
  private ctx: ProjectContext;

  constructor(ctx: ProjectContext) {
    this.ctx = ctx;
  }

  private get outDir(): string {
    return path.join(this.ctx.store.root, EXPORT_DIR);
  }

  /**
   * 执行导出（后台作业）。
   *
   * 进度分三段：收集（0-0.3）→ 渲染（0.3-0.85）→ 写盘（0.85-1）。
   * 写盘走 writeFileAtomic：导出文件也算「作者的作品」，不能半截。
   */
  async export(job: JobContext, req: ExportRequest): Promise<ExportResult> {
    const t0 = Date.now();
    const meta = await this.ctx.store.readMeta();

    job.progress(0.05, '读取文档树');
    const chapters = await this.collect(job, req, meta.count_mode);
    if (chapters.length === 0) throw new Error('所选范围内没有可导出的正文');

    const totalWords = chapters.reduce((s, c) => s + c.words, 0);
    job.progress(0.3, `渲染 ${req.format.toUpperCase()}`);

    const stamp = formatStamp();
    const baseName = safeName(meta.title || '未命名作品', 40);
    const typeset = req.typeset ? meta.typeset : null;

    let file: string;
    let data: Buffer;
    switch (req.format) {
      case 'txt':
        file = `${baseName}-${stamp}.txt`;
        data = Buffer.from(renderTxt(meta, chapters, typeset), 'utf8');
        break;
      case 'md':
        file = `${baseName}-${stamp}.md`;
        data = Buffer.from(renderMarkdown(meta, chapters, typeset), 'utf8');
        break;
      case 'docx':
        file = `${baseName}-${stamp}.docx`;
        job.progress(0.5, '生成 Word 文档');
        data = await renderDocx(meta, chapters, typeset);
        break;
      case 'epub':
        file = `${baseName}-${stamp}.epub`;
        job.progress(0.5, '打包 EPUB');
        data = renderEpub(meta, chapters, typeset);
        break;
      default: {
        const never: never = req.format;
        throw new Error(`不支持的导出格式：${String(never)}`);
      }
    }

    job.progress(0.85, '写入文件');
    await ensureDir(this.outDir);
    const abs = path.join(this.outDir, file);
    await writeFileAtomic(abs, data);

    // 导出物是「可再生成的中间产物」，留在 .studio 里会无限膨胀。
    // 保留最近 30 份（作者通常只需要最近几次下载），其余静默清掉。
    try {
      await pruneExports(this.ctx.store.root, 30);
    } catch (err) {
      console.error('[export] 清理旧导出文件失败（不影响本次导出）:', err);
    }

    job.progress(1, '导出完成');
    return {
      // 相对项目 root，路由直接拼下载 URL
      file: toPosix(path.relative(this.ctx.store.root, abs)),
      size: data.length,
      chapters: chapters.length,
      words: totalWords,
      took_ms: Date.now() - t0,
    };
  }

  // ─────────────────────────── 收集 ───────────────────────────

  /** 按范围收集章与场景，保证输出顺序与书里一致（卷 → 章 → 场景） */
  private async collect(
    job: JobContext,
    req: ExportRequest,
    countMode: ProjectMeta['count_mode'],
  ): Promise<CollectedChapter[]> {
    const tree = await this.ctx.store.readTree();
    const byId = new Map(tree.nodes.map((n) => [n.id, n]));

    // 确定要导出的卷/章集合
    let scopeVolume: DocNode | null = null;
    let scopeChapter: DocNode | null = null;
    if (req.scope === 'volume') {
      if (!req.scope_id) throw new Error('按卷导出必须指定 scope_id');
      scopeVolume = byId.get(req.scope_id) ?? null;
      if (!scopeVolume || scopeVolume.kind !== 'volume') throw new Error('指定的卷不存在');
    } else if (req.scope === 'chapter') {
      if (!req.scope_id) throw new Error('按章导出必须指定 scope_id');
      scopeChapter = byId.get(req.scope_id) ?? null;
      if (!scopeChapter) throw new Error('指定的章不存在');
      // 允许传入场景 id：自动上溯到它所属的章
      if (scopeChapter.kind === 'scene') {
        const parent = scopeChapter.parent_id ? byId.get(scopeChapter.parent_id) : null;
        if (parent && parent.kind === 'chapter') scopeChapter = parent;
      }
      if (scopeChapter.kind !== 'chapter') throw new Error('按章导出必须指定章（或章内场景）');
    }

    const volumes = tree.nodes
      .filter((n) => n.kind === 'volume')
      .filter((n) => !scopeVolume || n.id === scopeVolume.id)
      .sort((a, b) => a.order - b.order);

    const out: CollectedChapter[] = [];
    let chapterIndex = 0;
    const total = Math.max(1, volumes.length);

    for (let vi = 0; vi < volumes.length; vi++) {
      job.throwIfCancelled();
      const volume = volumes[vi];
      const chapters = tree.nodes
        .filter((n) => n.kind === 'chapter' && n.parent_id === volume.id)
        .filter((n) => !scopeChapter || n.id === scopeChapter.id)
        .sort((a, b) => a.order - b.order);

      for (const chapter of chapters) {
        const scenes = tree.nodes
          .filter((n) => n.kind === 'scene' && n.parent_id === chapter.id)
          .sort((a, b) => a.order - b.order);

        const collected: CollectedScene[] = [];
        for (const scene of scenes) {
          job.throwIfCancelled();
          const content = await this.ctx.store.readScene(scene.id);
          if (!content) continue;
          collected.push({
            docId: scene.id,
            title: scene.title,
            body: content.body,
            words: countWords(content.body, countMode),
            chapter: chapter.title,
            volume: volume.title,
            chapterIndex: chapterIndex + 1,
          });
        }
        if (collected.length === 0) continue;

        chapterIndex++;
        out.push({
          title: chapter.title,
          index: chapterIndex,
          volume: volume.title,
          scenes: collected,
          words: collected.reduce((s, c) => s + c.words, 0),
        });
      }

      job.progress(0.05 + ((vi + 1) / total) * 0.25, `收集 ${vi + 1}/${volumes.length} 卷`);
    }

    return out;
  }
}

// ─────────────────────────── 渲染：公共 ───────────────────────────

/** 章节标题模板：{n} 序号、{title} 标题（架构的 typeset.chapter_title） */
function chapterHeading(chapter: CollectedChapter, typeset: TypesetPreset | null): string {
  const template = typeset?.chapter_title || '第{n}章 {title}';
  return template
    .replace(/\{n\}/g, String(chapter.index))
    .replace(/\{title\}/g, chapter.title)
    .trim();
}

/** 正文段落（去掉首尾空白；空行不产生段落） */
function paragraphsOf(body: string): string[] {
  return body
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n+/g, ' ').trim())
    .filter(Boolean);
}

/** 段首缩进：全角空格（排版预设里的 indent 是「全角空格数」） */
function indentText(text: string, indent: number): string {
  if (indent <= 0) return text;
  return '\u3000'.repeat(indent) + text;
}

// ─────────────────────────── 渲染：TXT ───────────────────────────

/**
 * 平台排版预设（架构 7.7）：段首缩进、段间空行、章节标题格式。
 * 起点/番茄等平台的「发布版」基本就是这个样子：
 *   第1章 雨夜
 *
 * 　　夜雨敲窗，山门外一片寂静。
 *
 * 　　他推门而入。
 */
function renderTxt(
  meta: ProjectMeta,
  chapters: CollectedChapter[],
  typeset: TypesetPreset | null,
): string {
  const indent = typeset ? Math.max(0, Math.min(8, typeset.indent)) : 0;
  const gap = typeset ? typeset.paragraph_gap : true;
  const lines: string[] = [];

  lines.push(meta.title || '未命名作品');
  if (meta.author) lines.push(`作者：${meta.author}`);
  lines.push('');

  let lastVolume = '';
  for (const chapter of chapters) {
    if (chapter.volume && chapter.volume !== lastVolume) {
      lastVolume = chapter.volume;
      lines.push(`【${chapter.volume}】`);
      lines.push('');
    }
    lines.push(chapterHeading(chapter, typeset));
    lines.push('');

    for (const scene of chapter.scenes) {
      // 单场景章节不再重复写场景标题，避免「第1章 雨夜」下面又出现「雨夜」
      const showSceneTitle = chapter.scenes.length > 1;
      if (showSceneTitle) {
        lines.push(`　${scene.title}`);
        lines.push('');
      }
      for (const para of paragraphsOf(scene.body)) {
        lines.push(indentText(para, indent));
        if (gap) lines.push('');
      }
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// ─────────────────────────── 渲染：Markdown ───────────────────────────

function renderMarkdown(
  meta: ProjectMeta,
  chapters: CollectedChapter[],
  typeset: TypesetPreset | null,
): string {
  const lines: string[] = [];
  lines.push(`# ${meta.title || '未命名作品'}`);
  if (meta.author) lines.push(`> 作者：${meta.author}`);
  lines.push('');

  let lastVolume = '';
  for (const chapter of chapters) {
    if (chapter.volume && chapter.volume !== lastVolume) {
      lastVolume = chapter.volume;
      lines.push(`## ${chapter.volume}`);
      lines.push('');
    }
    lines.push(`### ${chapterHeading(chapter, typeset)}`);
    lines.push('');

    for (const scene of chapter.scenes) {
      if (chapter.scenes.length > 1) {
        lines.push(`#### ${scene.title}`);
        lines.push('');
      }
      // Markdown 用空行分段，不用全角缩进（缩进在 md 里会被解析成代码块）
      lines.push(scene.body.trim());
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd() + '\n';
}

// ─────────────────────────── 渲染：DOCX ───────────────────────────

async function renderDocx(
  meta: ProjectMeta,
  chapters: CollectedChapter[],
  typeset: TypesetPreset | null,
): Promise<Buffer> {
  const indent = typeset ? Math.max(0, Math.min(8, typeset.indent)) : 0;
  const gap = typeset ? typeset.paragraph_gap : true;

  const children: Paragraph[] = [];
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [new TextRun({ text: meta.title || '未命名作品', bold: true, size: 36 })],
    }),
  );
  if (meta.author) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 480 },
        children: [new TextRun({ text: `作者：${meta.author}`, size: 24 })],
      }),
    );
  }

  let lastVolume = '';
  for (const chapter of chapters) {
    if (chapter.volume && chapter.volume !== lastVolume) {
      lastVolume = chapter.volume;
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 480, after: 240 },
          children: [new TextRun({ text: chapter.volume, bold: true, size: 32 })],
        }),
      );
    }

    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 360, after: 200 },
        children: [new TextRun({ text: chapterHeading(chapter, typeset), bold: true, size: 28 })],
      }),
    );

    for (const scene of chapter.scenes) {
      if (chapter.scenes.length > 1) {
        children.push(
          new Paragraph({
            spacing: { before: 240, after: 120 },
            children: [new TextRun({ text: scene.title, bold: true, size: 24 })],
          }),
        );
      }
      for (const para of paragraphsOf(scene.body)) {
        children.push(
          new Paragraph({
            spacing: gap ? { after: 160, line: 360, lineRule: LineRuleType.AUTO } : { line: 360, lineRule: LineRuleType.AUTO },
            indent: indent > 0 ? { firstLine: indent * 480 } : undefined, // 全角字 ≈ 480 twips（12pt）
            children: [new TextRun({ text: para, size: 24 })],
          }),
        );
      }
    }
  }

  const doc = new Document({
    creator: meta.author || '写作台',
    title: meta.title || '未命名作品',
    description: '由写作台导出',
    styles: {
      default: {
        document: {
          run: { font: 'Songti SC', size: 24 },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

// ─────────────────────────── 渲染：EPUB ───────────────────────────

/**
 * EPUB 3 结构（最小可用集）：
 *   mimetype                 必须是第一项且 store 不压缩
 *   META-INF/container.xml   指向 opf
 *   OEBPS/content.opf        清单与 spine（阅读顺序）
 *   OEBPS/toc.ncx            目录（兼容老阅读器）
 *   OEBPS/style.css          中文正文排版
 *   OEBPS/chap-001.xhtml     每章一个 xhtml
 *
 * 不引入 epubcheck 依赖：结构按规范写死，字段少到可以人工核对。
 */
function renderEpub(
  meta: ProjectMeta,
  chapters: CollectedChapter[],
  typeset: TypesetPreset | null,
): Buffer {
  const bookId = `urn:uuid:${stableUuid(meta.id + ':' + meta.title)}`;
  const title = xmlEscape(meta.title || '未命名作品');
  const author = xmlEscape(meta.author || '佚名');
  const indent = typeset ? Math.max(0, Math.min(8, typeset.indent)) : 0;
  const gap = typeset ? typeset.paragraph_gap : true;

  const entries: ArchiveEntry[] = [];

  // 1. mimetype（必须是第一个文件、必须不压缩）
  entries.push({
    name: 'mimetype',
    data: Buffer.from('application/epub+zip', 'ascii'),
    store: true,
  });

  // 2. container.xml
  entries.push({
    name: 'META-INF/container.xml',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
      'utf8',
    ),
  });

  // 3. style.css
  const css = `body { font-family: "Songti SC", "Noto Serif CJK SC", serif; line-height: 1.8; margin: 0 1em; }
h1 { font-size: 1.2em; text-align: center; margin: 1.2em 0 1em; }
h2 { font-size: 1.05em; margin: 1em 0 0.6em; }
p { text-indent: ${indent}em; margin: ${gap ? '0 0 0.8em 0' : '0 0 0.2em 0'}; }
`;
  entries.push({ name: 'OEBPS/style.css', data: Buffer.from(css, 'utf8') });

  // 4. 每章一个 xhtml
  const chapterFiles: Array<{ href: string; id: string; label: string }> = [];
  for (const chapter of chapters) {
    const href = `chap-${String(chapter.index).padStart(3, '0')}.xhtml`;
    const id = `chap${chapter.index}`;
    const label = chapterHeading(chapter, typeset);
    chapterFiles.push({ href, id, label });

    const body: string[] = [];
    body.push(`<h1>${xmlEscape(label)}</h1>`);
    for (const scene of chapter.scenes) {
      if (chapter.scenes.length > 1) body.push(`<h2>${xmlEscape(scene.title)}</h2>`);
      for (const para of paragraphsOf(scene.body)) {
        body.push(`<p>${xmlEscape(para)}</p>`);
      }
    }

    entries.push({
      name: `OEBPS/${href}`,
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN" xml:lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<title>${xmlEscape(label)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${body.join('\n')}
</body>
</html>`,
        'utf8',
      ),
    });
  }

  // 5. content.opf
  const manifest = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    `<item id="css" href="style.css" media-type="text/css"/>`,
    ...chapterFiles.map(
      (c) => `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`,
    ),
  ].join('\n    ');

  const spine = chapterFiles.map((c) => `<itemref idref="${c.id}"/>`).join('\n    ');

  entries.push({
    name: 'OEBPS/content.opf',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${bookId}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator>${author}</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    ${manifest}
  </manifest>
  <spine toc="ncx">
    ${spine}
  </spine>
</package>`,
      'utf8',
    ),
  });

  // 6. nav.xhtml（EPUB 3 导航）
  entries.push({
    name: 'OEBPS/nav.xhtml',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN" xml:lang="zh-CN">
<head><meta charset="UTF-8"/><title>目录</title></head>
<body>
<nav epub:type="toc" id="toc">
<h1>目录</h1>
<ol>
${chapterFiles.map((c) => `  <li><a href="${c.href}">${xmlEscape(c.label)}</a></li>`).join('\n')}
</ol>
</nav>
</body>
</html>`,
      'utf8',
    ),
  });

  // 7. toc.ncx（兼容 EPUB 2 阅读器）
  entries.push({
    name: 'OEBPS/toc.ncx',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${bookId}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${title}</text></docTitle>
  <navMap>
${chapterFiles
  .map(
    (c, i) => `    <navPoint id="np${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${xmlEscape(c.label)}</text></navLabel>
      <content src="${c.href}"/>
    </navPoint>`,
  )
  .join('\n')}
  </navMap>
</ncx>`,
      'utf8',
    ),
  });

  return buildZip(entries);
}

/** 由字符串生成稳定的 UUID 形态标识（同一本书每次导出保持一致） */
function stableUuid(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  const hex = (n: number): string => n.toString(16).padStart(8, '0');
  const raw = (hex(h1) + hex(h2) + hex(h1 ^ h2) + hex((h1 + h2) >>> 0)).slice(0, 32);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-a${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
}

/** 清理导出目录（保留最近 N 份，避免 .studio 无限膨胀） */
export async function pruneExports(root: string, keep = 30): Promise<number> {
  const dir = path.join(root, EXPORT_DIR);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  const files: Array<{ name: string; mtime: number }> = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile()) continue;
      files.push({ name, mtime: stat.mtimeMs });
    } catch {
      /* 跳过读不到的文件 */
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  for (const file of files.slice(keep)) {
    await fs.rm(path.join(dir, file.name), { force: true }).catch(() => {});
    removed++;
  }
  return removed;
}

