/**
 * Node 18 没有把 Web Crypto 暴露成全局变量（Node 19 起才有）。
 *
 * 插件在 Obsidian 里始终能拿到 window.crypto，但测试进程可能跑在 Node 18 上。
 * 这里补齐只是让 CI 不因环境差异误报——属于测试基础设施的适配，
 * 与产品代码在 Obsidian 中的正确性无关。
 */

const existing = (globalThis as { crypto?: { getRandomValues?: unknown } }).crypto;

if (!existing || typeof existing.getRandomValues !== 'function') {
  const { webcrypto } = await import('node:crypto');
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true,
  });
}
