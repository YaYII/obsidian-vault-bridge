/**
 * 手机端在线更新插件的纯逻辑。
 *
 * 从电脑取回的 manifest.json 必须先验证确实是本插件，再覆盖本机文件；
 * 校验单独放在这里，便于单元测试穷举异常输入（畸形 JSON、别的插件、缺版本号）。
 */

/** 本插件的固定 id（manifest.json 的 id 字段） */
export const PLUGIN_ID = 'vault-bridge';

/**
 * 校验从电脑取回的 manifest.json，返回版本号。
 * 不是本插件、缺版本号或不是合法 JSON 时返回 null，调用方必须中止更新。
 */
export function readRemotePluginVersion(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as { id?: unknown; version?: unknown };
  if (record.id !== PLUGIN_ID) return null;
  if (typeof record.version !== 'string' || record.version.length === 0) return null;
  return record.version;
}
