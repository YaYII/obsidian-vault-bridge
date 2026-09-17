/**
 * HTTP 路由层。
 *
 * 刻意与 Node 的 http 模块解耦：输入是一个普通对象，输出也是一个普通对象，
 * 真实 HTTP 服务器只负责搬运。好处是这一层可以在单元测试里直接穷举调用，
 * 包括伪造 `../` 路径、错误令牌、超大请求等攻击面，不需要真的起端口。
 */

import type { Vault } from 'obsidian';
import { BUNDLE_FILES, ROUTES } from '../shared/protocol';
import { UnsafePathError, normalizeVaultPath } from '../shared/path';
import { mimeOf } from '../shared/mime';
import { baseName } from '../shared/path';
import type {
  AccessLogEntry,
  ErrorResponse,
  HealthResponse,
  ListResponse,
  UploadResponse,
} from '../shared/types';
import { AuthGuard, extractToken } from './auth';
import {
  BridgeOpError,
  ensureFolder,
  listFolder,
  readFileBinary,
  statFile,
  writeFileBinary,
} from './vault-ops';
import { renderWebUi } from './web-ui';
import { renderSetupPage } from './setup-page';
import { buildZip } from './zip';
import { nodeRequire } from './node-modules';

/** 路由层需要的运行上下文 */
export interface BridgeContext {
  vault: Vault;
  /** 当前版本号，用于健康检查 */
  version: string;
  /** 读取当前设置的快照（每次请求都重新读，改设置立即生效） */
  getSettings: () => BridgeRuntimeSettings;
  guard: AuthGuard;
  /** 记录一次访问，供设置页审计展示 */
  logAccess: (entry: AccessLogEntry) => void;
  /** 插件自身的安装目录（仅电脑端有值），用于给手机打包安装文件 */
  getPluginDir: () => string;
}

/** 路由层真正关心的设置子集 */
export interface BridgeRuntimeSettings {
  token: string;
  allowUpload: boolean;
  /** 列为空的字符串 */
  excludedDirs: string[];
  maxUploadBytes: number;
}

/** 与具体 HTTP 实现无关的请求描述 */
export interface BridgeRequest {
  method: string;
  /** 已解码的路径部分，例如 `/api/download` */
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  /** 请求体；非上传请求为空 */
  body: Uint8Array;
  /** 客户端地址，仅用于日志与限流 */
  ip: string;
}

/** 与具体 HTTP 实现无关的响应描述 */
export interface BridgeResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | string;
}

const TEXT_ENCODER = new TextEncoder();

function jsonResponse(status: number, payload: unknown): BridgeResponse {
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(payload),
  };
}

function errorResponse(status: number, error: string, message: string): BridgeResponse {
  const payload: ErrorResponse = { error, message };
  return jsonResponse(status, payload);
}

function htmlResponse(status: number, html: string): BridgeResponse {
  return {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: html,
  };
}

