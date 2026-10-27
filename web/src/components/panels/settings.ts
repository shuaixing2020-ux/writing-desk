/**
 * 设置面板 —— 全屏视图（inInspector=false）。
 *
 * 为什么全屏：编辑器观感、导入导出、备份与维护的控件密度远超 300px，
 * 挤在右侧栏里只会做成一个不好用的抽屉。分节展示，改动即时生效。
 *
 * 生效路径（与外壳约定）：
 *   - 编辑器观感 → ctx.actions.setSettings(patch)，外壳写 CSS 变量 + localStorage
 *   - 作品级设置（字数口径/每日目标/排版预设）→ api.updateProject / saveTypeset
 *   - 备份目录、导入导出、重建索引 → 各自的 api / actions
 */

import type { PanelContext, PanelDef, PanelInstance } from '../../lib/contracts.ts';
import type { AppState, EditorSettings, ThemeName } from '../../lib/store.ts';
import type {
  BackupTarget,
  CountMode,
  ExportFormat,
  ImportPreview,
  Job,
  TypesetPreset,
} from '../../../../shared/types.ts';
import {
  COUNT_MODE_LABELS,
  DEFAULT_TYPESET,
  WORK_MODE_LABELS,
} from '../../../../shared/types.ts';
import { h, fmtNum, formatTime } from '../../lib/dom.ts';
import {
  ICONS,
  confirmDanger,
  emptyBlock,
  errText,
  fmtBytes,
  loadingBlock,
  panelShell,
  sectionTitle,
  segmented,
  settingRow,
  slider,
  toast,
  toggle,
} from './shared.ts';

const FONT_OPTIONS: Array<{ value: EditorSettings['font']; label: string }> = [
  { value: 'serif', label: '衬线（宋）' },
  { value: 'sans', label: '无衬线（黑）' },
];

const THEME_OPTIONS: Array<{ value: ThemeName; label: string; title: string }> = [
  { value: 'light', label: '浅色', title: '暖纸白' },
  { value: 'sepia', label: '护眼', title: '暖黄纸' },
  { value: 'dark', label: '深色', title: '夜间' },
];

const COUNT_MODES: CountMode[] = ['hanzi', 'hanzi_punct', 'platform'];

