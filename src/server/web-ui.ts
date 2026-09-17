/**
 * 手机浏览器界面的装载器。
 *
 * 页面本体放在同目录的 web-ui.html 里，构建时由 esbuild 的 text loader 内联进产物，
 * 这样 HTML/CSS/JS 都能被编辑器正常高亮与校验，也避免在 TypeScript 里做字符串转义。
 */

import template from './web-ui.html';

/** 页面里唯一需要动态注入的占位符 */
const VERSION_PLACEHOLDER = '__VB_VERSION__';

/**
 * 渲染手机端网页。
 * 服务端不判断是否已授权——令牌校验由页面自身的脚本完成，
 * 这样一份 HTML 可以安全地缓存在任意设备上。
 */
export function renderWebUi(options: { authenticated?: boolean } = {}): string {
  void options;
  return template.split(VERSION_PLACEHOLDER).join('1.0.0');
}
