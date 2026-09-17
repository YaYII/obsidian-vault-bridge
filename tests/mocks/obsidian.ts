/**
 * Obsidian API 的测试替身。
 *
 * 只实现插件真正依赖的那部分 Vault 语义（目录树、二进制读写、stat 维护），
 * 行为对齐官方 API：createBinary 会自动建父目录并更新 size/mtime，
 * getAbstractFileByPath 对不存在的路径返回 null。
 */

export class TAbstractFile {
  name = '';
  path = '';
  parent: TFolder | null = null;
  vault: Vault | null = null;
}

export class TFile extends TAbstractFile {
  stat = { size: 0, mtime: 0, ctime: 0 };
  content: ArrayBuffer = new ArrayBuffer(0);
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

export class Vault {
  private readonly rootFolder = new TFolder();
  private clock = 1_700_000_000_000;

  constructor() {
    this.rootFolder.name = '';
    this.rootFolder.path = '';
    this.rootFolder.vault = this;
  }

  getRoot(): TFolder {
    return this.rootFolder;
  }

  private tick(): number {
    this.clock += 1000;
    return this.clock;
  }

  private locate(path: string): TAbstractFile | null {
    if (!path) return this.rootFolder;
    const segments = path.split('/');
    let cursor: TAbstractFile = this.rootFolder;
    for (const segment of segments) {
      if (!(cursor instanceof TFolder)) return null;
      const next = cursor.children.find((child) => child.name === segment);
      if (!next) return null;
      cursor = next;
    }
    return cursor;
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.locate(path);
  }

  private attach(parent: TFolder, node: TAbstractFile): void {
    node.parent = parent;
    node.vault = this;
    node.path = parent.path ? parent.path + '/' + node.name : node.name;
    parent.children.push(node);
  }

  private ensureFolder(folderPath: string): TFolder {
    const existing = this.locate(folderPath);
    if (existing instanceof TFolder) return existing;
    if (existing) throw new Error('路径被文件占用：' + folderPath);

    const segments = folderPath.split('/');
    let cursor = this.rootFolder;
    let acc = '';
    for (const segment of segments) {
      acc = acc ? acc + '/' + segment : segment;
      const hit = this.locate(acc);
      if (hit instanceof TFolder) {
        cursor = hit;
        continue;
      }
      const created = new TFolder();
      created.name = segment;
      this.attach(cursor, created);
      cursor = created;
    }
    return cursor;
  }

  async createFolder(path: string): Promise<TFolder> {
    return this.ensureFolder(path);
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    const slash = path.lastIndexOf('/');
    const parentPath = slash === -1 ? '' : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    const parent = parentPath ? this.ensureFolder(parentPath) : this.rootFolder;

    const file = new TFile();
    file.name = name;
    file.content = data;
    file.stat = { size: data.byteLength, mtime: this.tick(), ctime: this.tick() };
    this.attach(parent, file);
    return file;
  }

  async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
    file.content = data;
    file.stat = { size: data.byteLength, mtime: this.tick(), ctime: file.stat.ctime };
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    return file.content;
  }

  /** 测试辅助：直接塞一个文件进去 */
  seed(path: string, text: string): TFile {
    const bytes = new TextEncoder().encode(text);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const slash = path.lastIndexOf('/');
    const parentPath = slash === -1 ? '' : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    const parent = parentPath ? this.ensureFolder(parentPath) : this.rootFolder;
    const file = new TFile();
    file.name = name;
    file.content = buffer as ArrayBuffer;
    file.stat = { size: buffer.byteLength, mtime: this.tick(), ctime: this.tick() };
    this.attach(parent, file);
    return file;
  }
}

/** 插件与面板里用到但路由层不依赖的导出，给最小可用的替身避免导入报错 */
export const Platform = { isDesktopApp: true, isMobileApp: false, isMobile: false };

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

export class Notice {
  constructor(public readonly message: string) {}
}

export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class ItemView {}
export class WorkspaceLeaf {}
export function setIcon(): void {}
/** requestUrl 的可注入实现，测试通过 requestUrlStub.impl 替换 */
export const requestUrlStub: { impl: (options: unknown) => Promise<unknown> } = {
  impl: async () => {
    throw new Error('测试未设置 requestUrl 实现');
  },
};

export function requestUrl(options: unknown): Promise<unknown> {
  return requestUrlStub.impl(options);
}
