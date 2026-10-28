/**
 * 关系操作的撤销 / 重做（G3）。
 *
 * 为什么用「逆操作」而不是快照整个项目：
 *   关系改动只影响一两个条目文件。为每一步都存整个项目的快照，
 *   内存与写盘代价都太高，而且和大纲、正文的编辑历史混在一起也难理清。
 *   这里每一步只记一条逆操作（调一次 API 就能回退），足够轻。
 *
 * 作用域：内存栈，随页面刷新清空。
 *   不落盘是有意的 —— 跨会话的「撤销」语义很难定义（作者可能中途
 *   用编辑器手改过文件），贸然回退反而是数据风险。
 *   真正跨会话的版本安全由快照（server/services/snapshot.ts）负责。
 *
 * 上限 50 步：足够覆盖一次连续整理，又不会把内存占满。
 */

export interface HistoryEntry {
  /** 显示给作者的说明，如「新增关系 师徒 → 老掌门」 */
  label: string;
  /** 撤销这一步 */
  undo: () => Promise<void>;
  /** 重做这一步 */
  redo: () => Promise<void>;
}

const MAX_STEPS = 50;

export class UndoHistory {
  /** 已应用的步骤；undo 时从末尾取 */
  private applied: HistoryEntry[] = [];
  /** 已撤销、可重做的步骤；redo 时从末尾取 */
  private undone: HistoryEntry[] = [];
  /** 正在执行撤销/重做时不再记录新步骤，避免把回退动作本身记进历史 */
  private busy = false;

  /** 记录一步。会清空重做栈（与常见编辑器一致） */
  push(entry: HistoryEntry): void {
    if (this.busy) return;
    this.applied.push(entry);
    if (this.applied.length > MAX_STEPS) this.applied.shift();
    this.undone = [];
  }

  get canUndo(): boolean {
    return this.applied.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  get undoLabel(): string | null {
    return this.applied[this.applied.length - 1]?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.undone[this.undone.length - 1]?.label ?? null;
  }

  /**
   * 撤销一步。
   * @returns 被撤销的说明；没有可撤销的返回 null
   */
  async undo(): Promise<string | null> {
    const entry = this.applied.pop();
    if (!entry) return null;
    this.busy = true;
    try {
      await entry.undo();
      this.undone.push(entry);
      return entry.label;
    } catch (err) {
      // 失败要放回去，否则这一步就丢了
      this.applied.push(entry);
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /**
   * 重做一步。
   * @returns 被重做的说明；没有可重做的返回 null
   */
  async redo(): Promise<string | null> {
    const entry = this.undone.pop();
    if (!entry) return null;
    this.busy = true;
    try {
      await entry.redo();
      this.applied.push(entry);
      return entry.label;
    } catch (err) {
      this.undone.push(entry);
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /** 清空历史（切换作品、重建索引后调用） */
  clear(): void {
    this.applied = [];
    this.undone = [];
  }
}

/**
 * 每个作品一个历史栈。
 * 切换作品时必须换栈，否则会把 A 作品的撤销动作用到 B 作品上。
 */
const histories = new Map<string, UndoHistory>();

export function historyFor(projectId: string): UndoHistory {
  let h = histories.get(projectId);
  if (!h) {
    h = new UndoHistory();
    histories.set(projectId, h);
  }
  return h;
}
