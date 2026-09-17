/**
 * 真端口集成测试：起一个真实的 HTTP 服务，用 fetch 走完整链路。
 *
 * 这一层验证的是单元测试覆盖不到的部分——Node 请求解析、请求体读取、
 * 响应头写入、CORS 预检、端口绑定，以及中文路径的 URL 编解码往返。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// 测试进程里没有 Obsidian 注入的 require，这里用 Node 自己的模块系统顶替
vi.mock('../src/server/node-modules', async () => {
  const { createRequire: create } = await import('node:module');
  const loader = create(import.meta.url);
  return { nodeRequire: (id: string) => loader(id) };
});

const { BridgeServer } = await import('../src/server/http-server');
const { Vault } = await import('./mocks/obsidian');

const TOKEN = 'integration-token-0123456789ab';
const MAX_UPLOAD = 1024 * 1024;

let server: InstanceType<typeof BridgeServer>;
let baseUrl = '';
let vault: InstanceType<typeof Vault>;
const accessLog: Array<{ action: string; status: number }> = [];

function settings(overrides: Record<string, unknown> = {}) {
  return {
    token: TOKEN,
    allowUpload: true,
    excludedDirs: ['.obsidian', '.trash', '.git'],
    maxUploadBytes: MAX_UPLOAD,
    ...overrides,
  };
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: 'Bearer ' + TOKEN, ...extra };
}

beforeAll(async () => {
  vault = new Vault();
  vault.seed('团队知识库/README.md', '# 团队知识库\n\n这是根说明。');
  vault.seed('团队知识库/需求清单.md', '需求一\n需求二');
  vault.seed('附件/图.png', 'not-really-a-png');

  server = new BridgeServer({
    vault,
    version: '1.0.0-integration',
    getRuntimeSettings: () => settings(),
    logAccess: (entry: { action: string; status: number }) => {
      accessLog.push({ action: entry.action, status: entry.status });
    },
    reportError: () => undefined,
  } as never);

  // 端口传 0 让系统分配，避免与开发机上已有服务冲突
  await server.start(0);
  baseUrl = 'http://127.0.0.1:' + server.port;
});

afterAll(async () => {
  await server.stop();
});

describe('服务生命周期', () => {
  it('绑定在 0.0.0.0 上，手机才能通过局域网访问', () => {
    expect(server.isRunning).toBe(true);
    expect(server.port).toBeGreaterThan(0);
  });

  it('停止后不再监听', async () => {
    const temp = new BridgeServer({
      vault,
      version: 'x',
      getRuntimeSettings: () => settings(),
      logAccess: () => undefined,
      reportError: () => undefined,
    } as never);
    await temp.start(0);
    const port = temp.port;
    await temp.stop();
    expect(temp.isRunning).toBe(false);
    await expect(fetch('http://127.0.0.1:' + port + '/api/health')).rejects.toBeTruthy();
  });
});

describe('认证链路', () => {
  it('健康检查无需令牌', async () => {
    const res = await fetch(baseUrl + '/api/health');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.version).toBe('1.0.0-integration');
  });

  it('无令牌访问列表返回 401', async () => {
    const res = await fetch(baseUrl + '/api/list');
    expect(res.status).toBe(401);
  });

  it('错误令牌返回 401', async () => {
    const res = await fetch(baseUrl + '/api/list', { headers: { Authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
  });

  it('正确令牌可以列出目录', async () => {
    const res = await fetch(baseUrl + '/api/list', { headers: authHeaders() });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entries.map((e: { name: string }) => e.name)).toContain('团队知识库');
  });

  it('令牌可通过查询参数传递（浏览器直接点链接下载）', async () => {
    const res = await fetch(baseUrl + '/api/verify?token=' + TOKEN);
    expect(res.status).toBe(200);
  });
});

describe('中文路径编解码往返', () => {
  it('按中文目录列出文件', async () => {
    const url = baseUrl + '/api/list?path=' + encodeURIComponent('团队知识库');
    const res = await fetch(url, { headers: authHeaders() });
    const data = await res.json();
    const names = data.entries.map((e: { name: string }) => e.name);
    expect(names).toContain('README.md');
    expect(names).toContain('需求清单.md');
  });

  it('下载中文文件名并正确设置响应头', async () => {
    const url = baseUrl + '/api/download?path=' + encodeURIComponent('团队知识库/需求清单.md');
    const res = await fetch(url, { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('需求一\n需求二');
    expect(res.headers.get('content-disposition')).toContain(encodeURIComponent('需求清单.md'));
  });

  it('路径逃逸在真实链路上同样被拦下', async () => {
    const res = await fetch(baseUrl + '/api/download?path=' + encodeURIComponent('../../etc/passwd'), {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
  });

  it('点开头的受保护目录被拦下', async () => {
    const res = await fetch(baseUrl + '/api/list?path=' + encodeURIComponent('.obsidian'), {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
  });
});

describe('上传链路', () => {
  it('二进制上传后能被列出并原样下载回来', async () => {
    const payload = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const target = '收件箱/二进制.bin';

    const uploadRes = await fetch(baseUrl + '/api/upload?path=' + encodeURIComponent(target), {
      method: 'POST',
      headers: authHeaders(),
      body: payload,
    });
    expect(uploadRes.status).toBe(200);
    const result = await uploadRes.json();
    expect(result.action).toBe('created');
    expect(result.size).toBe(payload.byteLength);

    const listRes = await fetch(baseUrl + '/api/list?path=' + encodeURIComponent('收件箱'), {
      headers: authHeaders(),
    });
    const listed = await listRes.json();
    expect(listed.entries.map((e: { name: string }) => e.name)).toContain('二进制.bin');

    const downloadRes = await fetch(baseUrl + '/api/download?path=' + encodeURIComponent(target), {
      headers: authHeaders(),
    });
    const roundTrip = new Uint8Array(await downloadRes.arrayBuffer());
    expect(Array.from(roundTrip)).toEqual(Array.from(payload));
  });

  it('上传文本文件内容可读回', async () => {
    const res = await fetch(baseUrl + '/api/upload?path=' + encodeURIComponent('收件箱/来自手机.md'), {
      method: 'POST',
      headers: authHeaders(),
      body: '# 手机写的笔记',
    });
    expect(res.status).toBe(200);
    const back = await fetch(baseUrl + '/api/download?path=' + encodeURIComponent('收件箱/来自手机.md'), {
      headers: authHeaders(),
    });
    expect(await back.text()).toBe('# 手机写的笔记');
  });

  it('超过上限返回 413', async () => {
    const oversized = new Uint8Array(MAX_UPLOAD + 1024);
    const res = await fetch(baseUrl + '/api/upload?path=' + encodeURIComponent('太大.bin'), {
      method: 'POST',
      headers: authHeaders(),
      body: oversized,
    });
    expect(res.status).toBe(413);
    const data = await res.json();
    expect(data.error).toBe('too_large');
  });

  it('上传后目录能被自动创建', async () => {
    const res = await fetch(
      baseUrl + '/api/upload?path=' + encodeURIComponent('收件箱/深层/再深一层/笔记.md'),
      { method: 'POST', headers: authHeaders(), body: 'deep' }
    );
    expect(res.status).toBe(200);
    const listRes = await fetch(baseUrl + '/api/list?path=' + encodeURIComponent('收件箱/深层/再深一层'), {
      headers: authHeaders(),
    });
    expect(listRes.status).toBe(200);
  });

  it('新建目录接口可用', async () => {
    const res = await fetch(baseUrl + '/api/mkdir?path=' + encodeURIComponent('新建的目录'), {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
  });
});

describe('浏览器兼容与运维细节', () => {
  it('OPTIONS 预检返回 204 且带 CORS 头', async () => {
    const res = await fetch(baseUrl + '/api/list', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('普通响应也带 CORS 头', async () => {
    const res = await fetch(baseUrl + '/api/health');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('根路径返回手机端网页', async () => {
    const res = await fetch(baseUrl + '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    // doctype 在 HTML 里大小写无关，断言跟着放宽，避免被格式化工具影响
    expect(html.toLowerCase()).toContain('<!doctype html>');
    expect(html).toContain('Vault Bridge');
    expect(html).toContain('上传到此');
  });

  it('未知接口返回 404', async () => {
    const res = await fetch(baseUrl + '/api/whatever', { headers: authHeaders() });
    expect(res.status).toBe(404);
  });

  it('访问日志被记录且不含明文令牌', async () => {
    expect(accessLog.length).toBeGreaterThan(0);
    expect(accessLog.some((entry) => entry.action.indexOf('下载') !== -1)).toBe(true);
  });

  it('并发请求不会互相干扰', async () => {
    const requests = [] as Array<Promise<Response>>;
    for (let i = 0; i < 20; i++) {
      requests.push(
        fetch(baseUrl + '/api/list?path=' + encodeURIComponent('团队知识库'), { headers: authHeaders() })
      );
    }
    const responses = await Promise.all(requests);
    expect(responses.every((res) => res.status === 200)).toBe(true);
  });
});
