/**
 * 设定库面板 —— 角色 / 地点 / 势力 / 物品 / 术语 / 事件。
 *
 * 300px 宽度下的取舍：主从视图而不是左右分栏。
 * 列表与详情切换，详情里放「反向引用」——这是设定库真正的价值：
 * 作者想知道「林远上一次出场是哪一章」，而不是再读一遍人设。
 */

import type { PanelContext, PanelDef, PanelInstance } from '../../lib/contracts.ts';
import type { AppState } from '../../lib/store.ts';
import type { Entity, EntityDetail, EntityType } from '../../../../shared/types.ts';
import { ENTITY_TYPE_LABELS } from '../../../../shared/types.ts';
import { h, fmtNum, relativeTime } from '../../lib/dom.ts';
import { renderRelationSection } from './relations-block.ts';
import {
  ICONS,
  bigIcon,
  emptyBlock,
  errText,
  iconButton,
  loadingBlock,
  panelShell,
  confirmDanger,
  searchField,
  toast,
} from './shared.ts';

const TYPE_ORDER: EntityType[] = ['character', 'place', 'faction', 'item', 'term', 'event'];

function typeLabel(type: string): string {
  return ENTITY_TYPE_LABELS[type] ?? type;
}

function typeIcon(type: string): string {
  switch (type) {
    case 'character':
      return ICONS.bible;
    case 'place':
      return ICONS.layers;
    case 'faction':
      return ICONS.layers;
    case 'item':
      return ICONS.book;
    case 'term':
      return ICONS.quote;
    case 'event':
      return ICONS.clock;
    default:
      return ICONS.bible;
  }
}

