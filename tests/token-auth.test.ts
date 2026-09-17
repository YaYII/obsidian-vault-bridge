/** 令牌生成、恒定时间比较与暴力破解防护。 */

import { describe, expect, it } from 'vitest';
import { generateToken, maskToken, timingSafeEqual } from '../src/shared/token';
import { AuthGuard, extractToken } from '../src/server/auth';

describe('generateToken', () => {
  it('默认长度 32 且只含 URL 安全字符', () => {
    const token = generateToken();
    expect(token).toHaveLength(32);
    expect(token).toMatch(/^[abcdefghijkmnpqrstuvwxyz23456789]+$/);
  });

  it('连续生成不重复', () => {
    const set = new Set<string>();
    for (let i = 0; i < 500; i++) set.add(generateToken());
    expect(set.size).toBe(500);
  });

  it('长度可定制', () => {
    expect(generateToken(16)).toHaveLength(16);
    expect(generateToken(64)).toHaveLength(64);
  });
});

describe('timingSafeEqual', () => {
  it('相同字符串返回 true', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true);
  });

  it('任意位置不同都返回 false', () => {
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false);
    expect(timingSafeEqual('abc123', 'zbc123')).toBe(false);
  });

  it('长度不同返回 false', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', 'a')).toBe(false);
  });

  it('空串与空串相等', () => {
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

describe('maskToken', () => {
  it('只暴露首尾各 4 位', () => {
    expect(maskToken('abcdefghijklmnop')).toBe('abcd…mnop');
  });

  it('短令牌整体打码', () => {
    expect(maskToken('short')).toBe('****');
    expect(maskToken('')).toBe('(空)');
  });
});

describe('extractToken', () => {
  it('优先读取 Authorization 头', () => {
    const headers = { authorization: 'Bearer abc123' };
    expect(extractToken(headers, new URLSearchParams('token=xyz'))).toBe('abc123');
  });

  it('大小写与多余空格都能容忍', () => {
    expect(extractToken({ authorization: '  bearer   abc123  ' }, new URLSearchParams())).toBe('abc123');
  });

  it('没有头时回退到查询参数', () => {
    expect(extractToken({}, new URLSearchParams('token=fromurl'))).toBe('fromurl');
  });

  it('都没有时返回空串', () => {
    expect(extractToken({}, new URLSearchParams())).toBe('');
  });

  it('数组形式的头取第一个', () => {
    expect(extractToken({ authorization: ['Bearer a', 'Bearer b'] }, new URLSearchParams())).toBe('a');
  });
});

describe('AuthGuard', () => {
  const token = 'correct-token-value-123456';

  it('令牌正确时放行并清除失败计数', () => {
    const guard = new AuthGuard(() => token);
    guard.verify('wrong', '1.1.1.1');
    expect(guard.verify(token, '1.1.1.1').ok).toBe(true);
    expect(guard.verify('wrong', '1.1.1.1').ok).toBe(false);
  });

  it('缺失令牌被拒绝', () => {
    const guard = new AuthGuard(() => token);
    const result = guard.verify('', '2.2.2.2');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing_token');
  });

  it('服务端未配置令牌时一律拒绝，避免免认证', () => {
    const guard = new AuthGuard(() => '');
    expect(guard.verify('', '3.3.3.3').ok).toBe(false);
    expect(guard.verify('anything', '3.3.3.3').ok).toBe(false);
  });

  it('同一 IP 连续失败达到阈值后被限流', () => {
    const guard = new AuthGuard(() => token);
    for (let i = 0; i < 8; i++) guard.verify('wrong', '4.4.4.4');
    const result = guard.verify(token, '4.4.4.4');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('rate_limited');
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('限流只影响触发的那一个 IP', () => {
    const guard = new AuthGuard(() => token);
    for (let i = 0; i < 8; i++) guard.verify('wrong', '5.5.5.5');
    expect(guard.verify(token, '6.6.6.6').ok).toBe(true);
  });

  it('reset 可以解除限流（供用户手动解锁）', () => {
    const guard = new AuthGuard(() => token);
    for (let i = 0; i < 8; i++) guard.verify('wrong', '7.7.7.7');
    guard.reset('7.7.7.7');
    expect(guard.verify(token, '7.7.7.7').ok).toBe(true);
  });
});
