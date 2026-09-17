/**
 * vault 文件操作层。
 *
 * 全部通过 Obsidian 的 Vault API 完成，而不是直接操作文件系统，原因有三：
 *  1. Vault API 自带索引，写入后会立即触发 Obsidian 刷新，手机传上来的文件马上可见；
 *  2. Vault API 看不见 `.obsidian` 等配置目录，天然多一层隔离；
 *  3. 移动端与桌面端行为一致（本模块不引入任何 Node 依赖）。
 */

import { TAbstractFile, TFile, TFolder, Vault } from 'obsidian';
import type { BridgeEntry, ListResponse, UploadResponse } from '../shared/types';
import { parentOf } from '../shared/path';

/** 可预期的业务错误，由路由层映射为 4xx */
export class BridgeOpError extends Error {
  constructor(
    public readonly code: 'not_found' | 'not_a_folder' | 'conflict' | 'forbidden' | 'too_large',
    message: string
  ) {
    super(message);
    this.name = 'BridgeOpError';
  }
}

/**
 * 按路径查找条目，兼容 Unicode 归一化差异。
 *
 * iOS/macOS 的文件名默认是 NFD（分解式），Linux 是 NFC（组合式）。
 * 手机上传「团队知识库」若用 NFD，直接查会找不到 Linux 上 NFC 的同名目录，
 * 于是这里做一次变体回退，避免产生重名文件。
 */
function findAbstract(vault: Vault, path: string): TAbstractFile | null {
  if (!path) return vault.getRoot();
  const direct = vault.getAbstractFileByPath(path);
  if (direct) return direct;

  if (typeof path.normalize === 'function') {
    const nfc = path.normalize('NFC');
    if (nfc !== path) {
      const hit = vault.getAbstractFileByPath(nfc);
      if (hit) return hit;
    }
    const nfd = path.normalize('NFD');
    if (nfd !== path) {
      const hit = vault.getAbstractFileByPath(nfd);
      if (hit) return hit;
    }
  }
  return null;
}

/** 列目录条目时是否跳过（配置目录、版本库等噪音） */
function isExcluded(name: string, excluded: string[]): boolean {
  return excluded.indexOf(name) !== -1;
}

/** 把 vault 节点转成协议条目 */
function toEntry(node: TAbstractFile, parentPath: string): BridgeEntry {
  const isFolder = node instanceof TFolder;
  const stat = (node as unknown as { stat?: { size?: number; mtime?: number } }).stat;
  return {
    name: node.name,
    path: parentPath ? parentPath + '/' + node.name : node.name,
    kind: isFolder ? 'folder' : 'file',
    size: isFolder ? 0 : stat && typeof stat.size === 'number' ? stat.size : 0,
    mtime: stat && typeof stat.mtime === 'number' ? stat.mtime : 0,
  };
}

/** 列出目录内容，目录优先、再按中文友好顺序排序 */
export function listFolder(vault: Vault, dirPath: string, excludedDirs: string[]): ListResponse {
  const target = dirPath ? findAbstract(vault, dirPath) : vault.getRoot();
  if (!target) {
    throw new BridgeOpError('not_found', '目录不存在：' + dirPath);
  }
  if (!(target instanceof TFolder)) {
    throw new BridgeOpError('not_a_folder', '目标不是目录：' + dirPath);
  }

  const entries: BridgeEntry[] = [];
  for (const child of target.children) {
    if (isExcluded(child.name, excludedDirs)) continue;
    entries.push(toEntry(child, dirPath));
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });

  return { path: dirPath, parent: parentOf(dirPath), entries };
}

/** 推导某个节点自身路径（Vault API 不直接给，用父链拼） */
function pathOf(node: TAbstractFile): string {
  const chain: string[] = [node.name];
  let cursor = node.parent;
  while (cursor && cursor.name) {
    chain.unshift(cursor.name);
    cursor = cursor.parent;
  }
  return chain.join('/');
}

/** 读取文件元信息 */
export function statFile(vault: Vault, path: string): { path: string; size: number; mtime: number } {
  const node = findAbstract(vault, path);
  if (!node) throw new BridgeOpError('not_found', '文件不存在：' + path);
  if (!(node instanceof TFile)) throw new BridgeOpError('not_found', '目标不是文件：' + path);
  return { path: pathOf(node), size: node.stat.size, mtime: node.stat.mtime };
}

/** 读取文件内容为二进制 */
export async function readFileBinary(
  vault: Vault,
  path: string
): Promise<{ data: ArrayBuffer; name: string }> {
  const node = findAbstract(vault, path);
  if (!node) throw new BridgeOpError('not_found', '文件不存在：' + path);
  if (!(node instanceof TFile)) throw new BridgeOpError('not_found', '目标不是文件：' + path);
  const data = await vault.readBinary(node);
  return { data, name: node.name };
}

/** 逐级确保目录存在 */
export async function ensureFolder(vault: Vault, folderPath: string): Promise<void> {
  if (!folderPath) return;
  const segments = folderPath.split('/');
  let current = '';
  for (const segment of segments) {
    current = current ? current + '/' + segment : segment;
    const node = findAbstract(vault, current);
    if (node instanceof TFolder) continue;
    if (node) {
      throw new BridgeOpError('conflict', '路径被同名文件占用：' + current);
    }
    await vault.createFolder(current);
  }
}

/** 写入文件（存在则覆盖，不存在则连带父目录一起创建） */
export async function writeFileBinary(
  vault: Vault,
  path: string,
  data: ArrayBuffer
): Promise<UploadResponse> {
  const existing = findAbstract(vault, path);

  if (existing instanceof TFolder) {
    throw new BridgeOpError('conflict', '目标是目录，无法写入：' + path);
  }
  if (existing instanceof TFile) {
    await vault.modifyBinary(existing, data);
    return { path: pathOf(existing), size: data.byteLength, action: 'updated' };
  }

  const parent = parentOf(path);
  if (parent) {
    await ensureFolder(vault, parent);
  }
  const created = await vault.createBinary(path, data);
  return { path: pathOf(created), size: data.byteLength, action: 'created' };
}

/** 判断路径是否存在及其类型 */
export function kindOf(vault: Vault, path: string): 'file' | 'folder' | 'missing' {
  if (!path) return 'folder';
  const node = findAbstract(vault, path);
  if (!node) return 'missing';
  return node instanceof TFolder ? 'folder' : 'file';
}
