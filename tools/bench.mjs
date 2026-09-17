#!/usr/bin/env node
/**
 * 端到端性能基准：用宿主替身把插件真跑起来，压真实 HTTP 端口。
 *
 * 测的是用户真正会感知的东西——打开列表、下载、上传各要等多久，
 * 而不是孤立的函数调用耗时。使用独立端口，避免与正在运行的 Obsidian 冲突。
 *
 * 用法：node tools/bench.mjs
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vault, createObsidianMock } from './obsidian-host-mock.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);
const BENCH_PORT = 18770;
const mock = createObsidianMock();

function loadPluginClass(storedData) {
  const mainPath = resolve(projectRoot, 'main.js');
  const source = readFileSync(mainPath, 'utf8');
  const moduleObject = { exports: {} };
  const requireShim = (id) => {
    if (id === 'obsidian') return mock;
    return require_(id.startsWith('node:') ? id : 'node:' + id);
  };
  const factory = new Function('module', 'exports', 'require', '__filename', '__dirname', source);
  factory(moduleObject, moduleObject.exports, requireShim, mainPath, dirname(mainPath));
  const PluginClass = moduleObject.exports.default || moduleObject.exports;
  // 把预设数据塞进插件，模拟已有安装
  const instance = new PluginClass(
    {
      vault: storedData.vault,
      workspace: {
        getLeavesOfType: () => [],
        getLeaf: () => ({ setViewState: async () => undefined }),
        revealLeaf: async () => undefined,
      },
      setting: { open: () => undefined, openTabById: () => undefined },
    },
    { id: 'vault-bridge', name: 'Vault Bridge', version: '1.0.0', dir: projectRoot }
  );
  instance.loadData = async () => storedData.data;
  return instance;
}

/** 统计一串耗时样本 */
function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    count: sorted.length,
    min: sorted[0],
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
  };
}

function ms(value) {
  return value.toFixed(2) + 'ms';
}

function report(label, stats) {
  console.log(
    '  ' +
      label.padEnd(26) +
      'p50 ' +
      ms(stats.p50).padStart(9) +
      '   p95 ' +
      ms(stats.p95).padStart(9) +
      '   max ' +
      ms(stats.max).padStart(10) +
      '   n=' +
      stats.count
  );
}