export const panel: PanelDef = {
  id: 'settings',
  title: '设置',
  icon: ICONS.settings,
  inInspector: false,

  mount(container: HTMLElement, ctx: PanelContext): PanelInstance {
    let destroyed = false;
    let backups: BackupTarget[] = [];
    let backupsLoading = false;
    let backupsError: unknown = null;
    let importPreview: ImportPreview | null = null;
    let importFile: File | null = null;
    let importBusy = false;
    let importError: unknown = null;
    let jobs: Job[] = [];
    let jobsError: unknown = null;

    const shell = panelShell(container);
    shell.root.classList.add('panel-settings');
    const body = h('div', { class: 'p-settings' });
    shell.body.appendChild(body);

    // ─────────────────────── 渲染 ───────────────────────

    function render(): void {
      if (destroyed) return;
      const state = ctx.store.state;
      const scrollTop = shell.body.scrollTop;
      body.textContent = '';

      body.appendChild(renderEditorSection(state));
      body.appendChild(renderWritingSection(state));
      body.appendChild(renderTypesetSection(state));
      body.appendChild(renderBackupSection());
      body.appendChild(renderAiSection());
      body.appendChild(renderIoSection());
      body.appendChild(renderMaintenanceSection(state));
      body.appendChild(renderAbout(state));

      shell.body.scrollTop = scrollTop;
    }

    // ── 编辑器观感 ──
    function renderEditorSection(state: AppState): HTMLElement {
      const s = state.settings;
      const sec = h('section', { class: 'p-set-section' });
      sec.appendChild(sectionTitle('编辑器', { hint: '改动即时生效' }));

      sec.appendChild(
        settingRow(
          '字号',
          slider({
            min: 13,
            max: 24,
            step: 1,
            value: s.fontSize,
            format: (v) => `${v}px`,
            onChange: (v) => ctx.actions.setSettings({ fontSize: v }),
          }),
        ),
      );
      sec.appendChild(
        settingRow(
          '行距',
          slider({
            min: 1.4,
            max: 2.4,
            step: 0.05,
            value: s.lineHeight,
            format: (v) => v.toFixed(2),
            onChange: (v) => ctx.actions.setSettings({ lineHeight: v }),
          }),
        ),
      );
      sec.appendChild(
        settingRow(
          '版心宽度',
          slider({
            min: 24,
            max: 48,
            step: 1,
            value: s.measure,
            format: (v) => `${v}em`,
            onChange: (v) => ctx.actions.setSettings({ measure: v }),
          }),
          { hint: '一行多少字，影响阅读节奏' },
        ),
      );
      sec.appendChild(
        settingRow(
          '段间距',
          slider({
            min: 0,
            max: 2,
            step: 0.05,
            value: s.paragraphGap,
            format: (v) => `${v.toFixed(2)}em`,
            onChange: (v) => ctx.actions.setSettings({ paragraphGap: v }),
          }),
        ),
      );
      sec.appendChild(
        settingRow(
          '段首缩进',
          slider({
            min: 0,
            max: 2,
            step: 1,
            value: s.indent,
            format: (v) => (v === 0 ? '无' : `${v} 字`),
            onChange: (v) => ctx.actions.setSettings({ indent: v }),
          }),
        ),
      );
      sec.appendChild(
        settingRow(
          '正文字体',
          segmented(FONT_OPTIONS, s.font, (v) => ctx.actions.setSettings({ font: v })),
        ),
      );
      sec.appendChild(
        settingRow(
          '主题',
          segmented(THEME_OPTIONS, s.theme, (v) => ctx.actions.setSettings({ theme: v })),
        ),
      );
      sec.appendChild(
        settingRow(
          '专注模式',
          toggle(s.focus, (v) => ctx.actions.setSettings({ focus: v })),
          { hint: '隐藏两侧栏，只留正文' },
        ),
      );
      sec.appendChild(
        settingRow(
          '打字机模式',
          toggle(s.typewriter, (v) => ctx.actions.setSettings({ typewriter: v })),
          { hint: '光标行固定在屏幕中央' },
        ),
      );
      return sec;
    }

    // ── 写作设置（作品级） ──
    function renderWritingSection(state: AppState): HTMLElement {
      const project = state.project;
      const sec = h('section', { class: 'p-set-section' });
      sec.appendChild(sectionTitle('写作', { hint: project ? WORK_MODE_LABELS[project.mode] : '' }));

      if (!project) {
        sec.appendChild(h('div', { class: 'p-card-text' }, '尚未打开作品。'));
        return sec;
      }

      sec.appendChild(
        settingRow(
          '字数口径',
          h(
            'select',
            {
              class: 'select',
              'aria-label': '字数口径',
              onchange: (ev: Event) => {
                const next = (ev.target as HTMLSelectElement).value as CountMode;
                void patchProject({ count_mode: next }, '字数口径已更新');
              },
            },
            ...COUNT_MODES.map((m) =>
              h('option', { value: m, selected: m === project.count_mode }, COUNT_MODE_LABELS[m]),
            ),
          ),
          { hint: '全书统计与导出报告都按这个口径' },
        ),
      );

      const goalInput = h('input', {
        class: 'input p-num-input',
        type: 'number',
        min: '0',
        step: '100',
        value: String(project.daily_goal),
        'aria-label': '每日目标字数',
      }) as HTMLInputElement;
      goalInput.addEventListener('change', () => {
        const v = Math.max(0, Math.round(Number(goalInput.value) || 0));
        goalInput.value = String(v);
        if (v === project.daily_goal) return;
        void patchProject({ daily_goal: v }, '每日目标已更新');
      });
      sec.appendChild(settingRow('每日目标', h('div', { class: 'p-input-suffix' }, goalInput, h('span', null, '字'))));

      const autoPunct = toggle(project.auto_punct, (v) => {
        void patchProject({ auto_punct: v }, v ? '已开启标点自动规整' : '已关闭标点自动规整');
      });
      sec.appendChild(
        settingRow('标点自动规整', autoPunct, { hint: '保存时把 ... → …… 等常见写法规整' }),
      );

      return sec;
    }

    // ── 平台排版预设 ──
    function renderTypesetSection(state: AppState): HTMLElement {
      const project = state.project;
      const sec = h('section', { class: 'p-set-section' });
      sec.appendChild(sectionTitle('平台排版预设', { hint: '导出时套用，不改源文件' }));
      if (!project) return sec;

      const ts: TypesetPreset = { ...DEFAULT_TYPESET, ...(project.typeset ?? {}) };

      sec.appendChild(
        settingRow(
          '段首缩进',
          slider({
            min: 0,
            max: 2,
            step: 1,
            value: ts.indent,
            format: (v) => (v === 0 ? '无' : `${v} 全角空格`),
            onChange: (v) => void saveTypeset({ ...ts, indent: v }),
          }),
        ),
      );
      sec.appendChild(
        settingRow(
          '段间空行',
          toggle(ts.paragraph_gap, (v) => void saveTypeset({ ...ts, paragraph_gap: v })),
          { hint: '网文平台常见：段与段之间留一空行' },
        ),
      );

      const titleInput = h('input', {
        class: 'input',
        type: 'text',
        value: ts.chapter_title,
        placeholder: '第{n}章 {title}',
        'aria-label': '章节标题格式',
      }) as HTMLInputElement;
      titleInput.addEventListener('change', () => {
        const v = titleInput.value.trim() || DEFAULT_TYPESET.chapter_title;
        titleInput.value = v;
        void saveTypeset({ ...ts, chapter_title: v });
      });
      sec.appendChild(
        settingRow('章节标题', titleInput, { hint: '{n} 序号，{title} 标题' }),
      );

      return sec;
    }

    // ── 备份 ──
    function renderBackupSection(): HTMLElement {
      const sec = h('section', { class: 'p-set-section' });
      sec.appendChild(sectionTitle('备份', { hint: '整项目打包' }));

      const addRow = h('div', { class: 'p-backup-add' });
      const dirInput = h('input', {
        class: 'input',
        type: 'text',
        placeholder: '备份目录绝对路径，如 /Users/me/Backups/writing',
        'aria-label': '备份目录',
      }) as HTMLInputElement;
      const addBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => void addBackup(dirInput) }, '添加');
      addRow.append(dirInput, addBtn);
      sec.appendChild(addRow);

      if (backupsLoading) {
        sec.appendChild(loadingBlock('读取备份配置…'));
        return sec;
      }
      if (backupsError) {
        sec.appendChild(
          h(
            'div',
            { class: 'p-error compact' },
            h('div', { class: 'p-error-msg' }, errText(backupsError)),
            h('button', { class: 'btn sm', type: 'button', onclick: () => void loadBackups() }, '重试'),
          ),
        );
        return sec;
      }
      if (backups.length === 0) {
        sec.appendChild(
          h(
            'div',
            { class: 'p-card-text' },
            '还没有备份目标。添加一个目录，之后可以一键把整部作品打包过去（建议放在另一个磁盘或网盘同步目录）。',
          ),
        );
        return sec;
      }

      const list = h('div', { class: 'p-backup-list' });
      for (const target of backups) {
        const row = h('div', { class: 'p-backup-row' });
        row.appendChild(
          h(
            'div',
            { class: 'p-backup-main' },
            h('div', { class: 'p-backup-dir mono truncate', title: target.dir }, target.dir),
            h(
              'div',
              { class: 'p-backup-sub' },
              target.last_run ? `上次 ${formatTime(target.last_run)}` : '尚未备份',
              target.last_file ? ` · ${target.last_file}` : '',
            ),
            target.last_error
              ? h('div', { class: 'p-backup-err truncate', title: target.last_error }, target.last_error)
              : null,
          ),
        );
        row.appendChild(
          h(
            'div',
            { class: 'p-backup-actions' },
            toggle(target.enabled, (v) => void updateBackup(target, { enabled: v })),
            h(
              'button',
              {
                class: 'btn sm',
                type: 'button',
                onclick: () => {
                  void (async () => {
                    try {
                      await ctx.api.runBackup(target.id);
                      toast(ctx, '备份已开始', 'info');
                      void ctx.actions.refreshJobs().catch(() => {});
                    } catch (e) {
                      toast(ctx, `备份失败：${errText(e)}`, 'error');
                    }
                  })();
                },
              },
              '立即备份',
            ),
          ),
        );
        list.appendChild(row);
      }
      sec.appendChild(list);
      return sec;
    }

    // ── 导入导出 ──
    // ── AI 接入（预留，默认关闭） ──
    //
    // 这一块默认是「说明 + 全部禁用」的形态：告诉用户接口已留好，
    // 但当前版本不会发任何请求。等将来真的接入适配器，这里会自动变成可用。
    function renderAiSection(): HTMLElement {
      const sec = document.createElement('div');
      sec.appendChild(
        sectionTitle('AI 接入', { hint: '接口已预留，默认关闭；当前版本不会发起任何网络请求' }),
      );

      const wrap = h('div', { class: 'p-ai' }, loadingBlock('读取 AI 配置…'));
      sec.appendChild(wrap);

      void (async () => {
        try {
          const { config, status } = await ctx.api.getAi();
          wrap.textContent = '';
          wrap.appendChild(renderAiBody(config, status));
        } catch (err) {
          wrap.textContent = '';
          wrap.appendChild(
            h(
              'div',
              { class: 'p-error compact' },
              h('div', { class: 'p-error-msg' }, errText(err)),
              h(
                'button',
                {
                  class: 'btn sm',
                  type: 'button',
                  onclick: () => {
                    const parent = wrap.parentElement;
                    if (!parent) return;
                    const fresh = renderAiSection();
                    parent.replaceChild(fresh, sec);
                  },
                },
                '重试',
              ),
            ),
          );
        }
      })();

      return sec;
    }

    function renderAiBody(
      config: import('../../../../shared/types.ts').AiConfig,
      status: import('../../../../shared/types.ts').AiStatus,
    ): HTMLElement {
      const box = document.createElement('div');

      // 状态横幅
      const banner = h(
        'div',
        { class: `p-ai-banner ${status.available ? 'ok' : 'info'}` },
        h('div', { class: 'p-ai-banner-title' }, status.available ? 'AI 已接入' : 'AI 尚未接入'),
        h(
          'div',
          { class: 'p-ai-banner-text' },
          status.available
            ? '已安装适配器。调用前请确认下面的服务商与 Key 配置正确。'
            : '当前版本只预留了接口与配置位。开启下面的开关也只是记录配置，不会发起任何网络请求。',
        ),
      );
      box.appendChild(banner);

      const save = (patch: Partial<import('../../../../shared/types.ts').AiConfig>): void => {
        void (async () => {
          try {
            const res = await ctx.api.saveAi(patch);
            // 用返回值重绘，保证界面与磁盘一致（Key 是打码值）
            wrapReplace(res.config, res.status);
            ctx.toast('AI 配置已保存（仅存于本机）', 'ok');
          } catch (err) {
            ctx.toast(`保存失败：${err instanceof Error ? err.message : String(err)}`, 'error');
          }
        })();
      };

      // 用一个可变容器方便局部重绘
      const dyn = h('div', { class: 'p-ai-dyn' });
      const wrapReplace = (
        c: import('../../../../shared/types.ts').AiConfig,
        st: import('../../../../shared/types.ts').AiStatus,
      ): void => {
        dyn.textContent = '';
        dyn.appendChild(renderAiControls(c, st, save));
      };
      box.appendChild(dyn);
      wrapReplace(config, status);

      // 红线条目
      box.appendChild(
        h(
          'div',
          { class: 'p-ai-notes' },
          h('div', { class: 'p-ai-note' }, '· API Key 只保存在本机 project.json，界面上永远打码显示'),
          h('div', { class: 'p-ai-note' }, '· 即便将来接入，AI 产出也只作建议，不会自动改写你的正文'),
          h('div', { class: 'p-ai-note' }, '· 本工具没有遥测、没有崩溃上报，Key 不会被带出去'),
        ),
      );

      return box;
    }

    function renderAiControls(
      config: import('../../../../shared/types.ts').AiConfig,
      status: import('../../../../shared/types.ts').AiStatus,
      save: (patch: Partial<import('../../../../shared/types.ts').AiConfig>) => void,
    ): HTMLElement {
      const box = document.createElement('div');

      // 总开关
      box.appendChild(
        settingRow(
          '启用 AI',
          toggle(config.enabled, (v) => save({ enabled: v })),
          { hint: status.available ? '' : '当前版本未接入适配器，开启也不会有请求发生' },
        ),
      );

      // 服务商
      const providerSel = h('select', { class: 'select p-ai-select' }) as HTMLSelectElement;
      const providers: Array<[string, string]> = [
        ['deepseek', 'DeepSeek'],
        ['moonshot', 'Moonshot（月之暗面）'],
        ['openai-compatible', '自定义（OpenAI 兼容）'],
      ];
      for (const [value, label] of providers) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        if (value === config.provider) opt.selected = true;
        providerSel.appendChild(opt);
      }
      providerSel.addEventListener('change', () =>
        save({ provider: providerSel.value as import('../../../../shared/types.ts').AiProvider }),
      );
      box.appendChild(settingRow('服务商', providerSel));

      // Base URL
      const baseInput = textInput(config.base_url, '留空使用服务商默认地址', (v) =>
        save({ base_url: v }),
      );
      box.appendChild(settingRow('接口地址', baseInput, { hint: '自定义服务商时填写' }));

      // 模型
      const modelInput = textInput(config.model, '留空使用服务商默认模型', (v) => save({ model: v }));
      box.appendChild(settingRow('模型', modelInput));

      // API Key
      const keyInput = textInput(
        config.api_key,
        config.api_key ? '已保存（打码显示）' : '粘贴你的 API Key',
        (v) => save({ api_key: v }),
      );
      keyInput.type = 'password';
      keyInput.autocomplete = 'off';
      keyInput.spellcheck = false;
      // 聚焦时把打码值清掉，方便直接粘贴新 Key
      keyInput.addEventListener('focus', () => {
        if (keyInput.value.startsWith('****')) keyInput.value = '';
      });
      box.appendChild(
        settingRow('API Key', keyInput, { hint: '只存本机，界面打码显示' }),
      );

      // 生成参数
      box.appendChild(
        settingRow(
          '温度',
          slider({
            min: 0,
            max: 2,
            step: 0.1,
            value: config.temperature,
            format: (v) => v.toFixed(1),
            onChange: (v) => save({ temperature: v }),
          }),
          { hint: '越高越发散，写作建议 0.7–1.0' },
        ),
      );

      // 能力开关
      const featBox = h('div', { class: 'p-ai-feats' });
      const features: Array<[string, string, string]> = [
        ['continue', '续写', '基于当前场景上下文接续若干段'],
        ['polish', '润色选中段落', '只改表达，不改情节'],
        ['naming', '取名建议', '生成人物、地名候选'],
        ['consistency', '一致性提示', '提示角色行为是否与设定矛盾'],
      ];
      for (const [key, label, hint] of features) {
        const on = Boolean((config.features as unknown as Record<string, boolean>)[key]);
        featBox.appendChild(
          h(
            'div',
            { class: 'p-ai-feat' },
            h('div', { class: 'p-ai-feat-label' }, label, h('span', { class: 'p-ai-feat-hint' }, hint)),
            toggle(on, (v) => save({ features: { [key]: v } as never })),
          ),
        );
      }
      box.appendChild(h('div', { class: 'p-ai-feat-title' }, '能力开关'));
      box.appendChild(featBox);

      // 缺失项提示
      if (status.missing.length > 0) {
        const miss = h('div', { class: 'p-ai-missing' }, h('div', { class: 'p-ai-missing-title' }, '还差这些才能用：'));
        for (const m of status.missing) miss.appendChild(h('div', { class: 'p-ai-missing-item' }, `· ${m}`));
        box.appendChild(miss);
      }

      return box;
    }

    /** 小工具：文本输入，失焦保存 */
    function textInput(
      value: string,
      placeholder: string,
      onCommit: (v: string) => void,
    ): HTMLInputElement {
      const input = h('input', {
        class: 'input p-ai-input',
        type: 'text',
        value,
        placeholder,
      }) as HTMLInputElement;
      input.addEventListener('blur', () => {
        if (input.value !== value) onCommit(input.value.trim());
      });
      input.addEventListener('keydown', (ev) => {
        if ((ev as KeyboardEvent).key === 'Enter') input.blur();
      });
      return input;
    }

    function renderIoSection(): HTMLElement {
      const sec = h('section', { class: 'p-set-section' });
      sec.appendChild(sectionTitle('导入 / 导出'));

      // 导入
      const fileInput = h('input', {
        type: 'file',
        accept: '.txt,.md,.markdown,text/plain,text/markdown',
        class: 'p-file-input',
      }) as HTMLInputElement;
      fileInput.addEventListener('change', () => {
        const f = fileInput.files?.[0];
        if (!f) return;
        void prepareImport(f);
      });

      const importCard = h('div', { class: 'p-card' });
      importCard.appendChild(
        h(
          'div',
          { class: 'p-card-head' },
          h('span', { class: 'p-card-title' }, '导入稿件'),
          h('span', { class: 'p-card-sub' }, 'txt / md'),
        ),
      );
      importCard.appendChild(
        h(
          'div',
          { class: 'p-card-text' },
          '导入前会先做一份快照。支持「第X章」等常见章节切分，预览确认后再写入。',
        ),
      );
      importCard.appendChild(
        h('label', { class: 'btn sm block' }, h('span', { html: ICONS.upload }), '选择文件', fileInput),
      );

      if (importBusy) {
        importCard.appendChild(loadingBlock('解析中…'));
      } else if (importError) {
        importCard.appendChild(
          h('div', { class: 'p-error compact' }, h('div', { class: 'p-error-msg' }, errText(importError))),
        );
      } else if (importPreview) {
        const p = importPreview;
        importCard.appendChild(
          h(
            'div',
            { class: 'p-import-preview' },
            h(
              'div',
              { class: 'p-import-stats' },
              h('span', null, `${p.chapters.length} 章`),
              h('span', { class: 'p-dot-sep' }),
              h('span', { class: 'mono' }, `${fmtNum(p.total_words)} 字`),
              h('span', { class: 'p-dot-sep' }),
              h('span', null, p.encoding),
            ),
            p.garbled
              ? h('div', { class: 'p-warn-line' }, h('span', { html: ICONS.alert }), '疑似乱码，建议先转成 UTF-8 再导入')
              : null,
            h('div', { class: 'p-import-rule' }, `切分规则：${p.rule}`),
            h('pre', { class: 'p-import-text' }, p.preview.slice(0, 600)),
            h(
              'div',
              { class: 'p-import-actions' },
              h(
                'button',
                {
                  class: 'btn sm',
                  type: 'button',
                  onclick: () => {
                    importPreview = null;
                    importFile = null;
                    render();
                  },
                },
                '取消',
              ),
              h(
                'button',
                {
                  class: 'btn sm primary',
                  type: 'button',
                  onclick: () => void runImport(),
                },
                '确认导入',
              ),
            ),
          ),
        );
      }

      // 导出
      const exportCard = h('div', { class: 'p-card' });
      exportCard.appendChild(
        h(
          'div',
          { class: 'p-card-head' },
          h('span', { class: 'p-card-title' }, '导出全书'),
          h('span', { class: 'p-card-sub' }, '后台作业'),
        ),
      );
      exportCard.appendChild(
        h('div', { class: 'p-card-text' }, '按当前作品导出整本。导出文件保存在项目的 .studio/exports/ 下，完成后可直接下载。'),
      );
      const formats: Array<{ f: ExportFormat; label: string; hint: string }> = [
        { f: 'txt', label: 'TXT', hint: '投稿/平台发布' },
        { f: 'md', label: 'Markdown', hint: '保留结构' },
        { f: 'docx', label: 'Word', hint: '编辑/投稿' },
        { f: 'epub', label: 'EPUB', hint: '电子书' },
      ];
      const grid = h('div', { class: 'p-export-grid' });
      for (const item of formats) {
        grid.appendChild(
          h(
            'button',
            {
              class: 'p-export-btn',
              type: 'button',
              title: item.hint,
              onclick: () => {
                void (async () => {
                  try {
                    const job = await ctx.api.exportBook({
                      format: item.f,
                      scope: 'book',
                      typeset: item.f === 'txt',
                    });
                    jobs = [job, ...jobs];
                    toast(ctx, `${item.label} 导出已开始`, 'info');
                    void ctx.actions.refreshJobs().catch(() => {});
                    render();
                  } catch (e) {
                    toast(ctx, `导出失败：${errText(e)}`, 'error');
                  }
                })();
              },
            },
            h('span', { class: 'p-export-fmt' }, item.label),
            h('span', { class: 'p-export-hint' }, item.hint),
          ),
        );
      }
      exportCard.appendChild(grid);

      // 最近的作业（导出/导入/备份结果在这里可见）
      const recent = jobs.filter((j) => ['export', 'import', 'backup', 'rebuild_index'].includes(j.kind)).slice(0, 5);
      if (jobsError) {
        exportCard.appendChild(h('div', { class: 'p-error compact' }, h('div', { class: 'p-error-msg' }, errText(jobsError))));
      } else if (recent.length) {
        const jobList = h('div', { class: 'p-job-list' });
        for (const job of recent) jobList.appendChild(renderJobRow(job));
        exportCard.appendChild(jobList);
      }

      sec.append(importCard, exportCard);
      return sec;
    }

    function renderJobRow(job: Job): HTMLElement {
      const file = job.result && typeof job.result === 'object' && 'file' in job.result
        ? String((job.result as { file: unknown }).file)
        : null;
      const size = job.result && typeof job.result === 'object' && 'size' in job.result
        ? Number((job.result as { size: unknown }).size)
        : 0;

      const row = h('div', { class: `p-job status-${job.status}` });
      row.appendChild(
        h(
          'div',
          { class: 'p-job-main' },
          h(
            'div',
            { class: 'p-job-title' },
            job.kind === 'export' ? '导出' : job.kind === 'import' ? '导入' : job.kind === 'backup' ? '备份' : '重建索引',
            h('span', { class: `badge ${job.status === 'done' ? 'ok' : job.status === 'failed' ? 'danger' : ''}` },
              job.status === 'done' ? '完成' : job.status === 'failed' ? '失败' : job.status === 'running' ? '进行中' : job.status === 'queued' ? '排队' : '已取消'),
          ),
          h('div', { class: 'p-job-sub truncate' }, job.status === 'failed' ? (job.error ?? '未知错误') : job.message || formatTime(job.created_at)),
        ),
      );
      if (job.status === 'running' || job.status === 'queued') {
        row.appendChild(
          h('div', { class: 'p-progress' }, h('div', { class: 'p-progress-fill', style: { width: `${Math.round(job.progress * 100)}%` } })),
        );
      }
      if (file && job.status === 'done') {
        row.appendChild(
          h(
            'a',
            { class: 'btn sm', href: ctx.api.downloadUrl(file), download: '', title: size ? fmtBytes(size) : file },
            h('span', { html: ICONS.download }),
            '下载',
          ),
        );
      }
      return row;
    }

    // ── 维护 ──
    function renderMaintenanceSection(state: AppState): HTMLElement {
      const sec = h('section', { class: 'p-set-section' });
      sec.appendChild(sectionTitle('维护'));

      const trashCount = state.trash.length;
      sec.appendChild(
        settingRow(
          '回收站',
          h(
            'div',
            { class: 'row gap-2' },
            h('span', { class: 'badge' }, `${trashCount} 项`),
            h(
              'button',
              {
                class: 'btn sm',
                type: 'button',
                onclick: () => {
                  ctx.actions.setRightPanel('outline');
                  toast(ctx, '回收站入口由外壳提供（左侧树底部）', 'info');
                },
              },
              '查看',
            ),
          ),
          { hint: '删除的卷/章/场景保留 30 天' },
        ),
      );

      sec.appendChild(
        settingRow(
          '重建索引',
          h(
            'button',
            {
              class: 'btn sm',
              type: 'button',
              onclick: () => void rebuildIndex(),
            },
            '重建',
          ),
          { hint: '搜索/出场识别异常时使用，不影响稿件' },
        ),
      );

      sec.appendChild(
        settingRow(
          '检查规则',
          h(
            'button',
            {
              class: 'btn sm',
              type: 'button',
              onclick: () => ctx.actions.setRightPanel('lint'),
            },
            '打开检查面板',
          ),
        ),
      );

      sec.appendChild(
        settingRow(
          '快照',
          h(
            'button',
            {
              class: 'btn sm',
              type: 'button',
              onclick: () => ctx.actions.setRightPanel('snapshots'),
            },
            '查看版本历史',
          ),
        ),
      );

      return sec;
    }

    function renderAbout(state: AppState): HTMLElement {
      const sec = h('section', { class: 'p-set-section' });
      sec.appendChild(sectionTitle('关于'));
      const project = state.project;
      sec.appendChild(
        h(
          'div',
          { class: 'p-about' },
          h('div', { class: 'p-about-name' }, '写作台'),
          h('div', { class: 'p-about-line' }, '本地优先的小说写作工作台。稿件是纯 Markdown 文件，索引与数据库都可重建。'),
          h('div', { class: 'p-about-line' }, '不联网、不上传、不做任何统计。'),
          project
            ? h('div', { class: 'p-about-meta mono' }, `项目 ${project.id} · schema v${project.schema_version}`)
            : null,
        ),
      );
      return sec;
    }

    // ─────────────────────── 行为 ───────────────────────

    /** 服务端返回的 ProjectMeta 才是真相；形状异常时不要污染 store */
    function looksLikeProject(v: unknown): v is NonNullable<AppState['project']> {
      return !!v && typeof v === 'object' && 'id' in v && 'count_mode' in v;
    }

    async function patchProject(patch: Partial<NonNullable<AppState['project']>>, okMsg: string): Promise<void> {
      try {
        const updated = await ctx.api.updateProject(patch);
        if (looksLikeProject(updated)) ctx.store.set({ project: updated });
        else {
          const cur = ctx.store.state.project;
          if (cur) ctx.store.set({ project: { ...cur, ...patch } });
        }
        toast(ctx, okMsg, 'ok');
        render();
      } catch (e) {
        toast(ctx, `保存失败：${errText(e)}`, 'error');
        render();
      }
    }

    async function saveTypeset(typeset: TypesetPreset): Promise<void> {
      try {
        const updated = await ctx.api.saveTypeset(typeset);
        if (looksLikeProject(updated)) ctx.store.set({ project: updated });
        else {
          const cur = ctx.store.state.project;
          if (cur) ctx.store.set({ project: { ...cur, typeset } });
        }
        toast(ctx, '排版预设已保存', 'ok');
      } catch (e) {
        toast(ctx, `保存失败：${errText(e)}`, 'error');
      }
    }

    async function loadBackups(): Promise<void> {
      backupsLoading = true;
      backupsError = null;
      render();
      try {
        backups = await ctx.api.listBackups();
      } catch (e) {
        backupsError = e;
      } finally {
        backupsLoading = false;
        if (!destroyed) render();
      }
    }

    async function addBackup(input: HTMLInputElement): Promise<void> {
      const dir = input.value.trim();
      if (!dir) {
        input.focus();
        toast(ctx, '请填写备份目录', 'warn');
        return;
      }
      try {
        const target = await ctx.api.saveBackupTarget({ dir, enabled: true, keep: 10, interval_min: 60 });
        backups = [...backups, target];
        input.value = '';
        toast(ctx, '备份目录已添加', 'ok');
        render();
      } catch (e) {
        toast(ctx, `添加失败：${errText(e)}`, 'error');
      }
    }

    async function updateBackup(target: BackupTarget, patch: Partial<BackupTarget>): Promise<void> {
      try {
        const updated = await ctx.api.saveBackupTarget({ ...target, ...patch, dir: target.dir });
        backups = backups.map((b) => (b.id === updated.id ? updated : b));
        render();
      } catch (e) {
        toast(ctx, `保存失败：${errText(e)}`, 'error');
        render();
      }
    }

    async function prepareImport(file: File): Promise<void> {
      importBusy = true;
      importError = null;
      importPreview = null;
      importFile = file;
      render();
      try {
        const content = await file.text();
        const preview = await ctx.api.previewImport({ filename: file.name, content });
        if (destroyed) return;
        importPreview = preview;
      } catch (e) {
        if (destroyed) return;
        importError = e;
      } finally {
        if (!destroyed) {
          importBusy = false;
          render();
        }
      }
    }

    async function runImport(): Promise<void> {
      if (!importFile || !importPreview) return;
      try {
        const content = await importFile.text();
        const job = await ctx.api.runImport({ filename: importFile.name, content });
        jobs = [job, ...jobs];
        toast(ctx, '导入已开始，完成后会出现在文档树里', 'info');
        importPreview = null;
        importFile = null;
        void ctx.actions.refreshJobs().catch(() => {});
        void ctx.actions.refreshTree().catch(() => {});
        render();
      } catch (e) {
        toast(ctx, `导入失败：${errText(e)}`, 'error');
      }
    }

    async function rebuildIndex(): Promise<void> {
      const ok = await confirmDanger(ctx, {
        title: '重建索引？',
        message: '会重新扫描 manuscript/ 下的全部稿件并重建搜索索引。稿件文件不受影响，但耗时取决于作品规模。',
        confirmText: '开始重建',
        danger: false,
      });
      if (!ok) return;
      try {
        await ctx.actions.rebuildIndex();
        toast(ctx, '重建索引已开始', 'info');
        void ctx.actions.refreshJobs().catch(() => {});
      } catch (e) {
        toast(ctx, `重建失败：${errText(e)}`, 'error');
      }
    }

    async function loadJobs(): Promise<void> {
      try {
        jobs = await ctx.api.listJobs();
        jobsError = null;
      } catch (e) {
        jobsError = e;
      }
      if (!destroyed) render();
    }

    /**
     * 作品元信息由外壳负责加载，但设置面板大量依赖它（字数口径、每日目标、排版预设）。
     * 若外壳尚未填充（例如直接打开设置面板的时序差异），这里自行补拉一次，避免出现
     * 「尚未打开作品」的假空态。
     */
    async function ensureProject(): Promise<void> {
      if (ctx.store.state.project) return;
      try {
        const project = await ctx.api.getProject();
        if (destroyed) return;
        ctx.store.set({ project });
        render();
      } catch {
        /* 失败时保持提示态，由用户手动重试 */
      }
    }

    // 初始化
    render();
    void ensureProject();
    void loadBackups();
    void loadJobs();

    return {
      update(state: AppState, changed: Set<keyof AppState>): void {
        // 设置项里正在拖滑块/输入时不要整体重绘，否则会打断交互
        const active = document.activeElement;
        const interacting =
          !!active &&
          (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA');
        if (interacting) return;

        if (changed.has('jobs')) {
          jobs = state.jobs.length ? state.jobs : jobs;
          render();
          return;
        }
        if (
          changed.has('settings') ||
          changed.has('project') ||
          changed.has('trash') ||
          changed.has('nodes')
        ) {
          render();
        }
      },
      destroy(): void {
        destroyed = true;
        container.textContent = '';
      },
    };
  },
};
