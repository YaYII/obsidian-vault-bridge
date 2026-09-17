/**
 * 路由层端到端行为：直接调用 handleRequest，覆盖认证、上传下载、错误分支与路径逃逸。
 * 这一层不依赖真实端口，因此可以快速穷举各类攻击输入。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { handleRequest } from '../src/server/router';
import { AuthGuard } from '../src/server/auth';
import { Vault } from './mocks/obsidian';

const TOKEN = 'test-token-abcdefghijklmnop';
const MEGABYTE = 1024 * 1024;

function buildContext(options: { allowUpload?: boolean; maxUploadBytes?: number } = {}) {
  const vault = new Vault();
  const logs: Array<{ action: string; status: number; target: string }> = [];
  const settings = {
    token: TOKEN,
    allowUpload: options.allowUpload !== false,
    excludedDirs: ['.obsidian', '.trash', '.git'],
    maxUploadBytes: options.maxUploadBytes || 8 * MEGABYTE,
  };
  const ctx = {
    vault,
    version: '1.0.0-test',
    getSettings: () => settings,
    guard: new AuthGuard(() => settings.token),
    logAccess: (entry: { action: string; status: number; target: string }) => {
      logs.push({ action: entry.action, status: entry.status, target: entry.target });
    },
  };
  return { vault, ctx, logs, settings };
}

interface RequestOverrides {
  method?: string;
  pathname?: string;
  query?: Record<string, string>;
  token?: string | null;
  body?: Uint8Array;
}

function makeRequest(overrides: RequestOverrides = {}) {
  const headers: Record<string, string> = {};
  if (overrides.token !== null) {
    headers.authorization = 'Bearer ' + (overrides.token || TOKEN);
  }
  return {
    method: overrides.method || 'GET',
    pathname: overrides.pathname || '/api/health',
    query: new URLSearchParams(overrides.query || {}),
    headers,
    body: overrides.body || new Uint8Array(0),
    ip: '192.168.1.99',
  };
}

function bodyText(response: { body: Uint8Array | string }): string {
  return typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body);
}

describe('健康检查', () => {
  it('不需要令牌即可访问，用于区分地址不通与令牌不对', async () => {
    const { ctx } = buildContext();
    const response = await handleRequest(ctx, makeRequest({ pathname: '/api/health', token: null }));
    expect(response.status).toBe(200);
    expect(JSON.parse(bodyText(response)).ok).toBe(true);
  });
});

describe('认证', () => {
  it('缺少令牌时列表接口返回 401', async () => {
    const { ctx } = buildContext();
    const response = await handleRequest(ctx, makeRequest({ pathname: '/api/list', token: null }));
    expect(response.status).toBe(401);
  });

  it('令牌错误时返回 401', async () => {
    const { ctx } = buildContext();
    const response = await handleRequest(ctx, makeRequest({ pathname: '/api/list', token: 'wrong-token' }));
    expect(response.status).toBe(401);
  });

  it('令牌正确时放行', async () => {
    const { ctx } = buildContext();
    const response = await handleRequest(ctx, makeRequest({ pathname: '/api/list' }));
    expect(response.status).toBe(200);
  });

  it('令牌也能通过查询参数传递，便于浏览器直接下载', async () => {
    const { ctx } = buildContext();
    const response = await handleRequest(
      ctx,
      makeRequest({ pathname: '/api/list', token: null, query: { token: TOKEN } })
    );
    expect(response.status).toBe(200);
  });
});

describe('列目录', () => {
  let built: ReturnType<typeof buildContext>;
  beforeEach(() => {
    built = buildContext();
    built.vault.seed('团队知识库/README.md', '# 标题');
    built.vault.seed('团队知识库/需求清单.md', '内容');
    built.vault.seed('收件箱/待整理.md', 'x');
  });

  it('根目录列出文件夹', async () => {
    const response = await handleRequest(built.ctx, makeRequest({ pathname: '/api/list' }));
    const payload = JSON.parse(bodyText(response));
    expect(payload.path).toBe('');
    expect(payload.parent).toBeNull();
    expect(payload.entries.map((e: { name: string }) => e.name)).toEqual(['收件箱', '团队知识库']);
    expect(payload.entries.every((e: { kind: string }) => e.kind === 'folder')).toBe(true);
  });

  it('子目录列出文件并带上大小', async () => {
    const response = await handleRequest(
      built.ctx,
      makeRequest({ pathname: '/api/list', query: { path: '团队知识库' } })
    );
    const payload = JSON.parse(bodyText(response));
    expect(payload.parent).toBe('');
    const names = payload.entries.map((e: { name: string }) => e.name);
    expect(names).toContain('README.md');
    const readme = payload.entries.find((e: { name: string }) => e.name === 'README.md');
    expect(readme.kind).toBe('file');
    expect(readme.size).toBeGreaterThan(0);
    expect(readme.mtime).toBeGreaterThan(0);
  });

  it('目录不存在返回 404', async () => {
    const response = await handleRequest(
      built.ctx,
      makeRequest({ pathname: '/api/list', query: { path: '不存在的目录' } })
    );
    expect(response.status).toBe(404);
  });

  it('目标是文件时返回 400', async () => {
    const response = await handleRequest(
      built.ctx,
      makeRequest({ pathname: '/api/list', query: { path: '团队知识库/README.md' } })
    );
    expect(response.status).toBe(400);
  });

  it('排除目录不出现在列表中', async () => {
    built.vault.seed('.trash/删掉的.md', 'x');
    const response = await handleRequest(built.ctx, makeRequest({ pathname: '/api/list' }));
    const payload = JSON.parse(bodyText(response));
    expect(payload.entries.map((e: { name: string }) => e.name)).not.toContain('.trash');
  });
});

describe('下载', () => {
  it('返回文件内容与下载响应头', async () => {
    const { ctx, vault } = buildContext();
    vault.seed('团队知识库/说明.md', '你好，世界');
    const response = await handleRequest(
      ctx,
      makeRequest({ pathname: '/api/download', query: { path: '团队知识库/说明.md' } })
    );
    expect(response.status).toBe(200);
    expect(bodyText(response)).toBe('你好，世界');
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['content-disposition']).toContain(encodeURIComponent('说明.md'));
    expect(response.headers['content-length']).toBe(String(new TextEncoder().encode('你好，世界').length));
  });

  it('文件不存在返回 404', async () => {
    const { ctx } = buildContext();
    const response = await handleRequest(
      ctx,
      makeRequest({ pathname: '/api/download', query: { path: '没有这个.md' } })
    );
    expect(response.status).toBe(404);
  });

  it('目标是目录时返回 404', async () => {
    const { ctx, vault } = buildContext();
    vault.seed('目录里的文件.md', 'x');
    const response = await handleRequest(
      ctx,
      makeRequest({ pathname: '/api/download', query: { path: '目录里的文件.md/..' } })
    );
    expect([400, 404]).toContain(response.status);
  });
});

describe('上传', () => {
  it('写入新文件并自动建父目录', async () => {
    const { ctx, vault } = buildContext();
    const payload = new TextEncoder().encode('# 手机传来的笔记');
    const response = await handleRequest(
      ctx,
      makeRequest({
        method: 'POST',
        pathname: '/api/upload',
        query: { path: '收件箱/来自手机/笔记.md' },
        body: payload,
      })
    );
    expect(response.status).toBe(200);
    const result = JSON.parse(bodyText(response));
    expect(result.action).toBe('created');
    expect(result.size).toBe(payload.byteLength);
    expect(vault.getAbstractFileByPath('收件箱/来自手机/笔记.md')).toBeTruthy();
  });

  it('覆盖已有文件时返回 updated', async () => {
    const { ctx, vault } = buildContext();
    vault.seed('笔记.md', '旧内容');
    const response = await handleRequest(
      ctx,
      makeRequest({
        method: 'POST',
        pathname: '/api/upload',
        query: { path: '笔记.md' },
        body: new TextEncoder().encode('新内容'),
      })
    );
    const result = JSON.parse(bodyText(response));
    expect(result.action).toBe('updated');
    const file = vault.getAbstractFileByPath('笔记.md');
    expect(new TextDecoder().decode(file.content)).toBe('新内容');
  });

  it('关闭上传开关后返回 403', async () => {
    const built = buildContext({ allowUpload: false });
    const response = await handleRequest(
      built.ctx,
      makeRequest({
        method: 'POST',
        pathname: '/api/upload',
        query: { path: 'x.md' },
        body: new TextEncoder().encode('data'),
      })
    );
    expect(response.status).toBe(403);
  });

  it('超过大小上限返回 413', async () => {
    const built = buildContext({ maxUploadBytes: 10 });
    const response = await handleRequest(
      built.ctx,
      makeRequest({
        method: 'POST',
        pathname: '/api/upload',
        query: { path: 'x.md' },
        body: new TextEncoder().encode('这段内容明显超过十个字节了'),
      })
    );
    expect(response.status).toBe(413);
  });

  it('空请求体返回 400', async () => {
    const { ctx } = buildContext();
    const response = await handleRequest(
      ctx,
      makeRequest({ method: 'POST', pathname: '/api/upload', query: { path: 'x.md' } })
    );
    expect(response.status).toBe(400);
  });

  it('缺少目标路径返回 400', async () => {
    const { ctx } = buildContext();
    const response = await handleRequest(
      ctx,
      makeRequest({
        method: 'POST',
        pathname: '/api/upload',
        body: new TextEncoder().encode('data'),
      })
    );
    expect(response.status).toBe(400);
  });

  it('GET 方式调用返回 405', async () => {
    const { ctx } = buildContext();
    const response = await handleRequest(
      ctx,
      makeRequest({ method: 'GET', pathname: '/api/upload', query: { path: 'x.md' } })
    );
    expect(response.status).toBe(405);
  });
});

describe('新建目录', () => {
  it('逐级创建', async () => {
    const { ctx, vault } = buildContext();
    const response = await handleRequest(
      ctx,
      makeRequest({ method: 'POST', pathname: '/api/mkdir', query: { path: 'a/b/c' } })
    );
    expect(response.status).toBe(200);
    expect(vault.getAbstractFileByPath('a/b/c')).toBeTruthy();
  });
});

describe('安全边界（网络输入一律先过路径校验）', () => {
  const attacks: Array<[string, string]> = [
    ['list', '../'],
    ['list', '../../etc'],
    ['download', '../../../etc/passwd'],
    ['download', 'a/../../b.md'],
    ['download', '.obsidian/app.json'],
    ['list', '.obsidian'],
  ];

  for (const [route, path] of attacks) {
    it(`${route} 拒绝路径 ${JSON.stringify(path)}`, async () => {
      const { ctx } = buildContext();
      const response = await handleRequest(ctx, makeRequest({ pathname: '/api/' + route, query: { path } }));
      expect(response.status).toBe(400);
      expect(JSON.parse(bodyText(response)).error).toBe('unsafe_path');
    });
  }

  it('上传也不能逃出 vault', async () => {
    const { ctx } = buildContext();
    const response = await handleRequest(
      ctx,
      makeRequest({
        method: 'POST',
        pathname: '/api/upload',
        query: { path: '../../evil.sh' },
        body: new TextEncoder().encode('rm -rf /'),
      })
    );
    expect(response.status).toBe(400);
  });

  it('上传到 .obsidian 被拒绝（防止覆写插件配置）', async () => {
    const { ctx } = buildContext();
    const response = await handleRequest(
      ctx,
      makeRequest({
        method: 'POST',
        pathname: '/api/upload',
        query: { path: '.obsidian/plugins/vault-bridge/data.json' },
        body: new TextEncoder().encode('{}'),
      })
    );
    expect(response.status).toBe(400);
  });
});

describe('未知接口与访问日志', () => {
  it('未知路径返回 404', async () => {
    const { ctx } = buildContext();
    const response = await handleRequest(ctx, makeRequest({ pathname: '/api/不存在' }));
    expect(response.status).toBe(404);
  });

  it('每次请求都会写入一条审计日志', async () => {
    const { ctx, logs, vault } = buildContext();
    vault.seed('a.md', 'x');
    await handleRequest(ctx, makeRequest({ pathname: '/api/list' }));
    await handleRequest(ctx, makeRequest({ pathname: '/api/download', query: { path: 'a.md' } }));
    expect(logs.length).toBe(2);
    expect(logs[1].action).toContain('下载');
    expect(logs[1].status).toBe(200);
  });

  it('日志里不出现明文令牌', async () => {
    const { ctx, logs } = buildContext();
    await handleRequest(ctx, makeRequest({ pathname: '/api/list', token: null, query: { token: TOKEN } }));
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
    expect(JSON.stringify(logs)).toContain('token=***');
  });
});
