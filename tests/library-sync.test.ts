/**
 * 整库同步：收集与落地。
 *
 * 这一层是「手机点按钮 → 文件真的落到本机 vault」的核心，
 * 所以用替身客户端 + 替身 vault 把增量、失败隔离、目录结构都钉死。
 */

import { describe, expect, it } from 'vitest';
import type { BridgeClient } from '../src/client/api-client';
import {
  MAX_SYNC_FILES,
  collectRemoteFiles,
  describeSyncSummary,
  syncFilesToVault,
  syncFromComputer,
} from '../src/client/library-sync';
import type { BridgeEntry } from '../src/shared/types';
import { TFile, Vault } from './mocks/obsidian';

const encoder = new TextEncoder();

function bytes(text: string): ArrayBuffer {
  return encoder.encode(text).buffer as ArrayBuffer;
}

interface FakeOptions {
  /** 目录名 → 条目（kind 由是否有 children 决定） */
  tree: Record<string, Array<{ name: string; kind: 'file' | 'folder'; size?: number; mtime?: number }>>;
  /** 取内容；默认回显路径 */
  contents?: Record<string, string>;
  /** 这些目录的 list 会失败（模拟权限/被排除） */
  failing?: string[];
}

function fakeClient(options: FakeOptions) {
  const calls: { list: string[]; download: string[] } = { list: [], download: [] };
  const client = {
    async list(path: string) {
      calls.list.push(path);
      if ((options.failing || []).includes(path)) {
        throw new Error('list denied: ' + path);
      }
      const entries = options.tree[path] || [];
      return {
        path,
        parent: null,
        entries: entries.map((item) => ({
          name: item.name,
          path: path ? path + '/' + item.name : item.name,
          kind: item.kind,
          size: item.size ?? (options.contents?.[item.name] || item.name).length,
          mtime: item.mtime ?? 1_700_000_000_000,
        })) as BridgeEntry[],
      };
    },
    async download(path: string) {
      calls.download.push(path);
      const name = path.split('/').pop() || path;
      return bytes(options.contents?.[name] ?? name);
    },
  };
  return { client: client as unknown as BridgeClient, calls };
}

describe('collectRemoteFiles', () => {
  it('递归收齐所有目录里的文件，并把目录本身排除在外', async () => {
    const { client, calls } = fakeClient({
      tree: {
        '': [
          { name: '笔记', kind: 'folder' },
          { name: 'README.md', kind: 'file' },
        ],
        笔记: [{ name: '需求.md', kind: 'file' }],
      },
    });
    const unreadable: string[] = [];
    const files = await collectRemoteFiles(client, '', 0, unreadable);
    expect(files.map((f) => f.path).sort()).toEqual(['README.md', '笔记/需求.md']);
    expect(unreadable).toEqual([]);
    expect(calls.list).toEqual(['', '笔记']);
  });

  it('子目录读不到只记账，其余目录照常收集', async () => {
    const { client } = fakeClient({
      tree: {
        '': [
          { name: '私密', kind: 'folder' },
          { name: '公开', kind: 'folder' },
        ],
        公开: [{ name: 'a.md', kind: 'file' }],
      },
      failing: ['私密'],
    });
    const unreadable: string[] = [];
    const files = await collectRemoteFiles(client, '', 0, unreadable);
    expect(files.map((f) => f.path)).toEqual(['公开/a.md']);
    expect(unreadable).toEqual(['私密']);
  });

  it('顶层失败必须抛出去，不能伪装成「没有文件」', async () => {
    const { client } = fakeClient({ tree: {}, failing: [''] });
    await expect(collectRemoteFiles(client, '', 0, [])).rejects.toThrow('list denied');
  });

  it('到达单次上限就停下', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      name: 'f' + i + '.md',
      kind: 'file' as const,
    }));
    const { client } = fakeClient({ tree: { '': many } });
    const files = await collectRemoteFiles(client, '', 0, [], 3);
    expect(files).toHaveLength(3);
  });
});

