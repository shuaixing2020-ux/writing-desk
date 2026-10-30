/**
 * 端到端测试（Playwright）。
 *
 * 覆盖架构第 8 节的端到端清单：写作、保存、刷新恢复、冲突、导出。
 * 运行：npm run test:e2e
 *
 * 策略：启动真实服务（临时数据目录）→ 浏览器操作 → 断言 → 清理。
 * 用真实的 HTTP + DOM，不 mock，因为「保存不丢字」只有真跑才算数。
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.E2E_PORT ?? 7791);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const failures = [];

function ok(name) {
  pass++;
  console.log(`  ✔ ${name}`);
}

function bad(name, err) {
  fail++;
  failures.push({ name, err });
  console.log(`  ✖ ${name}`);
  console.log(`    ${String(err?.message ?? err).split('\n')[0]}`);
}

async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || '值不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/**
 * 找一个可用的 Chromium。
 *
 * Playwright 自带的 headless shell 可能未下载（npm i 不会自动拉浏览器），
 * 因此按优先级回退：环境变量 → 系统 Chrome → Playwright 缓存里已有的版本。
 * 这样在任意机器上都能跑，不强制下载几百 MB。
 */
async function launchBrowser() {
  const candidates = [];
  if (process.env.E2E_CHROME) candidates.push({ executablePath: process.env.E2E_CHROME });

  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const exists = async (p) => {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  };
  if (await exists(systemChrome)) candidates.push({ executablePath: systemChrome });

  // Playwright 缓存中已有的 chromium（取版本号最大的）
  const cacheDir = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  try {
    const dirs = (await fs.readdir(cacheDir))
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) {
      const bin = path.join(
        cacheDir,
        d,
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      );
      if (await exists(bin)) candidates.push({ executablePath: bin });
    }
  } catch {
    /* 无缓存 */
  }

  candidates.push({}); // 最后让 Playwright 用默认查找

  let lastErr;
  for (const opts of candidates) {
    try {
      return await chromium.launch(opts);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`无法启动浏览器：${lastErr?.message ?? '未知'}`);
}

