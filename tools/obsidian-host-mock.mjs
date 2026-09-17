/**
 * Obsidian 宿主替身（Node 环境）。
 *
 * 目的：在不启动 Obsidian 的前提下，把构建产物 main.js 真正加载起来跑一遍，
 * 验证「模块结构正确、插件生命周期可走通、HTTP 服务能真的起端口」。
 * 只实现插件实际用到的 API，行为对齐官方语义。
 */

export class TAbstractFile {
  constructor() {
    this.name = '';
    this.path = '';
    this.parent = null;
  }
}

export class TFile extends TAbstractFile {
  constructor() {
    super();
    this.stat = { size: 0, mtime: 0, ctime: 0 };
    this.content = new ArrayBuffer(0);
  }
}

export class TFolder extends TAbstractFile {
  constructor() {
    super();
    this.children = [];
  }
}

/** 内存文件系统版 Vault，行为与官方一致 */
export class Vault {
  constructor() {
    this.rootFolder = new TFolder();
    this.clock = 1700000000000;
    this.rootFolder.name = '';
    this.listeners = [];
  }

  getRoot() {
    return this.rootFolder;
  }

  tick() {
    this.clock += 1000;
    return this.clock;
  }

  locate(path) {
    if (!path) return this.rootFolder;
    let cursor = this.rootFolder;
    for (const segment of path.split('/')) {
      if (!(cursor instanceof TFolder)) return null;
      const next = cursor.children.find((c) => c.name === segment);
      if (!next) return null;
      cursor = next;
    }
    return cursor;
  }

  getAbstractFileByPath(path) {
    return this.locate(path);
  }

  attach(parent, node) {
    node.parent = parent;
    node.path = parent.path ? parent.path + '/' + node.name : node.name;
    parent.children.push(node);
  }

  ensureFolder(folderPath) {
    const existing = this.locate(folderPath);
    if (existing instanceof TFolder) return existing;
    if (existing) throw new Error('路径被文件占用：' + folderPath);
    let cursor = this.rootFolder;
    let acc = '';
    for (const segment of folderPath.split('/')) {
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

  async createFolder(path) {
    return this.ensureFolder(path);
  }

  async createBinary(path, data) {
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

  async modifyBinary(file, data) {
    file.content = data;
    file.stat = { size: data.byteLength, mtime: this.tick(), ctime: file.stat.ctime };
  }

  async readBinary(file) {
    return file.content;
  }

  seed(path, text) {
    const bytes = new TextEncoder().encode(text);
    return this.seedBinary(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }

  seedBinary(path, buffer) {
    const slash = path.lastIndexOf('/');
    const parentPath = slash === -1 ? '' : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    const parent = parentPath ? this.ensureFolder(parentPath) : this.rootFolder;
    const file = new TFile();
    file.name = name;
    file.content = buffer;
    file.stat = { size: buffer.byteLength, mtime: this.tick(), ctime: this.tick() };
    this.attach(parent, file);
    return file;
  }
}

/** 极简 DOM 替身，足够驱动设置页渲染而不抛错 */
class FakeEl {
  constructor(tag, opts) {
    this.tagName = tag;
    this.children = [];
    this.textContent = (opts && opts.text) || '';
    this.cls = (opts && opts.cls) || '';
    this.style = {};
    this.attrs = (opts && opts.attr) || {};
    this.title = '';
    this.value = this.attrs.value || '';
    this.disabled = false;
    this.readOnly = false;
    this.listeners = {};
  }
  createEl(tag, opts) {
    const el = new FakeEl(tag, opts);
    this.children.push(el);
    return el;
  }
  createDiv(opts) {
    return this.createEl('div', opts);
  }
  createSpan(opts) {
    return this.createEl('span', opts);
  }
  empty() {
    this.children = [];
  }
  addClass() {}
  removeClass() {}
  toggleClass() {}
  setText(text) {
    this.textContent = text;
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  appendChild(child) {
    this.children.push(child);
  }
  addEventListener(type, handler) {
    this.listeners[type] = handler;
  }
  /** 深度优先收集所有后代文本，供断言检查渲染内容 */
  collectText() {
    let out = this.textContent || '';
    for (const child of this.children) out += ' ' + child.collectText();
    return out;
  }
}

export class Notice {
  static history = [];
  constructor(message) {
    this.message = message;
    Notice.history.push(message);
  }
}

export const Platform = {
  isDesktopApp: true,
  isMobileApp: false,
  isMobile: false,
};

export class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
    this.stored = null;
    this.settingTabs = [];
    this.views = {};
    this.commands = [];
    this.ribbonIcons = [];
    this.cleanups = [];
  }
  async loadData() {
    return this.stored;
  }
  async saveData(data) {
    this.stored = JSON.parse(JSON.stringify(data));
  }
  addSettingTab(tab) {
    this.settingTabs.push(tab);
  }
  registerView(type, creator) {
    this.views[type] = creator;
  }
  addCommand(command) {
    this.commands.push(command);
  }
  addRibbonIcon(icon, title, callback) {
    this.ribbonIcons.push({ icon, title, callback });
  }
  register(cleanup) {
    this.cleanups.push(cleanup);
  }
  async unload() {
    for (const cleanup of this.cleanups) cleanup();
  }
}

export class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = new FakeEl('div');
  }
}

/** 链式 Setting 替身：把回调立即执行一次，从而覆盖设置项构造路径 */
export class Setting {
  constructor(containerEl) {
    this.containerEl = containerEl;
    this.components = [];
  }
  setName(name) {
    this.name = name;
    return this;
  }
  setDesc(desc) {
    this.desc = desc;
    return this;
  }
  setHeading() {
    return this;
  }
  addToggle(cb) {
    cb(this.makeComponent('toggle'));
    return this;
  }
  addText(cb) {
    cb(this.makeComponent('text'));
    return this;
  }
  addButton(cb) {
    cb(this.makeComponent('button'));
    return this;
  }
  addExtraButton(cb) {
    cb(this.makeComponent('extra'));
    return this;
  }
  makeComponent(kind) {
    const el = new FakeEl('input');
    const component = {
      kind,
      inputEl: el,
      setValue: () => component,
      setPlaceholder: () => component,
      setButtonText: () => component,
      setTooltip: () => component,
      setIcon: () => component,
      setDisabled: () => component,
      onChange: () => component,
      onClick: () => component,
    };
    this.components.push(component);
    return component;
  }
}

export class ItemView {
  constructor(leaf) {
    this.leaf = leaf;
    this.app = leaf && leaf.app ? leaf.app : {};
    this.contentEl = new FakeEl('div');
  }
}

export class WorkspaceLeaf {}

export function setIcon() {}

export function normalizePath(path) {
  return String(path).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

export async function requestUrl() {
  throw new Error('宿主替身未实现 requestUrl');
}

/** 把上面所有导出打包成一个对象，供 Module._load 拦截返回 */
export function createObsidianMock() {
  return {
    TAbstractFile,
    TFile,
    TFolder,
    Vault,
    Notice,
    Platform,
    Plugin,
    PluginSettingTab,
    Setting,
    ItemView,
    WorkspaceLeaf,
    setIcon,
    normalizePath,
    requestUrl,
  };
}
