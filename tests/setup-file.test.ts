/**
 * 插件文件下发接口（/setup/file）。
 *
 * 手机端靠它在线更新插件，因此这里必须证明两件事：
 *   1. 白名单挡住了目录穿越与任意文件读取；
 *   2. 正常请求能把插件目录里的真实文件按正确类型发出去。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Vault as ObsidianVault } from 'obsidian';
import { AuthGuard } from '../src/server/auth';
import { handleRequest } from '../src/server/router';
import { Vault } from './mocks/obsidian';

const TOKEN = 'test-token-abcdefghijklmnop';
const MAIN_JS = 'console.log("vault-bridge bundle");';

const pluginDir = mkdtempSync(join(tmpdir(), 'vault-bridge-plugin-'));
writeFileSync(join(pluginDir, 'main.js'), MAIN_JS);
writeFileSync(join(pluginDir, 'manifest.json'), '{"id":"vault-bridge","version":"9.9.9"}');

afterAll(() => {
  rmSync(pluginDir, { recursive: true, force: true });
});

function buildContext(dir: string) {
  const vault = new Vault();
  const settings = {
    token: TOKEN,
    allowUpload: true,
    excludedDirs: ['.obsidian', '.trash', '.git'],
    maxUploadBytes: 8 * 1024 * 1024,
  };
  return {
    vault: vault as unknown as ObsidianVault,
    version: '1.0.0-test',
    getSettings: () => settings,
    guard: new AuthGuard(() => settings.token),
    logAccess: () => undefined,
    getPluginDir: () => dir,
  };
}

function makeRequest(
  overrides: { method?: string; query?: Record<string, string>; token?: string | null } = {}
) {
  const headers: Record<string, string> = {};
  if (overrides.token !== null) {
    headers.authorization = 'Bearer ' + (overrides.token || TOKEN);
  }
  return {
    method: overrides.method || 'GET',
    pathname: '/setup/file',
    query: new URLSearchParams(overrides.query || {}),
    headers,
    body: new Uint8Array(0),
    ip: '192.168.1.99',
  };
}

function bodyText(response: { body: Uint8Array | string }): string {
  return typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body);
}

describe('下发插件文件', () => {
  it('main.js 原样返回，类型为 JavaScript', async () => {
    const response = await handleRequest(
      buildContext(pluginDir),
      makeRequest({ query: { name: 'main.js' } })
    );
    expect(response.status).toBe(200);
    expect(bodyText(response)).toBe(MAIN_JS);
    expect(response.headers['content-type']).toContain('javascript');
    expect(response.headers['content-length']).toBe(String(MAIN_JS.length));
  });

  it('manifest.json 按 JSON 返回', async () => {
    const response = await handleRequest(
      buildContext(pluginDir),
      makeRequest({ query: { name: 'manifest.json' } })
    );
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('json');
    expect(JSON.parse(bodyText(response)).version).toBe('9.9.9');
  });

  it('白名单外的文件名一律 400，挡住目录穿越', async () => {
    const ctx = buildContext(pluginDir);
    for (const name of ['../main.js', '../../etc/passwd', '/etc/passwd', 'data.json', '']) {
      const response = await handleRequest(ctx, makeRequest({ query: { name } }));
      expect(response.status, 'name=' + name).toBe(400);
    }
  });

  it('缺名字参数时 400，而不是读取别的文件', async () => {
    const response = await handleRequest(buildContext(pluginDir), makeRequest());
    expect(response.status).toBe(400);
  });

  it('电脑端拿不到插件目录时返回 500，让手机端知道原因', async () => {
    const response = await handleRequest(buildContext(''), makeRequest({ query: { name: 'main.js' } }));
    expect(response.status).toBe(500);
  });

  it('白名单内但文件不存在时 404', async () => {
    const response = await handleRequest(
      buildContext(pluginDir),
      makeRequest({ query: { name: 'styles.css' } })
    );
    expect(response.status).toBe(404);
  });

  it('非 GET 方法 405', async () => {
    const response = await handleRequest(
      buildContext(pluginDir),
      makeRequest({ method: 'POST', query: { name: 'main.js' } })
    );
    expect(response.status).toBe(405);
  });

  it('不带令牌 401（与安装包下载同级，不额外放开）', async () => {
    const response = await handleRequest(
      buildContext(pluginDir),
      makeRequest({ query: { name: 'main.js' }, token: null })
    );
    expect(response.status).toBe(401);
  });
});
