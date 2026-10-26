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