describe('syncFilesToVault', () => {
  it('按电脑上的相对结构落到下载目录里', async () => {
    const vault = new Vault();
    const files: BridgeEntry[] = [
      { name: '需求清单.md', path: '团队知识库/需求清单.md', kind: 'file', size: 6, mtime: 1 },
    ];
    const { client, calls } = fakeClient({ tree: {}, contents: { '需求清单.md': '# 需求' } });

    const summary = await syncFilesToVault({
      vault: vault as never,
      client,
      files,
      downloadDir: 'VaultBridge下载',
      unreadable: 0,
      capped: false,
    });

    expect(summary.downloaded).toBe(1);
    expect(calls.download).toEqual(['团队知识库/需求清单.md']);
    const written = vault.getAbstractFileByPath('VaultBridge下载/团队知识库/需求清单.md');
    expect(written instanceof TFile).toBe(true);
    expect(new TextDecoder().decode((written as TFile).content)).toBe('# 需求');
  });

  it('本地已有且未变化的文件跳过，不产生下载请求', async () => {
    const vault = new Vault();
    await vault.createFolder('VaultBridge下载/团队知识库');
    const existing = await vault.createBinary('VaultBridge下载/团队知识库/需求清单.md', bytes('旧内容'));

    const files: BridgeEntry[] = [
      {
        name: '需求清单.md',
        path: '团队知识库/需求清单.md',
        kind: 'file',
        size: existing.stat.size,
        mtime: existing.stat.mtime,
      },
    ];
    const { client, calls } = fakeClient({ tree: {} });
    const summary = await syncFilesToVault({
      vault: vault as never,
      client,
      files,
      downloadDir: 'VaultBridge下载',
      unreadable: 0,
      capped: false,
    });

    expect(summary.skipped).toBe(1);
    expect(summary.downloaded).toBe(0);
    expect(calls.download).toEqual([]);
    expect(new TextDecoder().decode(existing.content)).toBe('旧内容');
  });

  it('内容变了的文件会被覆盖', async () => {
    const vault = new Vault();
    await vault.createFolder('VaultBridge下载');
    const existing = await vault.createBinary('VaultBridge下载/a.md', bytes('旧'));
    const files: BridgeEntry[] = [
      { name: 'a.md', path: 'a.md', kind: 'file', size: 99, mtime: existing.stat.mtime + 60_000 },
    ];
    const { client } = fakeClient({ tree: {}, contents: { 'a.md': '新' } });
    const summary = await syncFilesToVault({
      vault: vault as never,
      client,
      files,
      downloadDir: 'VaultBridge下载',
      unreadable: 0,
      capped: false,
    });
    expect(summary.downloaded).toBe(1);
    expect(new TextDecoder().decode(existing.content)).toBe('新');
  });

  it('单个文件失败只计数，其余文件继续下完', async () => {
    const vault = new Vault();
    const files: BridgeEntry[] = ['a.md', 'b.md', 'c.md'].map((name) => ({
      name,
      path: name,
      kind: 'file' as const,
      size: 1,
      mtime: 1,
    }));
    const failing = {
      async list() {
        return { path: '', parent: null, entries: [] as BridgeEntry[] };
      },
      async download(path: string) {
        if (path === 'b.md') throw new Error('网络中断');
        return bytes(path);
      },
    } as unknown as BridgeClient;

    const summary = await syncFilesToVault({
      vault: vault as never,
      client: failing,
      files,
      downloadDir: '',
      unreadable: 0,
      capped: false,
    });

    expect(summary.downloaded).toBe(2);
    expect(summary.failed).toBe(1);
    expect(vault.getAbstractFileByPath('a.md')).not.toBeNull();
    expect(vault.getAbstractFileByPath('c.md')).not.toBeNull();
    expect(vault.getAbstractFileByPath('b.md')).toBeNull();
  });

  it('汇报进度时带总数与当前文件', async () => {
    const vault = new Vault();
    const files: BridgeEntry[] = ['a.md', 'b.md'].map((name) => ({
      name,
      path: name,
      kind: 'file' as const,
      size: 1,
      mtime: 1,
    }));
    const { client } = fakeClient({ tree: {} });
    const seen: string[] = [];
    await syncFilesToVault({
      vault: vault as never,
      client,
      files,
      downloadDir: '',
      unreadable: 0,
      capped: false,
      onProgress: (progress) => {
        seen.push(progress.done + '/' + progress.total + ':' + progress.path);
      },
    });
    expect(seen).toEqual(['1/2:a.md', '2/2:b.md']);
  });
});

describe('syncFromComputer 与文案', () => {
  it('一路从根目录收集并落地', async () => {
    const vault = new Vault();
    const { client } = fakeClient({
      tree: {
        '': [{ name: '笔记', kind: 'folder' }],
        笔记: [{ name: 'a.md', kind: 'file' }],
      },
      contents: { 'a.md': '内容' },
    });
    const summary = await syncFromComputer({
      vault: vault as never,
      client,
      downloadDir: '',
    });
    expect(summary.downloaded).toBe(1);
    expect(vault.getAbstractFileByPath('笔记/a.md')).not.toBeNull();
  });

  it('统计文案把跳过的、失败的、读不到的都说清楚', () => {
    const text = describeSyncSummary(
      { downloaded: 3, skipped: 2, failed: 1, unreadable: 4, total: 6, capped: false },
      ''
    );
    expect(text).toContain('下载 3 个');
    expect(text).toContain('跳过 2 个未变化');
    expect(text).toContain('失败 1 个');
    expect(text).toContain('无法读取 4 个目录');
    expect(text).toContain('vault 根目录');
  });

  it('触到单次上限时提示再点一次', () => {
    const text = describeSyncSummary(
      { downloaded: 0, skipped: 0, failed: 0, unreadable: 0, total: MAX_SYNC_FILES, capped: true },
      'VaultBridge下载'
    );
    expect(text).toContain('单次上限');
    expect(text).toContain('VaultBridge下载');
  });
});
