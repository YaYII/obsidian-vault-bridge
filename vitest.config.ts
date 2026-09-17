import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/** 让 .html 像源码一样被导入为字符串，对齐 esbuild 的 text loader */
const htmlAsText = {
  name: 'html-as-text',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!id.endsWith('.html')) return null;
    return { code: 'export default ' + JSON.stringify(code), map: null };
  },
};

export default defineConfig({
  plugins: [htmlAsText],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 让测试进程具备 Obsidian 宿主的全局（window、Web Crypto）
    setupFiles: ['tests/setup/host-env.ts'],
    coverage: {
      provider: 'v8',
      // 只统计插件自身源码，不含测试与工具脚本
      include: ['src/**/*.ts'],
      exclude: ['src/types.d.ts'],
      reporter: ['text', 'json-summary'],
      reportsDirectory: './.code-review/coverage',
    },
  },
  resolve: {
    alias: {
      // 测试环境没有 Obsidian 宿主，用行为等价的替身实现顶替
      obsidian: fileURLToPath(new URL('./tests/mocks/obsidian.ts', import.meta.url)),
    },
  },
});
