/**
 * 访问令牌的生成与校验。
 *
 * 两端都要用到：电脑端生成并校验，手机端保存并携带。
 * 只依赖 Web Crypto（Obsidian 桌面与 iOS 均可用），不引入 Node 依赖，
 * 这样同一份代码在移动端也能安全加载。
 */

/** 令牌字符集：URL 安全，避免在浏览器地址栏或日志里被转义 */
const TOKEN_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/**
 * 取 Web Crypto 实现。
 *
 * Obsidian 桌面端（Electron）与移动端（WebView）都会提供全局 crypto；
 * 但某些运行环境（例如未开实验开关的 Node 18）并没有把它挂到全局上，
 * 直接写 crypto.getRandomValues 只会抛出难懂的 "crypto is not defined"。
 * 这里显式探测，把问题说清楚。
 */
function requireWebCrypto(): Crypto {
  // 用 window 而不是 globalThis：Obsidian 建议如此以兼容弹出窗口，
  // 弹出窗口拥有自己的 window，而 globalThis 在部分宿主里指向别处。
  // 纯 Node 环境（测试进程、开发脚本）没有 window，
  // 由 tests/setup/host-env.ts 与 tools/node-webcrypto.mjs 补上。
  const impl = typeof window === 'undefined' ? undefined : window.crypto;
  if (!impl || typeof impl.getRandomValues !== 'function') {
    throw new Error('当前运行环境不提供 Web Crypto（crypto.getRandomValues），无法安全生成访问令牌');
  }
  return impl;
}

/**
 * 生成一个高强度随机令牌。
 * 使用 crypto.getRandomValues（CSPRNG），拒绝采样以消除取模偏差。
 * @param length 令牌长度，默认 32 字符（约 160 bit 熵）
 */
export function generateToken(length = 32): string {
  const alphabetSize = TOKEN_ALPHABET.length;
  const maxValid = Math.floor(256 / alphabetSize) * alphabetSize;
  const out: string[] = [];
  const buffer = new Uint8Array(length * 2);
  const webCrypto = requireWebCrypto();

  while (out.length < length) {
    webCrypto.getRandomValues(buffer);
    for (let i = 0; i < buffer.length && out.length < length; i++) {
      const byte = buffer[i];
      if (byte < maxValid) {
        out.push(TOKEN_ALPHABET.charAt(byte % alphabetSize));
      }
    }
  }
  return out.join('');
}

/**
 * 恒定时间字符串比较，避免通过响应耗时逐字符爆破令牌。
 * 长度不同时同样走完整轮比较，不提前返回。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

/** 把令牌中间部分打码，用于写入日志 */
export function maskToken(token: string): string {
  if (!token) return '(空)';
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
