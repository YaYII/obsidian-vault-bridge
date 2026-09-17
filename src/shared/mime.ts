/** 按扩展名推断 Content-Type。下载时告诉浏览器/客户端如何处理字节流。 */

const MIME_BY_EXTENSION: Record<string, string> = {
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  canvas: 'application/json; charset=utf-8',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** 取不到时统一回落为二进制流，避免浏览器把未知文件当 HTML 渲染 */
export function mimeOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const ext = fileName.slice(dot + 1).toLowerCase();
  return MIME_BY_EXTENSION[ext] || 'application/octet-stream';
}

/** 判断扩展名是否为文本类，客户端据此选择预览方式 */
export function isTextLike(fileName: string): boolean {
  const mime = mimeOf(fileName);
  return mime.startsWith('text/') || mime.indexOf('json') !== -1;
}
