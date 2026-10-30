#!/usr/bin/env node
/**
 * 一键启动脚本 —— 部署入口。
 *
 * 做三件事：
 *   1. 依赖没装 → 自动 npm install
 *   2. 前端没构建 / 源码更新了 → 自动构建
 *   3. 启动服务（默认 http://127.0.0.1:7788）
 *
 * 设计意图：作者双击就能用，不需要懂 npm。
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.WD_PORT ?? '7788';

function log(msg) {
  console.log(`\x1b[36m▸\x1b[0m ${msg}`);
}

function warn(msg) {
  console.log(`\x1b[33m!\x1b[0m ${msg}`);
}

function fail(msg) {
  console.error(`\x1b[31m✖\x1b[0m ${msg}`);
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 前端产物是否比源码旧 */
async function needsBuild() {
  const entry = path.join(root, 'web', 'dist', 'js', 'app.js');
  if (!(await exists(entry))) return true;

  const outStat = await fs.stat(entry);
  const srcDirs = [path.join(root, 'web', 'src'), path.join(root, 'shared')];

  const newest = async (dir) => {
    let latest = 0;
    const walk = async (d) => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          await walk(p);
        } else if (/\.(ts|css|html)$/.test(e.name)) {
          const st = await fs.stat(p);
          if (st.mtimeMs > latest) latest = st.mtimeMs;
        }
      }
    };
    await walk(dir);
    return latest;
  };

  for (const dir of srcDirs) {
    if (!(await exists(dir))) continue;
    if ((await newest(dir)) > outStat.mtimeMs) return true;
  }
  return false;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}`)),
    );
    child.on('error', reject);
  });
}

async function main() {
  console.log('\n\x1b[1m写作台\x1b[0m · 本地部署\n');

  // 1. Node 版本
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    fail(`需要 Node.js 22 或更高版本（当前 ${process.versions.node}）`);
    fail('请到 https://nodejs.org 下载 LTS 版本');
    process.exit(1);
  }

  // 2. 依赖
  if (!(await exists(path.join(root, 'node_modules', 'fastify')))) {
    log('首次运行，正在安装依赖…');
    await run('npm', ['install', '--no-audit', '--no-fund']);
  }

  // 3. 前端构建
  if (await needsBuild()) {
    log('正在构建前端…');
    await run(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/build-web.mjs']);
  } else {
    log('前端产物已是最新');
  }

  // 4. 启动
  console.log('');
  log(`启动服务：\x1b[1mhttp://127.0.0.1:${PORT}\x1b[0m`);
  log('按 Ctrl+C 停止');
  console.log('');

  /**
   * 监督循环：网页里点「重启服务」时，子进程会以退出码 75 结束，
   * 这里收到 75 就重新拉起，页面那边轮询 /api/health 等它回来再刷新。
   * 其它退出码（包括 Ctrl+C 触发的 SIGTERM）照旧退出，不做意外重启。
   */
  let stopping = false;
  const RESTART_CODE = 75;

  const shutdown = () => {
    stopping = true;
    child?.kill('SIGTERM');
    setTimeout(() => process.exit(0), 800);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  let child = null;
  for (;;) {
    child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', 'server/main.ts'],
      {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env, WD_PORT: PORT, WD_SUPERVISED: '1' },
      },
    );

    const code = await new Promise((resolve) => {
      child.on('exit', (c, signal) => resolve(signal ? 1 : (c ?? 0)));
      child.on('error', () => resolve(1));
    });

    if (code === RESTART_CODE && !stopping) {
      log('收到重启请求，正在重新拉起服务…');
      continue;
    }
    process.exit(code ?? 0);
  }
}

main().catch((err) => {
  fail(err.message);
  process.exit(1);
});
