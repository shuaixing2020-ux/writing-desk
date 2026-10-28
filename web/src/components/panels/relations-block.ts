/**
 * 设定库条目详情里的「关系」分组。
 *
 * 为什么单独成文件：bible.ts 已经 596 行，关系部分又有列表、表单、
 * 锚点换算、类型过滤等逻辑，塞进去会让那个文件难以阅读。
 * 这里只负责渲染一个分组，数据与动作全部通过参数传入。
 *
 * 300px 宽度下的取舍：
 *   - 「指向」与「被指向」分两组纵向排列，不做左右分栏
 *   - 新增表单内联展开，不弹窗（弹窗在 300px 里放不下表单）
 *   - 类型下拉按当前条目类型过滤，避免作者选到必然报错的类型
 */

import type { PanelContext } from '../../lib/contracts.ts';
import type {
  Entity,
  EntityType,
  Relation,
  RelationTypeDef,
} from '../../../../shared/types.ts';
import { ENTITY_TYPE_LABELS } from '../../../../shared/types.ts';
import { h } from '../../lib/dom.ts';
import { confirmDanger, errText, toast } from './shared.ts';

export interface RelationSectionOptions {
  ctx: PanelContext;
  /** 当前条目 */
  entity: Entity;
  /** 全部条目（用于选目标） */
  entities: Entity[];
  /** 文档树节点（用于章节锚点下拉） */
  docs: Array<{ id: string; title: string; kind: string; order: number; parent_id: string | null }>;
  /** 章节 id → 序号（由调用方从文档树算好） */
  ordinalOf: (docId: string) => number | null;
  /** 关系变更后刷新详情 */
  onChanged: () => void;
}

/**
 * 渲染关系分组。
 * 返回元素；内部自带加载态与错误态。
 */
