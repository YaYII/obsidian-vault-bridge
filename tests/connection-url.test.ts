/**
 * 「电脑地址」的容错。
 *
 * 真实事故：手机端把设置页给的完整链接（带 token 参数）整条粘进「电脑地址」，
 * 之后请求被拼成 …/obs?token=xxx/api/health —— 实测网关返回 301 + text/html，
 * 插件于是报「电脑返回了无法解析的内容」。这里把这个行为钉死。
 */

import { describe, expect, it } from 'vitest';
import { extractTokenFromUrl, normalizeBaseUrl } from '../src/client/api-client';

describe('normalizeBaseUrl', () => {
  it('剥掉查询串，避免令牌被拼进请求路径', () => {
    expect(normalizeBaseUrl('https://x.ngrok-free.dev/obs?token=abc123')).toBe(
      'https://x.ngrok-free.dev/obs'
    );
  });

  it('剥掉锚点与多余的斜杠', () => {
    expect(normalizeBaseUrl('https://a.dev/obs/#/x')).toBe('https://a.dev/obs');
    expect(normalizeBaseUrl('https://a.dev/obs///')).toBe('https://a.dev/obs');
  });

  it('缺协议时补 http，局域网地址照旧', () => {
    expect(normalizeBaseUrl('192.168.1.44:8770')).toBe('http://192.168.1.44:8770');
    expect(normalizeBaseUrl('  http://127.0.0.1:8770  ')).toBe('http://127.0.0.1:8770');
  });

  it('空输入返回空串', () => {
    expect(normalizeBaseUrl('')).toBe('');
    expect(normalizeBaseUrl('   ')).toBe('');
  });
});

describe('extractTokenFromUrl', () => {
  it('从浏览器链接里取出令牌', () => {
    expect(extractTokenFromUrl('https://x.dev/obs?token=abc123')).toBe('abc123');
    expect(extractTokenFromUrl('http://192.168.1.44:8770/?token=abc123&x=1')).toBe('abc123');
  });

  it('没有令牌时返回空串（纯地址不会被误判）', () => {
    expect(extractTokenFromUrl('https://x.dev/obs')).toBe('');
    expect(extractTokenFromUrl('')).toBe('');
  });

  it('令牌是 URL 编码时还原', () => {
    expect(extractTokenFromUrl('https://x.dev/?token=a%2Bb')).toBe('a+b');
  });
});