async function main() {
  console.log('Vault Bridge 性能基准\n');

  // ── 构造一个贴近真实规模的 vault：1000 个文件 + 若干目录 ──
  const vault = new Vault();
  for (let i = 0; i < 200; i++) {
    vault.seed(`团队知识库/项目${i % 20}/文档${i}.md`, 'x'.repeat(500));
  }
  for (let i = 0; i < 800; i++) {
    vault.seed(`收件箱/条目${i}.md`, 'y'.repeat(200));
  }

  const plugin = loadPluginClass({
    vault,
    data: {
      enabled: true,
      autoStart: true,
      port: BENCH_PORT,
      token: 'bench-token-0123456789abcdefghij',
      allowUpload: true,
      maxUploadMB: 64,
      excludeDirs: '.obsidian,.trash,.git',
      keepAccessLog: true,
    },
  });

  // ── 1. 启动耗时 ──
  const bootStart = performance.now();
  await plugin.onload();
  const bootMs = performance.now() - bootStart;
  console.log('启动阶段');
  console.log('  插件 onload 到服务可用      ' + ms(bootMs));

  const base = 'http://127.0.0.1:' + plugin.server.port;
  const auth = { Authorization: 'Bearer bench-token-0123456789abcdefghij' };

  if (!plugin.server || !plugin.server.isRunning) {
    throw new Error('服务未启动，基准无法继续');
  }

  // ── 2. 健康检查（最轻的路径，衡量基础开销）──
  const healthSamples = [];
  for (let i = 0; i < 300; i++) {
    const t = performance.now();
    await fetch(base + '/api/health');
    healthSamples.push(performance.now() - t);
  }
  console.log('\n读路径');
  report('GET /api/health', summarize(healthSamples));

  // ── 3. 列目录：小目录 vs 大目录 ──
  const listSmall = [];
  for (let i = 0; i < 150; i++) {
    const t = performance.now();
    await fetch(base + '/api/list?path=' + encodeURIComponent('团队知识库'), { headers: auth });
    listSmall.push(performance.now() - t);
  }
  report('GET /api/list (小目录)', summarize(listSmall));

  const listLarge = [];
  for (let i = 0; i < 150; i++) {
    const t = performance.now();
    await fetch(base + '/api/list?path=' + encodeURIComponent('收件箱'), { headers: auth });
    listLarge.push(performance.now() - t);
  }
  report('GET /api/list (800 项)', summarize(listLarge));

  // ── 4. 下载：小文件 vs 1MB ──
  const small = new Uint8Array(2048);
  await fetch(base + '/api/upload?path=' + encodeURIComponent('基准/小文件.bin'), {
    method: 'POST',
    headers: auth,
    body: small,
  });
  const downloadSmall = [];
  for (let i = 0; i < 150; i++) {
    const t = performance.now();
    await fetch(base + '/api/download?path=' + encodeURIComponent('基准/小文件.bin'), { headers: auth });
    downloadSmall.push(performance.now() - t);
  }
  report('GET download (2KB)', summarize(downloadSmall));

  const big = new Uint8Array(1024 * 1024);
  for (let i = 0; i < big.length; i += 4096) big[i] = i % 251;
  const uploadBigTime = [];
  for (let i = 0; i < 12; i++) {
    const t = performance.now();
    await fetch(base + '/api/upload?path=' + encodeURIComponent('基准/大文件.bin'), {
      method: 'POST',
      headers: auth,
      body: big,
    });
    uploadBigTime.push(performance.now() - t);
  }
  console.log('\n写路径');
  report('POST upload (1MB)', summarize(uploadBigTime));

  const downloadBig = [];
  for (let i = 0; i < 12; i++) {
    const t = performance.now();
    const res = await fetch(base + '/api/download?path=' + encodeURIComponent('基准/大文件.bin'), {
      headers: auth,
    });
    await res.arrayBuffer();
    downloadBig.push(performance.now() - t);
  }
  report('GET download (1MB)', summarize(downloadBig));

  const uploadSmall = [];
  for (let i = 0; i < 150; i++) {
    const t = performance.now();
    await fetch(base + '/api/upload?path=' + encodeURIComponent('基准/小文件.bin'), {
      method: 'POST',
      headers: auth,
      body: small,
    });
    uploadSmall.push(performance.now() - t);
  }
  report('POST upload (2KB)', summarize(uploadSmall));

  // ── 5. 并发：手机批量操作时的表现 ──
  const concurrentStart = performance.now();
  await Promise.all(
    Array.from({ length: 50 }, () =>
      fetch(base + '/api/list?path=' + encodeURIComponent('团队知识库'), { headers: auth })
    )
  );
  const concurrentMs = performance.now() - concurrentStart;
  console.log('\n并发');
  console.log(
    '  50 个并发列表请求            ' + ms(concurrentMs) + '（平均 ' + ms(concurrentMs / 50) + '/请求）'
  );

  // ── 6. 安全开销：路径校验与令牌比对几乎零成本 ──
  const badToken = [];
  for (let i = 0; i < 200; i++) {
    const t = performance.now();
    await fetch(base + '/api/list', { headers: { Authorization: 'Bearer wrong' } });
    badToken.push(performance.now() - t);
  }
  console.log('\n安全路径开销');
  report('401 拒绝（含限流判定）', summarize(badToken));

  await plugin.onunload();
  await new Promise((r) => setTimeout(r, 300));

  console.log('\n基准完成');
}

main().catch((error) => {
  console.error('基准失败：', error);
  process.exit(1);
});
