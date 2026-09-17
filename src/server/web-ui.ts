/**
 * 手机浏览器界面的装载器。
 *
 * 页面本体放在同目录的 web-ui.html 里，构建时由 esbuild 的 text loader 内联进产物，
 * 这样 HTML/CSS/JS 都能被编辑器正常高亮与校验，也避免在 TypeScript 里做字符串转义。
 */

import template from './web-ui.html';

/**
 * 渲染手机端网页。
 *
 * 服务端不判断是否已授权——令牌校验由页面自身的脚本完成，
 * 这样一份 HTML 可以安全地缓存在任意设备上。
 * 部署前缀（被反向代理挂在子路径时）由路由层注入，见 router.ts 的 injectBase。
 */
export function renderWebUi(): string {
  return template;
}