/** 生成兼顾老浏览器的下载响应头，中文文件名用 RFC 5987 形式编码 */
function contentDisposition(fileName: string): string {
  const asciiFallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  const encoded = encodeURIComponent(fileName);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * 处理一次请求。任何异常都会被收敛为结构化错误响应，不会让服务器崩溃。
 */
export async function handleRequest(ctx: BridgeContext, req: BridgeRequest): Promise<BridgeResponse> {
  const settings = ctx.getSettings();
  const started = Date.now();
  let action = '';
  let response: BridgeResponse;

  try {
    response = await route(ctx, req, settings, (label) => {
      action = label;
    });
  } catch (error) {
    if (error instanceof UnsafePathError) {
      response = errorResponse(400, 'unsafe_path', error.message);
    } else if (error instanceof BridgeOpError) {
      const statusMap: Record<BridgeOpError['code'], number> = {
        not_found: 404,
        not_a_folder: 400,
        conflict: 409,
        forbidden: 403,
        too_large: 413,
      };
      response = errorResponse(statusMap[error.code], error.code, error.message);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      response = errorResponse(500, 'internal_error', message);
    }
  }

  const elapsed = Date.now() - started;
  if (response.status >= 400) {
    action = action ? action + '（失败）' : '请求失败';
  }
  ctx.logAccess({
    at: started,
    ip: req.ip,
    method: req.method,
    target: req.pathname + (req.query.toString() ? '?' + redactQuery(req.query) : ''),
    status: response.status,
    action: action ? `${action} ${elapsed}ms` : `${req.method} ${elapsed}ms`,
  });

  return response;
}

/** 日志里不能出现明文令牌 */
function redactQuery(query: URLSearchParams): string {
  const parts: string[] = [];
  query.forEach((value, key) => {
    parts.push(key === 'token' ? 'token=***' : `${key}=${value}`);
  });
  return parts.join('&');
}

async function route(
  ctx: BridgeContext,
  req: BridgeRequest,
  settings: BridgeRuntimeSettings,
  setAction: (label: string) => void
): Promise<BridgeResponse> {
  const { pathname, method } = req;

  /**
   * 统一的路径解析入口。
   * 把 vault 的真实配置目录带进安全校验——配置目录可被用户改名，
   * 靠固定字面量屏蔽会在自定义配置下失效。
   */
  const resolveRequestPath = (raw: string): string =>
    normalizeVaultPath(raw, { configDir: ctx.vault.configDir });

  // 健康检查放在鉴权之前：手机端要能判断「地址通不通」与「令牌对不对」是两类问题
  if (pathname === ROUTES.health) {
    const payload: HealthResponse = { ok: true, app: 'Vault Bridge', version: ctx.version, time: Date.now() };
    setAction('健康检查');
    return jsonResponse(200, payload);
  }

  const provided = extractToken(req.headers, req.query);

  // 安装指引页本身不含机密（令牌由页面脚本从地址栏读取），因此无需认证也能查看，
  // 否则用户第一次拿到地址却还没配令牌时会卡在这里。
  if (pathname === ROUTES.setup && method === 'GET') {
    setAction('打开手机安装指引');
    return htmlResponse(200, renderSetupPage());
  }

  // 手机浏览器打开根路径时，没有令牌就渲染「输入令牌」页面，而不是干巴巴的 401
  if (pathname === ROUTES.ui && method === 'GET') {
    const auth = ctx.guard.verify(provided, req.ip);
    if (!auth.ok) {
      setAction('打开网页（未授权）');
      return htmlResponse(200, renderWebUi({ authenticated: false }));
    }
    setAction('打开网页');
    return htmlResponse(200, renderWebUi({ authenticated: true }));
  }

  const auth = ctx.guard.verify(provided, req.ip);
  if (!auth.ok) {
    if (auth.reason === 'rate_limited') {
      setAction('令牌错误过多已被限流');
      return errorResponse(
        429,
        'rate_limited',
        `尝试次数过多，请 ${Math.ceil((auth.retryAfterMs || 0) / 1000)} 秒后重试`
      );
    }
    setAction('令牌校验失败');
    return errorResponse(401, auth.reason || 'unauthorized', '令牌无效或缺失');
  }

  switch (pathname) {
    case ROUTES.verify: {
      setAction('校验令牌');
      return jsonResponse(200, { ok: true, version: ctx.version });
    }

    case ROUTES.list: {
      const dir = resolveRequestPath(req.query.get('path') || '');
      const payload: ListResponse = listFolder(ctx.vault, dir, settings.excludedDirs);
      setAction(`列出目录 ${dir || '/'}`);
      return jsonResponse(200, payload);
    }

    case ROUTES.stat: {
      const target = resolveRequestPath(req.query.get('path') || '');
      const payload = statFile(ctx.vault, target);
      setAction(`查看信息 ${target}`);
      return jsonResponse(200, payload);
    }

    case ROUTES.download: {
      const target = resolveRequestPath(req.query.get('path') || '');
      const { data, name } = await readFileBinary(ctx.vault, target);
      setAction(`下载 ${target}`);
      return {
        status: 200,
        headers: {
          'content-type': mimeOf(name),
          'content-length': String(data.byteLength),
          'content-disposition': contentDisposition(name),
          'cache-control': 'no-store',
        },
        body: new Uint8Array(data),
      };
    }

    case ROUTES.upload: {
      if (method !== 'POST') return errorResponse(405, 'method_not_allowed', '上传请使用 POST');
      if (!settings.allowUpload) {
        setAction('上传被拒绝（已关闭上传）');
        return errorResponse(403, 'upload_disabled', '电脑端已关闭上传功能');
      }
      const target = resolveRequestPath(req.query.get('path') || '');
      if (!target) return errorResponse(400, 'bad_request', '必须指定上传目标路径');
      if (req.body.byteLength === 0) return errorResponse(400, 'bad_request', '请求体为空');
      if (req.body.byteLength > settings.maxUploadBytes) {
        return errorResponse(
          413,
          'too_large',
          `文件超过上限 ${Math.round(settings.maxUploadBytes / 1024 / 1024)} MB`
        );
      }
      // 复制一份，避免 Node Buffer 的底层 ArrayBuffer 被复用
      const bytes = new Uint8Array(req.body.byteLength);
      bytes.set(req.body);
      const payload: UploadResponse = await writeFileBinary(ctx.vault, target, bytes.buffer);
      setAction(`${payload.action === 'created' ? '上传新建' : '上传覆盖'} ${payload.path}`);
      return jsonResponse(200, payload);
    }

    case ROUTES.setupBundle: {
      if (method !== 'GET') return errorResponse(405, 'method_not_allowed', '请使用 GET');
      const pluginDir = ctx.getPluginDir();
      if (!pluginDir) {
        return errorResponse(500, 'unsupported', '当前环境无法读取插件目录（仅电脑端支持打包）');
      }
      const fs = nodeRequire<typeof import('fs')>('fs');
      const nodePath = nodeRequire<typeof import('path')>('path');
      const entries = BUNDLE_FILES.map((name) => ({
        name,
        data: new Uint8Array(fs.readFileSync(nodePath.join(pluginDir, name))),
      }));
      const archive = buildZip(entries);
      setAction('下载手机安装包');
      return {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-length': String(archive.byteLength),
          'content-disposition': 'attachment; filename="vault-bridge-plugin.zip"',
          'cache-control': 'no-store',
        },
        body: archive,
      };
    }

    case ROUTES.mkdir: {
      if (method !== 'POST') return errorResponse(405, 'method_not_allowed', '新建目录请使用 POST');
      if (!settings.allowUpload) {
        return errorResponse(403, 'upload_disabled', '电脑端已关闭写操作');
      }
      const target = resolveRequestPath(req.query.get('path') || '');
      if (!target) return errorResponse(400, 'bad_request', '必须指定目录路径');
      await ensureFolder(ctx.vault, target);
      setAction(`新建目录 ${target}`);
      return jsonResponse(200, { path: target, ok: true });
    }

    default: {
      setAction('未知接口');
      return errorResponse(404, 'not_found', '没有这个接口：' + pathname);
    }
  }
}

/** 供测试与调用方复用的编码器 */
export function encodeText(text: string): Uint8Array {
  return TEXT_ENCODER.encode(text);
}

/** 下载链接里带上文件名，便于客户端保存 */
export function downloadName(path: string): string {
  return baseName(path);
}
