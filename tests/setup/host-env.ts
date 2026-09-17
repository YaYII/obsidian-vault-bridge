/**
 * 让测试进程更像 Obsidian 的宿主环境。
 *
 * 插件代码按 Obsidian 的规范书写——用 `window` 而不是 `globalThis`
 * （弹窗兼容），用 `window.setInterval` 而不是裸 `setInterval`。
 * 但测试跑在纯 Node 进程里，这些浏览器全局并不存在，于是这里补上，
 * 使被测代码无需为了「能在测试里跑」而偏离官方写法。
 */

// 标记为模块：顶层 await 只在模块里合法
export {};

const globalScope = globalThis as Record<string, unknown>;

// Obsidian 跑在 Electron renderer / WebView 中，window 始终存在
if (typeof globalScope.window === 'undefined') {
  Object.defineProperty(globalScope, 'window', {
    value: globalThis,
    configurable: true,
    writable: true,
  });
}

// Node 18 不把 Web Crypto 挂到全局（Node 19 才默认开启），
// 且脚本文件里没有而 node -e 里有，故显式补齐。
const existingCrypto = (globalScope.crypto as { getRandomValues?: unknown } | undefined) ?? undefined;
if (!existingCrypto || typeof existingCrypto.getRandomValues !== 'function') {
  const { webcrypto } = await import('node:crypto');
  Object.defineProperty(globalScope, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true,
  });
}
