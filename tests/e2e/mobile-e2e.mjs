/**
 * 移动端端到端测试。
 *
 * 覆盖：多设备视口布局、抽屉开合、底部导航、触摸目标尺寸、
 *       手机上实际写作与自动保存、横向溢出。
 *
 * 运行：node tests/e2e/mobile-e2e.mjs
 * 前置：服务已在 7788 运行（npm run serve）。
 */

import { chromium } from 'playwright';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:7788';
let pass = 0, fail = 0;
const failures = [];

const green = s => `\x1b[32m${s}\x1b[0m`;
const red = s => `\x1b[31m${s}\x1b[0m`;

async function check(name, fn) {
  try { await fn(); pass++; console.log(`  ${green('✔')} ${name}`); }
  catch (e) { fail++; failures.push({ name, e }); console.log(`  ${red('✖')} ${name}\n     ${String(e.message).split('\n')[0]}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m || '断言失败'); };

async function launch() {
  const candidates = [
    { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    {},
  ];
  let last;
  for (const o of candidates) {
    try { return await chromium.launch(o); } catch (e) { last = e; }
  }
  throw last;
}

const DEVICES = [
  { name: 'iPhone SE',         w: 375,  h: 667,  mobile: true },
  { name: 'iPhone 14 Pro',     w: 393,  h: 852,  mobile: true },
  { name: 'iPhone 14 Pro Max', w: 430,  h: 932,  mobile: true },
  { name: 'Pixel 7',           w: 412,  h: 915,  mobile: true },
  { name: 'iPad Mini',         w: 744,  h: 1133, mobile: true },
  { name: 'iPad Air',          w: 820,  h: 1180, mobile: true },
  { name: 'Laptop',            w: 1280, h: 800,  mobile: false },
];

const browser = await launch();
console.log(`\n写作台 · 移动端端到端\n${'─'.repeat(52)}`);

// ═══════════ 1. 布局 ═══════════
console.log('\n【1】多设备布局');

for (const d of DEVICES) {
  await check(`${d.name} (${d.w}×${d.h})`, async () => {
    const ctx = await browser.newContext({
      viewport: { width: d.w, height: d.h },
      deviceScaleFactor: d.mobile ? 3 : 1,
      isMobile: d.mobile,
      hasTouch: d.mobile,
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1800);

    const r = await page.evaluate(() => {
      const nav = document.querySelector('.mobile-nav');
      const ed = document.querySelector('[contenteditable]');
      const smallTargets = [...document.querySelectorAll('button')].filter(b => {
        const rect = b.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.height < 32;
      }).length;
      return {
        hOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        navVisible: nav ? getComputedStyle(nav).display !== 'none' : false,
        navBtns: nav ? nav.querySelectorAll('.mobile-nav-btn').length : 0,
        editorW: ed ? Math.round(ed.getBoundingClientRect().width) : 0,
        smallTargets,
      };
    });

    assert(!r.hOverflow, `存在横向溢出`);
    assert(r.editorW > 0, '编辑器不可见');
    // 手机/平板上编辑器应占满大部分宽度。
    // 桌面端不适用：桌面是「三栏 + 版心限宽」，正文宽度由 --editor-measure
    // 刻意限制在 34em（中文长行阅读会串行），不能按视口比例断言。
    if (d.w <= 960) {
      assert(r.editorW > d.w * 0.75, `编辑器过窄：${r.editorW}px / ${d.w}px`);
    } else {
      assert(r.editorW >= 380, `桌面版心过窄：${r.editorW}px`);
    }

    if (d.w <= 960) {
      assert(r.navVisible, '移动端应显示底部导航');
      assert(r.navBtns === 5, `底部导航应有 5 项，实际 ${r.navBtns}`);
    } else {
      assert(!r.navVisible, '桌面端不应显示底部导航');
    }
    // 触摸目标尺寸只对触摸设备有意义；桌面用鼠标，小按钮是合理的信息密度
    if (d.mobile) {
      assert(r.smallTargets <= 2, `触摸目标过小：${r.smallTargets} 个`);
    }
    assert(errs.length === 0, `JS 错误：${errs[0]}`);
    await ctx.close();
  });
}

// ═══════════ 2. 抽屉交互 ═══════════
console.log('\n【2】抽屉交互');

const ctx = await browser.newContext({
  viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
});
const page = await ctx.newPage();
const pageErrs = [];
page.on('pageerror', e => pageErrs.push(String(e)));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

const drawerState = () => page.evaluate(() => {
  const sh = document.querySelector('.app-shell');
  return {
    open: sh.classList.contains('mobile-drawer-open'),
    which: sh.classList.contains('mobile-drawer-sidebar') ? 'sidebar'
         : sh.classList.contains('mobile-drawer-inspector') ? 'inspector' : 'none',
    bodyLocked: document.body.style.overflow === 'hidden',
  };
});

await check('初始状态无抽屉', async () => {
  const s = await drawerState();
  assert(!s.open && s.which === 'none', JSON.stringify(s));
});

await check('点「稿件」打开左抽屉并锁定背景滚动', async () => {
  await page.locator('.mobile-nav-btn[data-nav="outline"]').click();
  await page.waitForTimeout(450);
  const s = await drawerState();
  assert(s.open && s.which === 'sidebar', JSON.stringify(s));
  assert(s.bodyLocked, '背景应禁止滚动');
});

await check('点遮罩关闭抽屉', async () => {
  await page.locator('.drawer-scrim').click({ position: { x: 370, y: 300 } });
  await page.waitForTimeout(450);
  const s = await drawerState();
  assert(!s.open, '抽屉应关闭');
  assert(!s.bodyLocked, '应恢复背景滚动');
});

await check('点「面板」打开右抽屉', async () => {
  await page.locator('.mobile-nav-btn[data-nav="panel"]').click();
  await page.waitForTimeout(500);
  const s = await drawerState();
  assert(s.open && s.which === 'inspector', JSON.stringify(s));
});

await check('抽屉打开时底部导航仍可点（不被遮罩拦截）', async () => {
  await page.locator('.mobile-nav-btn[data-nav="outline"]').click({ timeout: 4000 });
  await page.waitForTimeout(500);
  const s = await drawerState();
  assert(s.open && s.which === 'sidebar', `应切到左抽屉，实际 ${JSON.stringify(s)}`);
});

await check('选择文档后自动收起抽屉', async () => {
  // 抽屉展开动画 320ms，等它稳定后再点，否则会被判定为 unstable
  await page.waitForTimeout(600);
  const scene = page.locator('.sidebar .tree-row').filter({ hasText: '雨夜来客' }).first();
  await scene.waitFor({ state: 'visible', timeout: 8000 });
  await scene.click({ timeout: 8000 });
  await page.waitForTimeout(1400);
  const s = await drawerState();
  assert(!s.open, `选中文档后应自动收起抽屉，实际 ${JSON.stringify(s)}`);
});

// ═══════════ 3. 手机写作 ═══════════
console.log('\n【3】手机写作与保存');

await check('正文可见', async () => {
  const text = await page.locator('body').innerText();
  assert(text.includes('夜雨敲窗'), '正文未显示');
});

await check('输入并自动保存', async () => {
  // 兜底：若抽屉意外还开着，先关掉，否则侧栏会挡住编辑器
  if ((await drawerState()).open) {
    await page.locator('.drawer-scrim').click({ position: { x: 370, y: 300 } }).catch(() => {});
    await page.waitForTimeout(500);
  }
  const ed = page.locator('[contenteditable]').first();
  await ed.waitFor({ state: 'visible', timeout: 8000 });
  await ed.click({ timeout: 8000 });
  await page.keyboard.press('ControlOrMeta+End');
  const mark = `移动端测试-${Date.now()}`;
  await page.keyboard.type(` ${mark}`, { delay: 12 });
  await page.waitForTimeout(3500);

  // 从 API 校验落盘
  const projects = await (await fetch(`${BASE}/api/projects`)).json();
  const pid = projects[0].id;
  const tree = await (await fetch(`${BASE}/api/projects/${encodeURIComponent(pid)}/tree`)).json();
  const scene = tree.nodes.find(n => n.title === '雨夜来客');
  const content = await (await fetch(`${BASE}/api/projects/${encodeURIComponent(pid)}/scenes/${scene.id}`)).json();
  assert(content.body.includes(mark), '内容未落盘');
});

await check('刷新后内容仍在', async () => {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const text = await page.locator('body').innerText();
  assert(/移动端测试-\d+/.test(text), '刷新后内容丢失');
});

await check('无 JS 运行时错误', async () => {
  assert(pageErrs.length === 0, `错误：${pageErrs.slice(0, 3).join(' | ')}`);
});

await ctx.close();
await browser.close();

console.log(`\n${'─'.repeat(52)}`);
if (fail === 0) {
  console.log(green(`全部通过 · ${pass} 项`));
} else {
  console.log(red(`通过 ${pass} · 失败 ${fail}`));
  for (const f of failures) console.log(`  · ${f.name}: ${f.e.message}`);
  process.exitCode = 1;
}
