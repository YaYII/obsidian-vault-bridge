/**
 * 手机端访问电脑的 HTTP 客户端。
 *
 * 全程使用 Obsidian 的 requestUrl 而不是 fetch：
 * 它由原生层实现，绕过浏览器 CORS 与同源限制，是移动端插件访问外部服务的唯一可靠方式。
 */

import { requestUrl } from 'obsidian';
import type { HealthResponse, ListResponse, StatResponse, UploadResponse } from '../shared/types';
import { ROUTES } from '../shared/protocol';

/** 客户端侧可预期的错误，界面据此给出人话提示 */
export class BridgeClientError extends Error {
  constructor(
    message: string,
    public readonly kind: 'network' | 'auth' | 'http' | 'server'
  ) {
    super(message);
    this.name = 'BridgeClientError';
  }
}

/** 把用户输入的地址整理成规范形式 */
export function normalizeBaseUrl(raw: string): string {
  let value = (raw || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) {
    value = 'http://' + value;
  }
  return value.replace(/\/+$/, '');
}

interface CallOptions {
  method?: 'GET' | 'POST';
  query?: Record<string, string>;
  body?: ArrayBuffer;
  /** 期望返回二进制而不是 JSON */
  binary?: boolean;
  /** 登录校验失败时抛出 auth 错误 */
  timeoutMs?: number;
}

export class BridgeClient {
  private readonly baseUrl: string;

  constructor(
    serverUrl: string,
    private readonly token: string
  ) {
    this.baseUrl = normalizeBaseUrl(serverUrl);
  }

  /** 地址是否已填写 */
  get configured(): boolean {
    return this.baseUrl.length > 0 && this.token.length > 0;
  }

  /** 连接信息摘要，用于界面显示 */
  get endpoint(): string {
    return this.baseUrl;
  }

  /** 连通性探测（无需令牌），用于区分「地址不对」与「令牌不对」 */
  async health(): Promise<HealthResponse> {
    return (await this.call(ROUTES.health, { method: 'GET' })) as HealthResponse;
  }

  /** 校验令牌是否有效 */
  async verify(): Promise<void> {
    await this.call(ROUTES.verify, { method: 'GET' });
  }

  /** 列目录 */
  async list(path: string): Promise<ListResponse> {
    return (await this.call(ROUTES.list, { query: { path } })) as ListResponse;
  }

  /** 取文件元信息 */
  async stat(path: string): Promise<StatResponse> {
    return (await this.call(ROUTES.stat, { query: { path } })) as StatResponse;
  }

  /** 下载文件内容 */
  async download(path: string): Promise<ArrayBuffer> {
    return (await this.call(ROUTES.download, { query: { path }, binary: true })) as ArrayBuffer;
  }

  /** 上传文件内容 */
  async upload(path: string, data: ArrayBuffer): Promise<UploadResponse> {
    return (await this.call(ROUTES.upload, {
      method: 'POST',
      query: { path },
      body: data,
    })) as UploadResponse;
  }

  /** 新建目录 */
  async mkdir(path: string): Promise<void> {
    await this.call(ROUTES.mkdir, { method: 'POST', query: { path } });
  }

  /** 统一请求封装：拼 URL、带令牌、把各类失败翻译成可读错误 */
  private async call(route: string, options: CallOptions): Promise<unknown> {
    if (!this.baseUrl) {
      throw new BridgeClientError('还没有填写电脑地址', 'network');
    }

    const url = new URL(this.baseUrl + route);
    if (options.query) {
      for (const key of Object.keys(options.query)) {
        url.searchParams.set(key, options.query[key]);
      }
    }

    let response;
    try {
      response = await requestUrl({
        url: url.toString(),
        method: options.method || 'GET',
        headers: {
          Authorization: 'Bearer ' + this.token,
        },
        body: options.body,
        throw: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BridgeClientError(
        '连不上电脑（' + message + '）。请确认：电脑端服务已开启、手机与电脑在同一 WiFi、地址与端口填写正确',
        'network'
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new BridgeClientError('令牌无效或已失效，请在电脑端设置页复制最新令牌', 'auth');
    }
    if (response.status === 429) {
      throw new BridgeClientError('尝试次数过多，已被电脑端临时限流，请稍后再试', 'auth');
    }
    if (response.status >= 400) {
      let detail = 'HTTP ' + response.status;
      try {
        const parsed = JSON.parse(response.text);
        if (parsed && parsed.message) detail = parsed.message;
      } catch {
        /* 响应不是 JSON，保留状态码 */
      }
      throw new BridgeClientError(detail, 'http');
    }

    if (options.binary) {
      return response.arrayBuffer;
    }
    if (!response.text) return {};
    try {
      return JSON.parse(response.text);
    } catch {
      throw new BridgeClientError('电脑返回了无法解析的内容', 'server');
    }
  }
}
