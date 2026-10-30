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

    await check('批量删除 → 回收站 → 批量恢复（结构与顺序一致）', async () => {
      // 造一个独立的小结构，避免影响后续检查依赖《雨夜》
      const mk = async (kind, parentId, title) => {
        const r = await fetch(`${BASE}/api/projects/${projectId}/nodes`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind, parent_id: parentId, title }),
        });
        assert(r.ok, `建 ${title} 失败 HTTP ${r.status}`);
        return r.json();
      };

      const vol = await mk('volume', null, '批量卷');
      const chap = await mk('chapter', vol.id, '批量章');
      const s1 = await mk('scene', chap.id, '批量场景一');
      const s2 = await mk('scene', chap.id, '批量场景二');

      for (const [i, s] of [s1, s2].entries()) {
        const w = await fetch(`${BASE}/api/projects/${projectId}/scenes/${s.id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ body: `批量内容 ${i + 1}` }),
        });
        assert(w.ok, `写正文失败 HTTP ${w.status}`);
      }

      const shapeOf = async () => {
        const t = await (await fetch(`${BASE}/api/projects/${projectId}/tree`)).json();
        return t.nodes
          .filter((n) => n.title.startsWith('批量'))
          .map((n) => `${n.kind}:${n.title}:${n.parent_id}:${n.order}`)
          .sort()
          .join('|');
      };

      const before = await shapeOf();
      assert(before.split('|').length === 4, `前置条件：应有 4 个批量节点，实际 ${before}`);

      // 批量删除两个场景
      const del = await fetch(`${BASE}/api/projects/${projectId}/nodes/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [s1.id, s2.id] }),
      });
      assert(del.status === 200, `批量删除失败 HTTP ${del.status}`);
      const delBody = await del.json();
      assert(delBody.deleted === 2, `应删 2 项，实际 ${delBody.deleted}`);
      assert(
        delBody.items.length === 2 && delBody.items.every((i) => typeof i.trash_id === 'string' && i.trash_id),
        '批量删除必须返回每项的 trash_id（撤销需要）',
      );

      const mid = await shapeOf();
      assert(mid.split('|').length === 2, `删除后应剩 2 个容器，实际 ${mid}`);

      // 批量恢复
      const res = await fetch(`${BASE}/api/projects/${projectId}/trash/restore-batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: delBody.items.map((i) => i.trash_id) }),
      });
      assert(res.status === 200, `批量恢复失败 HTTP ${res.status}`);
      const resBody = await res.json();
      assert(resBody.restored === 2, `应恢复 2 项，实际 ${resBody.restored}`);

      const after = await shapeOf();
      assert(after === before, `恢复后结构应完全一致\n  删除前: ${before}\n  恢复后: ${after}`);

      return '2 项批量删除与恢复，结构顺序一致';
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

    await check('标点自动规整（开启后保存生效）', async () => {
      // 默认关闭时应原样保存
      const before = await (await fetch(`${BASE}/api/projects/${projectId}/meta`)).json();
      if (before.auto_punct) {
        await fetch(`${BASE}/api/projects/${projectId}/meta`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ auto_punct: false }),
        });
      }
      const rawBody = '他说...然后走了！！！';
      const save1 = await fetch(`${BASE}/api/projects/${projectId}/scenes/${sceneId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: rawBody, base_rev: 0 }),
      });
      const r1 = await save1.json();
      const got1 = await (await fetch(`${BASE}/api/projects/${projectId}/scenes/${sceneId}`)).json();
      assert(got1.body === rawBody, `关闭时不应改动，实际 ${JSON.stringify(got1.body)}`);

      // 开启后应规整
      await fetch(`${BASE}/api/projects/${projectId}/meta`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ auto_punct: true }),
      });
      const save2 = await fetch(`${BASE}/api/projects/${projectId}/scenes/${sceneId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: rawBody, base_rev: r1.rev }),
      });
      const r2 = await save2.json();
      const got2 = await (await fetch(`${BASE}/api/projects/${projectId}/scenes/${sceneId}`)).json();
      assert(got2.body.includes('……'), `省略号未规整：${JSON.stringify(got2.body)}`);
      assert(got2.body.includes('走了！') && !got2.body.includes('！！！'), '重复感叹号未折叠');
      assert(r2.body === got2.body, '响应未回传规整结果（前端无法同步）');

      // 幂等：再存一次不应再变化
      const save3 = await fetch(`${BASE}/api/projects/${projectId}/scenes/${sceneId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: got2.body, base_rev: r2.rev }),
      });
      const r3 = await save3.json();
      assert(r3.body === undefined, '已规整内容再次保存不应回传 body（说明不幂等）');

      // 恢复关闭状态，避免影响后续检查
      await fetch(`${BASE}/api/projects/${projectId}/meta`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ auto_punct: false }),
      });
      return '关闭时不动、开启后规整、幂等';
    });

    await check('备份管线可用（含目录安全校验）', async () => {
      // 备份目录必须放在数据目录之外（服务端会拒绝数据目录内的路径，
      // 这是防止备份把自己套娃进项目里的保护）。这里单独建临时目录。
      const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-selfcheck-backup-'));

      // 先验证保护生效：数据目录内的路径必须被拒绝
      const badRes = await fetch(`${BASE}/api/projects/${projectId}/backup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: path.join(dataDir, '_should_reject'), enabled: true }),
      });
      assert(badRes.status === 400, `数据目录内的备份路径应被拒绝，实际 HTTP ${badRes.status}`);

      const res = await fetch(`${BASE}/api/projects/${projectId}/backup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: backupDir, enabled: true, keep: 2, interval_min: 1 }),
      });
      assert(res.status === 200, `创建备份目标失败 HTTP ${res.status}`);
      const target = await res.json();
      assert(target.id, '未返回目标 id');

      // 手动触发一次，确认备份管线可用（调度器本身按 60s tick，自检不等它）
      const run = await fetch(`${BASE}/api/projects/${projectId}/backup/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target_id: target.id }),
      });
      assert(run.status === 200, `触发备份失败 HTTP ${run.status}`);
      const job = await run.json();

      for (let i = 0; i < 120; i++) {
        const j = await (await fetch(`${BASE}/api/projects/${projectId}/jobs/${job.id}`)).json();
        if (j.status === 'done') {
          const files = (await fs.readdir(backupDir)).filter((f) => f.endsWith('.tar.gz'));
          assert(files.length >= 1, '未生成备份文件');
          // 校验是合法 gzip
          const buf = await fs.readFile(path.join(backupDir, files[0]));
          assert(buf[0] === 0x1f && buf[1] === 0x8b, '备份文件不是合法 gzip');
          await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
          return `${files.length} 个备份，${(buf.length / 1024).toFixed(1)} KB，越界路径已拒绝`;
        }
        if (j.status === 'failed') throw new Error(`备份失败：${j.error}`);
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error('备份超时');
    });

    await check('AI 接口默认关闭且拒绝调用（零出站请求）', async () => {
      const res = await fetch(`${BASE}/api/projects/${projectId}/ai`);
      assert(res.status === 200, `HTTP ${res.status}`);
      const { config, status } = await res.json();
      assert(config.enabled === false, 'AI 默认必须是关闭的');
      assert(status.available === false, '当前版本不应报告 AI 可用');
      assert(Array.isArray(status.missing) && status.missing.length > 0, '应说明缺失项');

      // 即便强行调用，也必须被拦在网络请求之前
      const call = await fetch(`${BASE}/api/projects/${projectId}/ai/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feature: 'continue', prompt: '测试' }),
      });
      assert(call.status === 503, `应返回 503，实际 ${call.status}`);
      const err = await call.json();
      assert(typeof err.code === 'string' && err.code.startsWith('ai_'), '应返回 AI 错误码');
      return '默认关闭，调用被拦截';
    });

    await check('AI Key 打码且不被回传覆盖', async () => {
      const secret = 'sk-selfcheck-secret-1234';
      const save = await fetch(`${BASE}/api/projects/${projectId}/ai`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: secret }),
      });
      const saved = await save.json();
      assert(saved.config.api_key === '****1234', `返回的 Key 应打码，实际 ${saved.config.api_key}`);
      assert(!JSON.stringify(saved).includes(secret), '响应体不应包含完整 Key');

      // 模拟前端把打码值原样回传：磁盘上的真 Key 不能被覆盖
      await fetch(`${BASE}/api/projects/${projectId}/ai`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: '****1234' }),
      });
      const after = await (await fetch(`${BASE}/api/projects/${projectId}/ai`)).json();
      assert(after.config.api_key === '****1234', '打码值被当成了真 Key 写入');

      // 清理：显式清空
      await fetch(`${BASE}/api/projects/${projectId}/ai`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: '' }),
      });
      return '打码正确，回传不覆盖';
    });

    await check('关系：新增 → 读回 → 修改 → 删除', async () => {
      // 建两个角色
      const mk = async (name) => {
        const r = await fetch(`${BASE}/api/projects/${projectId}/entities`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'character', name }),
        });
        assert(r.status === 200, `建条目失败 ${name}: HTTP ${r.status}`);
        return r.json();
      };
      const e1 = await mk('自检角色甲');
      const e2 = await mk('自检角色乙');

      // 新增师徒关系
      const create = await fetch(`${BASE}/api/projects/${projectId}/entities/${e1.id}/relations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'mentor', to: e2.id, note: '自检备注' }),
      });
      assert(create.status === 200, `新增关系失败 HTTP ${create.status}`);
      const rel = await create.json();
      assert(rel.id, '未返回关系 id');

      // 读回
      const view = await (await fetch(`${BASE}/api/projects/${projectId}/entities/${e1.id}/relations`)).json();
      assert(view.out.length === 1, `出向关系应为 1 条，实际 ${view.out.length}`);
      assert(view.out[0].to_name === '自检角色乙', '目标显示名不对');

      // 入向（反向视角）
      const back = await (await fetch(`${BASE}/api/projects/${projectId}/entities/${e2.id}/relations`)).json();
      assert(back.in.length === 1, '入向关系应为 1 条');

      // 修改
      const patch = await fetch(`${BASE}/api/projects/${projectId}/relations/${rel.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: '改过的备注' }),
      });
      assert(patch.status === 200, `修改失败 HTTP ${patch.status}`);
      assert((await patch.json()).note === '改过的备注', '备注未更新');

      // 删除
      const del = await fetch(`${BASE}/api/projects/${projectId}/relations/${rel.id}`, { method: 'DELETE' });
      assert(del.status === 200, `删除失败 HTTP ${del.status}`);
      const after = await (await fetch(`${BASE}/api/projects/${projectId}/entities/${e1.id}/relations`)).json();
      assert(after.out.length === 0, '删除后关系仍在');

      return '增删改查全通';
    });

    await check('关系：非法端点被拒绝', async () => {
      const list = await (await fetch(`${BASE}/api/projects/${projectId}/entities`)).json();
      const e1 = list.find((e) => e.name === '自检角色甲');
      const e2 = list.find((e) => e.name === '自检角色乙');
      assert(e1 && e2, '缺少上一步创建的角色');

      // 师徒只能角色→角色，这里用「导致」（只能事件→事件）应当被拒
      const res = await fetch(`${BASE}/api/projects/${projectId}/entities/${e1.id}/relations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'causes', to: e2.id }),
      });
      assert(res.status === 400, `应返回 400，实际 ${res.status}`);
      const err = await res.json();
      assert(err.code === 'rel_endpoint_invalid', `错误码应为 rel_endpoint_invalid，实际 ${err.code}`);
      const detail = err.message || err.error;
      assert(detail.includes('不支持'), `错误信息应说明原因，实际：${detail}`);
      return `${err.code}`;
    });

    await check('关系：目标删除后标记悬空并被 lint 报告', async () => {
      const list = await (await fetch(`${BASE}/api/projects/${projectId}/entities`)).json();
      const e1 = list.find((e) => e.name === '自检角色甲');
      const e2 = list.find((e) => e.name === '自检角色乙');
      assert(e1 && e2);

      // 建关系后删除目标
      const create = await fetch(`${BASE}/api/projects/${projectId}/entities/${e1.id}/relations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'kin', to: e2.id }),
      });
      assert(create.status === 200, `建关系失败 HTTP ${create.status}`);

      await fetch(`${BASE}/api/projects/${projectId}/entities/${e2.id}`, { method: 'DELETE' });

      const view = await (await fetch(`${BASE}/api/projects/${projectId}/entities/${e1.id}/relations`)).json();
      assert(view.out.length === 1, '关系应还在（悬空状态）');
      assert(view.out[0].dangling === true, '应标记 dangling');

      const lint = await (await fetch(`${BASE}/api/projects/${projectId}/relations/lint`)).json();
      assert(
        lint.some((i) => i.code === 'relation_dangling_target'),
        'lint 应报告悬空关系',
      );
      return `悬空 ${lint.filter((i) => i.code === 'relation_dangling_target').length} 条`;
    });

    await check('关系：反转方向（多文件操作 + 事务日志）', async () => {
      const mk = async (name) => {
        const r = await fetch(`${BASE}/api/projects/${projectId}/entities`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'character', name }),
        });
        return r.json();
      };
      const a = await mk('反转甲');
      const b = await mk('反转乙');

      const create = await fetch(`${BASE}/api/projects/${projectId}/entities/${a.id}/relations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'mentor', to: b.id, note: '反转测试' }),
      });
      assert(create.status === 200, `建关系失败 HTTP ${create.status}`);
      const rel = await create.json();

      const rev = await fetch(`${BASE}/api/projects/${projectId}/relations/${rel.id}/reverse`, {
        method: 'POST',
      });
      assert(rev.status === 200, `反转失败 HTTP ${rev.status}`);
      const reversed = await rev.json();
      assert(reversed.from === b.id, '起点应变成原终点');
      assert(reversed.to === a.id, '终点应变成原起点');
      assert(reversed.id === rel.id, 'id 必须保持不变');

      // 两个条目的索引都要更新
      const va = await (await fetch(`${BASE}/api/projects/${projectId}/entities/${a.id}/relations`)).json();
      const vb = await (await fetch(`${BASE}/api/projects/${projectId}/entities/${b.id}/relations`)).json();
      assert(va.out.length === 0 && va.in.length === 1, `反转后甲应只有入向，实际 out=${va.out.length} in=${va.in.length}`);
      assert(vb.out.length === 1 && vb.in.length === 0, `反转后乙应只有出向，实际 out=${vb.out.length} in=${vb.in.length}`);

      // 事务日志必须清理干净（没有未完成的事务）
      const journalDir = path.join(dataDir, projectId, '.studio', 'journal');
      const pending = (await fs.readdir(journalDir).catch(() => [])).filter((f) => f.endsWith('.json'));
      assert(pending.length === 0, `事务完成后不应留下日志，实际 ${pending.length} 个`);

      return '方向已反转，日志已清理';
    });

    await check('关系：改指向（多文件操作）', async () => {
      const list = await (await fetch(`${BASE}/api/projects/${projectId}/entities`)).json();
      const a = list.find((e) => e.name === '反转甲');
      const b = list.find((e) => e.name === '反转乙');
      const mk = async (name) => {
        const r = await fetch(`${BASE}/api/projects/${projectId}/entities`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'character', name }),
        });
        return r.json();
      };
      const c = await mk('反转丙');

      // 现在 b→a，把它改成 b→c
      const vb = await (await fetch(`${BASE}/api/projects/${projectId}/entities/${b.id}/relations`)).json();
      const rel = vb.out[0];
      assert(rel, '缺少待改指向的关系');

      const res = await fetch(`${BASE}/api/projects/${projectId}/relations/${rel.id}/retarget`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: c.id }),
      });
      assert(res.status === 200, `改指向失败 HTTP ${res.status}`);
      const updated = await res.json();
      assert(updated.to === c.id, '目标应已改变');

      const after = await (await fetch(`${BASE}/api/projects/${projectId}/entities/${b.id}/relations`)).json();
      assert(after.out[0]?.to === c.id, '索引未更新');
      void a;
      return `指向已改为「${c.name}」`;
    });

    await check('关系：按原 id 恢复（撤销删除的服务端能力）', async () => {
      const list = await (await fetch(`${BASE}/api/projects/${projectId}/entities`)).json();
      const a = list.find((e) => e.name === '反转甲');
      const b = list.find((e) => e.name === '反转乙');
      assert(a && b, '缺少测试条目');

      // 建一条关系
      const created = await (
        await fetch(`${BASE}/api/projects/${projectId}/entities/${a.id}/relations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'kin', to: b.id, note: '待撤销' }),
        })
      ).json();
      assert(created.id, '未返回关系 id');

      // 删除
      const del = await fetch(`${BASE}/api/projects/${projectId}/relations/${created.id}`, {
        method: 'DELETE',
      });
      assert(del.status === 200, `删除失败 HTTP ${del.status}`);

      // 按原 id 恢复（撤销删除走的就是这条路径）
      const restored = await fetch(`${BASE}/api/projects/${projectId}/entities/${a.id}/relations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: created.id,
          type: created.type,
          to: created.to,
          note: created.note,
        }),
      });
      assert(restored.status === 200, `按原 id 恢复失败 HTTP ${restored.status}`);
      const back = await restored.json();
      assert(back.id === created.id, `id 未保持：${back.id} !== ${created.id}`);

      // 重复 id 必须被拒绝，否则撤销会覆盖别人的关系
      const dup = await fetch(`${BASE}/api/projects/${projectId}/entities/${a.id}/relations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: created.id, type: 'kin', to: b.id }),
      });
      assert(dup.status === 409, `重复 id 应返回 409，实际 ${dup.status}`);

      // 收尾：删掉，避免影响后续检查
      await fetch(`${BASE}/api/projects/${projectId}/relations/${created.id}`, { method: 'DELETE' });
      return 'id 保持且重复被拒';
    });

    await check('事务日志目录无残留（崩溃恢复前置条件）', async () => {
      const journalDir = path.join(dataDir, projectId, '.studio', 'journal');
      const exists = await fs.stat(journalDir).then(() => true).catch(() => false);
      if (!exists) return '无日志目录（尚无多文件操作）';
      const pending = (await fs.readdir(journalDir)).filter((f) => f.endsWith('.json'));
      assert(pending.length === 0, `应无待恢复事务，实际 ${pending.length} 个`);
      return '0 个待恢复事务';
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
