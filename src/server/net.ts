/** 本机网络地址探测（仅桌面端），用于在设置页告诉用户「手机该输哪个网址」。 */

import { nodeRequire } from './node-modules';

export interface ListenAddress {
  /** 形如 http://192.168.1.44:8770 */
  url: string;
  /** 网卡名，便于用户辨认该选哪个 */
  iface: string;
  /** 是否像是可用的局域网地址（过滤掉 Docker/虚拟网桥） */
  preferred: boolean;
}

/** 常见虚拟网卡名前缀，这些地址手机通常连不上，排在后面 */
const VIRTUAL_IFACE_PATTERNS = [
  /^docker/i,
  /^br-/i,
  /^virbr/i,
  /^veth/i,
  /^vmnet/i,
  /^vboxnet/i,
  /^tun/i,
  /^tap/i,
  /^utun/i,
];

function isVirtual(iface: string): boolean {
  return VIRTUAL_IFACE_PATTERNS.some((pattern) => pattern.test(iface));
}

/**
 * 列出所有可让手机访问的地址。
 * 回环地址不展示（手机连不上），虚拟网卡地址排在最后。
 */
export function listListenAddresses(port: number): ListenAddress[] {
  const os = nodeRequire<typeof import('os')>('os');
  const interfaces = os.networkInterfaces();
  const result: ListenAddress[] = [];

  for (const iface of Object.keys(interfaces)) {
    const addresses = interfaces[iface];
    if (!addresses) continue;
    for (const address of addresses) {
      if (address.family !== 'IPv4' || address.internal) continue;
      result.push({
        url: `http://${address.address}:${port}`,
        iface,
        preferred: !isVirtual(iface),
      });
    }
  }

  result.sort((a, b) => {
    if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
    return a.iface.localeCompare(b.iface);
  });
  return result;
}
