/**
 * Node 内置模块的惰性装载点（仅桌面端可达）。
 *
 * 为什么单独成文件：整个插件的 main.js 是同一份产物，iOS 上也会被加载。
 * 只要没人调用 `nodeRequire`，产物里就不会有任何模块被真正解析，
 * 因此移动端加载本插件完全安全。
 * esbuild 配置里已把 'http' / 'os' 等标记为 external，这里保留为运行时的 require()。
 */
export function nodeRequire<T>(id: string): T {
  // 用 typeof 探测而不是直接引用：移动端 WebView 里 require 未必存在，
  // 直接写 require(...) 会抛 ReferenceError，typeof 不会。
  const loader = (typeof require === 'function' ? require : null) as ((moduleId: string) => T) | null;
  if (!loader) {
    throw new Error('当前运行环境不提供 Node 模块系统，无法加载：' + id);
  }
  return loader(id);
}
