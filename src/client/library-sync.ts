/**
 * 整库同步（电脑 → 手机）的核心流程。
 *
 * 独立成模块的原因：触发入口有两个——传输面板的大按钮、设置页的「一键同步」。
 * 两边必须走同一段逻辑，否则「跳过未变化」「失败隔离」这些行为迟早会走偏。
 * 这里只依赖 Obsidian 的 Vault 接口与 HTTP 客户端，因此能在单测里用替身穷举。
 */

import { TFile, TFolder, type Vault } from 'obsidian';
import type { BridgeClient } from './api-client';
import { parentOf } from '../shared/path';
import { isUpToDate, resolveDownloadTarget } from '../shared/transfer-path';
import type { BridgeEntry, ListResponse } from '../shared/types';

/** 单次同步的文件数上限：手机上一次跑太久容易被当成卡死，超过就分次点 */
export const MAX_SYNC_FILES = 2000;

/** 目录递归深度上限，防止异常结构把手机拖死 */
const MAX_DEPTH = 12;

export interface SyncSummary {
  /** 真正写入或覆盖的文件数 */
  downloaded: number;
  /** 大小与修改时间都没变、被跳过的文件数 */
  skipped: number;
  /** 下载或写盘失败的文件数 */
  failed: number;
  /** 读取被拒绝的电脑目录数 */
  unreadable: number;
  /** 候选文件总数 */
  total: number;
  /** 是否触到单次上限 */
  capped: boolean;
}

export interface SyncProgress {
  /** 当前处理到第几个（含已跳过的） */
  done: number;
  total: number;
  /** 正在处理的文件在电脑上的路径 */
  path: string;
}

/**
 * 递归收集电脑上的文件。
 *
 * 单个子目录读不到（权限、被排除、并发删除）不该让整库同步整体失败，
 * 记进 unreadable 如实汇报；顶层失败（地址错、令牌失效）必须抛出去，
 * 否则会把故障伪装成「电脑上没有文件」。
 */
export async function collectRemoteFiles(
  client: BridgeClient,
  path: string,
  depth: number,
  unreadable: string[],
  maxFiles: number = MAX_SYNC_FILES
): Promise<BridgeEntry[]> {
  if (depth > MAX_DEPTH) return [];

  let data: ListResponse;
  if (depth === 0) {
    data = await client.list(path);
  } else {
    try {
      data = await client.list(path);
    } catch {
      unreadable.push(path || '/');
      return [];
    }
  }

  const files: BridgeEntry[] = [];
  for (const item of data.entries) {
    if (item.kind === 'file') {
      files.push(item);
    } else {
      const nested = await collectRemoteFiles(client, item.path, depth + 1, unreadable, maxFiles);
      for (const file of nested) files.push(file);
    }
    if (files.length >= maxFiles) break;
  }
  return files;
}

/** 确保某个文件的父目录存在（Obsidian 的 createBinary 不会自动建多层目录） */
export async function ensureFolderFor(vault: Vault, filePath: string): Promise<void> {
  const parent = parentOf(filePath);
  if (!parent) return;
  const existing = vault.getAbstractFileByPath(parent);
  if (existing instanceof TFolder) return;
  if (existing) throw new Error('同名文件已存在：' + parent);
  await vault.createFolder(parent);
}

/**
 * 把文件列表逐个落到本机 vault。
 *
 * 增量策略：本地已有且 size 与 mtime 都没变就跳过；
 * 单个文件失败不中断整次同步，只计数，最后如实汇报。
 */
export async function syncFilesToVault(options: {
  vault: Vault;
  client: BridgeClient;
  files: BridgeEntry[];
  downloadDir: string;
  unreadable: number;
  capped: boolean;
  onProgress?: (progress: SyncProgress) => void | Promise<void>;
}): Promise<SyncSummary> {
  const { vault, client, files, downloadDir } = options;
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    const target = resolveDownloadTarget(downloadDir, file.path);
    const existing = vault.getAbstractFileByPath(target);

    if (
      existing instanceof TFile &&
      isUpToDate({ size: existing.stat.size, mtime: existing.stat.mtime }, file)
    ) {
      skipped++;
      continue;
    }

    if (options.onProgress) {
      await options.onProgress({
        done: downloaded + skipped + failed + 1,
        total: files.length,
        path: file.path,
      });
    }

    try {
      const data = await client.download(file.path);
      await ensureFolderFor(vault, target);
      if (existing instanceof TFile) {
        await vault.modifyBinary(existing, data);
      } else if (!existing) {
        await vault.createBinary(target, data);
      }
      downloaded++;
    } catch {
      // 单个文件失败不该中断整次同步，继续处理其余文件
      failed++;
    }
  }

  return {
    downloaded,
    skipped,
    failed,
    unreadable: options.unreadable,
    total: files.length,
    capped: options.capped,
  };
}

/** 从电脑某个目录（默认根目录）一路收集并落地到手机 */
export async function syncFromComputer(options: {
  vault: Vault;
  client: BridgeClient;
  downloadDir: string;
  rootPath?: string;
  onProgress?: (progress: SyncProgress) => void | Promise<void>;
}): Promise<SyncSummary> {
  const unreadable: string[] = [];
  const files = await collectRemoteFiles(options.client, options.rootPath || '', 0, unreadable);
  return syncFilesToVault({
    vault: options.vault,
    client: options.client,
    files,
    downloadDir: options.downloadDir,
    unreadable: unreadable.length,
    capped: files.length >= MAX_SYNC_FILES,
    onProgress: options.onProgress,
  });
}

/** 把统计拼成一句人话；面板与设置页共用同一套措辞 */
export function describeSyncSummary(summary: SyncSummary, downloadDir: string): string {
  const parts = ['下载 ' + summary.downloaded + ' 个'];
  if (summary.skipped > 0) parts.push('跳过 ' + summary.skipped + ' 个未变化');
  if (summary.failed > 0) parts.push('失败 ' + summary.failed + ' 个');
  if (summary.unreadable > 0) parts.push('无法读取 ' + summary.unreadable + ' 个目录');
  if (summary.capped) parts.push('已到单次上限 ' + MAX_SYNC_FILES + ' 个，再点一次可继续');
  return '同步完成：' + parts.join('，') + '（' + (downloadDir || 'vault 根目录') + '）';
}
