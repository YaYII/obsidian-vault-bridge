/**
 * vault 路径规范化与安全校验。
 *
 * 这是服务端的第一道防线：任何来自网络的路径都必须先经过 normalizeVaultPath，
 * 确保它无法逃出 vault 根目录，也无法触碰被禁用的敏感目录。
 * 纯函数、无副作用，便于单元测试穷举攻击面。
 */

/** 路径非法时抛出，由上层转换成 HTTP 400 */
export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

/**
 * 把配置目录整理成可比较的目录名。
 *
 * Obsidian 的配置目录名由用户配置（`Vault#configDir`），不是固定的 `.obsidian`，
 * 因此这里只用调用方传入的真实值，绝不硬编码字面量。
 */
export function blockedDirNames(configDir?: string): string[] {
  if (typeof configDir !== 'string' || !configDir.trim()) return [];
  const dir = configDir.trim().replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
  return dir ? [dir] : [];
}

/**
 * 路径中是否出现了隐藏目录（以点开头的段）。
 *
 * 这是「配置目录保护」的兜底：即便拿不到 configDir，也不放行任何隐藏目录——
 * 以点开头的目录装的是元数据（配置、回收站、视图状态等），
 * 不该通过网络暴露。有了这层，保护就不依赖调用方是否记得传 configDir。
 */
function hasHiddenSegment(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'));
}

/**
 * 把任意客户端输入整理成 vault 内相对路径。
 *
 * 接受：`''`、`'a/b.md'`、`'/a/b.md'`、`'a\\b.md'`
 * 拒绝：`'../etc/passwd'`、`'/etc/passwd'`、`'a/../../x'`、含 NUL、含盘符
 *
 * @param input 客户端原始路径
 * @param options.allowHidden 是否放行配置目录（默认 false，仅内部调用可放开）
 * @param options.configDir 当前 vault 的真实配置目录名，取自 `Vault#configDir`
 * @returns 规范化后的相对路径；vault 根返回空串
 * @throws {UnsafePathError} 路径试图越界或触碰禁用目录
 */
export function normalizeVaultPath(
  input: string,
  options: { allowHidden?: boolean; configDir?: string } = {}
): string {
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

    // 规则一：配置目录（真实名字来自 Vault#configDir）一律拒绝
    for (const prefix of blockedDirNames(options.configDir)) {
      if (lower === prefix || lower.startsWith(prefix + '/')) {
        throw new UnsafePathError('该目录受保护，不允许通过网络访问');
      }
    }

    // 规则二：任何隐藏目录都拒绝——兜底保护，不依赖能否拿到 configDir
    if (hasHiddenSegment(normalized)) {
      throw new UnsafePathError('隐藏目录不允许通过网络访问');
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
export function isBlockedPath(path: string, configDir?: string): boolean {
  const lower = path.toLowerCase();
  return blockedDirNames(configDir).some((p) => lower === p || lower.startsWith(p + '/'));
}
