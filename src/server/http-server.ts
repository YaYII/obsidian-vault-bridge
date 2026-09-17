/**
 * Node HTTP 服务器装配层（仅桌面端）。
 *
 * 分工：本文件只负责「把 Node 的请求对象搬进路由层、把路由结果搬回响应」，
 * 所有业务判断都在 router.ts 里，保持可测试。
 *
 * 移动端兼容的关键：本文件用到的 Node 内置模块全部走 nodeRequire 惰性解析，
 * 且整个类只在 Platform.isDesktopApp 为真时才被实例化。esbuild 已将这些模块
 * 标记为 external，产物里保留为原样的 require()，iOS 加载 main.js 时不会触发。
 */

import type { Vault } from 'obsidian';

/**
 * Node HTTP 对象的结构化类型。
 *
 * 刻意不写 `import ... from 'http'`——静态 import 会被判定为引入了 Node 内置模块
 * （移动端并不存在），而本文件只在桌面端执行。改用类型查询表达依赖：
 * 它只存在于类型层，编译后完全消失，运行时零影响。
 */
type ServerLike = import('http').Server;
type RequestLike = import('http').IncomingMessage;
type ResponseLike = import('http').ServerResponse;
import type { AccessLogEntry } from '../shared/types';
import { AuthGuard } from './auth';
import { handleRequest, type BridgeRequest, type BridgeResponse, type BridgeRuntimeSettings } from './router';

/** 宿主（插件）需要提供给服务器的能力 */
export interface ServerHost {
  vault: Vault;
  version: string;
  /** 每次请求都重新读取，保证设置改动立即生效 */
  getRuntimeSettings: () => BridgeRuntimeSettings;
  logAccess: (entry: AccessLogEntry) => void;
  /** 服务器层面的异常（端口占用、监听失败）上报给界面 */
  reportError: (message: string) => void;
  /** 插件自身的安装目录，用于给手机打包安装文件 */
  getPluginDir: () => string;
}

/**
 * 惰性解析 Node 内置模块。
 * 调用方必须是桌面端路径，移动端不存在这些模块。
 */
function nodeRequire<T>(id: string): T {
  // 构建时这些模块被标记为 external，因此这里保留为运行时的 require。
  const loader = require as unknown as (moduleId: string) => T;
  return loader(id);
}

/**
 * 按总长度一次性分配后拷贝。
 * 不用 Node 的 Buffer：那是仅在桌面端存在的全局，
 * 用标准 Uint8Array 可以让这份代码不依赖任何 Node 全局。
 */
function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** 把 IPv6 映射地址还原成易读的 IPv4 */
function humanizeIp(raw: string | undefined): string {
  if (!raw) return 'unknown';
  if (raw.indexOf('::ffff:') === 0) return raw.slice(7);
  return raw;
}

export class BridgeServer {
  private server: ServerLike | null = null;
  private boundPort = 0;
  private readonly guard: AuthGuard;
  private sweepTimer: number | null = null;

  constructor(private readonly host: ServerHost) {
    this.guard = new AuthGuard(() => this.host.getRuntimeSettings().token);
  }

  /** 是否正在监听 */
  get isRunning(): boolean {
    return this.server !== null;
  }

  /** 实际生效的端口（0 表示未运行） */
  get port(): number {
    return this.boundPort;
  }

