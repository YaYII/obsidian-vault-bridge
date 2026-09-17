import esbuild from 'esbuild';
import process from 'node:process';
import builtins from 'builtin-modules';

const banner = `/*
Vault Bridge —— Obsidian 插件（电脑端服务 + 手机端客户端，同一份代码）
本文件由 esbuild 打包生成，请勿直接编辑；源码见 src/。
*/\n`;

const watch = process.argv.includes('--watch');

/**
 * 关键约束（决定移动端能否加载）：
 * 1. platform 保持 browser —— 生成的代码不依赖 Node 全局（process/Buffer 不注入），
 *    iOS 上 Obsidian 才能正常 require 这份 main.js。
 * 2. Node 内置模块全部 external —— 保留为原样的 require('http')，运行时才解析。
 *    桌面端在 Platform.isDesktopApp 守卫下才会执行到，移动端永不触发。
 */
const ctx = await esbuild.context({
  banner: { js: banner },
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    ...builtins,
  ],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: false,
  treeShaking: true,
  outfile: 'main.js',
  platform: 'browser',
  minify: !watch,
  // 手机端网页整份内联进产物，运行时无需额外文件
  loader: { '.html': 'text' },
});

if (watch) {
  await ctx.watch();
  console.log('[vault-bridge] watching...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log('[vault-bridge] build done -> main.js');
}