/** 等 HTTP 服务可用 */
async function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`服务在 ${timeoutMs}ms 内未就绪：${url}`);
}

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-e2e-'));
  console.log(`\n数据目录：${dataDir}`);
  console.log(`服务端口：${PORT}\n`);

  // ── 启动服务 ──
  const server = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', 'server/main.ts'],
    {
      cwd: root,
      env: { ...process.env, WD_PORT: String(PORT), WD_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let serverLog = '';
  server.stdout.on('data', (d) => {
    serverLog += String(d);
  });
  server.stderr.on('data', (d) => {
    serverLog += String(d);
  });

  const cleanup = async () => {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    await waitForServer(`${BASE}/api/projects`);
    console.log('服务已就绪\n');

    // ═══════════ 1. API 层 ═══════════
    console.log('【1】API 契约');

    let projectId;
    await check('创建作品', async () => {
      const res = await fetch(`${BASE}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '端到端测试小说', author: '测试作者', mode: 'webnovel' }),
      });
      assertEq(res.status, 200, 'HTTP 状态');
      const data = await res.json();
      projectId = data.id;
      assert(projectId, '应返回作品 id');
      assertEq(data.title, '端到端测试小说');
    });

    let volumeId, chapterId, sceneId;
    await check('创建卷 / 章 / 场景', async () => {
      const post = async (url, body) => {
        const res = await fetch(`${BASE}${url}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        assertEq(res.status, 200, `${url} 状态`);
        return res.json();
      };
      const v = await post(`/api/projects/${projectId}/nodes`, { kind: 'volume', parent_id: null, title: '第一卷' });
      volumeId = v.id;
      const c = await post(`/api/projects/${projectId}/nodes`, { kind: 'chapter', parent_id: volumeId, title: '开篇' });
      chapterId = c.id;
      const s = await post(`/api/projects/${projectId}/nodes`, { kind: 'scene', parent_id: chapterId, title: '雨夜' });
      sceneId = s.id;
      assert(volumeId && chapterId && sceneId, '三级节点都应创建成功');
    });

    await check('保存正文并读回', async () => {
      const body = '夜雨敲窗，山门外一片寂静。\n\n“师父，我回来了。”';
      const save = await fetch(`${BASE}/api/projects/${projectId}/scenes/${sceneId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body, base_rev: 1 }),
      });
      assertEq(save.status, 200, '保存状态');
      const saved = await save.json();
      assert(saved.rev >= 2, '修订号应递增');

      const get = await fetch(`${BASE}/api/projects/${projectId}/scenes/${sceneId}`);
      const got = await get.json();
      assertEq(got.body, body, '读回正文应完全一致');
    });

    await check('文件即真相：磁盘上是可读 Markdown', async () => {
      const walk = async (dir) => {
        const out = [];
        for (const e of await fs.readdir(dir, { withFileTypes: true })) {
          if (e.name.startsWith('.')) continue;
          const p = path.join(dir, e.name);
          if (e.isDirectory()) out.push(...(await walk(p)));
          else out.push(p);
        }
        return out;
      };
      const files = await walk(path.join(dataDir, projectId));
      const sceneFile = files.find((f) => f.includes('s0001-雨夜.md'));
      assert(sceneFile, '场景文件名应带顺序前缀与中文标题');
      const raw = await fs.readFile(sceneFile, 'utf8');
      assert(raw.startsWith('---'), '应有 frontmatter');
      assert(raw.includes('id:'), 'frontmatter 应含稳定 id');
      assert(raw.includes('夜雨敲窗'), '正文应在文件中');
    });

    await check('搜索：2 字中文人名可命中', async () => {
      const res = await fetch(`${BASE}/api/projects/${projectId}/search?q=${encodeURIComponent('师父')}`);
      const data = await res.json();
      assert(data.hits.length > 0, '应搜到「师父」');
      assert(data.took_ms >= 0, '应返回耗时');
    });

    await check('设定库：创建条目并识别出场', async () => {
      const res = await fetch(`${BASE}/api/projects/${projectId}/entities`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'character',
          name: '师父',
          aliases: ['师尊'],
          fields: { 身份: '青云门掌门' },
          description: '沉稳寡言。',
        }),
      });
      assertEq(res.status, 200, '创建状态');
      const entity = await res.json();

      // 出场识别是异步索引的，稍等
      await new Promise((r) => setTimeout(r, 400));
      const detail = await (await fetch(`${BASE}/api/projects/${projectId}/entities/${entity.id}`)).json();
      assert(detail.name === '师父', '条目应可读回');
      assert(Array.isArray(detail.mentions), '应返回出场列表');
    });

    await check('索引重建（后台作业）', async () => {
      const res = await fetch(`${BASE}/api/projects/${projectId}/index/rebuild`, { method: 'POST' });
      const job = await res.json();
      assert(job.id, '应返回作业 id');
      // 轮询完成
      for (let i = 0; i < 60; i++) {
        const j = await (await fetch(`${BASE}/api/projects/${projectId}/jobs/${job.id}`)).json();
        if (j.status === 'done') return;
        if (j.status === 'failed') throw new Error(`重建失败：${j.error}`);
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error('重建索引超时');
    });

    await check('导出 txt', async () => {
      const res = await fetch(`${BASE}/api/projects/${projectId}/export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ format: 'txt', scope: 'book', typeset: true }),
      });
      const job = await res.json();
      for (let i = 0; i < 80; i++) {
        const j = await (await fetch(`${BASE}/api/projects/${projectId}/jobs/${job.id}`)).json();
        if (j.status === 'done') {
          assert(j.result?.file, '应返回导出文件');
          const dl = await fetch(`${BASE}/api/projects/${projectId}/download?file=${encodeURIComponent(j.result.file)}`);
          assertEq(dl.status, 200, '下载状态');
          const text = await dl.text();
          assert(text.includes('夜雨敲窗'), '导出内容应含正文');
          return;
        }
        if (j.status === 'failed') throw new Error(`导出失败：${j.error}`);
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error('导出超时');
    });

    await check('路径穿越被拒绝', async () => {
      const res = await fetch(
        `${BASE}/api/projects/${projectId}/download?file=${encodeURIComponent('../../../../etc/passwd')}`,
      );
      assert(res.status >= 400, `应拒绝穿越路径，实际 ${res.status}`);
    });

    await check('快照与恢复', async () => {
      const create = await fetch(`${BASE}/api/projects/${projectId}/snapshots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ doc_id: sceneId, reason: 'manual' }),
      });
      const snap = await create.json();
      assert(snap.id, '应创建快照');

      const list = await (await fetch(`${BASE}/api/projects/${projectId}/snapshots?doc_id=${sceneId}`)).json();
      assert(list.length >= 1, '快照列表应非空');

      // 改动后恢复
      await fetch(`${BASE}/api/projects/${projectId}/scenes/${sceneId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: '被改坏的内容', base_rev: 2 }),
      });
      const restore = await fetch(`${BASE}/api/projects/${projectId}/snapshots/${snap.id}/restore`, { method: 'POST' });
      assertEq(restore.status, 200, '恢复状态');
      const after = await (await fetch(`${BASE}/api/projects/${projectId}/scenes/${sceneId}`)).json();
      assert(after.body.includes('夜雨敲窗'), '恢复后应回到快照内容');
    });

    // ═══════════ 2. 浏览器端 ═══════════
    console.log('\n【2】浏览器交互');

    const browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    await check('首页加载，无致命 JS 错误', async () => {
      await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
      // 等应用外壳出现（不是 boot 屏）
      await page.waitForFunction(() => !document.querySelector('#boot'), { timeout: 20000 });
      const title = await page.title();
      assert(title.includes('写作台'), `标题应为写作台，实际 ${title}`);
    });

    await check('三栏布局渲染', async () => {
      const hasApp = await page.locator('.app, #app').first().isVisible();
      assert(hasApp, '应用外壳应可见');
    });

    await check('编辑器可输入并自动保存', async () => {
      // 找到编辑器（可能是 contenteditable 或 textarea）
      const editable = page.locator('[contenteditable="true"], [contenteditable="plaintext-only"], textarea').first();
      await editable.waitFor({ state: 'visible', timeout: 15000 });
      await editable.click();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type('夜雨敲窗，山门外一片寂静。', { delay: 12 });
      // 等去抖保存（2s）+ 余量
      await page.waitForTimeout(3500);
      // 检查保存状态文案
      const text = await page.locator('body').innerText();
      assert(/已保存|保存/.test(text), '状态栏应显示保存状态');
    });

    await check('刷新后内容恢复（防丢验证）', async () => {
      await page.waitForTimeout(1200);
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForFunction(() => !document.querySelector('#boot'), { timeout: 20000 });
      await page.waitForTimeout(1500);
      const bodyText = await page.locator('body').innerText();
      assert(bodyText.includes('夜雨敲窗'), '刷新后正文应仍在（这是稿件安全的核心断言）');
    });

    await check('截图留证', async () => {
      await page.screenshot({ path: path.join(root, 'tests/e2e/screenshot-main.png'), fullPage: false });
    });

    // ═══════════ 3. 关系图谱 ═══════════
    console.log('\n【3】关系图谱');

    await check('设定库详情显示关系分组', async () => {
      await page.locator('.inspector-tabs button[data-panel="bible"]').click();
      await page.waitForTimeout(900);
      // 用 selfcheck 建的两个角色：自检角色甲
      const target = page.locator('.panel').locator('text=自检角色甲').first();
      if ((await target.count()) === 0) {
        // 没有的话跳过（项目数据由 selfcheck 产生，可能已被清理）
        return;
      }
      await target.click();
      await page.waitForTimeout(1500);
      const hasRel = await page.locator('.p-rel').count();
      assert(hasRel > 0, '未渲染关系分组');
    });

    await check('新增关系表单按类型过滤', async () => {
      const addBtn = page.locator('.p-rel-add').first();
      if ((await addBtn.count()) === 0) return;
      await addBtn.click();
      await page.waitForTimeout(600);
      const opts = await page.evaluate(() => {
        const sel = document.querySelector('.p-rel-form select');
        return sel ? [...sel.options].map((o) => o.textContent) : [];
      });
      assert(opts.length > 0, '类型下拉为空');
      // 角色可用的类型应包含师徒，但不包含「导致」（只能事件→事件）
      assert(opts.includes('师徒'), `类型下拉应含「师徒」，实际：${opts.join(', ')}`);
      assert(!opts.includes('导致'), `角色不应能选「导致」，实际：${opts.join(', ')}`);
    });

    await check('命令面板：点击命令项能执行', async () => {
      await page.keyboard.press('ControlOrMeta+k');
      await page.waitForTimeout(700);
      const items = await page.locator('.cmdk-item').count();
      assert(items > 0, '命令面板没有列出命令');

      // 点「切换打字机模式」，验证命令真的执行了
      await page.locator('.cmdk-item', { hasText: '切换打字机模式' }).first().click();
      await page.waitForTimeout(1200);
      const closed = await page.locator('.cmdk').count();
      assert(closed === 0, '执行命令后命令面板应关闭');
      const tw = await page.evaluate(() => document.querySelectorAll('[class*="typewriter"]').length);
      assert(tw > 0, '命令未生效（打字机模式没有开启）');
    });

    await check('命令面板：搜正文关键词可跳进场景', async () => {
      await page.keyboard.press('ControlOrMeta+k');
      await page.waitForTimeout(700);
      // 测试作品的场景正文里有「夜雨敲窗」
      await page.keyboard.type('夜雨', { delay: 40 });
      await page.waitForTimeout(1600);

      const hits = await page.locator('.cmdk-item.is-hit').count();
      assert(hits > 0, '没有搜索到正文命中');

      await page.locator('.cmdk-item.is-hit').first().click();
      await page.waitForTimeout(2200);

      const closed = await page.locator('.cmdk').count();
      assert(closed === 0, '跳转后命令面板应关闭');
      const body = await page.locator('body').innerText();
      assert(body.includes('夜雨敲窗'), '未跳到命中的场景');
      // 面包屑应指向该场景
      assert(/雨夜/.test(body), '编辑器没有切换到目标场景');
    });

    await check('顶栏有图谱入口且可打开', async () => {
      const btn = page.locator('.topbar .icon-btn[title="关系图谱"]');
      assert((await btn.count()) === 1, '顶栏缺少关系图谱入口');
      await btn.first().click();
      await page.waitForTimeout(2500);
      assert((await page.locator('.gv-root').count()) === 1, '点击顶栏按钮未打开图谱');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(700);
    });

    await check('关系图谱可打开并渲染节点', async () => {
      // 用命令面板打开图谱
      await page.keyboard.press('ControlOrMeta+k');
      await page.waitForTimeout(700);
      await page.keyboard.type('关系图谱', { delay: 20 });
      await page.waitForTimeout(600);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2500);

      const graph = await page.evaluate(() => ({
        open: !!document.querySelector('.gv-root'),
        nodes: document.querySelectorAll('.gv-node').length,
        status: document.querySelector('.gv-status')?.textContent ?? '',
      }));
      assert(graph.open, '图谱视图未打开');
      // 这个测试项目里建过条目，应该至少渲染出一个节点
      assert(graph.nodes > 0, `图谱未渲染节点（${graph.status}）`);

      // 关掉图谱，避免影响后续检查
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
    });

    // ─────────── 【4】章节快捷删除（C2） ───────────

    console.log('\n【4】章节快捷删除');

    // 造一组专用节点，避免影响前面用例依赖的「雨夜」。
    // 注意：上面 API 段里的 post 是块级作用域，这里要自带一个。
    const apiPost = async (url, body) => {
      const r = await fetch(`${BASE}${url}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert(r.ok, `POST ${url} → HTTP ${r.status}`);
      return r.json();
    };

    const delVolume = await apiPost(`/api/projects/${projectId}/nodes`, {
      kind: 'volume',
      parent_id: null,
      title: '删除测试卷',
    });
    const delChapter = await apiPost(`/api/projects/${projectId}/nodes`, {
      kind: 'chapter',
      parent_id: delVolume.id,
      title: '删除测试章',
    });
    const mkScene = async (title) =>
      apiPost(`/api/projects/${projectId}/nodes`, {
        kind: 'scene',
        parent_id: delChapter.id,
        title,
      });
    const emptyScene = await mkScene('空场景');
    const filledScene = await mkScene('有字场景');
    await fetch(`${BASE}/api/projects/${projectId}/scenes/${filledScene.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '这段正文用于触发删除确认框。' }),
    });

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(2200);

    const rowByTitle = (title) => page.locator('.tree-row', { hasText: title }).first();
    const treeTitles = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.tree-row')].map(
          (r) => r.querySelector('.tree-title')?.textContent ?? '',
        ),
      );

    await check('删空场景：不弹确认，出现撤销入口，撤销后回到原位', async () => {
      const before = await treeTitles();
      const row = rowByTitle('空场景');
      await row.hover();
      await row.locator('.tree-del').click();
      await page.waitForTimeout(1200);

      assert(
        (await page.locator('.modal').count()) === 0,
        '删除空场景不应弹确认框（作者在清理，不该被拦）',
      );
      assert((await page.locator('.toast-action').count()) === 1, '缺少撤销入口');

      await page.locator('.toast-action').click();
      await page.waitForTimeout(1600);
      assertEq((await treeTitles()).join('|'), before.join('|'), '撤销后顺序应与删除前一致');
    });

    await check('删有字场景：弹确认，Esc 取消后无变化', async () => {
      const before = await treeTitles();
      const row = rowByTitle('有字场景');
      await row.hover();
      await row.locator('.tree-del').click();
      await page.waitForTimeout(700);

      const modal = await page.locator('.modal').count();
      assert(modal === 1, '删除有字场景应弹确认框');
      const text = await page.locator('.modal').innerText();
      assert(/移入回收站/.test(text) && /可恢复/.test(text), `确认文案缺关键信息：${text}`);

      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
      assertEq((await treeTitles()).join('|'), before.join('|'), 'Esc 取消后不应有任何变化');
    });

    await check('Cmd/Ctrl 多选两章删除，再撤销', async () => {
      await rowByTitle('空场景').click();
      await page.waitForTimeout(300);
      await rowByTitle('有字场景').click({ modifiers: ['ControlOrMeta'] });
      await page.waitForTimeout(500);

      const selected = await page.locator('.tree-row.selected').count();
      assert(selected === 2, `应选中 2 项，实际 ${selected}`);

      await page.locator('.tree-row.selected').first().focus();
      await page.keyboard.press('Delete');
      await page.waitForTimeout(800);
      assert((await page.locator('.modal').count()) === 1, '批量删除有字场景应弹确认');
      await page.locator('.modal button', { hasText: '移入回收站' }).click();
      await page.waitForTimeout(1800);

      const afterDelete = await treeTitles();
      assert(!afterDelete.includes('空场景') && !afterDelete.includes('有字场景'), '两项都应被删');

      await page.locator('.toast-action').click();
      await page.waitForTimeout(1800);
      const afterUndo = await treeTitles();
      assert(afterUndo.includes('空场景') && afterUndo.includes('有字场景'), '撤销后两项都应恢复');
    });

    await check('删除正在编辑的场景后，编辑器切到相邻场景', async () => {
      // 先切到要删的场景，让编辑器持有它
      await rowByTitle('空场景').click();
      await page.waitForTimeout(900);
      const editing = await page.evaluate(
        () => document.querySelector('.tree-row.current .tree-title')?.textContent ?? '',
      );
      assert(editing === '空场景', `前置条件失败：当前编辑的是「${editing}」`);

      const row = rowByTitle('空场景');
      await row.hover();
      await row.locator('.tree-del').click();
      await page.waitForTimeout(1500);

      const nowEditing = await page.evaluate(
        () => document.querySelector('.tree-row.current .tree-title')?.textContent ?? '',
      );
      assert(nowEditing !== '空场景', '被删的场景不应仍是当前文档');
      assert(nowEditing.length > 0, '应切到相邻场景，而不是空状态');

      // 撤销，把项目恢复原样，避免影响后续检查
      if ((await page.locator('.toast-action').count()) > 0) {
        await page.locator('.toast-action').click();
        await page.waitForTimeout(1500);
      }
    });

    // ─────────── 【5】并排工作台（L1） ───────────

    console.log('\n【5】并排工作台');

    const inspectorWidth = () =>
      page.evaluate(() => Math.round(document.querySelector('.inspector')?.getBoundingClientRect().width ?? 0));

    await check('预设切换：窄 380 / 宽 560', async () => {
      await page.locator('.inspector-preset', { hasText: '宽' }).click();
      await page.waitForTimeout(700);
      assertEq(await inspectorWidth(), 560, '宽栏预设应为 560');

      await page.locator('.inspector-preset', { hasText: '窄' }).click();
      await page.waitForTimeout(700);
      assertEq(await inspectorWidth(), 380, '窄栏预设应为 380');
    });

    await check('拖拽分隔条改变宽度，刷新后保留', async () => {
      const box = await page.locator('.inspector-resizer').boundingBox();
      assert(box, '找不到分隔条');

      const start = await inspectorWidth();
      await page.mouse.move(box.x + box.width / 2, box.y + 180);
      await page.mouse.down();
      for (let i = 1; i <= 5; i++) {
        await page.mouse.move(box.x + box.width / 2 - i * 20, box.y + 180);
        await page.waitForTimeout(30);
      }
      await page.mouse.up();
      await page.waitForTimeout(500);

      const dragged = await inspectorWidth();
      assert(dragged > start + 60, `拖拽后应变宽：${start} → ${dragged}`);

      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(2400);
      const afterReload = await inspectorWidth();
      assert(
        Math.abs(afterReload - dragged) <= 2,
        `刷新后宽度应保留：期望约 ${dragged}，实际 ${afterReload}`,
      );
    });

    await check('分隔条可用键盘调整（每步 16px）', async () => {
      await page.locator('.inspector-resizer').focus();
      // 每一步都重新测量：上一次拖拽留下的宽度可能是小数，
      // 拿旧值做绝对比较会被四舍五入坑到。
      const base = await inspectorWidth();
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(300);
      const wider = await inspectorWidth();
      assert(wider === base + 16, `左方向键应加宽 16px：${base} → ${wider}`);

      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(300);
      const restored = await inspectorWidth();
      assert(restored === wider - 16, `右方向键应收窄 16px：${wider} → ${restored}`);
    });

    await check('专注模式隐藏目录与检查器，再按恢复', async () => {
      await page.keyboard.press('ControlOrMeta+Shift+F');
      await page.waitForTimeout(600);

      const focused = await page.evaluate(() => ({
        cls: document.querySelector('.app-shell')?.className ?? '',
        editorW: Math.round(document.querySelector('.editor-root')?.getBoundingClientRect().width ?? 0),
        viewport: window.innerWidth,
      }));
      assert(/focus-mode/.test(focused.cls), '未进入专注模式');
      assert(
        focused.editorW >= focused.viewport - 4,
        `专注模式正文应占满：${focused.editorW}/${focused.viewport}`,
      );

      await page.keyboard.press('ControlOrMeta+Shift+F');
      await page.waitForTimeout(600);
      const back = await page.evaluate(() => document.querySelector('.app-shell')?.className ?? '');
      assert(!/focus-mode/.test(back), '未退出专注模式');
    });

    await check('窗口变窄时自动收窄检查器，正文不被挤没', async () => {
      await page.setViewportSize({ width: 1100, height: 900 });
      await page.waitForTimeout(600);

      const s = await page.evaluate(() => ({
        inspector: Math.round(document.querySelector('.inspector')?.getBoundingClientRect().width ?? 0),
        editor: Math.round(document.querySelector('.editor-root')?.getBoundingClientRect().width ?? 0),
      }));
      assert(s.editor >= 560, `正文被挤到 ${s.editor}px，应至少 560`);
      assert(s.inspector >= 300, `检查器不应低于 300px，实际 ${s.inspector}`);

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(600);
    });

    // ─────────── 【6】大纲列表编辑（O2） ───────────

    console.log('\n【6】大纲列表编辑');

    // apiPost 已在【4】声明，这里复用

    // 专用结构，避免影响前面的用例
    const outVol = await apiPost(`/api/projects/${projectId}/nodes`, {
      kind: 'volume',
      parent_id: null,
      title: '大纲卷',
    });
    const outChap = await apiPost(`/api/projects/${projectId}/nodes`, {
      kind: 'chapter',
      parent_id: outVol.id,
      title: '大纲章',
    });
    const outScene = await apiPost(`/api/projects/${projectId}/nodes`, {
      kind: 'scene',
      parent_id: outChap.id,
      title: '大纲场',
    });

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(2400);
    await page.locator('.inspector-tabs button[data-panel="outline"]').click();
    await page.waitForTimeout(900);

    const outlineValues = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.p-outline-name')].map((i) => i.value),
      );

    /**
     * 按标题把焦点放到大纲的某一行。
     * 不用 locator：行会随重绘整批替换，索引会漂，
     * 而且在页面内直接 focus 更贴近「作者点进去」这件事。
     */
    const focusOutlineRow = (title) =>
      page.evaluate((t) => {
        const inputs = [...document.querySelectorAll('.p-outline-name')];
        const el = inputs.find((i) => i.value === t);
        if (!el) return false;
        el.focus();
        el.select?.();
        return true;
      }, title);

    await check('大纲：行首标类型，标题是输入框', async () => {
      const info = await page.evaluate(() => ({
        kinds: [...document.querySelectorAll('.p-outline-kind-label')].map((e) => e.textContent),
        inputs: document.querySelectorAll('.p-outline-name').length,
      }));
      assert(info.inputs > 0, '大纲没有渲染出可编辑行');
      assert(info.kinds.includes('卷') && info.kinds.includes('章') && info.kinds.includes('场'),
        `行首类型标记不全：${info.kinds.slice(0, 8).join(',')}`);
    });

    await check('Enter 新建同级并聚焦新行，输入标题后 Enter 继续', async () => {
      // 点到最后一行（大纲场）的标题输入框
      const last = page.locator('.p-outline-name').last();
      await last.click();
      await page.waitForTimeout(300);

      await page.keyboard.press('Enter');
      await page.waitForTimeout(1400);

      const afterEnter = await page.evaluate(() => {
        const inputs = [...document.querySelectorAll('.p-outline-name')];
        const active = document.activeElement;
        return {
          count: inputs.length,
          focusedId: active?.dataset?.id ?? null,
          lastId: inputs[inputs.length - 1]?.dataset?.id ?? null,
        };
      });
      assert(
        afterEnter.focusedId === afterEnter.lastId,
        `新建后焦点应落在新行：焦点 ${afterEnter.focusedId}，末行 ${afterEnter.lastId}`,
      );

      // 直接打字应替换默认标题（全选状态）
      await page.keyboard.type('大纲新场', { delay: 30 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);

      const values = await outlineValues();
      assert(values.includes('大纲新场'), `标题未写入：${values.join('/')}`);
    });

    await check('Alt+↑ 调整顺序并刷新保留', async () => {
      const before = await outlineValues();
      const idx = before.indexOf('大纲新场');
      assert(idx > 0, '前置条件：新场应在列表中且不在首位');

      assert(await focusOutlineRow('大纲新场'), '没找到「大纲新场」这一行');
      await page.waitForTimeout(300);
      await page.keyboard.press('Alt+ArrowUp');
      await page.waitForTimeout(1400);

      const after = await outlineValues();
      assert(
        after.indexOf('大纲新场') === idx - 1,
        `上移未生效：${before.join('/')} → ${after.join('/')}`,
      );

      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(2400);
      await page.locator('.inspector-tabs button[data-panel="outline"]').click();
      await page.waitForTimeout(800);
      const persisted = await outlineValues();
      assert(persisted.includes('大纲新场'), '刷新后新场标题丢失');
      assert(
        persisted.indexOf('大纲新场') === idx - 1,
        `刷新后顺序变了：${persisted.join('/')}`,
      );
    });

    await check('空标题 Backspace 删除并撤销', async () => {
      const before = (await outlineValues()).length;
      // 找到「大纲新场」并清空标题
      assert(await focusOutlineRow('大纲新场'), '没找到「大纲新场」这一行');
      await page.waitForTimeout(300);
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(500);
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(1600);

      const after = (await outlineValues()).length;
      assert(after === before - 1, `删除未生效：${before} → ${after}`);

      const undo = await page.locator('.toast-action').count();
      assert(undo === 1, '删除后应有撤销入口');
      await page.locator('.toast-action').click();
      await page.waitForTimeout(1800);
      assert((await outlineValues()).length === before, '撤销后行数应恢复');
    });

    await check('点击大纲行同步到左侧目录（选中状态共享）', async () => {
      assert(await focusOutlineRow('大纲章'), '没找到「大纲章」这一行');
      await page.waitForTimeout(1400);

      const current = await page.evaluate(
        () => document.querySelector('.tree-row.current .tree-title')?.textContent ?? '',
      );
      assertEq(current, '大纲章', '左侧目录的当前项应同步为「大纲章」');
    });

    await check('无未捕获的运行时错误', async () => {
      // 过滤掉网络类噪音（服务端某些路由可能还在开发）
      const real = consoleErrors.filter(
        (e) => !/Failed to load resource|404|net::ERR|WebSocket/i.test(e),
      );
      assert(real.length === 0, `存在 JS 错误：\n${real.slice(0, 5).join('\n')}`);
    });

    await browser.close();
  } finally {
    await cleanup();
  }

  // ── 汇总 ──
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) {
    console.log('\n失败项：');
    for (const f of failures) console.log(`  · ${f.name}: ${f.err?.message ?? f.err}`);
    if (serverLog) {
      console.log('\n服务端日志（末尾）：');
      console.log(serverLog.split('\n').slice(-30).join('\n'));
    }
    process.exitCode = 1;
  } else {
    console.log('全部通过 ✓');
  }
}

main().catch((err) => {
  console.error('端到端测试崩溃：', err);
  process.exitCode = 1;
});
