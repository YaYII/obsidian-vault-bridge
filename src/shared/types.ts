/**
 * Vault Bridge 的跨端共享类型：电脑端服务与手机端客户端都依赖这里，
 * 保证两侧对协议的理解只有一个事实源。
 */

/** 目录项类型 */
export type EntryKind = 'file' | 'folder';

/** 列表接口返回的单个条目 */
export interface BridgeEntry {
  /** 条目名（不含父路径） */
  name: string;
  /** vault 内相对路径，正斜杠分隔 */
  path: string;
  kind: EntryKind;
  /** 字节数；目录为 0 */
  size: number;
  /** 最后修改时间（毫秒时间戳） */
  mtime: number;
}

/** GET /api/list 响应 */
export interface ListResponse {
  /** 被列出的目录相对路径（vault 根为空串） */
  path: string;
  /** 父目录相对路径；已在根时为 null */
  parent: string | null;
  entries: BridgeEntry[];
}

/** GET /api/stat 响应 */
export interface StatResponse {
  path: string;
  size: number;
  mtime: number;
}

/** GET /api/health 响应（无需授权，用于连通性探测） */
export interface HealthResponse {
  ok: true;
  app: string;
  version: string;
  /** 服务端时间，便于客户端判断时钟偏差 */
  time: number;
}

/** 统一错误响应 */
export interface ErrorResponse {
  error: string;
  message: string;
}

/** 上传成功响应 */
export interface UploadResponse {
  path: string;
  size: number;
  /** created = 新建文件；updated = 覆盖已有文件 */
  action: 'created' | 'updated';
}

/** 电脑端记录的一条访问日志，显示在设置页里供用户审计 */
export interface AccessLogEntry {
  at: number;
  ip: string;
  method: string;
  /** 请求路径与查询串（已脱敏 token） */
  target: string;
  status: number;
  /** 人类可读的动作描述，例如「下载 团队知识库/a.md」 */
  action: string;
}