export function renderRelationSection(opts: RelationSectionOptions): HTMLElement {
  const { ctx, entity } = opts;
  const box = h('div', { class: 'p-field p-rel' });
  box.appendChild(h('div', { class: 'p-field-label' }, '关系'));

  const host = h('div', { class: 'p-rel-body' }, h('div', { class: 'p-loading' }, h('span', { class: 'spinner' }), h('span', null, '读取关系…')));
  box.appendChild(host);

  let types: RelationTypeDef[] = [];
  let view: { out: Array<Relation & { dangling?: boolean }>; in: Array<Relation & { dangling?: boolean }> } = {
    out: [],
    in: [],
  };
  let formOpen = false;
  let editingId: string | null = null;
  let retargetingId: string | null = null;
  let lastError: string | null = null;

  const load = async (): Promise<void> => {
    try {
      const [t, v] = await Promise.all([
        ctx.api.listRelationTypes(),
        ctx.api.listRelations(entity.id),
      ]);
      types = t.types;
      view = v;
      lastError = null;
      render();
    } catch (err) {
      lastError = errText(err);
      render();
    }
  };

  /** 类型定义查表 */
  const typeOf = (key: string): RelationTypeDef | null => types.find((t) => t.key === key) ?? null;

  /** 章节锚点 → 「第 N 章」 */
  const anchorText = (docId: string | undefined): string => {
    if (!docId) return '';
    const n = opts.ordinalOf(docId);
    return n === null ? '位置未知' : `第 ${n} 章`;
  };

  /** 区间文字 */
  const rangeText = (rel: Relation): string => {
    const s = rel.since ? anchorText(rel.since) : '';
    const u = rel.until ? anchorText(rel.until) : '';
    if (s && u) return `${s} 到 ${u.replace('第 ', '')}`;
    if (s) return `${s} 起`;
    if (u) return `到 ${u.replace('第 ', '')}`;
    return '';
  };

  /** 该条目类型可用的关系类型（按端点约束过滤） */
  const usableTypes = (): RelationTypeDef[] =>
    types.filter((t) => t.allowed === null || t.allowed.some(([from]) => from === entity.type));

  /** 目标任务：在给定类型下，哪些条目类型可以作为终点 */
  const targetTypesFor = (def: RelationTypeDef): EntityType[] => {
    if (def.allowed === null) return [];
    return [...new Set(def.allowed.filter(([from]) => from === entity.type).map(([, to]) => to))];
  };

  function render(): void {
    host.textContent = '';

    if (lastError) {
      host.appendChild(
        h(
          'div',
          { class: 'p-error compact' },
          h('div', { class: 'p-error-msg' }, lastError),
          h('button', { class: 'btn sm', type: 'button', onclick: () => void load() }, '重试'),
        ),
      );
      return;
    }

    // ── 出向：我指向谁 ──
    const outGroup = h('div', { class: 'p-rel-group' });
    outGroup.appendChild(
      h(
        'div',
        { class: 'p-rel-group-head' },
        h('span', null, `指向 · ${view.out.length}`),
        h(
          'button',
          {
            class: 'p-rel-add',
            type: 'button',
            title: '新增关系',
            onclick: () => {
              formOpen = true;
              editingId = null;
              render();
            },
          },
          '＋',
        ),
      ),
    );

    if (view.out.length === 0 && !formOpen) {
      outGroup.appendChild(h('div', { class: 'p-field-empty' }, '还没有指向任何条目。'));
    }

    for (const rel of view.out) {
      outGroup.appendChild(renderRow(rel, 'out'));
    }

    // 新增表单
    if (formOpen && editingId === null) {
      outGroup.appendChild(renderForm(null));
    }

    host.appendChild(outGroup);

    // ── 入向：谁指向我 ──
    if (view.in.length > 0) {
      const inGroup = h('div', { class: 'p-rel-group' });
      inGroup.appendChild(h('div', { class: 'p-rel-group-head' }, h('span', null, `被指向 · ${view.in.length}`)));
      for (const rel of view.in) inGroup.appendChild(renderRow(rel, 'in'));
      host.appendChild(inGroup);
    }
  }

  function renderRow(rel: Relation & { dangling?: boolean }, dir: 'out' | 'in'): HTMLElement {
    const def = typeOf(rel.type);
    // 入向显示反向名（"徒弟"而不是"师徒"）
    const label = dir === 'in' ? (def?.inverse_label ?? def?.label ?? rel.type) : (def?.label ?? rel.type);

    const otherId = dir === 'out' ? rel.to : rel.from;
    const otherName = rel.to_name ?? otherId;

    const range = rangeText(rel);

    const row = h('div', { class: `p-rel-row${rel.dangling ? ' dangling' : ''}` });

    // 第一行：类型 + 对方名字
    const nameBtn = h(
      'button',
      {
        class: 'p-rel-name truncate',
        type: 'button',
        title: rel.dangling ? '目标条目已被删除' : `打开「${otherName}」`,
        onclick: () => {
          if (rel.dangling) return;
          // 跳到对方条目：通过重绘整个面板实现
          opts.ctx.actions.jumpToEntity(otherId);
        },
      },
      otherName,
    );

    row.appendChild(
      h(
        'div',
        { class: 'p-rel-main' },
        h('span', { class: 'p-rel-type' }, label),
        h('span', { class: 'p-rel-arrow', 'aria-hidden': 'true' }, dir === 'out' ? '→' : '←'),
        nameBtn,
      ),
    );

    // 第二行：区间 + 备注
    const meta: string[] = [];
    if (range) meta.push(range);
    if (rel.note) meta.push(rel.note);
    if (rel.dangling) meta.push('目标已被删除');

    if (meta.length > 0) {
      row.appendChild(h('div', { class: 'p-rel-meta truncate' }, meta.join(' · ')));
    }

    // 第三行：操作（只有出向可编辑；入向要改得动对方的文件，属 G3）
    const ops = h('div', { class: 'p-rel-ops' });

    if (rel.dangling) {
      // 悬空关系：只给出「移除」这一个动作
      ops.appendChild(
        h(
          'button',
          {
            class: 'p-rel-op danger',
            type: 'button',
            onclick: () => {
              void (async () => {
                const ok = await confirmDanger(ctx, {
                  title: '移除悬空关系',
                  message: `「${label} → ${otherName}」的目标条目已不存在，移除这条关系？`,
                  confirmText: '移除',
                });
                if (!ok) return;
                try {
                  await ctx.api.deleteRelation(rel.id);
                  toast(ctx, '已移除', 'ok');
                  await load();
                  opts.onChanged();
                } catch (err) {
                  toast(ctx, `移除失败：${errText(err)}`, 'error');
                }
              })();
            },
          },
          '移除',
        ),
      );
    } else if (dir === 'out') {
      ops.appendChild(
        h(
          'button',
          {
            class: 'p-rel-op',
            type: 'button',
            onclick: () => {
              formOpen = true;
              editingId = rel.id;
              render();
            },
          },
          '编辑',
        ),
      );
      // 反转方向：只对有向关系提供（无向关系反转没有意义）
      if (def?.directed) {
        ops.appendChild(
          h(
            'button',
            {
              class: 'p-rel-op',
              type: 'button',
              title: '把「A → B」变成「B → A」，会同时改动两个条目文件',
              onclick: () => {
                void (async () => {
                  const ok = await confirmDanger(ctx, {
                    title: '反转关系方向',
                    message:
                      `把「${otherName} ${def.label} ${entity.name}」变成` +
                      `「${entity.name} ${def.label} ${otherName}」？\n\n` +
                      `这会同时修改「${entity.name}」和「${otherName}」两个条目文件。`,
                    confirmText: '反转',
                  });
                  if (!ok) return;
                  try {
                    await ctx.api.reverseRelation(rel.id);
                    toast(ctx, '已反转方向', 'ok');
                    await load();
                    opts.onChanged();
                  } catch (err) {
                    toast(ctx, `反转失败：${errText(err)}`, 'error');
                  }
                })();
              },
            },
            '反转',
          ),
        );
      }

      // 改指向：把关系连到另一个条目
      ops.appendChild(
        h(
          'button',
          {
            class: 'p-rel-op',
            type: 'button',
            onclick: () => {
              retargetingId = rel.id;
              formOpen = false;
              editingId = null;
              render();
            },
          },
          '改指向',
        ),
      );

      ops.appendChild(
        h(
          'button',
          {
            class: 'p-rel-op danger',
            type: 'button',
            onclick: () => {
              void (async () => {
                const ok = await confirmDanger(ctx, {
                  title: '删除关系',
                  message: `删除「${label} → ${otherName}」这条关系？`,
                  confirmText: '删除',
                });
                if (!ok) return;
                try {
                  await ctx.api.deleteRelation(rel.id);
                  toast(ctx, '已删除', 'ok');
                  await load();
                  opts.onChanged();
                } catch (err) {
                  toast(ctx, `删除失败：${errText(err)}`, 'error');
                }
              })();
            },
          },
          '删除',
        ),
      );
    }

    if (ops.childElementCount > 0) row.appendChild(ops);

    // 改指向的内联表单
    if (retargetingId === rel.id) {
      row.appendChild(renderRetargetForm(rel));
    }

    // 编辑态：就地展开表单
    if (editingId === rel.id) {
      row.appendChild(renderForm(rel));
    }

    return row;
  }

  /** 改指向表单：只换目标条目，其他字段原样保留 */
  function renderRetargetForm(rel: Relation): HTMLElement {
    const form = h('div', { class: 'p-rel-form' });
    const errorHost = h('div', { class: 'p-rel-error hidden' });

    const def = typeOf(rel.type);
    const allowedTypes = def ? targetTypesFor(def) : [];
    const candidates = opts.entities
      .filter((e) => e.id !== entity.id && e.id !== rel.to)
      .filter((e) => allowedTypes.length === 0 || allowedTypes.includes(e.type))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));

    form.appendChild(h('div', { class: 'p-rel-current' }, `当前指向：${rel.to_name ?? rel.to}`));

    const select = h('select', { class: 'select' }) as HTMLSelectElement;
    if (candidates.length === 0) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '没有符合类型要求的目标';
      select.appendChild(o);
    } else {
      for (const e of candidates) {
        const o = document.createElement('option');
        o.value = e.id;
        o.textContent = `${e.name}（${ENTITY_TYPE_LABELS[e.type] ?? e.type}）`;
        select.appendChild(o);
      }
    }
    form.appendChild(h('label', { class: 'p-rel-field' }, h('span', null, '改为指向'), select));
    form.appendChild(errorHost);

    const submit = h('button', { class: 'btn sm primary', type: 'button' }, '确定');
    const cancel = h(
      'button',
      {
        class: 'btn sm',
        type: 'button',
        onclick: () => {
          retargetingId = null;
          render();
        },
      },
      '取消',
    );

    submit.addEventListener('click', () => {
      void (async () => {
        errorHost.classList.add('hidden');
        if (!select.value) {
          errorHost.textContent = '请选择一个新的目标条目。';
          errorHost.classList.remove('hidden');
          return;
        }
        submit.disabled = true;
        try {
          await ctx.api.retargetRelation(rel.id, select.value);
          toast(ctx, '已改指向', 'ok');
          retargetingId = null;
          await load();
          opts.onChanged();
        } catch (err) {
          errorHost.textContent = errText(err);
          errorHost.classList.remove('hidden');
        } finally {
          submit.disabled = false;
        }
      })();
    });

    form.appendChild(h('div', { class: 'p-rel-form-ops' }, submit, cancel));
    return form;
  }

  /** 新增/编辑表单 */
  function renderForm(existing: Relation | null): HTMLElement {
    const form = h('div', { class: 'p-rel-form' });
    const errorHost = h('div', { class: 'p-rel-error hidden' });

    // ── 类型下拉：按当前条目类型过滤 ──
    const available = existing ? types : usableTypes();
    const typeSel = h('select', { class: 'select' }) as HTMLSelectElement;
    for (const t of available) {
      const opt = document.createElement('option');
      opt.value = t.key;
      opt.textContent = t.label;
      if (existing && t.key === existing.type) opt.selected = true;
      typeSel.appendChild(opt);
    }
    if (available.length === 0) {
      form.appendChild(h('div', { class: 'p-field-empty' }, `「${ENTITY_TYPE_LABELS[entity.type] ?? entity.type}」暂无可用的关系类型。`));
      form.appendChild(
        h('button', { class: 'btn sm', type: 'button', onclick: () => { formOpen = false; editingId = null; render(); } }, '取消'),
      );
      return form;
    }

    // ── 目标条目下拉（新增时才有；编辑不改端点） ──
    let targetSel: HTMLSelectElement | null = null;
    if (!existing) {
      targetSel = h('select', { class: 'select' }) as HTMLSelectElement;
      const refreshTargets = (): void => {
        const def = typeOf(typeSel.value);
        if (!def || !targetSel) return;
        const allowedTypes = targetTypesFor(def);
        const candidates: Entity[] = opts.entities
          .filter((e) => e.id !== entity.id)
          .filter((e) => allowedTypes.length === 0 || allowedTypes.includes(e.type))
          .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
        targetSel.textContent = '';
        if (candidates.length === 0) {
          const o = document.createElement('option');
          o.value = '';
          o.textContent = '没有符合类型要求的目标';
          targetSel.appendChild(o);
        } else {
          for (const e of candidates) {
            const o = document.createElement('option');
            o.value = e.id;
            o.textContent = `${e.name}（${ENTITY_TYPE_LABELS[e.type] ?? e.type}）`;
            targetSel.appendChild(o);
          }
        }
      };
      typeSel.addEventListener('change', refreshTargets);
      refreshTargets();
    }

    // ── 章节锚点下拉 ──
    const chapterOptions = (): Array<{ id: string; label: string }> => {
      const chapters = opts.docs
        .filter((d) => d.kind === 'chapter')
        .sort((a, b) => a.order - b.order);
      const outAdjusted: Array<{ id: string; label: string }> = [];
      let n = 0;
      for (const c of chapters) {
        n++;
        outAdjusted.push({ id: c.id, label: `第 ${n} 章 ${c.title}` });
      }
      return outAdjusted;
    };

    const makeAnchorSelect = (selected?: string): HTMLSelectElement => {
      const sel = h('select', { class: 'select' }) as HTMLSelectElement;
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '不限';
      sel.appendChild(none);
      for (const c of chapterOptions()) {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = c.label;
        if (selected === c.id) o.selected = true;
        sel.appendChild(o);
      }
      return sel;
    };

    const sinceSel = makeAnchorSelect(existing?.since);
    const untilSel = makeAnchorSelect(existing?.until);

    const noteInput = h('input', {
      class: 'input',
      type: 'text',
      placeholder: '备注（可留空）',
      value: existing?.note ?? '',
    }) as HTMLInputElement;

    // 组装
    const rows: HTMLElement[] = [];
    rows.push(h('label', { class: 'p-rel-field' }, h('span', null, '类型'), typeSel));
    if (targetSel) rows.push(h('label', { class: 'p-rel-field' }, h('span', null, '目标'), targetSel));
    rows.push(h('label', { class: 'p-rel-field' }, h('span', null, '起始'), sinceSel));
    rows.push(h('label', { class: 'p-rel-field' }, h('span', null, '结束'), untilSel));
    rows.push(h('label', { class: 'p-rel-field' }, h('span', null, '备注'), noteInput));
    for (const r of rows) form.appendChild(r);
    form.appendChild(errorHost);

    const submit = h(
      'button',
      { class: 'btn sm primary', type: 'button' },
      existing ? '保存' : '添加',
    );
    const cancel = h(
      'button',
      {
        class: 'btn sm',
        type: 'button',
        onclick: () => {
          formOpen = false;
          editingId = null;
          render();
        },
      },
      '取消',
    );

    const showError = (msg: string): void => {
      errorHost.textContent = msg;
      errorHost.classList.remove('hidden');
    };

    submit.addEventListener('click', () => {
      void (async () => {
        errorHost.classList.add('hidden');
        submit.disabled = true;
        try {
          if (existing) {
            await ctx.api.updateRelation(existing.id, {
              type: typeSel.value,
              since: sinceSel.value || null,
              until: untilSel.value || null,
              note: noteInput.value,
            });
            toast(ctx, '关系已更新', 'ok');
          } else {
            if (!targetSel || !targetSel.value) {
              showError('请选择一个目标条目。');
              submit.disabled = false;
              return;
            }
            await ctx.api.createRelation(entity.id, {
              type: typeSel.value,
              to: targetSel.value,
              since: sinceSel.value || undefined,
              until: untilSel.value || undefined,
              note: noteInput.value,
            });
            toast(ctx, '关系已添加', 'ok');
          }
          formOpen = false;
          editingId = null;
          await load();
          opts.onChanged();
        } catch (err) {
          // 服务端的具体原因显示在表单里，不只弹 toast
          showError(errText(err));
        } finally {
          submit.disabled = false;
        }
      })();
    });

    form.appendChild(h('div', { class: 'p-rel-form-ops' }, submit, cancel));
    return form;
  }

  void load();
  return box;
}
