/**
 * 在 Node 侧脚本里补齐全局 Web Crypto。
 *
 * 背景（实测，非推测）：Node 18 默认不把 Web Crypto 挂到全局，Node 19 才默认开启；
 * 而且在 Node 18 上它的可用性还取决于执行方式——
 *   node -e "typeof globalThis.crypto"        → object
 *   node script.mjs / script.cjs              → undefined
 * 所以只靠 "我本地测过" 会漏掉脚本场景。
 *
 * 插件的产物在 Node 环境下生成令牌时会用到 crypto.getRandomValues，
 * 这里在任何脚本逻辑之前补上，让 verify / bench 在 Node 18 上也能跑通。
 * 只影响这些开发脚本；Obsidian 的 Electron 与 WebView 始终自带 window.crypto。
 */

// 插件代码按 Obsidian 规范使用 window；脚本环境没有它，这里一并补上。
const globalScope = globalThis;
if (typeof globalScope.window === 'undefined') {
  Object.defineProperty(globalScope, 'window', { value: globalThis, configurable: true, writable: true });
}

const existing = globalThis.crypto;

if (!existing || typeof existing.getRandomValues !== 'function') {
  const { webcrypto } = await import('node:crypto');
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true,
  });
}

export const webCryptoReady = true;
