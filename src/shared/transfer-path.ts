/**
 * 传输落点计算。
 *
 * 从面板实现里抽出来的纯逻辑：手机下载要把电脑的相对结构原样搬到本地，
 * 上传则要落到电脑指定目录，且不能把已有的前缀重复拼一遍。
 * 这类路径拼接是「下载后发现文件不在预期位置」的主要来源，单独成函数便于穷举验证。
 */

/** 去掉目录设置里多余的首尾斜杠；空串表示「vault 根目录」 */
export function normalizeDirPrefix(dir: string): string {
  if (typeof dir !== 'string') return '';
  return dir.replace(/^\/+/, '').replace(/\/+$/, '').trim();
}

/**
 * 计算下载到手机的完整路径：保持与电脑一致的相对结构。
 * 例：downloadDir='VaultBridge下载'，remotePath='团队知识库/a.md'
 *     → 'VaultBridge下载/团队知识库/a.md'
 */
export function resolveDownloadTarget(downloadDir: string, remotePath: string): string {
  const base = normalizeDirPrefix(downloadDir);
  const relative = String(remotePath || '').replace(/^\/+/, '');
  return base ? base + '/' + relative : relative;
}

/**
 * 计算上传到电脑的完整路径。
 * 若本地路径本身就位于目标目录之下，则原样使用，避免拼成 a/b/a/b/x.md。
 * 例：uploadDir='收件箱'，localPath='收件箱/笔记.md' → '收件箱/笔记.md'（不重复拼接）
 *     uploadDir='收件箱'，localPath='随手记/笔记.md' → '收件箱/随手记/笔记.md'
 */
export function resolveUploadTarget(uploadDir: string, localPath: string): string {
  const base = normalizeDirPrefix(uploadDir);
  const source = String(localPath || '').replace(/^\/+/, '');
  if (!base) return source;
  if (source === base || source.indexOf(base + '/') === 0) return source;
  return base + '/' + source;
}

/**
 * 判断本地文件是否已经是最新，用于跳过未变化的文件。
 *
 * 为什么需要它：全量下载 200 个文件时，若每次都整库重下，
 * 第二次同步仍要传输全部字节——而绝大多数文件其实没动过。
 *
 * 采用 size + mtime 双重判定，并对 mtime 留出容差：
 * 不同文件系统的时间精度不同（秒级/毫秒级/纳秒级），
 * 同步工具也可能微调时间戳，容差可避免把「其实没变」的文件误判为需要重下。
 */
export const MTIME_TOLERANCE_MS = 2000;

export function isUpToDate(
  local: { size: number; mtime: number } | null | undefined,
  remote: { size: number; mtime: number }
): boolean {
  if (!local) return false;
  if (typeof local.size !== 'number' || typeof local.mtime !== 'number') return false;
  if (local.size !== remote.size) return false;
  // 远程时间戳缺失时无法判定，保守地重新下载
  if (!Number.isFinite(remote.mtime) || remote.mtime <= 0) return false;
  return Math.abs(local.mtime - remote.mtime) <= MTIME_TOLERANCE_MS;
}
