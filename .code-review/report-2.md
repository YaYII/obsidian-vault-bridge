# 代码审查诊断报告 · 第 2 轮

- **项目**：`/home/as-workstation01/Documents/project/vault-bridge`
- **结论**：✅ **通过**
- **生成时间**：2026-09-17T04:43:29.519Z

## 摘要

Vault Bridge v1.0.0 —— Obsidian 双端文件传输插件（电脑端 HTTP 服务 + 手机端客户端，同一份产物）。

【本轮修复的实质问题】
1. 项目原本没有 eslint 配置，审查工具空跑返回 0 问题；补上 eslint9 + typescript-eslint 后立刻抓出未使用导入。
2. code_review_test 带 --coverage 但缺 @vitest/coverage-v8，vitest 直接退出、解析出 0 个测试；补齐后恢复为 160 个。
3. 覆盖率暴露 client/api-client.ts（手机端通信的全部逻辑）为 0%，补 24 个测试后达 98.18%。
4. panel.ts 中 617 行 UI 里的落点计算无任何覆盖，抽出为 shared/transfer-path.ts 并补 16 个边界测试
   （含「收件箱备份」不应被误判为「收件箱」子路径这类前缀陷阱）。
5. 上一轮报告引用了陈旧的 lint / 覆盖率缓存，导致误报未通过；刷新各环节数据后重出报告。

【优雅性自评】分层清晰：shared 纯函数（路径安全/令牌/落点计算/协议常量）→ server 路由与装配 → client 客户端与面板。
路由层刻意与 Node http 解耦，输入输出都是普通对象，因此可对路径逃逸、错误令牌、超大请求等攻击面做穷举式单测而不必启动端口；
Node 内置模块集中收敛在 nodeRequire 一个装载点，移动端加载同一份产物时永不触发，该约束由产物验证断言。

【安全验证】路径沙箱对 ../ 逃逸、绝对路径、盘符、NUL 字节、.obsidian 配置目录全部拒绝（27 项攻击面测试）；
令牌恒定时间比对 + 同 IP 失败 8 次封禁 5 分钟；审计日志中令牌脱敏为 token=***。

【性能】onload 到服务可用 17ms；列表 p50 2.5ms（800 项目录 5.0ms）；1MB 上传 p50 13ms、下载 p50 9ms；
50 并发平均 0.7ms/请求；401 拒绝路径 p50 2ms。CPU 剖析 idle 占 80.9%，无应用层热点，瓶颈在网络往返而非代码。

【已知缺口（不掩盖）】src/main.ts、src/settings.ts、src/client/panel.ts 在 vitest 中为 0%：它们是 Obsidian UI 组件，需要宿主与 DOM 环境。
其中 main.ts 与 zip.ts 的行为已由 tools/verify-bundle.mjs 的 42 项产物级验证真实覆盖（真起端口、真打请求、真跑插件生命周期，
并断言手机端 onload 后不创建服务端实例、不占用端口），但不在 vitest 进程内，故不计入覆盖率数字。
后续若要提升，建议引入 jsdom + Obsidian Setting/ItemView 替身，优先覆盖设置项读写与连接失败分支。

**AI 优雅性评分**：88/100

## Quality Gate

| 检查项 | 结果 | 详情 |
| --- | --- | --- |
| 静态检查 | ✅ | 无 P0/P1 问题（共 0 条，P2/P3 为建议级） |
| 格式化 | ✅ | 格式合规 |
| 测试 | ✅ | 160/160 通过，0 失败，0 跳过，覆盖率 42.88% |
| 覆盖率 | ✅ | 42.88% ≥ 40% |
| 性能回归 | ✅ | node tools/bench.mjs: p50 6516ms → 5415ms（-16.9%），阈值 +15% |

## 静态检查

无问题。
## 格式化

格式合规。

## 性能基准（程序级）

命令：`node tools/bench.mjs`（3 次，排除冷启动）

| 指标 | 值 |
| --- | --- |
| p50 | 5415 ms |
| p90 | 5719 ms |
| 均值 | 5415 ms |
| 最快/最慢 | 5034 / 5795 ms |
| 内存峰值(RSS) | 158.9 MB |

| 对比上轮 | 上轮 p50 | 本轮 p50 | 变化 |
| --- | --- | --- | --- |
| `node tools/bench.mjs` | 6516 ms | 5415 ms | -16.9% |

## 性能热点（函数级剖析）

引擎：`v8-cpuprofile`，总自耗时 4110 ms

| # | 函数 | 位置 | 自耗时 | 占比 |
| --- | --- | --- | --- | --- |
| 1 | `(idle)` | native | 3325 ms | 80.9% |
| 2 | `(anonymous)` | native | 147 ms | 3.6% |
| 3 | `(garbage collector)` | native | 140 ms | 3.4% |
| 4 | `E` | native | 140 ms | 3.4% |
| 5 | `(program)` | native | 112 ms | 2.7% |
| 6 | `writev` | native | 80 ms | 2% |
| 7 | `httpFetch` | node:internal/deps/undici/undici:11074 | 52 ms | 1.3% |
| 8 | `runMicrotasks` | native | 44 ms | 1.1% |
| 9 | `_Request` | node:internal/deps/undici/undici:9894 | 35 ms | 0.8% |
| 10 | `Q` | native | 35 ms | 0.8% |

> profiled tools/bench.mjs via node --cpu-prof

## 测试

工具：`vitest` · 160/160 通过，0 失败，0 跳过，耗时 4073ms，覆盖率 42.88%

---

生成于 DeepSeek Harness `dsh-code-review`。修复后重新运行审查工具并再次生成报告，直到 Quality Gate 全部通过。