export const panel: PanelDef = {
  id: 'bible',
  title: '设定库',
  icon: ICONS.bible,
  inInspector: true,

  mount(container: HTMLElement, ctx: PanelContext): PanelInstance {
    const search = searchField({
      placeholder: '搜索条目…',
      onInput: () => renderList(),
    });

    const addBtn = iconButton(ICONS.plus, '新建条目', () => openCreateForm());
    const shell = panelShell(container, { toolbar: search, tools: [addBtn] });

    let filterType: EntityType | 'all' = 'all';
    let selectedId: string | null = null;
    let detail: EntityDetail | null = null;
    let detailLoading = false;
    let creating = false;
    let destroyed = false;

    const contentHost = h('div', { class: 'p-bible-content' });
    shell.body.appendChild(contentHost);

    // 外部（图谱节点点击、搜索结果）请求聚焦某个条目时，直接打开它的详情。
    // 没有这个监听，jumpToEntity 只会把右栏切到设定库，作者还得自己再找一遍。
    const onFocusEntity = (ev: Event): void => {
      const id = (ev as CustomEvent<{ id?: string }>).detail?.id;
      if (!id || destroyed) return;
      selectedId = id;
      void openDetail(id);
    };
    window.addEventListener('writingdesk:focus-entity', onFocusEntity);

    // ─────────────────────── 列表 ───────────────────────

    function renderList(): void {
      if (destroyed) return;
      selectedId = null;
      detail = null;
      const state = ctx.store.state;
      const q = search.value.trim().toLowerCase();
      const entities = state.entities;

      const wrap = h('div', { class: 'p-bible' });

      if (entities.length === 0) {
        wrap.appendChild(
          emptyBlock({
            icon: bigIcon('<path d="M3.2 2.8h6.4a2 2 0 0 1 2 2v8.4H5.2a2 2 0 0 1-2-2z"/>'),
            title: '还没有设定条目',
            hint: '角色、地点、势力都记在这里。写正文时名字会自动关联出场章节。',
            action: { label: '新建角色', onClick: () => openCreateForm('character') },
          }),
        );
        contentHost.textContent = '';
        contentHost.appendChild(wrap);
        return;
      }

      // 类型筛选 chips（带数量）
      const counts = new Map<string, number>();
      for (const e of entities) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
      const chipRow = h('div', { class: 'p-chips' });
      const allChip = h(
        'button',
        {
          class: `p-chip${filterType === 'all' ? ' sel' : ''}`,
          type: 'button',
          onclick: () => {
            filterType = 'all';
            renderList();
          },
        },
        '全部',
        h('span', { class: 'p-chip-n' }, String(entities.length)),
      );
      chipRow.appendChild(allChip);
      for (const t of TYPE_ORDER) {
        const n = counts.get(t) ?? 0;
        if (n === 0) continue;
        chipRow.appendChild(
          h(
            'button',
            {
              class: `p-chip${filterType === t ? ' sel' : ''}`,
              type: 'button',
              onclick: () => {
                filterType = t;
                renderList();
              },
            },
            typeLabel(t),
            h('span', { class: 'p-chip-n' }, String(n)),
          ),
        );
      }
      wrap.appendChild(chipRow);

      const filtered = entities
        .filter((e) => filterType === 'all' || e.type === filterType)
        .filter((e) => {
          if (!q) return true;
          if (e.name.toLowerCase().includes(q)) return true;
          if (e.aliases.some((a) => a.toLowerCase().includes(q))) return true;
          return e.description.toLowerCase().includes(q);
        })
        .sort((a, b) => {
          const ta = TYPE_ORDER.indexOf(a.type);
          const tb = TYPE_ORDER.indexOf(b.type);
          if (ta !== tb) return (ta < 0 ? 99 : ta) - (tb < 0 ? 99 : tb);
          return a.name.localeCompare(b.name, 'zh-Hans-CN');
        });

      if (filtered.length === 0) {
        wrap.appendChild(
          emptyBlock({
            icon: ICONS.search,
            title: '没有匹配的条目',
            hint: q ? `换个关键词试试，或清除筛选。` : '这个分类下还没有条目。',
          }),
        );
        contentHost.textContent = '';
        contentHost.appendChild(wrap);
        return;
      }

      // 按类型分组
      const groups = new Map<string, Entity[]>();
      for (const e of filtered) {
        const arr = groups.get(e.type) ?? [];
        arr.push(e);
        groups.set(e.type, arr);
      }
      for (const [type, list] of groups) {
        wrap.appendChild(
          h(
            'div',
            { class: 'p-group-title' },
            h('span', null, typeLabel(type)),
            h('span', { class: 'p-group-n' }, String(list.length)),
          ),
        );
        const groupEl = h('div', { class: 'p-entity-list' });
        for (const ent of list) {
          groupEl.appendChild(renderEntityRow(ent));
        }
        wrap.appendChild(groupEl);
      }

      contentHost.textContent = '';
      contentHost.appendChild(wrap);
    }

    function renderEntityRow(ent: Entity): HTMLElement {
      return h(
        'button',
        {
          class: 'p-entity-row',
          type: 'button',
          onclick: () => void openDetail(ent.id),
        },
        h('span', { class: 'p-entity-icon', html: typeIcon(ent.type) }),
        h(
          'span',
          { class: 'p-entity-main' },
          h('span', { class: 'p-entity-name truncate' }, ent.name),
          h(
            'span',
            { class: 'p-entity-sub truncate' },
            ent.aliases.length ? ent.aliases.join(' / ') : ent.description || '暂无描述',
          ),
        ),
        h('span', { class: 'p-entity-time' }, relativeTime(ent.updated_at)),
      );
    }

    // ─────────────────────── 详情 ───────────────────────

    async function openDetail(id: string): Promise<void> {
      selectedId = id;
      detail = null;
      detailLoading = true;
      renderDetail();
      try {
        const data = await ctx.api.getEntity(id);
        if (destroyed || selectedId !== id) return;
        detail = data;
      } catch (err) {
        if (destroyed || selectedId !== id) return;
        detailLoading = false;
        contentHost.textContent = '';
        contentHost.appendChild(backRow());
        contentHost.appendChild(errorDetail(err, () => void openDetail(id)));
        return;
      }
      detailLoading = false;
      renderDetail();
    }

    function backRow(): HTMLElement {
      const btn = h(
        'button',
        {
          class: 'p-back',
          type: 'button',
          onclick: () => {
            selectedId = null;
            detail = null;
            renderList();
          },
        },
        h('span', { class: 'p-back-icon', html: ICONS.chevron }),
        '返回列表',
      );
      return h('div', { class: 'p-back-row' }, btn);
    }

    function errorDetail(err: unknown, retry: () => void): HTMLElement {
      return h(
        'div',
        { class: 'p-error' },
        h('div', { class: 'p-error-icon', html: ICONS.alert }),
        h('div', { class: 'p-error-msg' }, errText(err)),
        h('button', { class: 'btn sm', type: 'button', onclick: retry }, '重试'),
      );
    }

    function renderDetail(): void {
      if (destroyed) return;
      contentHost.textContent = '';
      contentHost.appendChild(backRow());

      if (detailLoading || !detail) {
        contentHost.appendChild(loadingBlock('读取条目…'));
        return;
      }

      const ent = detail;
      const head = h(
        'div',
        { class: 'p-detail-head' },
        h(
          'div',
          { class: 'p-detail-title-row' },
          h('span', { class: 'p-detail-icon', html: typeIcon(ent.type) }),
          h('h3', { class: 'p-detail-title' }, ent.name),
          h('span', { class: 'badge' }, typeLabel(ent.type)),
        ),
        h(
          'div',
          { class: 'p-detail-meta' },
          h('span', null, `出场 ${detail.total_count} 次`),
          detail.last_doc ? h('span', { class: 'p-dot-sep', 'aria-hidden': 'true' }) : null,
          detail.last_doc ? h('span', { class: 'truncate' }, `最近：${detail.last_doc.doc_title}`) : null,
        ),
      );
      contentHost.appendChild(head);

      // 别名
      const aliasSection = h('div', { class: 'p-field' });
      aliasSection.appendChild(h('div', { class: 'p-field-label' }, '别名'));
      aliasSection.appendChild(
        h(
          'div',
          { class: 'p-alias-list' },
          ...(ent.aliases.length
            ? ent.aliases.map((a) => h('span', { class: 'badge' }, a))
            : [h('span', { class: 'p-field-empty' }, '无别名，出场识别只匹配本名')]),
        ),
      );
      contentHost.appendChild(aliasSection);

      // 自定义字段
      const fieldKeys = Object.keys(ent.fields ?? {});
      if (fieldKeys.length) {
        const box = h('div', { class: 'p-field' });
        box.appendChild(h('div', { class: 'p-field-label' }, '资料'));
        const dl = h('div', { class: 'p-kv' });
        for (const k of fieldKeys) {
          dl.appendChild(h('div', { class: 'p-kv-k' }, k));
          dl.appendChild(h('div', { class: 'p-kv-v' }, ent.fields[k] ?? ''));
        }
        box.appendChild(dl);
        contentHost.appendChild(box);
      }

      // 描述（可编辑，失焦保存）
      const descBox = h('div', { class: 'p-field' });
      descBox.appendChild(h('div', { class: 'p-field-label' }, '描述'));
      const desc = h('textarea', {
        class: 'textarea p-detail-desc',
        rows: 5,
        placeholder: '写清楚这个人想要什么、怕什么、说话什么调子…',
        value: ent.description,
      }) as HTMLTextAreaElement;
      desc.addEventListener('blur', () => {
        if (desc.value === ent.description) return;
        const next = desc.value;
        void ctx.actions
          .saveEntity({ ...ent, description: next })
          .then(() => {
            ent.description = next;
            toast(ctx, '已保存', 'ok');
          })
          .catch((e: unknown) => {
            toast(ctx, `保存失败：${errText(e)}`, 'error');
            desc.value = ent.description;
          });
      });
      descBox.appendChild(desc);
      contentHost.appendChild(descBox);

      // 关系（指向与被指向）
      try {
        contentHost.appendChild(
          renderRelationSection({
            ctx,
            entity: {
              id: ent.id,
              type: ent.type,
              name: ent.name,
              aliases: ent.aliases,
              fields: ent.fields,
              description: ent.description,
              created_at: ent.created_at,
              updated_at: ent.updated_at,
            },
            entities: ctx.store.state.entities,
            docs: ctx.store.state.nodes.map((n) => ({
              id: n.id,
              title: n.title,
              kind: n.kind,
              order: n.order,
              parent_id: n.parent_id,
            })),
            ordinalOf: (docId) => {
              // 场景归它所在的章；章取自身
              const nodes = ctx.store.state.nodes;
              const byId = new Map(nodes.map((n) => [n.id, n]));
              const chapters = nodes
                .filter((n) => n.kind === 'chapter')
                .sort((a, b) => a.order - b.order);
              let cur = byId.get(docId);
              let guard = 0;
              while (cur && guard++ < 50) {
                if (cur.kind === 'chapter') {
                  const idx = chapters.findIndex((c) => c.id === cur!.id);
                  return idx === -1 ? null : idx + 1;
                }
                cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
              }
              return null;
            },
            onChanged: () => {
              // 关系变化后重载详情（悬空状态需要重新计算）
              void openDetail(ent.id);
            },
          }),
        );
      } catch (err) {
        contentHost.appendChild(
          h('div', { class: 'p-field-empty' }, `关系加载失败：${errText(err)}`),
        );
      }

      // 反向引用
      const mentionBox = h('div', { class: 'p-field' });
      mentionBox.appendChild(h('div', { class: 'p-field-label' }, `出场章节 · ${ent.mentions.length}`));
      if (ent.mentions.length === 0) {
        mentionBox.appendChild(
          h(
            'div',
            { class: 'p-field-empty' },
            '还没有在正文里识别到这个名字。写进正文后会自动出现。',
          ),
        );
      } else {
        const list = h('div', { class: 'p-mention-list' });
        for (const m of [...ent.mentions].sort((a, b) => b.count - a.count)) {
          list.appendChild(
            h(
              'button',
              {
                class: 'p-mention',
                type: 'button',
                title: `${m.doc_title} · 命中 ${m.count} 次`,
                onclick: () => {
                  void ctx.actions
                    .revealInEditor(m.doc_id, m.first_pos, m.first_pos + m.entity_name.length)
                    .catch((e: unknown) => toast(ctx, errText(e), 'error'));
                },
              },
              h('span', { class: 'p-mention-title truncate' }, m.doc_title),
              h('span', { class: 'p-mention-count mono' }, `${m.count}`),
            ),
          );
        }
        mentionBox.appendChild(list);
      }
      contentHost.appendChild(mentionBox);

      // 操作
      const actions = h(
        'div',
        { class: 'p-detail-actions' },
        h(
          'button',
          {
            class: 'btn sm',
            type: 'button',
            onclick: () => {
              selectedId = null;
              detail = null;
              openEditForm(ent);
            },
          },
          '编辑',
        ),
        h(
          'button',
          {
            class: 'btn sm danger',
            type: 'button',
            onclick: () => {
              void (async () => {
                const ok = await confirmDanger(ctx, {
                  title: `删除「${ent.name}」？`,
                  message: '该条目会从设定库移除。正文内容不受影响，但出场关联会丢失。',
                  confirmText: '删除',
                });
                if (!ok) return;
                try {
                  await ctx.actions.deleteEntity(ent.id);
                  toast(ctx, '已删除', 'ok');
                  selectedId = null;
                  detail = null;
                  renderList();
                } catch (e) {
                  toast(ctx, `删除失败：${errText(e)}`, 'error');
                }
              })();
            },
          },
          '删除',
        ),
      );
      contentHost.appendChild(actions);
    }

    // ─────────────────────── 新建 / 编辑表单 ───────────────────────

    function openCreateForm(presetType?: string): void {
      creating = true;
      selectedId = null;
      detail = null;
      renderForm(null, presetType ?? 'character');
    }

    function openEditForm(ent: Entity): void {
      creating = false;
      renderForm(ent, ent.type);
    }

    function renderForm(existing: Entity | null, initialType: string): void {
      contentHost.textContent = '';
      const isNew = !existing;
      contentHost.appendChild(
        h(
          'div',
          { class: 'p-back-row' },
          h(
            'button',
            {
              class: 'p-back',
              type: 'button',
              onclick: () => {
                if (existing) void openDetail(existing.id);
                else renderList();
              },
            },
            h('span', { class: 'p-back-icon', html: ICONS.chevron }),
            isNew ? '取消' : '返回详情',
          ),
        ),
      );

      const form = h('form', { class: 'p-form' });
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        void submit();
      });

      const typeSelect = h(
        'select',
        { class: 'select', 'aria-label': '条目类型' },
        ...TYPE_ORDER.map((t) =>
          h('option', { value: t, selected: t === initialType }, typeLabel(t)),
        ),
      ) as HTMLSelectElement;

      const nameInput = h('input', {
        class: 'input',
        type: 'text',
        placeholder: '名字，如「林远」',
        value: existing?.name ?? '',
        maxlength: '40',
        required: true,
      }) as HTMLInputElement;

      const aliasInput = h('input', {
        class: 'input',
        type: 'text',
        placeholder: '别名，用逗号分隔',
        value: existing?.aliases.join('，') ?? '',
      }) as HTMLInputElement;

      const descInput = h('textarea', {
        class: 'textarea',
        rows: 4,
        placeholder: '一句话人设，或几条关键设定…',
        value: existing?.description ?? '',
      }) as HTMLTextAreaElement;

      form.append(
        h('div', { class: 'p-field' }, h('div', { class: 'p-field-label' }, '类型'), typeSelect),
        h('div', { class: 'p-field' }, h('div', { class: 'p-field-label' }, '名称'), nameInput),
        h('div', { class: 'p-field' }, h('div', { class: 'p-field-label' }, '别名'), aliasInput),
        h('div', { class: 'p-field' }, h('div', { class: 'p-field-label' }, '描述'), descInput),
      );

      const submitBtn = h('button', { class: 'btn primary block', type: 'submit' }, isNew ? '创建' : '保存');
      form.appendChild(h('div', { class: 'p-form-actions' }, submitBtn));
      contentHost.appendChild(form);

      async function submit(): Promise<void> {
        const name = nameInput.value.trim();
        if (!name) {
          nameInput.focus();
          toast(ctx, '名称不能为空', 'warn');
          return;
        }
        const aliases = aliasInput.value
          .split(/[,，、;；\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        submitBtn.disabled = true;
        try {
          await ctx.actions.saveEntity({
            ...(existing ?? {}),
            type: typeSelect.value,
            name,
            aliases,
            description: descInput.value.trim(),
            fields: existing?.fields ?? {},
          });
          toast(ctx, isNew ? '已创建' : '已保存', 'ok');
          creating = false;
          // 保存后刷新列表（外壳 refreshEntities 会推新 state）
          await ctx.actions.refreshEntities();
          const list = ctx.store.state.entities;
          const saved = list.find((e) => e.name === name && e.type === typeSelect.value);
          if (saved) await openDetail(saved.id);
          else renderList();
        } catch (e) {
          toast(ctx, `保存失败：${errText(e)}`, 'error');
        } finally {
          submitBtn.disabled = false;
        }
      }

      setTimeout(() => nameInput.focus(), 0);
    }

    // ─────────────────────── 生命周期 ───────────────────────

    let lastEntitiesRef: Entity[] | null = null;
    renderList();

    return {
      update(state: AppState, changed: Set<keyof AppState>): void {
        if (!changed.has('entities')) return;
        if (state.entities === lastEntitiesRef) return;
        lastEntitiesRef = state.entities;
        // 正在编辑时不要打断输入
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) {
          return;
        }
        if (creating) return;
        if (selectedId) {
          // 详情页保留位置，仅刷新数据源
          const fresh = state.entities.find((e) => e.id === selectedId);
          if (!fresh) {
            renderList();
          }
          return;
        }
        renderList();
      },
      destroy(): void {
        window.removeEventListener('writingdesk:focus-entity', onFocusEntity);
        destroyed = true;
        container.textContent = '';
      },
    };
  },
};
