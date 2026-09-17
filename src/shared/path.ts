/**
 * vault 路径规范化与安全校验。
 *
 * 这是服务端的第一道防线：任何来自网络的路径都必须先经过 normalizeVaultPath，
 * 确保它无法逃出 vault 根目录，也无法触碰被禁用的敏感目录。
 * 纯函数、无副作用，便于单元测试穷举攻击面。
 */

/** 默认禁止通过网络访问的目录（配置目录内含 API key、令牌等机密） */
export const BLOCKED_PREFIXES = ['.obsidian'];

/** 路径非法时抛出，由上层转换成 HTTP 400 */
export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

/**
 * 把任意客户端输入整理成 vault 内相对路径。
 *
 * 接受：`''`、`'a/b.md'`、`'/a/b.md'`、`'a\\b.md'`
 * 拒绝：`'../etc/passwd'`、`'/etc/passwd'`、`'a/../../x'`、含 NUL、含盘符
 *
 * @param input 客户端原始路径
 * @param options.allowHidden 是否放行 `.obsidian` 等敏感目录（默认 false）
 * @returns 规范化后的相对路径；vault 根返回空串
 * @throws {UnsafePathError} 路径试图越界或触碰禁用目录
 */
export function normalizeVaultPath(input: string, options: { allowHidden?: boolean } = {}): string {
  if (typeof input !== 'string') {
    throw new UnsafePathError('路径必须是字符串');
  }
  if (input.indexOf('\u0000') !== -1) {
    throw new UnsafePathError('路径包含非法字符');
  }

  // 统一分隔符：Windows 客户端可能送来反斜杠
  const unified = input.replace(/\\/g, '/');

  // 去掉多余的起始斜杠，使其相对化；后续逐段校验真正的越界
  const withoutLeading = unified.replace(/^\/+/, '');

  // 拒绝 Windows 盘符（C:/...）与 UNC 残留
  if (/^[a-zA-Z]:/.test(withoutLeading)) {
    throw new UnsafePathError('不接受绝对路径');
  }

  const stack: string[] = [];
  for (const rawSegment of withoutLeading.split('/')) {
    const segment = rawSegment.trim();
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (stack.length === 0) {
        throw new UnsafePathError('路径越出知识库范围');
      }
      stack.pop();
      continue;
    }
    stack.push(segment);
  }

  const normalized = stack.join('/');

  if (!options.allowHidden) {
    const lower = normalized.toLowerCase();
    for (const prefix of BLOCKED_PREFIXES) {
      if (lower === prefix || lower.startsWith(prefix + '/')) {
        throw new UnsafePathError('该目录受保护，不允许通过网络访问');
      }
    }
  }

  return normalized;
}

/** 拼接父路径与子名，返回新的相对路径 */
export function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** 取父目录相对路径；已在根时返回 null */
export function parentOf(path: string): string | null {
  if (!path) return null;
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

/** 取路径最后一段作为显示名 */
export function baseName(path: string): string {
  if (!path) return '';
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

/** 判断路径本身或其祖先是否命中禁用前缀 */
export function isBlockedPath(path: string): boolean {
  const lower = path.toLowerCase();
  return BLOCKED_PREFIXES.some((p) => lower === p || lower.startsWith(p + '/'));
}
