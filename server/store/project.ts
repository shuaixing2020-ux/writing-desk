/**
 * 项目文件夹存储层 —— 「文件即真相」的执行层。
 *
 * 磁盘布局（架构 6.1）：
 *   我的小说/
 *   ├─ project.json
 *   ├─ manuscript/v01-第一卷/c001-开篇/s0001-雨夜.md
 *   ├─ bible/characters/林远.md
 *   ├─ notes/  inbox/  research/
 *   └─ .studio/  （可整体丢弃重建）
 *
 * 身份靠 frontmatter 里的 id，文件名只负责"人眼可读 + 排序"。
 * 所有写入走 writeFileAtomic。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  DocNode,
  DocStatus,
  DocTree,
  Entity,
  EntityType,
  NodeKind,
  ProjectMeta,
  SceneContent,
  TypesetPreset,
} from '../../shared/types.ts';
import { DEFAULT_AI_CONFIG, DEFAULT_TYPESET } from '../../shared/types.ts';
import { ensureDir, exists, readJsonSafe, readTextSafe, rmSafe, writeFileAtomic, writeJsonAtomic } from '../util/atomic.ts';
import { fmArray, fmNumber, fmString, parseFrontmatter, stringifyScene, type Frontmatter } from '../util/frontmatter.ts';
import { pad, safeName, ulid } from '../util/id.ts';
import { countWords } from '../util/words.ts';

export const SCHEMA_VERSION = 1;

const MANUSCRIPT = 'manuscript';
const BIBLE = 'bible';
const NOTES = 'notes';
const INBOX = 'inbox';
const STUDIO = '.studio';

export const ENTITY_DIRS: Record<string, string> = {
  character: 'characters',
  place: 'places',
  faction: 'factions',
  item: 'items',
  term: 'terms',
  event: 'events',
};

const DIR_TO_ENTITY_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(ENTITY_DIRS).map(([k, v]) => [v, k]),
);

/** 简单的串行队列：同一项目的写操作排队，避免并发写同一文件 */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => {});
    return result;
  }
}

export interface ProjectPaths {
  root: string;
  manuscript: string;
  bible: string;
  notes: string;
  inbox: string;
  studio: string;
  snapshots: string;
  trash: string;
  logs: string;
  projectFile: string;
  indexDb: string;
}

export function projectPaths(root: string): ProjectPaths {
  return {
    root,
    manuscript: path.join(root, MANUSCRIPT),
    bible: path.join(root, BIBLE),
    notes: path.join(root, NOTES),
    inbox: path.join(root, INBOX),
    studio: path.join(root, STUDIO),
    snapshots: path.join(root, STUDIO, 'snapshots'),
    trash: path.join(root, STUDIO, 'trash'),
    logs: path.join(root, STUDIO, 'logs'),
    projectFile: path.join(root, 'project.json'),
    indexDb: path.join(root, STUDIO, 'index.sqlite'),
  };
}

const KIND_PREFIX: Record<NodeKind, string> = { volume: 'v', chapter: 'c', scene: 's' };
const KIND_WIDTH: Record<NodeKind, number> = { volume: 2, chapter: 3, scene: 4 };
const META_FILE: Record<'volume' | 'chapter', string> = {
  volume: '_volume.md',
  chapter: '_chapter.md',
};

/** 从文件名前缀解析顺序号，如 c003-开篇 → 3 */
function parseOrderPrefix(name: string): { order: number; rest: string } | null {
  const m = /^[vcs](\d+)-(.+)$/.exec(name);
  if (!m) return null;
  return { order: Number(m[1]), rest: m[2] };
}

