/**
 * 手机端 API 客户端——这是手机与电脑通信的全部逻辑，
 * 它出错用户就传不了文件，因此错误分支要逐条钉死。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { BridgeClient, BridgeClientError, normalizeBaseUrl } from '../src/client/api-client';
import { requestUrlStub } from './mocks/obsidian';

const TOKEN = 'client-token-0123456789abcdef';

/** 构造一个 requestUrl 响应 */
function respond(overrides: { status?: number; text?: string; arrayBuffer?: ArrayBuffer } = {}) {
  return {
    status: overrides.status === undefined ? 200 : overrides.status,
    text: overrides.text === undefined ? '{}' : overrides.text,
    arrayBuffer: overrides.arrayBuffer || new ArrayBuffer(0),
    headers: {},
    json: {},
  };
}

let captured: Array<Record<string, unknown>> = [];

beforeEach(() => {
  captured = [];
  requestUrlStub.impl = async (options: unknown) => {
    captured.push(options as Record<string, unknown>);
    return respond({ status: 200, text: '{"ok":true}' });
  };
});

describe('normalizeBaseUrl', () => {
  it('缺协议时补 http', () => {
    expect(normalizeBaseUrl('192.168.1.44:8770')).toBe('http://192.168.1.44:8770');
  });

  it('保留已有的 https', () => {
    expect(normalizeBaseUrl('https://x.trycloudflare.com')).toBe('https://x.trycloudflare.com');
  });

  it('去掉尾部斜杠', () => {
    expect(normalizeBaseUrl('http://a.b:1///')).toBe('http://a.b:1');
  });

  it('去空白', () => {
    expect(normalizeBaseUrl('  http://a.b  ')).toBe('http://a.b');
  });

  it('空串保持空串', () => {
    expect(normalizeBaseUrl('')).toBe('');
  });
});

describe('configured', () => {
  it('地址与令牌都填了才算配置完成', () => {
    expect(new BridgeClient('http://a.b:1', TOKEN).configured).toBe(true);
    expect(new BridgeClient('', TOKEN).configured).toBe(false);
    expect(new BridgeClient('http://a.b:1', '').configured).toBe(false);
  });

  it('endpoint 暴露规范化后的地址', () => {
    expect(new BridgeClient('a.b:1', TOKEN).endpoint).toBe('http://a.b:1');
  });
});

describe('请求构造', () => {
  it('带上 Bearer 令牌头', async () => {
    await new BridgeClient('http://a.b:1', TOKEN).verify();
    expect(captured[0].headers).toEqual({ Authorization: 'Bearer ' + TOKEN });
  });

  it('查询参数被正确编码进 URL', async () => {
    await new BridgeClient('http://a.b:1', TOKEN).list('团队知识库/子目录');
    const url = String(captured[0].url);
    expect(url).toContain('/api/list');
    expect(url).toContain(encodeURIComponent('团队知识库/子目录'));
  });

  it('上传走 POST 且带二进制体', async () => {
    const body = new Uint8Array([1, 2, 3]).buffer;
    await new BridgeClient('http://a.b:1', TOKEN).upload('收件箱/a.bin', body);
    expect(captured[0].method).toBe('POST');
    expect(captured[0].body).toBe(body);
  });

  it('下载取 arrayBuffer 而不是文本', async () => {
    const payload = new Uint8Array([9, 8, 7]).buffer;
    requestUrlStub.impl = async () => respond({ status: 200, arrayBuffer: payload });
    const result = await new BridgeClient('http://a.b:1', TOKEN).download('a.bin');
    expect(new Uint8Array(result)).toEqual(new Uint8Array([9, 8, 7]));
  });

  it('未填地址时立刻报错，不发请求', async () => {
    await expect(new BridgeClient('', TOKEN).list('')).rejects.toThrow(BridgeClientError);
    expect(captured).toHaveLength(0);
  });
});

