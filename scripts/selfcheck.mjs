#!/usr/bin/env node
/**
 * 集成自检 —— 部署完成后一键确认「写作台」真的能干活。
 *
 * 检查项分四层：
 *   1. 环境（Node 版本、依赖、构建产物）
 *   2. 服务（能否启动、API 是否响应、静态文件是否可访问）
 *   3. 稿件安全（原子写、崩溃恢复、索引重建）
 *   4. 功能面（树/正文/搜索/设定库/检查/快照/导出）
 *
 * 用法：node scripts/selfcheck.mjs
 * 不修改你的真实作品数据（用临时目录）。
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.CHECK_PORT ?? 7793);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const problems = [];

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

function section(title) {
  console.log(`\n${bold(title)}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    pass++;
    console.log(`  ${green('✔')} ${name}${detail ? dim(`  ${detail}`) : ''}`);
    return true;
  } catch (err) {
    fail++;
    problems.push({ name, err });
    console.log(`  ${red('✖')} ${name}`);
    console.log(`     ${red(String(err?.message ?? err).split('\n')[0])}`);
    return false;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

const exists = async (p) => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

async function waitForServer(url, timeoutMs = 40000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch {
      /* 未就绪 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  console.log(`\n${bold('写作台 · 部署自检')}\n${dim('─'.repeat(52))}`);

  // ═══════════ 1. 环境 ═══════════
  section('【1】环境');

  await check('Node.js 版本 ≥ 22', async () => {
    const major = Number(process.versions.node.split('.')[0]);
    assert(major >= 22, `当前 ${process.versions.node}，需要 ≥ 22`);
    return `v${process.versions.node}`;
  });

  await check('依赖已安装', async () => {
    for (const dep of ['fastify', '@fastify/static', '@fastify/websocket', 'docx', 'diff-match-patch']) {
      assert(await exists(path.join(root, 'node_modules', dep)), `缺少依赖 ${dep}，请运行 npm install`);
    }
    return '5 个核心依赖';
  });

  await check('node:sqlite 可用（含 FTS5）', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t(x)');
    db.exec("INSERT INTO t VALUES('夜雨')");
    const row = db.prepare('SELECT x FROM t').get();
    db.close();
    assert(row?.x === '夜雨', 'SQLite 读写异常');
    return 'SQLite 3.x';
  });

  await check('前端已构建', async () => {
    const appJs = path.join(root, 'web', 'dist', 'js', 'app.js');
    assert(await exists(appJs), '缺少 web/dist/js/app.js，请运行 npm run build');
    const st = await fs.stat(appJs);
    assert(st.size > 5000, `产物过小（${st.size} 字节），构建可能失败`);
    return `${(st.size / 1024).toFixed(0)} KB`;
  });

  await check('前端样式齐全', async () => {
    for (const f of ['tokens.css', 'base.css', 'app.css', 'editor.css', 'mobile.css']) {
      assert(
        await exists(path.join(root, 'web', 'dist', 'styles', f)),
        `缺少样式 ${f}`,
      );
    }
    return '5 个样式文件';
  });

  // ═══════════ 2. 服务 ═══════════
  section('【2】服务启动与 API');

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-check-'));
  const server = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', 'server/main.ts'],
    {
      cwd: root,
      env: { ...process.env, WD_PORT: String(PORT), WD_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  server.stdout.on('data', (d) => (log += String(d)));
  server.stderr.on('data', (d) => (log += String(d)));

  const cleanup = async () => {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  };

  let projectId = null;
  let sceneId = null;

  try {
    const up = await check('服务可启动并响应', async () => {
      const ok = await waitForServer(`${BASE}/api/projects`);
      if (!ok) {
        throw new Error(`服务未就绪。日志：\n${log.split('\n').slice(-12).join('\n')}`);
      }
      return BASE;
    });

    if (!up) throw new Error('服务未启动，后续检查跳过');

    await check('首页可访问', async () => {
      const res = await fetch(BASE);
      assert(res.status === 200, `HTTP ${res.status}`);
      const html = await res.text();
      assert(html.includes('写作台'), '首页内容异常');
      return `HTTP 200`;
    });

    await check('静态资源可加载', async () => {
      for (const p of ['/styles/tokens.css', '/styles/base.css', '/js/app.js']) {
        const res = await fetch(`${BASE}${p}`);
        assert(res.status === 200, `${p} → HTTP ${res.status}`);
      }
      return 'CSS + JS';
    });

    await check('创建作品', async () => {
      const res = await fetch(`${BASE}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '自检作品', author: '自检', mode: 'webnovel' }),
      });
      assert(res.status === 200, `HTTP ${res.status}`);
      const data = await res.json();
      projectId = data.id;
      assert(projectId, '未返回作品 id');
      return projectId;
    });

    await check('作品列表', async () => {
      const list = await (await fetch(`${BASE}/api/projects`)).json();
      assert(Array.isArray(list), '应返回数组');
      assert(list.length >= 1, '应至少有一个作品');
      return `${list.length} 部作品`;
    });

    // ═══════════ 3. 稿件安全 ═══════════
    section('【3】稿件安全（最重要）');

    let volumeId = null;
    let chapterId = null;

    await check('创建卷章场景', async () => {
      const post = async (body) => {
        const res = await fetch(`${BASE}/api/projects/${projectId}/nodes`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert(res.status === 200, `HTTP ${res.status}`);
        return res.json();
      };
      const v = await post({ kind: 'volume', parent_id: null, title: '第一卷' });
      volumeId = v.id;
      const c = await post({ kind: 'chapter', parent_id: volumeId, title: '开篇' });
      chapterId = c.id;
      const s = await post({ kind: 'scene', parent_id: chapterId, title: '雨夜' });
      sceneId = s.id;
      return '卷 → 章 → 场景';
    });

    const TEST_BODY = '夜雨敲窗，山门外一片寂静。\n\n“师父，我回来了。”\n\n林远站在雨里，斗笠压得很低。';

    await check('保存并原样读回', async () => {
      const res = await fetch(`${BASE}/api/projects/${projectId}/scenes/${sceneId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: TEST_BODY, base_rev: 1 }),
      });
      assert(res.status === 200, `HTTP ${res.status}`);
      const saved = await res.json();
      assert(saved.rev >= 2, '修订号未递增');

      const got = await (await fetch(`${BASE}/api/projects/${projectId}/scenes/${sceneId}`)).json();
      assert(got.body === TEST_BODY, '读回内容与写入不一致（这是稿件损坏）');
      return `rev ${saved.rev}, ${saved.word_count} 字`;
    });

    await check('磁盘上是可读 Markdown（文件即真相）', async () => {
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
      const sceneFile = files.find((f) => f.endsWith('.md') && f.includes('雨夜'));
      assert(sceneFile, '找不到场景文件');
      const raw = await fs.readFile(sceneFile, 'utf8');
      assert(raw.startsWith('---'), '缺少 frontmatter');
      assert(/^id:\s*\S+/m.test(raw), 'frontmatter 缺 id');
      assert(raw.includes('夜雨敲窗'), '正文不在文件里');
      return path.relative(root, sceneFile);
    });

    await check('无残留临时文件（原子写）', async () => {
      const walk = async (dir) => {
        const out = [];
        for (const e of await fs.readdir(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) out.push(...(await walk(p)));
          else if (e.name.endsWith('.tmp')) out.push(p);
        }
        return out;
      };
      const leftovers = await walk(dataDir);
      assert(leftovers.length === 0, `残留 ${leftovers.length} 个临时文件`);
      return '0 个残留';
    });

    await check('快照与恢复', async () => {
      const snap = await (
        await fetch(`${BASE}/api/projects/${projectId}/snapshots`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ doc_id: sceneId, reason: 'manual' }),
        })
      ).json();
      assert(snap.id, '快照未创建');

      // 改坏
      await fetch(`${BASE}/api/projects/${projectId}/scenes/${sceneId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: '这是被覆盖的内容', base_rev: 2 }),
      });
      const corrupted = await (await fetch(`${BASE}/api/projects/${projectId}/scenes/${sceneId}`)).json();
      assert(corrupted.body === '这是被覆盖的内容', '覆盖未生效');

      // 恢复
      const res = await fetch(`${BASE}/api/projects/${projectId}/snapshots/${snap.id}/restore`, {
        method: 'POST',
      });
      assert(res.status === 200, `恢复失败 HTTP ${res.status}`);
      const restored = await (await fetch(`${BASE}/api/projects/${projectId}/scenes/${sceneId}`)).json();
      assert(restored.body === TEST_BODY, '恢复后内容与快照不一致');
      return '快照 → 覆盖 → 恢复，内容一致';
    });

    await check('删除进回收站并可恢复', async () => {
      const del = await fetch(`${BASE}/api/projects/${projectId}/nodes/${chapterId}`, { method: 'DELETE' });
      assert(del.status === 200, `删除失败 HTTP ${del.status}`);

      const trash = await (await fetch(`${BASE}/api/projects/${projectId}/trash`)).json();
      assert(trash.length >= 1, '回收站为空');

      const restore = await fetch(`${BASE}/api/projects/${projectId}/trash/${trash[0].id}/restore`, {
        method: 'POST',
      });
      assert(restore.status === 200, `恢复失败 HTTP ${restore.status}`);

      const tree = await (await fetch(`${BASE}/api/projects/${projectId}/tree`)).json();
      assert(tree.nodes.some((n) => n.title === '雨夜'), '恢复后场景未回来');
      return '删除 → 回收站 → 恢复';
    });

    await check('索引可重建（删库不丢内容）', async () => {
      const idx = path.join(dataDir, projectId, '.studio', 'index.sqlite');
      assert(await exists(idx), '索引文件不存在');

      const res = await fetch(`${BASE}/api/projects/${projectId}/index/rebuild`, { method: 'POST' });
      const job = await res.json();
      assert(job.id, '未返回作业');

      for (let i = 0; i < 100; i++) {
        const j = await (await fetch(`${BASE}/api/projects/${projectId}/jobs/${job.id}`)).json();
        if (j.status === 'done') {
          const got = await (await fetch(`${BASE}/api/projects/${projectId}/scenes/${sceneId}`)).json();
          assert(got.body === TEST_BODY, '重建索引后正文丢失');
          return `作业 ${j.id.slice(0, 6)} 完成`;
        }
        if (j.status === 'failed') throw new Error(`重建失败：${j.error}`);
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error('重建索引超时');
    });

    // ═══════════ 4. 功能面 ═══════════
    section('【4】功能面');

    await check('中文搜索（2 字词）', async () => {
      const res = await fetch(`${BASE}/api/projects/${projectId}/search?q=${encodeURIComponent('林远')}`);
      assert(res.status === 200, `HTTP ${res.status}`);
      const data = await res.json();
      assert(Array.isArray(data.hits), '返回格式异常');
      assert(data.hits.length >= 1, '应搜到「林远」');
      return `${data.hits.length} 处命中，${data.took_ms}ms`;
    });

    await check('设定库与出场识别', async () => {
      const res = await fetch(`${BASE}/api/projects/${projectId}/entities`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'character',
          name: '林远',
          aliases: ['小林'],
          fields: { 身份: '青云门弟子' },
          description: '主角。',
        }),
      });
      assert(res.status === 200, `HTTP ${res.status}`);
      const entity = await res.json();

      await new Promise((r) => setTimeout(r, 500));
      const detail = await (await fetch(`${BASE}/api/projects/${projectId}/entities/${entity.id}`)).json();
      assert(detail.name === '林远', '条目读回失败');
      assert(Array.isArray(detail.mentions), '缺少出场数据');
      return `别名 ${detail.aliases?.length ?? 0} 个，出场 ${detail.total_count ?? 0} 次`;
    });

    await check('规则检查', async () => {
      const res = await fetch(`${BASE}/api/projects/${projectId}/lint/rules`);
      assert(res.status === 200, `HTTP ${res.status}`);
      const rules = await res.json();
      assert(Array.isArray(rules) && rules.length > 0, '应有内置规则');
      return `${rules.length} 条规则`;
    });

    await check('场景检查可执行', async () => {
      const res = await fetch(`${BASE}/api/projects/${projectId}/lint/scene/${sceneId}`);
      assert(res.status === 200, `HTTP ${res.status}`);
      const result = await res.json();
      assert(Array.isArray(result.issues), '返回格式异常');
      return `${result.issues.length} 个问题，${result.took_ms}ms`;
    });

    await check('统计与目标', async () => {
      const res = await fetch(`${BASE}/api/projects/${projectId}/goal`);
      assert(res.status === 200, `HTTP ${res.status}`);
      const goal = await res.json();
      assert(typeof goal.total_words === 'number', '缺少全书字数');
      return `全书 ${goal.total_words} 字`;
    });

    await check('导出 txt', async () => {
      const res = await fetch(`${BASE}/api/projects/${projectId}/export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ format: 'txt', scope: 'book', typeset: true }),
      });
      assert(res.status === 200, `HTTP ${res.status}`);
      const job = await res.json();

      for (let i = 0; i < 120; i++) {
        const j = await (await fetch(`${BASE}/api/projects/${projectId}/jobs/${job.id}`)).json();
        if (j.status === 'done') {
          assert(j.result?.file, '未返回文件');
          const dl = await fetch(
            `${BASE}/api/projects/${projectId}/download?file=${encodeURIComponent(j.result.file)}`,
          );
          assert(dl.status === 200, `下载失败 HTTP ${dl.status}`);
          const text = await dl.text();
          assert(text.includes('夜雨敲窗'), '导出内容缺正文');
          return `${j.result.words ?? '?'} 字，${(j.result.size / 1024).toFixed(1)} KB`;
        }
        if (j.status === 'failed') throw new Error(`导出失败：${j.error}`);
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error('导出超时');
    });

    await check('导出 docx', async () => {
      const res = await fetch(`${BASE}/api/projects/${projectId}/export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ format: 'docx', scope: 'book', typeset: true }),
      });
      const job = await res.json();
      for (let i = 0; i < 120; i++) {
        const j = await (await fetch(`${BASE}/api/projects/${projectId}/jobs/${job.id}`)).json();
        if (j.status === 'done') {
          const dl = await fetch(
            `${BASE}/api/projects/${projectId}/download?file=${encodeURIComponent(j.result.file)}`,
          );
          const buf = Buffer.from(await dl.arrayBuffer());
          // docx 是 zip，应以 PK 开头
          assert(buf[0] === 0x50 && buf[1] === 0x4b, 'docx 文件头不是 ZIP');
          return `${(buf.length / 1024).toFixed(1)} KB`;
        }
        if (j.status === 'failed') throw new Error(`导出失败：${j.error}`);
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error('导出超时');
    });

    await check('灵感箱', async () => {
      const res = await fetch(`${BASE}/api/projects/${projectId}/inbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '一个自检用的灵感' }),
      });
      assert(res.status === 200, `HTTP ${res.status}`);
      const list = await (await fetch(`${BASE}/api/projects/${projectId}/inbox`)).json();
      assert(list.some((i) => i.text.includes('自检')), '灵感未保存');
      return `${list.length} 条`;
    });

    await check('WebSocket 可连接', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      const ok = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 5000);
        ws.onopen = () => {
          clearTimeout(timer);
          resolve(true);
        };
        ws.onerror = () => {
          clearTimeout(timer);
          resolve(false);
        };
      });
      ws.close();
      assert(ok, 'WebSocket 连接失败');
      return '/ws';
    });

    await check('路径穿越被拒绝', async () => {
      const res = await fetch(
        `${BASE}/api/projects/${projectId}/download?file=${encodeURIComponent('../../../../etc/passwd')}`,
      );
      assert(res.status >= 400, `应拒绝，实际 HTTP ${res.status}`);
      return `HTTP ${res.status}`;
    });

    await check('不存在的路由返回 JSON 错误', async () => {
      const res = await fetch(`${BASE}/api/projects/${projectId}/nonexistent-endpoint`);
      assert(res.status === 404, `HTTP ${res.status}`);
      const body = await res.json().catch(() => null);
      assert(body && typeof body.error === 'string', '错误响应不是 JSON 信封');
      return 'JSON 错误信封';
    });
  } finally {
    await cleanup();
  }

  // ═══════════ 汇总 ═══════════
  console.log(`\n${dim('─'.repeat(52))}`);
  if (fail === 0) {
    console.log(`${green(bold(`全部通过 · ${pass} 项检查`))}`);
    console.log(`\n启动服务：${bold('npm run serve')}`);
    console.log(`访问地址：${bold('http://127.0.0.1:7788')}\n`);
  } else {
    console.log(`${red(bold(`通过 ${pass} · 失败 ${fail}`))}`);
    console.log('\n需要处理：');
    for (const p of problems) console.log(`  · ${p.name}\n    ${p.err?.message ?? p.err}`);
    console.log('');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\n${red('自检崩溃：')}`, err);
  process.exitCode = 1;
});
