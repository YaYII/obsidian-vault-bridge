/**
 * 访问授权守卫。
 *
 * 电脑端端口一旦对局域网/公网开放，任何能连上的人都会尝试访问，
 * 因此这里做三件事：令牌恒定时间比对、失败次数限流、访问审计。
 */

import { timingSafeEqual } from '../shared/token';

/** 单个 IP 的失败计数窗口 */
const FAILURE_WINDOW_MS = 60_000;
/** 窗口内允许的失败次数，超过即临时封禁 */
const MAX_FAILURES_PER_WINDOW = 8;
/** 触发限流后的封禁时长 */
const BAN_DURATION_MS = 5 * 60_000;

interface FailureRecord {
  count: number;
  windowStart: number;
  bannedUntil: number;
}

export interface AuthResult {
  ok: boolean;
  /** 拒绝原因，便于写入日志与排查 */
  reason?: 'missing_token' | 'bad_token' | 'rate_limited';
  /** 剩余封禁毫秒数 */
  retryAfterMs?: number;
}

/** 令牌校验与暴力破解防护 */
export class AuthGuard {
  private failures = new Map<string, FailureRecord>();

  constructor(private readonly getExpectedToken: () => string) {}

  /**
   * 校验一次请求携带的令牌。
   * @param provided 客户端提交的令牌；未携带时传空串
   * @param clientIp 客户端地址，用于限流分桶
   */
  verify(provided: string, clientIp: string): AuthResult {
    const record = this.failures.get(clientIp);
    const now = Date.now();

    if (record && record.bannedUntil > now) {
      return { ok: false, reason: 'rate_limited', retryAfterMs: record.bannedUntil - now };
    }

    const expected = this.getExpectedToken();
    if (!expected) {
      // 未配置令牌时一律拒绝，避免"空令牌等于免认证"的致命默认
      return { ok: false, reason: 'bad_token' };
    }
    if (!provided) {
      this.recordFailure(clientIp, now);
      return { ok: false, reason: 'missing_token' };
    }

    if (timingSafeEqual(provided, expected)) {
      this.failures.delete(clientIp);
      return { ok: true };
    }

    this.recordFailure(clientIp, now);
    return { ok: false, reason: 'bad_token' };
  }

  private recordFailure(ip: string, now: number): void {
    const record = this.failures.get(ip);
    if (!record || now - record.windowStart > FAILURE_WINDOW_MS) {
      this.failures.set(ip, { count: 1, windowStart: now, bannedUntil: 0 });
      return;
    }
    record.count += 1;
    if (record.count >= MAX_FAILURES_PER_WINDOW) {
      record.bannedUntil = now + BAN_DURATION_MS;
      record.count = 0;
      record.windowStart = now;
    }
  }

  /** 清理过期记录，避免长期运行后 Map 无限增长 */
  sweep(now = Date.now()): void {
    for (const [ip, record] of this.failures) {
      const expired = now - record.windowStart > FAILURE_WINDOW_MS && record.bannedUntil < now;
      if (expired) this.failures.delete(ip);
    }
  }

  /** 重置某 IP 的失败记录（用户手动解锁时使用） */
  reset(ip?: string): void {
    if (ip) this.failures.delete(ip);
    else this.failures.clear();
  }
}

/** 从请求头与查询参数中提取令牌 */
export function extractToken(
  headers: Record<string, string | string[] | undefined>,
  query: URLSearchParams
): string {
  const raw = headers['authorization'];
  const headerValue = Array.isArray(raw) ? raw[0] : raw;
  if (headerValue) {
    const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
    if (match) return match[1].trim();
  }
  return query.get('token') || '';
}