describe('错误翻译', () => {
  it('401 归类为令牌问题', async () => {
    requestUrlStub.impl = async () => respond({ status: 401, text: '' });
    const error = await new BridgeClient('http://a.b:1', TOKEN).verify().catch((e) => e);
    expect(error).toBeInstanceOf(BridgeClientError);
    expect((error as BridgeClientError).kind).toBe('auth');
    expect((error as BridgeClientError).message).toContain('令牌');
  });

  it('403 同样归类为令牌问题', async () => {
    requestUrlStub.impl = async () => respond({ status: 403, text: '' });
    const error = await new BridgeClient('http://a.b:1', TOKEN).verify().catch((e) => e);
    expect((error as BridgeClientError).kind).toBe('auth');
  });

  it('429 提示被限流', async () => {
    requestUrlStub.impl = async () => respond({ status: 429, text: '' });
    const error = await new BridgeClient('http://a.b:1', TOKEN).verify().catch((e) => e);
    expect((error as BridgeClientError).message).toContain('限流');
  });

  it('其它 4xx 透出服务端 message', async () => {
    requestUrlStub.impl = async () =>
      respond({ status: 413, text: JSON.stringify({ error: 'too_large', message: '文件超过上限 32 MB' }) });
    const error = await new BridgeClient('http://a.b:1', TOKEN)
      .upload('a.bin', new ArrayBuffer(1))
      .catch((e) => e);
    expect((error as BridgeClientError).message).toBe('文件超过上限 32 MB');
  });

  it('非 JSON 错误响应回落到状态码', async () => {
    requestUrlStub.impl = async () => respond({ status: 500, text: '<html>oops</html>' });
    const error = await new BridgeClient('http://a.b:1', TOKEN).verify().catch((e) => e);
    expect((error as BridgeClientError).message).toContain('500');
  });

  it('底层抛异常时给出可操作的排查提示', async () => {
    requestUrlStub.impl = async () => {
      throw new Error('Network request failed');
    };
    const error = await new BridgeClient('http://a.b:1', TOKEN).verify().catch((e) => e);
    expect((error as BridgeClientError).kind).toBe('network');
    expect((error as BridgeClientError).message).toContain('同一 WiFi');
  });

  it('返回内容不是 JSON 时报服务端异常', async () => {
    requestUrlStub.impl = async () => respond({ status: 200, text: 'not json at all' });
    const error = await new BridgeClient('http://a.b:1', TOKEN).verify().catch((e) => e);
    expect((error as BridgeClientError).kind).toBe('server');
  });

  it('空响应体按空对象处理', async () => {
    requestUrlStub.impl = async () => respond({ status: 200, text: '' });
    await expect(new BridgeClient('http://a.b:1', TOKEN).verify()).resolves.toBeUndefined();
  });
});

describe('健康检查', () => {
  it('解析健康检查响应', async () => {
    requestUrlStub.impl = async () =>
      respond({
        status: 200,
        text: JSON.stringify({ ok: true, app: 'Vault Bridge', version: '1.0.0', time: 1 }),
      });
    const health = await new BridgeClient('http://a.b:1', TOKEN).health();
    expect(health.ok).toBe(true);
    expect(health.version).toBe('1.0.0');
  });

  it('健康检查也走 /api/health', async () => {
    await new BridgeClient('http://a.b:1', TOKEN).health();
    expect(String(captured[0].url)).toContain('/api/health');
  });
});

describe('列表与建目录', () => {
  it('解析目录列表', async () => {
    requestUrlStub.impl = async () =>
      respond({
        status: 200,
        text: JSON.stringify({
          path: '',
          parent: null,
          entries: [{ name: 'a.md', path: 'a.md', kind: 'file', size: 10, mtime: 1 }],
        }),
      });
    const listed = await new BridgeClient('http://a.b:1', TOKEN).list('');
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0].name).toBe('a.md');
  });

  it('建目录走 POST 且带 path 参数', async () => {
    await new BridgeClient('http://a.b:1', TOKEN).mkdir('新目录');
    expect(captured[0].method).toBe('POST');
    expect(String(captured[0].url)).toContain(encodeURIComponent('新目录'));
  });
});
