/** 连接档案：地址推断、去重排序、相对时间与令牌打码。 */

import { describe, expect, it } from 'vitest';
import {
  MAX_PROFILES,
  findProfile,
  forgetProfile,
  formatRelativeTime,
  inferProfileLabel,
  maskProfileToken,
  mostRecentProfile,
  rememberProfile,
  type ServerProfile,
} from '../src/shared/server-profile';

describe('inferProfileLabel', () => {
  it('识别局域网私有网段', () => {
    expect(inferProfileLabel('http://192.168.1.44:8770')).toBe('局域网');
    expect(inferProfileLabel('http://10.0.0.8:8770')).toBe('局域网');
    expect(inferProfileLabel('http://172.16.3.9:8770')).toBe('局域网');
    expect(inferProfileLabel('http://172.31.255.1:8770')).toBe('局域网');
  });

  it('172.32 不属于私有段，按域名原样显示', () => {
    expect(inferProfileLabel('http://172.32.0.1:8770')).toBe('172.32.0.1');
  });

  it('识别本机地址', () => {
    expect(inferProfileLabel('http://127.0.0.1:8770')).toBe('本机');
    expect(inferProfileLabel('http://localhost:8770')).toBe('本机');
  });

  it('识别隧道域名', () => {
    expect(inferProfileLabel('https://abc-def.trycloudflare.com')).toBe('公网隧道');
    expect(inferProfileLabel('https://x.ngrok-free.dev')).toBe('ngrok 隧道');
    expect(inferProfileLabel('https://x.ngrok-free.app')).toBe('ngrok 隧道');
  });

  it('其它情况显示主机名', () => {
    expect(inferProfileLabel('https://vault.example.com/obs')).toBe('vault.example.com');
  });

  it('空值给出兜底名', () => {
    expect(inferProfileLabel('')).toBe('未命名');
  });
});

describe('rememberProfile', () => {
  const t0 = 1_700_000_000_000;

  it('首次记录会补上推断出的名字', () => {
    const list = rememberProfile([], 'http://192.168.1.44:8770', 'tok', t0);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ url: 'http://192.168.1.44:8770', token: 'tok', label: '局域网' });
  });

  it('同一地址不重复，只更新时间与令牌', () => {
    let list = rememberProfile([], 'http://a:1', 'old', t0);
    list = rememberProfile(list, 'http://a:1', 'new', t0 + 1000);
    expect(list).toHaveLength(1);
    expect(list[0].token).toBe('new');
    expect(list[0].lastUsedAt).toBe(t0 + 1000);
  });

  it('令牌为空时保留原令牌', () => {
    let list = rememberProfile([], 'http://a:1', 'keepme', t0);
    list = rememberProfile(list, 'http://a:1', '', t0 + 1);
    expect(list[0].token).toBe('keepme');
  });

  it('按最近使用倒序排列', () => {
    let list = rememberProfile([], 'http://a:1', 't', t0);
    list = rememberProfile(list, 'http://b:1', 't', t0 + 2000);
    list = rememberProfile(list, 'http://c:1', 't', t0 + 1000);
    expect(list.map((item) => item.url)).toEqual(['http://b:1', 'http://c:1', 'http://a:1']);
  });

  it('超过上限时丢弃最久未用的', () => {
    let list: ServerProfile[] = [];
    for (let i = 0; i < MAX_PROFILES + 5; i++) {
      list = rememberProfile(list, 'http://host' + i + ':1', 't', t0 + i);
    }
    expect(list).toHaveLength(MAX_PROFILES);
    // 最新的一条仍在，最早的一条已被丢弃
    expect(list[0].url).toBe('http://host' + (MAX_PROFILES + 4) + ':1');
    expect(list.some((item) => item.url === 'http://host0:1')).toBe(false);
  });

  it('空地址被忽略', () => {
    const list = rememberProfile([{ url: 'http://a:1', token: 't', label: 'a', lastUsedAt: t0 }], '   ', 't');
    expect(list).toHaveLength(1);
  });

  it('传入非法值时不崩', () => {
    expect(rememberProfile(null as unknown as ServerProfile[], 'http://a:1', 't', t0)).toHaveLength(1);
  });
});

describe('查找与删除', () => {
  const list: ServerProfile[] = [
    { url: 'http://a:1', token: 'ta', label: 'a', lastUsedAt: 100 },
    { url: 'http://b:1', token: 'tb', label: 'b', lastUsedAt: 200 },
  ];

  it('mostRecentProfile 取最近一条', () => {
    expect(mostRecentProfile(list)?.url).toBe('http://b:1');
    expect(mostRecentProfile([])).toBeNull();
  });

  it('findProfile 命中与未命中', () => {
    expect(findProfile(list, 'http://a:1')?.token).toBe('ta');
    expect(findProfile(list, 'http://zzz:1')).toBeNull();
  });

  it('forgetProfile 移除指定地址', () => {
    const next = forgetProfile(list, 'http://a:1');
    expect(next).toHaveLength(1);
    expect(next[0].url).toBe('http://b:1');
  });
});

describe('formatRelativeTime', () => {
  const now = 1_700_000_000_000;

  it('分级显示', () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe('刚刚');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 分钟前');
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3 小时前');
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe('2 天前');
  });

  it('超过一周显示日期', () => {
    const old = new Date(2026, 0, 5, 10, 0).getTime();
    const later = new Date(2026, 5, 1, 0, 0).getTime();
    expect(formatRelativeTime(old, later)).toBe('2026-01-05');
  });

  it('未来时间戳（本机与电脑时钟有偏差）按刚刚处理', () => {
    // 设备间时钟不可能完全一致，出现"未来"记录是正常的，不该显示成负数时间
    expect(formatRelativeTime(now + 60_000, now)).toBe('刚刚');
  });

  it('非法时间戳给出占位符', () => {
    expect(formatRelativeTime(0, now)).toBe('从未使用');
    expect(formatRelativeTime(Number.NaN, now)).toBe('从未使用');
  });
});

describe('maskProfileToken', () => {
  it('只露首尾', () => {
    expect(maskProfileToken('abcdefghijklmnop')).toBe('abcd••••mnop');
  });

  it('短令牌整体打码', () => {
    expect(maskProfileToken('short')).toBe('••••••••');
  });

  it('空令牌给出说明', () => {
    expect(maskProfileToken('')).toBe('未记录令牌');
  });
});
