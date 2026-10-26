/**
 * 前端构建：esbuild 打包 web/src → web/dist
 *
 * 产物是浏览器原生 ES module，无需开发服务器、无需热更新。
 * 这符合「本地常驻服务 + 静态文件」的部署模型（架构 5.3）。
 */

import * as esbuild from 'esbuild';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'web', 'src');
const outDir = path.join(root, 'web', 'dist');
const watch = process.argv.includes('--watch');

/** 拷贝静态资源（html/css/图片），保持目录结构 */
async function copyStatic() {
  await fs.mkdir(outDir, { recursive: true });

  // index.html
  await fs.copyFile(path.join(root, 'web', 'index.html'), path.join(outDir, 'index.html'));

  // 样式
  const stylesSrc = path.join(srcDir, 'styles');
  const stylesOut = path.join(outDir, 'styles');
  await fs.mkdir(stylesOut, { recursive: true });
  for (const f of await fs.readdir(stylesSrc)) {
    if (f.endsWith('.css')) {
      await fs.copyFile(path.join(stylesSrc, f), path.join(stylesOut, f));
    }
  }
}

/** 构建选项 */
function options() {
  return {
    entryPoints: [path.join(srcDir, 'app.ts')],
    bundle: true,
    format: 'esm',
    target: ['es2022'],
    outfile: path.join(outDir, 'js', 'app.js'),
    sourcemap: true,
    minify: !watch,
    logLevel: 'info',
    define: {
      'process.env.NODE_ENV': watch ? '"development"' : '"production"',
    },
    loader: { '.svg': 'text', '.png': 'dataurl' },
    // 前端不需要 node 内建模块
    platform: 'browser',
  };
}

await copyStatic();

if (watch) {
  const ctx = await esbuild.context(options());
  await ctx.watch();
  // 样式与 html 变化也要同步（简易轮询）
  let lastSig = '';
  setInterval(async () => {
    try {
      const files = [
        path.join(root, 'web', 'index.html'),
        ...(await fs.readdir(path.join(srcDir, 'styles'))).map((f) =>
          path.join(srcDir, 'styles', f),
        ),
      ];
      const sig = (
        await Promise.all(
          files.map(async (f) => {
            const st = await fs.stat(f).catch(() => null);
            return st ? `${f}:${st.mtimeMs}` : '';
          }),
        )
      ).join('|');
      if (sig !== lastSig) {
        lastSig = sig;
        await copyStatic();
        console.log('[build] 静态资源已更新');
      }
    } catch {
      /* ignore */
    }
  }, 700);
  console.log('[build] 监听模式已启动');
} else {
  await esbuild.build(options());
  console.log('[build] 构建完成 → web/dist');
}
