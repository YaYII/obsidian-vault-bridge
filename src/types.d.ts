/** 构建期由 esbuild 的 text loader 处理，导入结果是文件全文 */
declare module '*.html' {
  const content: string;
  export default content;
}
