/**
 * 一句话建关系的界面（R2）。
 *
 * 形态：［X ▼］ 是 ［Y ▼］ 的 ［角色词 ▼］ ［添加］
 * 作者不需要理解起点终点，只要会说「谁是谁的什么人」。
 *
 * 预览放在按钮上方：提交前就能看到「会建出什么」，避免方向搞反了才发现。
 */

import type { Entity, RelationTypeDef } from '../../../shared/types.ts';
import type { PanelContext } from '../lib/contracts.ts';
import { h } from '../lib/dom.ts';
import {
  ownerAndDirection,
  previewText,
  resolveSentence,
  roleWords,
  type RoleWord,
} from '../lib/relation-sentence.ts';
import { errText, toast } from './panels/shared.ts';

export interface RelationBuilderOptions {
  ctx: PanelContext;
  /** 当前页面条目（X 的默认值；也是写文件的目标） */
  current: Entity;
  entities: Entity[];
  types: RelationTypeDef[];
  /** 建好之后回调（面板重新加载关系） */
  onCreated: () => void | Promise<void>;
}

/** 错误码 → 作者能看懂的话 */
const ERROR_TEXT: Record<string, string> = {
  rel_endpoint_invalid: '这两个条目的类型之间不能建这种关系',
  rel_duplicate: '这条关系已经存在',
  rel_cycle: '这会形成循环，不能这样建',
  rel_self_loop: '不能和自己建关系',
  rel_target_missing: '对方条目已不存在',
  rel_range_invalid: '起止章节的顺序不对',
  rel_anchor_missing: '指定的章节不存在',
  rel_type_unknown: '未知的关系类型',
};

function errorText(err: unknown): string {
  const anyErr = err as { code?: string; message?: string };
  if (anyErr?.code && ERROR_TEXT[anyErr.code]) {
    return ERROR_TEXT[anyErr.code];
  }
  return errText(err);
}

export function renderRelationBuilder(opts: RelationBuilderOptions): HTMLElement {
  const { ctx, current, entities, types } = opts;

  const wrap = h('div', { class: 'p-rel-builder' });
  const errorHost = h('div', { class: 'p-rel-builder-error hidden' });

  const showError = (msg: string): void => {
    errorHost.textContent = msg;
    errorHost.classList.remove('hidden');
  };
  const clearError = (): void => {
    errorHost.classList.add('hidden');
    errorHost.textContent = '';
  };

  const sorted = [...entities].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const optionFor = (e: Entity): HTMLOptionElement => {
    const o = document.createElement('option');
    o.value = e.id;
    o.textContent = e.name;
    return o;
  };

  // ── X：默认是当前条目，但可改 ──
  const xSel = h('select', { class: 'select p-rel-builder-x', 'aria-label': '主体条目' }) as HTMLSelectElement;
  for (const e of sorted) {
    const o = optionFor(e);
    if (e.id === current.id) o.selected = true;
    xSel.appendChild(o);
  }

  // ── Y：对方条目，默认取第一个不是 X 的 ──
  const ySel = h('select', { class: 'select p-rel-builder-y', 'aria-label': '对方条目' }) as HTMLSelectElement;

  // ── 角色词 ──
  const wordSel = h('select', { class: 'select p-rel-builder-word', 'aria-label': '关系角色词' }) as HTMLSelectElement;

  /** 按两端条目的类型约束过滤角色词 */
  function refillWords(): void {
    const x = entities.find((e) => e.id === xSel.value);
    const y = entities.find((e) => e.id === ySel.value);
    const prev = wordSel.value;
    wordSel.textContent = '';
    if (!x || !y) return;

    const allowed = roleWords(types).filter((w) => {
      const def = types.find((t) => t.key === w.type);
      if (!def) return false;
      if (!def.allowed) return true;
      const isFrom = w.selfIsFrom !== false; // 对称按起点算
      const pair: [string, string] = isFrom ? [x.type, y.type] : [y.type, x.type];
      return def.allowed.some(([a, b]) => a === pair[0] && b === pair[1]);
    });

    for (const w of allowed) {
      const o = document.createElement('option');
      o.value = `${w.type}\u0000${w.word}`;
      o.textContent = w.word;
      wordSel.appendChild(o);
    }
    if (prev) wordSel.value = prev;
    if (!wordSel.value && allowed.length > 0) {
      wordSel.value = `${allowed[0].type}\u0000${allowed[0].word}`;
    }
    renderPreview();
  }

  function currentWord(): RoleWord | null {
    const [type, word] = wordSel.value.split('\u0000');
    if (!type || !word) return null;
    const found = roleWords(types).find((w) => w.type === type && w.word === word);
    return found ?? null;
  }

  const preview = h('div', { class: 'p-rel-builder-preview' });

  function renderPreview(): void {
    const x = entities.find((e) => e.id === xSel.value);
    const y = entities.find((e) => e.id === ySel.value);
    const w = currentWord();
    if (!x || !y || !w) {
      preview.textContent = '';
      return;
    }
    const def = types.find((t) => t.key === w.type);
    preview.textContent = previewText(x.name, y.name, w, def?.label ?? w.type);
  }

  function refillTargets(): void {
    const prev = ySel.value;
    ySel.textContent = '';
    for (const e of sorted) {
      if (e.id === xSel.value) continue; // 不能和自己建关系
      ySel.appendChild(optionFor(e));
    }
    if (prev && [...ySel.options].some((o) => o.value === prev)) ySel.value = prev;
    refillWords();
  }

  xSel.addEventListener('change', () => {
    clearError();
    refillTargets();
  });
  ySel.addEventListener('change', () => {
    clearError();
    refillWords();
  });
  wordSel.addEventListener('change', () => {
    clearError();
    renderPreview();
  });

  const submit = h(
    'button',
    { class: 'btn sm primary p-rel-builder-add', type: 'button' },
    '添加',
  ) as HTMLButtonElement;

  submit.addEventListener('click', () => {
    void (async () => {
      clearError();
      const x = entities.find((e) => e.id === xSel.value);
      const y = entities.find((e) => e.id === ySel.value);
      const w = currentWord();
      if (!x || !y || !w) {
        showError('请先选好两个条目和角色词');
        return;
      }

      const resolved = resolveSentence(x.id, y.id, w);
      const { owner, other, direction } = ownerAndDirection(current.id, x.id, y.id, resolved);

      submit.disabled = true;
      try {
        await ctx.api.createRelation(owner, {
          type: w.type,
          other,
          direction,
        });
        toast(ctx, '关系已建立', 'ok');
        preview.textContent = '';
        await opts.onCreated();
      } catch (err) {
        showError(errorText(err));
      } finally {
        submit.disabled = false;
      }
    })();
  });

  const line = h(
    'div',
    { class: 'p-rel-builder-line' },
    xSel,
    h('span', { class: 'p-rel-builder-word-sep' }, '是'),
    ySel,
    h('span', { class: 'p-rel-builder-word-sep' }, '的'),
    wordSel,
    submit,
  );

  wrap.append(line, preview, errorHost);

  refillTargets();
  return wrap;
}