  /** 启动监听；已在运行时先停再起，实现「改端口即生效」 */
  async start(port: number): Promise<void> {
    if (this.server) {
      await this.stop();
    }

    const http = nodeRequire<typeof import('http')>('http');

    const server = http.createServer((req, res) => {
      this.handleNodeRequest(req, res).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.host.reportError('请求处理异常：' + message);
        try {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'internal_error', message }));
        } catch {
          /* 响应可能已经开始写出，忽略 */
        }
      });
    });

    // 大文件上传需要更宽松的头部超时，但保持整体可控
    server.headersTimeout = 60_000;
    server.requestTimeout = 0;
    server.keepAliveTimeout = 15_000;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        if (error.code === 'EADDRINUSE') {
          reject(new Error(`端口 ${port} 已被占用，请换一个端口`));
        } else if (error.code === 'EACCES') {
          reject(new Error(`没有权限监听端口 ${port}（1024 以下端口需要管理员权限）`));
        } else {
          reject(new Error('监听失败：' + error.message));
        }
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // 绑定 0.0.0.0，手机才能通过局域网地址访问
      server.listen(port, '0.0.0.0');
    });

    this.server = server;
    const address = server.address();
    this.boundPort = address && typeof address === 'object' ? address.port : port;

    // 定期清理限流表，避免长期运行内存增长
    // 用 window.setInterval 而不是裸 setInterval：Obsidian 建议如此以兼容弹出窗口。
    this.sweepTimer = window.setInterval(() => this.guard.sweep(), 60_000);

    // Office 场景下定时器不影响进程退出；但在纯 Node 环境（产物验证脚本）里
    // 若定时器未被清理会挂住进程，因此能 unref 就 unref。
    const timer = this.sweepTimer as unknown as { unref?: () => void };
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  /** 停止监听并断开所有连接 */
  async stop(): Promise<void> {
    if (this.sweepTimer) {
      window.clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.boundPort = 0;

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // 主动断开 keep-alive 连接，否则 close 会一直等待
      if (
        typeof (server as unknown as { closeAllConnections?: () => void }).closeAllConnections === 'function'
      ) {
        (server as unknown as { closeAllConnections: () => void }).closeAllConnections();
      }
      window.setTimeout(resolve, 2000);
    });
  }

  /** 重置某个 IP 的失败计数（用户在设置页手动解锁） */
  unlock(ip?: string): void {
    this.guard.reset(ip);
  }

  /** 把 Node 请求转成路由层输入，再写回响应 */
  private async handleNodeRequest(req: RequestLike, res: ResponseLike): Promise<void> {
    // 浏览器预检：允许手机浏览器与第三方客户端跨域调用
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      this.applyCors(res);
      res.setHeader('access-control-max-age', '86400');
      res.end();
      return;
    }

    const settings = this.host.getRuntimeSettings();
    const bodyResult = await this.readBody(req, settings.maxUploadBytes);

    if (bodyResult.tooLarge) {
      this.applyCors(res);
      res.statusCode = 413;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          error: 'too_large',
          message: `文件超过上限 ${Math.round(settings.maxUploadBytes / 1024 / 1024)} MB`,
        })
      );
      return;
    }

    const url = new URL(req.url || '/', 'http://localhost');
    let pathname = url.pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      /* 保持原样，交给路由层判断 */
    }

    const bridgeRequest: BridgeRequest = {
      method: (req.method || 'GET').toUpperCase(),
      pathname,
      query: url.searchParams,
      headers: req.headers,
      body: bodyResult.body,
      ip: humanizeIp(req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : undefined),
    };

    const response: BridgeResponse = await handleRequest(
      {
        vault: this.host.vault,
        version: this.host.version,
        getSettings: this.host.getRuntimeSettings,
        guard: this.guard,
        logAccess: this.host.logAccess,
        getPluginDir: this.host.getPluginDir,
      },
      bridgeRequest
    );

    this.applyCors(res);
    res.statusCode = response.status;
    for (const key of Object.keys(response.headers)) {
      res.setHeader(key, response.headers[key]);
    }
    if (typeof response.body === 'string') {
      res.end(response.body);
    } else {
      res.end(response.body);
    }
  }

  /** 读取请求体，超过上限立刻停止累积并丢弃后续数据 */
  private readBody(req: RequestLike, maxBytes: number): Promise<{ body: Uint8Array; tooLarge: boolean }> {
    return new Promise((resolve) => {
      const chunks: Uint8Array[] = [];
      let total = 0;
      let tooLarge = false;

      req.on('data', (chunk: Uint8Array) => {
        if (tooLarge) return;
        total += chunk.length;
        if (total > maxBytes) {
          tooLarge = true;
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooLarge) {
          resolve({ body: new Uint8Array(0), tooLarge: true });
          return;
        }
        resolve({ body: concatBytes(chunks), tooLarge: false });
      });
      req.on('error', () => {
        resolve({ body: new Uint8Array(0), tooLarge: false });
      });
    });
  }

  private applyCors(res: ResponseLike): void {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-expose-headers', 'content-disposition, content-length');
  }
}
