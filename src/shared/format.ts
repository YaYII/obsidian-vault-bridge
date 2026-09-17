/** 展示层格式化工具，两端共用，保证同一份数据在 PC 与手机上显示一致。 */

/** 把字节数格式化为人类可读文本 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

/** 把毫秒时间戳格式化为 YYYY-MM-DD HH:mm */
export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '-';
  const d = new Date(ms);
  const pad = (n: number) => (n < 10 ? '0' + n : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 截断过长文本，用于单行展示 */
export function truncate(text: string, max = 60): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}
