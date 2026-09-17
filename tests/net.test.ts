/** 网卡地址探测——决定设置页告诉用户「手机该输哪个网址」。 */

import { describe, expect, it, vi } from 'vitest';

const fakeInterfaces = {
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  eno1: [{ address: '192.168.1.44', family: 'IPv4', internal: false }],
  docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
  virbr0: [{ address: '192.168.122.1', family: 'IPv4', internal: false }],
  'br-abc123': [{ address: '172.28.0.1', family: 'IPv4', internal: false }],
  wlan0: [{ address: '10.0.0.8', family: 'IPv4', internal: false }],
  'en0.100': [{ address: '2001:db8::1', family: 'IPv6', internal: false }],
};

vi.mock('../src/server/node-modules', () => ({
  nodeRequire: (id: string) => {
    if (id === 'os') return { networkInterfaces: () => fakeInterfaces };
    throw new Error('测试未预期的模块：' + id);
  },
}));

const { listListenAddresses } = await import('../src/server/net');

describe('listListenAddresses', () => {
  it('拼出带端口的 http 地址', () => {
    const result = listListenAddresses(8770);
    expect(result.some((item) => item.url === 'http://192.168.1.44:8770')).toBe(true);
  });

  it('过滤回环地址（手机连不上）', () => {
    const result = listListenAddresses(8770);
    expect(result.some((item) => item.url.indexOf('127.0.0.1') !== -1)).toBe(false);
  });

  it('过滤 IPv6', () => {
    const result = listListenAddresses(8770);
    expect(result.every((item) => item.url.indexOf('2001:') === -1)).toBe(true);
  });

  it('真实局域网网卡排在虚拟网桥前面', () => {
    const result = listListenAddresses(8770);
    const realIndex = result.findIndex((item) => item.iface === 'eno1');
    const dockerIndex = result.findIndex((item) => item.iface === 'docker0');
    expect(realIndex).toBeGreaterThanOrEqual(0);
    expect(dockerIndex).toBeGreaterThan(realIndex);
    expect(result[0].iface).toBe('eno1');
  });

  it('标记虚拟网卡为不优先', () => {
    const result = listListenAddresses(8770);
    const docker = result.find((item) => item.iface === 'docker0');
    const real = result.find((item) => item.iface === 'eno1');
    expect(docker && docker.preferred).toBe(false);
    expect(real && real.preferred).toBe(true);
  });

  it('端口变化反映到地址里', () => {
    const result = listListenAddresses(9999);
    expect(result[0].url).toContain(':9999');
  });
});