function stripExt(name: string): string {
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

function isSceneFile(name: string): boolean {
  return name.endsWith('.md') && !name.startsWith('_');
}

export class ProjectStore {
  readonly paths: ProjectPaths;
  private mutex = new Mutex();
  private metaCache: ProjectMeta | null = null;

  constructor(root: string) {
    this.paths = projectPaths(root);
  }

  get root(): string {
    return this.paths.root;
  }

  /** 所有写操作的统一入口 */
  private write<T>(fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(fn);
  }

  // ─────────────────────── 项目生命周期 ───────────────────────

  static async create(
    root: string,
    init: { title: string; author?: string; mode?: ProjectMeta['mode'] } = { title: '未命名作品' },
  ): Promise<ProjectStore> {
    const paths = projectPaths(root);
    await ensureDir(paths.manuscript);
    await ensureDir(paths.bible);
    await ensureDir(paths.notes);
    await ensureDir(paths.inbox);
    await ensureDir(paths.studio);
    await ensureDir(paths.snapshots);
    await ensureDir(paths.trash);
    await ensureDir(paths.logs);
    for (const dir of Object.values(ENTITY_DIRS)) {
      await ensureDir(path.join(paths.bible, dir));
    }

    const now = Date.now();
    const meta: ProjectMeta = {
      id: ulid(now),
      schema_version: SCHEMA_VERSION,
      title: init.title || '未命名作品',
      author: init.author ?? '',
      mode: init.mode ?? 'webnovel',
      count_mode: 'hanzi',
      daily_goal: 3000,
      created_at: now,
      updated_at: now,
      typeset: { ...DEFAULT_TYPESET },
      lan: { enabled: false },
      auto_punct: false,
      ai: structuredClone(DEFAULT_AI_CONFIG),
    };
    await writeJsonAtomic(paths.projectFile, meta);
    return new ProjectStore(root);
  }

  async readMeta(): Promise<ProjectMeta> {
    if (this.metaCache) return this.metaCache;
    const fallback: ProjectMeta = {
      id: ulid(),
      schema_version: SCHEMA_VERSION,
      title: path.basename(this.paths.root),
      author: '',
      mode: 'webnovel',
      count_mode: 'hanzi',
      daily_goal: 3000,
      created_at: Date.now(),
      updated_at: Date.now(),
      typeset: { ...DEFAULT_TYPESET },
      lan: { enabled: false },
      auto_punct: false,
      ai: structuredClone(DEFAULT_AI_CONFIG),
    };
    const raw = await readJsonSafe<Partial<ProjectMeta>>(this.paths.projectFile, {});

    // 前向保护：作品由「更新版本」的工具写过时，旧版本绝不能继续打开并回写。
    // 否则 schema_version 会被降级成当前版本号，未来字段被静默丢弃 —— 那是丢数据。
    // 宁可拒绝打开并提示升级，也不能悄悄改坏。
    const diskVersion = typeof raw.schema_version === 'number' ? raw.schema_version : SCHEMA_VERSION;
    if (diskVersion > SCHEMA_VERSION) {
      throw new Error(
        `这个作品由更新版本的写作台创建（schema_version ${diskVersion}，` +
          `当前版本只支持到 ${SCHEMA_VERSION}）。请升级写作台后再打开，` +
          `以免旧版本改写文件导致内容丢失。`,
      );
    }

    // 迁移只增不破坏：新字段补默认值。
    // 目前只有 schema_version 1，没有历史版本需要迁移；
    // 将来加版本时，在这里按 diskVersion 分支补齐字段即可。
    const meta: ProjectMeta = {
      ...fallback,
      ...raw,
      typeset: { ...DEFAULT_TYPESET, ...(raw.typeset ?? {}) },
      lan: { ...fallback.lan, ...(raw.lan ?? {}) },
      // ai 必须深合并：老作品没有 ai 字段，features 也要补默认值（全关）
      ai: {
        ...DEFAULT_AI_CONFIG,
        ...(raw.ai ?? {}),
        features: { ...DEFAULT_AI_CONFIG.features, ...(raw.ai?.features ?? {}) },
      },
      schema_version: SCHEMA_VERSION,
    };
    this.metaCache = meta;
    return meta;
  }

  async updateMeta(patch: Partial<ProjectMeta>): Promise<ProjectMeta> {
    return this.write(async () => {
      const cur = await this.readMeta();
      const next: ProjectMeta = {
        ...cur,
        ...patch,
        typeset: patch.typeset ? { ...cur.typeset, ...patch.typeset } : cur.typeset,
        lan: patch.lan ? { ...cur.lan, ...patch.lan } : cur.lan,
        updated_at: Date.now(),
      };
      await writeJsonAtomic(this.paths.projectFile, next);
      this.metaCache = next;
      return next;
    });
  }

  invalidateMeta(): void {
    this.metaCache = null;
  }

  // ─────────────────────── 树读取 ───────────────────────

  /**
   * 扫描磁盘重建文档树。文件系统是唯一真相，树不缓存。
   */
  async readTree(): Promise<DocTree> {
    const meta = await this.readMeta();
    const nodes: DocNode[] = [];
    const volDirs = await this.listDirs(this.paths.manuscript);

    for (const volDir of volDirs) {
      const volPath = path.join(this.paths.manuscript, volDir);
      const volMeta = await this.readContainerMeta(volPath, 'volume', volDir);
      nodes.push(volMeta);

      const chapDirs = await this.listDirs(volPath);
      for (const chapDir of chapDirs) {
        const chapPath = path.join(volPath, chapDir);
        const chapMeta = await this.readContainerMeta(chapPath, 'chapter', chapDir);
        chapMeta.parent_id = volMeta.id;
        nodes.push(chapMeta);

        const files = await this.listFiles(chapPath);
        for (const file of files) {
          if (!isSceneFile(file)) continue;
          const scene = await this.readSceneNode(path.join(chapPath, file), chapMeta.id, file, meta);
          if (scene) nodes.push(scene);
        }
      }
    }

    // 排序：按 order，再按标题，保证稳定
    nodes.sort((a, b) => {
      if (a.parent_id === b.parent_id) return a.order - b.order || a.title.localeCompare(b.title, 'zh');
      return 0;
    });

    return { nodes };
  }

  private async listDirs(dir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort((a, b) => {
          const pa = parseOrderPrefix(a);
          const pb = parseOrderPrefix(b);
          if (pa && pb && pa.order !== pb.order) return pa.order - pb.order;
          return a.localeCompare(b, 'zh');
        });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private async listFiles(dir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .sort((a, b) => {
          const pa = parseOrderPrefix(stripExt(a));
          const pb = parseOrderPrefix(stripExt(b));
          if (pa && pb && pa.order !== pb.order) return pa.order - pb.order;
          return a.localeCompare(b, 'zh');
        });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  /** 读取卷/章的 _volume.md / _chapter.md；缺失则从目录名合成（兼容用户手工放入的文件夹） */
  private async readContainerMeta(
    dir: string,
    kind: 'volume' | 'chapter',
    dirName: string,
  ): Promise<DocNode> {
    const metaPath = path.join(dir, META_FILE[kind]);
    const raw = await readTextSafe(metaPath);
    const prefix = parseOrderPrefix(dirName);
    const fallbackTitle = prefix?.rest ?? dirName;

    if (raw === null) {
      // 没有元文件：合成一个稳定 id（基于路径，保证多次读取一致）
      return {
        id: `${kind}-${Buffer.from(path.relative(this.paths.manuscript, dir)).toString('base64url').slice(0, 22)}`,
        kind,
        title: fallbackTitle,
        parent_id: null,
        order: prefix?.order ?? 0,
        status: 'draft',
        summary: '',
        word_count: 0,
        updated_at: 0,
        file: path.relative(this.root, metaPath),
      };
    }

    const { data } = parseFrontmatter(raw);
    return {
      id: fmString(data, 'id') || `missing-${dirName}`,
      kind,
      title: fmString(data, 'title', fallbackTitle),
      parent_id: null,
      order: fmNumber(data, 'order', prefix?.order ?? 0),
      status: (fmString(data, 'status', 'draft') as DocStatus) ?? 'draft',
      summary: fmString(data, 'summary'),
      word_count: 0,
      updated_at: fmNumber(data, 'updated_at', 0),
      file: path.relative(this.root, metaPath),
    };
  }

  private async readSceneNode(
    filePath: string,
    parentId: string,
    fileName: string,
    meta: ProjectMeta,
  ): Promise<DocNode | null> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch {
      return null;
    }
    const { data, body } = parseFrontmatter(raw);
    const prefix = parseOrderPrefix(stripExt(fileName));
    return {
      id: fmString(data, 'id') || `scene-${path.basename(filePath, '.md')}`,
      kind: 'scene',
      title: fmString(data, 'title', prefix?.rest ?? stripExt(fileName)),
      parent_id: parentId,
      order: fmNumber(data, 'order', prefix?.order ?? 0),
      status: (fmString(data, 'status', 'draft') as DocStatus) ?? 'draft',
      summary: fmString(data, 'summary'),
      word_count: countWords(body, meta.count_mode),
      updated_at: fmNumber(data, 'updated_at', 0),
      file: path.relative(this.root, filePath),
      pov: fmString(data, 'pov') || undefined,
      time: fmString(data, 'time') || undefined,
      tags: fmArray(data, 'tags'),
      plotlines: fmArray(data, 'plotlines'),
      rev: fmNumber(data, 'rev', 0),
    };
  }

  // ─────────────────────── 场景读写 ───────────────────────

  /** 定位场景文件绝对路径（树里带 file 相对路径） */
  async resolveDocFile(docId: string): Promise<{ node: DocNode; abs: string } | null> {
    const tree = await this.readTree();
    const node = tree.nodes.find((n) => n.id === docId);
    if (!node) return null;
    if (!node.file) return { node, abs: '' };
    return { node, abs: path.join(this.root, node.file) };
  }

  async readScene(docId: string): Promise<SceneContent | null> {
    const found = await this.resolveDocFile(docId);
    if (!found || found.node.kind !== 'scene' || !found.abs) return null;
    const raw = await fs.readFile(found.abs, 'utf8');
    const { data, body } = parseFrontmatter(raw);
    return {
      id: docId,
      // 写入侧已规范化（无尾随空白），读取侧同样去掉尾部换行，保证往返稳定
      body: body.replace(/\n+$/, ''),
      rev: fmNumber(data, 'rev', 0),
      hash: fmString(data, 'hash'),
      updated_at: fmNumber(data, 'updated_at', 0),
    };
  }

  /**
   * 写入场景正文。原子写 + 修订号校验。
   * base_rev 落后时返回 conflict=true，由上层保存为冲突副本（架构 7.8）。
   */
  async writeScene(
    docId: string,
    body: string,
    baseRev: number,
  ): Promise<{ rev: number; hash: string; updated_at: number; word_count: number; conflict: boolean }> {
    return this.write(async () => {
      const found = await this.resolveDocFile(docId);
      if (!found || !found.abs) throw new Error(`文档不存在: ${docId}`);

      const raw = await fs.readFile(found.abs, 'utf8');
      const { data, body: oldBody } = parseFrontmatter(raw);
      const currentRev = fmNumber(data, 'rev', 0);

      const conflict = baseRev < currentRev && oldBody !== body;
      const nextRev = currentRev + 1;
      const hash = await hashText(body);
      const now = Date.now();

      const nextData: Frontmatter = {
        ...data,
        id: docId,
        rev: nextRev,
        hash,
        updated_at: now,
        words: countWords(body, (await this.readMeta()).count_mode),
      };
      await writeFileAtomic(found.abs, stringifyScene(nextData, body));

      return {
        rev: nextRev,
        hash,
        updated_at: now,
        word_count: countWords(body, (await this.readMeta()).count_mode),
        conflict,
      };
    });
  }

  // ─────────────────────── 树结构变更 ───────────────────────

  /** 下一个可用序号 */
  private async nextOrder(parentDir: string, kind: NodeKind): Promise<number> {
    const prefix = KIND_PREFIX[kind];
    let max = 0;
    const entries = kind === 'scene' ? await this.listFiles(parentDir) : await this.listDirs(parentDir);
    for (const name of entries) {
      const stem = kind === 'scene' ? stripExt(name) : name;
      const m = new RegExp(`^${prefix}(\\d+)-`).exec(stem);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  }

  private containerFileName(kind: NodeKind, order: number, title: string): string {
    return `${KIND_PREFIX[kind]}${pad(order, KIND_WIDTH[kind])}-${safeName(title)}`;
  }

  /** 新建卷 / 章 / 场景 */
  async createNode(input: {
    kind: NodeKind;
    parent_id: string | null;
    title: string;
    status?: DocStatus;
  }): Promise<DocNode> {
    return this.write(async () => {
      const title = input.title?.trim() || (input.kind === 'volume' ? '新卷' : input.kind === 'chapter' ? '新章' : '新场景');
      const id = ulid();
      const now = Date.now();
      let parentDir = this.paths.manuscript;

      if (input.kind !== 'volume') {
        if (!input.parent_id) throw new Error('章/场景必须指定父节点');
        const parent = await this.resolveDocFile(input.parent_id);
        if (!parent || !parent.node.file) throw new Error('父节点不存在');
        parentDir = path.dirname(parent.abs);
        // 场景的父必须是章；章的父必须是卷
        const expected = input.kind === 'scene' ? 'chapter' : 'volume';
        if (parent.node.kind !== expected) {
          throw new Error(`${input.kind} 的父节点必须是 ${expected}`);
        }
      }

      const order = await this.nextOrder(parentDir, input.kind);
      const name = this.containerFileName(input.kind, order, title);

      if (input.kind === 'scene') {
        const file = path.join(parentDir, `${name}.md`);
        await writeFileAtomic(
          file,
          stringifyScene(
            { id, title, order, status: input.status ?? 'draft', rev: 1, updated_at: now, hash: await hashText('') },
            '',
          ),
        );
        return {
          id,
          kind: 'scene',
          title,
          parent_id: input.parent_id,
          order,
          status: input.status ?? 'draft',
          summary: '',
          word_count: 0,
          updated_at: now,
          file: path.relative(this.root, file),
          tags: [],
          plotlines: [],
          rev: 1,
        };
      }

      const dir = path.join(parentDir, name);
      await ensureDir(dir);
      const metaPath = path.join(dir, META_FILE[input.kind as 'volume' | 'chapter']);
      await writeFileAtomic(
        metaPath,
        stringifyScene(
          { id, title, order, status: input.status ?? 'draft', summary: '', updated_at: now },
          '',
        ),
      );
      return {
        id,
        kind: input.kind,
        title,
        parent_id: input.parent_id,
        order,
        status: input.status ?? 'draft',
        summary: '',
        word_count: 0,
        updated_at: now,
        file: path.relative(this.root, metaPath),
      };
    });
  }

  /** 重命名节点（同时重命名文件/目录，保持前缀顺序） */
  async renameNode(docId: string, title: string): Promise<DocNode> {
    return this.write(async () => {
      const found = await this.resolveDocFile(docId);
      if (!found || !found.abs) throw new Error(`节点不存在: ${docId}`);
      const node = found.node;
      const newTitle = title.trim() || node.title;

      const dir = path.dirname(found.abs);
      const base = path.basename(found.abs);
      const newName = this.containerFileName(node.kind, node.order, newTitle);
      const newPath =
        node.kind === 'scene' ? path.join(dir, `${newName}.md`) : path.join(dir, newName);

      // 先改内容，再移动，避免移动后内容写丢
      const raw = await fs.readFile(found.abs, 'utf8');
      const { data, body } = parseFrontmatter(raw);
      await writeFileAtomic(
        found.abs,
        stringifyScene({ ...data, title: newTitle, updated_at: Date.now() }, body),
      );

      if (newPath !== found.abs) {
        await fs.rename(found.abs, newPath);
      }

      return { ...node, title: newTitle, file: path.relative(this.root, newPath) };
    });
  }

  /** 更新节点元数据（状态、摘要、标签等） */
  async updateNodeMeta(
    docId: string,
    patch: {
      status?: DocStatus;
      summary?: string;
      pov?: string;
      time?: string;
      tags?: string[];
      plotlines?: string[];
    },
  ): Promise<void> {
    return this.write(async () => {
      const found = await this.resolveDocFile(docId);
      if (!found || !found.abs) throw new Error(`节点不存在: ${docId}`);
      const raw = await fs.readFile(found.abs, 'utf8');
      const { data, body } = parseFrontmatter(raw);
      const next: Frontmatter = { ...data, updated_at: Date.now() };
      if (patch.status !== undefined) next.status = patch.status;
      if (patch.summary !== undefined) next.summary = patch.summary;
      if (patch.pov !== undefined) next.pov = patch.pov;
      if (patch.time !== undefined) next.time = patch.time;
      if (patch.tags !== undefined) next.tags = patch.tags;
      if (patch.plotlines !== undefined) next.plotlines = patch.plotlines;
      await writeFileAtomic(found.abs, stringifyScene(next, body));
    });
  }

  /**
   * 移动节点到新父节点（拖拽排序）。
   * 只支持同层级内移动（场景→章，章→卷），跨层级类型不匹配直接拒绝。
   */
  async moveNode(docId: string, newParentId: string, newOrder: number): Promise<void> {
    return this.write(async () => {
      const found = await this.resolveDocFile(docId);
      if (!found || !found.abs) throw new Error(`节点不存在: ${docId}`);
      const node = found.node;
      if (node.kind === 'volume') throw new Error('卷不支持移动');

      const parent = await this.resolveDocFile(newParentId);
      if (!parent || !parent.node.file) throw new Error('目标父节点不存在');
      const expected = node.kind === 'scene' ? 'chapter' : 'volume';
      if (parent.node.kind !== expected) throw new Error(`${node.kind} 不能移动到 ${parent.node.kind} 下`);

      const targetDir = path.dirname(parent.abs);
      if (path.dirname(found.abs) === targetDir) {
        // 同目录：只改顺序号
        await this.renumberSiblings(targetDir, node.kind, docId, newOrder);
        return;
      }

      // 跨目录：改 order 后移动
      const newName = this.containerFileName(node.kind, newOrder, node.title);
      const dest =
        node.kind === 'scene' ? path.join(targetDir, `${newName}.md`) : path.join(targetDir, newName);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(found.abs, dest);
      await this.renumberSiblings(targetDir, node.kind, docId, newOrder);
    });
  }

  /** 把某个节点插到指定位置，其余兄弟顺延 */
  private async renumberSiblings(
    dir: string,
    kind: NodeKind,
    docId: string,
    newOrder: number,
  ): Promise<void> {
    const entries =
      kind === 'scene'
        ? (await this.listFiles(dir)).filter(isSceneFile).map((f) => stripExt(f))
        : await this.listDirs(dir);

    const items: Array<{ name: string; order: number; isTarget: boolean; title: string }> = [];
    for (const name of entries) {
      const prefix = parseOrderPrefix(name);
      if (!prefix) continue;
      items.push({ name, order: prefix.order, isTarget: false, title: prefix.rest });
    }
    items.sort((a, b) => a.order - b.order);

    // 找到目标（通过读取 id 匹配）
    for (const item of items) {
      const abs = path.join(dir, kind === 'scene' ? `${item.name}.md` : item.name);
      const p = kind === 'scene' ? abs : path.join(abs, META_FILE[kind as 'volume' | 'chapter']);
      const raw = await readTextSafe(p);
      if (!raw) continue;
      const { data } = parseFrontmatter(raw);
      if (fmString(data, 'id') === docId) {
        item.isTarget = true;
        break;
      }
    }

    const target = items.find((i) => i.isTarget);
    if (!target) return;

    const rest = items.filter((i) => !i.isTarget);
    const insertAt = Math.max(0, Math.min(newOrder - 1, rest.length));
    rest.splice(insertAt, 0, target);

    // 依次重命名，前缀变了才动
    for (let i = 0; i < rest.length; i++) {
      const desired = i + 1;
      const item = rest[i];
      if (item.order === desired && !item.isTarget) continue;
      const oldAbs = path.join(dir, kind === 'scene' ? `${item.name}.md` : item.name);
      const newName = this.containerFileName(kind, desired, item.title);
      const newAbs = path.join(dir, kind === 'scene' ? `${newName}.md` : newName);
      if (oldAbs === newAbs) continue;

      // 更新 frontmatter 的 order
      const metaPath = kind === 'scene' ? oldAbs : path.join(oldAbs, META_FILE[kind as 'volume' | 'chapter']);
      const raw = await readTextSafe(metaPath);
      if (raw !== null) {
        const { data, body } = parseFrontmatter(raw);
        await writeFileAtomic(metaPath, stringifyScene({ ...data, order: desired }, body));
      }
      await fs.rename(oldAbs, newAbs).catch(() => {});
    }
  }

  /** 删除节点到回收站（返回被删节点列表） */
  async deleteNode(docId: string): Promise<DocNode[]> {
    return this.write(async () => {
      const tree = await this.readTree();
      const node = tree.nodes.find((n) => n.id === docId);
      if (!node || !node.file) throw new Error(`节点不存在: ${docId}`);

      // 收集整棵子树
      const doomed: DocNode[] = [node];
      if (node.kind !== 'scene') {
        const collect = (parentId: string) => {
          for (const child of tree.nodes.filter((n) => n.parent_id === parentId)) {
            doomed.push(child);
            if (child.kind !== 'scene') collect(child.id);
          }
        };
        collect(node.id);
      }

      const abs = path.join(this.root, node.file);
      const destDir = path.join(this.paths.trash, `${Date.now()}-${docId}`);
      await ensureDir(destDir);

      // 恢复必须回到原来的父目录，否则章会被丢到 manuscript 根下变成孤立目录，
      // 它下面的场景会整片从文档树里消失（正文没丢，但作者看不到）。
      // 所以这里把「被移动项」的原父目录相对路径一并记下来。
      const movingPath = node.kind === 'scene' ? abs : path.dirname(abs);
      const parentRel = path.relative(this.root, path.dirname(movingPath));

      await fs.rename(movingPath, path.join(destDir, path.basename(movingPath)));

      await writeJsonAtomic(path.join(destDir, '_trash.json'), {
        deleted_at: Date.now(),
        root_doc_id: docId,
        // 恢复锚点：被移动项的名称 + 原父目录（相对项目 root，'' 表示 manuscript 根）
        name: path.basename(movingPath),
        parent_rel: parentRel,
        nodes: doomed,
      });

      return doomed;
    });
  }

  /** 从回收站恢复（回到原父目录；父目录已不存在时退回 manuscript 根） */
  async restoreFromTrash(trashId: string): Promise<void> {
    return this.write(async () => {
      const dir = path.join(this.paths.trash, trashId);
      if (!(await exists(dir))) throw new Error('回收站条目不存在');
      const info = await readJsonSafe<{
        nodes?: DocNode[];
        name?: string;
        parent_rel?: string;
      }>(path.join(dir, '_trash.json'), {});
      const payload = (await fs.readdir(dir)).filter((n) => n !== '_trash.json');
      if (payload.length === 0) throw new Error('回收站条目为空');

      const item = info.name && payload.includes(info.name) ? info.name : payload[0];
      const src = path.join(dir, item);

      // 优先回到原父目录；父目录若也被删了，退回 manuscript 根，至少内容不会丢
      let targetDir = info.parent_rel
        ? path.join(this.root, info.parent_rel)
        : this.paths.manuscript;
      if (!(await exists(targetDir))) {
        targetDir = this.paths.manuscript;
      }

      let finalDest = path.join(targetDir, item);
      let n = 1;
      while (await exists(finalDest)) {
        finalDest = path.join(targetDir, `${n++}-${item}`);
      }
      await ensureDir(targetDir);
      await fs.rename(src, finalDest);
      await rmSafe(dir);
    });
  }

  async listTrash(): Promise<Array<{ id: string; name: string; deleted_at: number; nodes: DocNode[] }>> {
    const dirs = await fs.readdir(this.paths.trash).catch(() => [] as string[]);
    const out: Array<{ id: string; name: string; deleted_at: number; nodes: DocNode[] }> = [];
    for (const d of dirs) {
      if (d.startsWith('.')) continue;
      const info = await readJsonSafe<{ deleted_at?: number; nodes?: DocNode[] }>(
        path.join(this.paths.trash, d, '_trash.json'),
        {},
      );
      out.push({
        id: d,
        name: info.nodes?.[0]?.title ?? d,
        deleted_at: info.deleted_at ?? 0,
        nodes: info.nodes ?? [],
      });
    }
    return out.sort((a, b) => b.deleted_at - a.deleted_at);
  }

  async purgeTrash(trashId: string): Promise<void> {
    await rmSafe(path.join(this.paths.trash, trashId));
  }

  // ─────────────────────── 设定库 ───────────────────────

  async listEntities(): Promise<Entity[]> {
    const out: Entity[] = [];
    const dirs = await fs.readdir(this.paths.bible).catch(() => [] as string[]);
    for (const dirName of dirs) {
      const dirPath = path.join(this.paths.bible, dirName);
      const stat = await fs.stat(dirPath).catch(() => null);
      if (!stat?.isDirectory()) continue;
      const type = DIR_TO_ENTITY_TYPE[dirName] ?? dirName;
      const files = await fs.readdir(dirPath).catch(() => [] as string[]);
      for (const f of files) {
        if (!f.endsWith('.md') || f.startsWith('_')) continue;
        const raw = await readTextSafe(path.join(dirPath, f));
        if (raw === null) continue;
        const { data, body } = parseFrontmatter(raw);
        out.push({
          id: fmString(data, 'id') || `entity-${dirName}-${stripExt(f)}`,
          type: fmString(data, 'type', type) as EntityType,
          name: fmString(data, 'name', stripExt(f)),
          aliases: fmArray(data, 'aliases'),
          fields: parseFields(data),
          description: body.trim(),
          created_at: fmNumber(data, 'created_at', 0),
          updated_at: fmNumber(data, 'updated_at', 0),
        });
      }
    }
    return out.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name, 'zh'));
  }

  private entityDir(type: EntityType): string {
    return ENTITY_DIRS[type] ?? (safeName(type, 20).toLowerCase() || 'other');
  }

  async saveEntity(input: {
    id?: string;
    type: EntityType;
    name: string;
    aliases?: string[];
    fields?: Record<string, string>;
    description?: string;
  }): Promise<Entity> {
    return this.write(async () => {
      const type = input.type || 'term';
      const dirName = this.entityDir(type);
      const dirPath = path.join(this.paths.bible, dirName);
      await ensureDir(dirPath);

      let existingPath: string | null = null;
      let existing: Entity | null = null;
      if (input.id) {
        const all = await this.listEntities();
        existing = all.find((e) => e.id === input.id) ?? null;
        if (existing) {
          const files = await fs.readdir(dirPath).catch(() => [] as string[]);
          for (const f of files) {
            if (!f.endsWith('.md')) continue;
            const raw = await readTextSafe(path.join(dirPath, f));
            if (raw && fmString(parseFrontmatter(raw).data, 'id') === input.id) {
              existingPath = path.join(dirPath, f);
              break;
            }
          }
          // 类型变了要换目录
          if (existingPath && existing.type !== type) {
            await fs.rename(existingPath, path.join(dirPath, path.basename(existingPath)));
            existingPath = path.join(dirPath, path.basename(existingPath));
          }
        }
      }

      const now = Date.now();
      const id = existing?.id ?? input.id ?? ulid();
      const name = input.name.trim() || '未命名条目';
      const fileName = `${safeName(name)}.md`;
      const target = existingPath ?? path.join(dirPath, fileName);

      const data: Frontmatter = {
        id,
        type,
        name,
        aliases: input.aliases ?? existing?.aliases ?? [],
        created_at: existing?.created_at || now,
        updated_at: now,
      };
      // 自定义字段平铺，方便人工编辑
      for (const [k, v] of Object.entries(input.fields ?? existing?.fields ?? {})) {
        if (v !== '' && v !== undefined) data[k] = v;
      }

      await writeFileAtomic(
        target,
        stringifyScene(data, input.description ?? existing?.description ?? ''),
      );

      // 改名导致文件名变化时，删掉旧文件
      if (existingPath && path.basename(existingPath) !== fileName) {
        const desired = path.join(dirPath, fileName);
        if (desired !== existingPath) {
          await fs.rename(existingPath, desired).catch(() => {});
        }
      }

      return {
        id,
        type,
        name,
        aliases: input.aliases ?? existing?.aliases ?? [],
        fields: input.fields ?? existing?.fields ?? {},
        description: input.description ?? existing?.description ?? '',
        created_at: existing?.created_at || now,
        updated_at: now,
      };
    });
  }

  async deleteEntity(entityId: string): Promise<void> {
    return this.write(async () => {
      const all = await this.listEntities();
      const target = all.find((e) => e.id === entityId);
      if (!target) return;
      const dirPath = path.join(this.paths.bible, this.entityDir(target.type));
      const files = await fs.readdir(dirPath).catch(() => [] as string[]);
      for (const f of files) {
        if (!f.endsWith('.md')) continue;
        const p = path.join(dirPath, f);
        const raw = await readTextSafe(p);
        if (raw && fmString(parseFrontmatter(raw).data, 'id') === entityId) {
          const destDir = path.join(this.paths.trash, `${Date.now()}-${entityId}`);
          await ensureDir(destDir);
          await fs.rename(p, path.join(destDir, f));
          await writeJsonAtomic(path.join(destDir, '_trash.json'), {
            deleted_at: Date.now(),
            root_doc_id: entityId,
            nodes: [],
          });
          return;
        }
      }
    });
  }

  // ─────────────────────── 笔记 / 灵感箱 ───────────────────────

  async listInbox(): Promise<Array<{ id: string; text: string; created_at: number }>> {
    const raw = await readJsonSafe<Array<{ id: string; text: string; created_at: number }>>(
      path.join(this.paths.inbox, 'inbox.json'),
      [],
    );
    return raw.sort((a, b) => b.created_at - a.created_at);
  }

  async addInbox(text: string): Promise<{ id: string; text: string; created_at: number }> {
    return this.write(async () => {
      const items = await this.listInbox();
      const item = { id: ulid(), text, created_at: Date.now() };
      items.unshift(item);
      await writeJsonAtomic(path.join(this.paths.inbox, 'inbox.json'), items.slice(0, 500));
      return item;
    });
  }

  async deleteInbox(id: string): Promise<void> {
    return this.write(async () => {
      const items = (await this.listInbox()).filter((i) => i.id !== id);
      await writeJsonAtomic(path.join(this.paths.inbox, 'inbox.json'), items);
    });
  }

  // ─────────────────────── 统计聚合 ───────────────────────

  /** 全书字数与场景数 */
  async totals(): Promise<{ word_count: number; scene_count: number }> {
    const tree = await this.readTree();
    let word_count = 0;
    let scene_count = 0;
    for (const n of tree.nodes) {
      if (n.kind === 'scene') {
        word_count += n.word_count;
        scene_count++;
      }
    }
    return { word_count, scene_count };
  }
}

function parseFields(data: Frontmatter): Record<string, string> {
  const reserved = new Set(['id', 'type', 'name', 'aliases', 'created_at', 'updated_at']);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (reserved.has(k)) continue;
    if (v === null || v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

/** 内容哈希（SHA-256，用于快照去重与冲突检测） */
export async function hashText(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Buffer.from(digest).toString('hex').slice(0, 32);
}
