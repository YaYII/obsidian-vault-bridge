/**
 * 连接档案（服务器地址 + 令牌）的保存与选择逻辑。
 *
 * 为什么需要它：手机要连的地址不止一个——在家是局域网 IP，出门是公网隧道域名，
 * 而隧道域名每次重建都会变；令牌还是 32 位随机串，手输既不现实也容易错。
 * 所以把「曾经连通过的地址 + 对应令牌」记下来，下次直接选。
 *
 * 纯函数、无副作用，便于穷举各种边界（空值、重复地址、超量、时间显示）。
 */

/** 一条连接档案 */
export interface ServerProfile {
  /** 规范化后的服务器地址，作为去重键 */
  url: string;
  /** 该服务器（电脑）的访问令牌 —— 注意不是本机插件自己的令牌 */
  token: string;
  /** 便于识别的名字，自动推断，用户无需填写 */
  label: string;
  /** 最后使用时间（毫秒时间戳） */
  lastUsedAt: number;
}

/** 最多保留的档案条数，避免设置文件无限膨胀 */
export const MAX_PROFILES = 12;

/** 去掉协议与路径，取出主机名 */
function hostOf(url: string): string {
  return url
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .split(':')[0];
}

/**
 * 根据地址推断一个能一眼认出的名字。
 * 目的是让用户不用自己起名，看到列表就知道该选哪条。
 */
export function inferProfileLabel(url: string): string {
  const host = hostOf(url).toLowerCase();
  if (!host) return '未命名';
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return '本机';
  }
  if (/\.trycloudflare\.com$/.test(host)) {
    return '公网隧道';
  }
  if (/\.ngrok(-free)?\.(dev|app|io)$/.test(host)) {
    return 'ngrok 隧道';
  }
  // RFC1918 私有网段：局域网
  if (/^192\.168\./.test(host) || /^10\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return '局域网';
  }
  return host;
}

/**
 * 记录一次成功连接。
 *
 * 规则：
 *  - 同一地址只保留一条（更新令牌与时间），避免历史里堆满重复项；
 *  - 按最后使用时间倒序排列，最常用的排在最前；
 *  - 超过上限时丢弃最久未用的。
 */
export function rememberProfile(
  profiles: ServerProfile[],
  url: string,
  token: string,
  now: number = Date.now()
): ServerProfile[] {
  const normalizedUrl = (url || '').trim();
  if (!normalizedUrl) return profiles.slice();

  const list = Array.isArray(profiles) ? profiles.slice() : [];
  const existingIndex = list.findIndex((item) => item.url === normalizedUrl);

  if (existingIndex === -1) {
    list.push({
      url: normalizedUrl,
      token: token || '',
      label: inferProfileLabel(normalizedUrl),
      lastUsedAt: now,
    });
  } else {
    const existing = list[existingIndex];
    list[existingIndex] = {
      url: existing.url,
      // 令牌变化时以新值覆盖（用户在电脑端重新生成过）
      token: token || existing.token,
      label: existing.label || inferProfileLabel(normalizedUrl),
      lastUsedAt: now,
    };
  }

  list.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  return list.slice(0, MAX_PROFILES);
}

/** 取最近使用的一条；没有则返回 null */
export function mostRecentProfile(profiles: ServerProfile[]): ServerProfile | null {
  if (!Array.isArray(profiles) || profiles.length === 0) return null;
  return profiles.reduce((best, item) => (item.lastUsedAt > best.lastUsedAt ? item : best));
}

/** 按地址查找档案 */
export function findProfile(profiles: ServerProfile[], url: string): ServerProfile | null {
  if (!Array.isArray(profiles)) return null;
  return profiles.find((item) => item.url === url) || null;
}

/** 从列表中移除指定地址 */
export function forgetProfile(profiles: ServerProfile[], url: string): ServerProfile[] {
  if (!Array.isArray(profiles)) return [];
  return profiles.filter((item) => item.url !== url);
}

/** 把时间戳格式化为便于扫读的相对时间 */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '从未使用';
  const diff = now - timestamp;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前';
  if (diff < 7 * 86_400_000) return Math.floor(diff / 86_400_000) + ' 天前';
  const d = new Date(timestamp);
  const pad = (n: number) => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** 令牌打码显示，列表里不该出现完整令牌 */
export function maskProfileToken(token: string): string {
  if (!token) return '未记录令牌';
  if (token.length <= 8) return '••••••••';
  return token.slice(0, 4) + '••••' + token.slice(-4);
}
