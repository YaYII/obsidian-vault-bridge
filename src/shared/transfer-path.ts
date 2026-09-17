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
