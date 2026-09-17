/**
 * 两端共享的协议常量。改这里等于改契约，电脑端与手机端同时生效。
 */

/** 电脑端默认监听端口 */
export const DEFAULT_PORT = 8770;

/** 插件名（用于健康检查响应与页面标题） */
export const APP_NAME = 'Vault Bridge';

/** 认证请求头名称 */
export const AUTH_HEADER = 'authorization';

/** 认证方案前缀 */
export const AUTH_SCHEME = 'Bearer';

/** 也支持用查询参数携带令牌，便于浏览器直接点开下载链接 */
export const AUTH_QUERY_KEY = 'token';

/** 单次上传字节上限默认值（32 MiB）。手机端把文件读进内存，过大易触发 iOS WebView 内存告警 */
export const DEFAULT_MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/** 接口路径 */
export const ROUTES = {
  /** 手机浏览器访问的图形界面 */
  ui: '/',
  /** 无需授权的连通性探测 */
  health: '/api/health',
  /** 校验令牌是否有效 */
  verify: '/api/verify',
  /** 列目录 */
  list: '/api/list',
  /** 文件元信息 */
  stat: '/api/stat',
  /** 下载文件 */
  download: '/api/download',
  /** 上传文件（原始字节流写入） */
  upload: '/api/upload',
  /** 新建目录 */
  mkdir: '/api/mkdir',
  /** 手机端安装引导页 */
  setup: '/setup',
  /** 插件自身安装包（供手机下载安装） */
  setupBundle: '/setup/plugin.zip',
} as const;

/** 安装包里需要打包的插件文件，顺序即解压后的呈现顺序 */
export const BUNDLE_FILES = ['manifest.json', 'main.js', 'styles.css'] as const;

/** 默认排除同步的目录（客户端列表时直接过滤，减少噪音） */
export const DEFAULT_EXCLUDED_DIRS = ['.obsidian', '.trash', '.git'];
