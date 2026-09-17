/**
 * 手机端传输面板：浏览电脑上的知识库并下载到本地，或把本地文件上传到电脑。
 *
 * 交互模型刻意做成「两边各一个浏览器」：
 *   下载页签 —— 浏览的是电脑目录，下载后按相同相对路径落到本地下载目录，
 *               这样 Obsidian 的双链、附件引用在手机上依然成立；
 *   上传页签 —— 浏览的是手机目录，上传后按相同相对路径落到电脑的目标目录。
 */

import { ItemView, Notice, Platform, TFile, TFolder, WorkspaceLeaf, setIcon } from 'obsidian';
import { BridgeClient, BridgeClientError, extractTokenFromUrl, normalizeBaseUrl } from './api-client';
import { formatBytes } from '../shared/format';
import { parentOf } from '../shared/path';
import { resolveDownloadTarget, resolveUploadTarget } from '../shared/transfer-path';
import { readRemotePluginVersion } from '../shared/plugin-update';
import type { BridgeEntry } from '../shared/types';
import { MAX_SYNC_FILES, collectRemoteFiles, describeSyncSummary, syncFilesToVault } from './library-sync';
import { describeError } from './error-text';
import {
  forgetProfile,
  formatRelativeTime,
  maskProfileToken,
  rememberProfile,
  type ServerProfile,
} from '../shared/server-profile';
import type VaultBridgePlugin from '../main';

export const VIEW_TYPE_BRIDGE_PANEL = 'vault-bridge-panel';

type Tab = 'download' | 'upload';

/** 面板的全部可变状态，渲染函数只读它 */
interface PanelState {
  tab: Tab;
  /** 下载页签当前浏览的电脑目录 */
  remotePath: string;
  /** 上传页签当前浏览的手机目录 */
  localPath: string;
  remoteEntries: BridgeEntry[];
  localEntries: BridgeEntry[];
  connected: boolean;
  /** 正在进行的操作描述，非空时禁用交互 */
  busy: string;
  lastMessage: string;
  lastMessageKind: 'info' | 'ok' | 'err';
  /** 待连接的电脑访问令牌（与档案同步，连接成功后写回历史） */
  serverToken: string;
  /** 是否展开历史记录列表 */
  showHistory: boolean;
}

export class BridgePanel extends ItemView {
  private state: PanelState = {
    tab: 'download',
    remotePath: '',
    localPath: '',
    remoteEntries: [],
    localEntries: [],
    connected: false,
    busy: '',
    lastMessage: '',
    lastMessageKind: 'info',
    serverToken: '',
    showHistory: false,
  };

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: VaultBridgePlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_BRIDGE_PANEL;
  }

  getDisplayText(): string {
    return 'Vault Bridge 传输';
  }

  getIcon(): string {
    return 'arrow-left-right';
  }

  async onOpen(): Promise<void> {
    // 打开面板时把当前地址对应的令牌带出来，用户通常不必重输
    this.state.serverToken = this.currentConnection().token;
    await this.render();
  }

  /** 构造客户端；地址或令牌缺失时返回 null */
  /**
   * 当前连接信息。
   *
   * 令牌优先取面板里已填的值，其次取该地址在历史档案里的记录；
   * 都没有时回退到本机令牌——旧版本就是这么连的（vault 连同 data.json 一起同步的场景）。
   */
  private currentConnection(): { url: string; token: string } {
    return this.plugin.resolveConnection(this.state.serverToken);
  }

  private buildClient(): BridgeClient | null {
    return this.plugin.createClient(this.state.serverToken);
  }

  /** 首次进入或切换设置后尝试连接一次 */
  private async tryConnect(silent = true): Promise<void> {
    const client = this.buildClient();
    if (!client) {
      this.state.connected = false;
      if (!silent) new Notice('请先填写电脑地址');
      return;
    }
    this.state.busy = '正在连接电脑…';
    await this.render();
    try {
      await client.verify();
      this.state.connected = true;
      this.state.lastMessage = '已连接 ' + client.endpoint;
      this.state.lastMessageKind = 'ok';

      // 连接成功即写入历史：地址与令牌一起记下，换网络时直接选，不必手输
      this.plugin.settings.clientServerUrl = client.endpoint;
      this.plugin.settings.serverProfiles = rememberProfile(
        this.plugin.settings.serverProfiles,
        client.endpoint,
        this.currentConnection().token
      );
      await this.plugin.saveSettings();

      await this.refreshRemote();
      await this.refreshLocal();
    } catch (error) {
      this.state.connected = false;
      this.state.lastMessage = describeError(error);
      this.state.lastMessageKind = 'err';
    } finally {
      this.state.busy = '';
      await this.render();
    }
  }

  /** 拉取电脑目录 */
  private async refreshRemote(): Promise<void> {
    const client = this.buildClient();
    if (!client) return;
    try {
      const data = await client.list(this.state.remotePath);
      this.state.remoteEntries = data.entries;
      this.state.remotePath = data.path;
    } catch (error) {
      this.state.lastMessage = describeError(error);
      this.state.lastMessageKind = 'err';
    }
  }

  /** 读取手机本地目录（走 Obsidian Vault，自动跳过配置目录） */
  private async refreshLocal(): Promise<void> {
    const folderPath = this.state.localPath;
    const node = folderPath ? this.app.vault.getAbstractFileByPath(folderPath) : this.app.vault.getRoot();
    if (!(node instanceof TFolder)) {
      this.state.localPath = '';
      this.state.localEntries = this.readLocalEntries(this.app.vault.getRoot());
      return;
    }
    this.state.localEntries = this.readLocalEntries(node);
  }

  private readLocalEntries(folder: TFolder): BridgeEntry[] {
    const entries: BridgeEntry[] = [];
    for (const child of folder.children) {
      if (child.name === this.app.vault.configDir || child.name === '.trash' || child.name === '.git')
        continue;
      const entryPath = folder.path ? folder.path + '/' + child.name : child.name;
      if (child instanceof TFolder) {
        entries.push({ name: child.name, path: entryPath, kind: 'folder', size: 0, mtime: 0 });
      } else if (child instanceof TFile) {
        // 用 instanceof 安全收窄，避免对 TFile 做类型断言
        entries.push({
          name: child.name,
          path: entryPath,
          kind: 'file',
          size: child.stat.size,
          mtime: child.stat.mtime,
        });
      }
    }
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
    return entries;
  }

  // ───────────────────────────── 渲染 ─────────────────────────────

  private async render(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('vault-bridge-panel');

    this.renderHeader(root);
    this.renderTabs(root);
    // 整库同步是手机上最常用的动作，直接放在页签正下方，不进二级界面
    if (this.state.tab === 'download') {
      this.renderSyncBar(root);
    }

    const body = root.createDiv({ cls: 'vault-bridge-body' });
    if (this.state.busy) {
      body.createDiv({ cls: 'vault-bridge-busy', text: '⏳ ' + this.state.busy });
    }

    if (this.state.tab === 'download') {
      this.renderRemoteBrowser(body);
    } else {
      this.renderLocalBrowser(body);
    }

    this.renderFooter(root);
  }

  /**
   * 整库同步入口。
   *
   * 用户的心智模型是「点一下，把电脑上的东西全弄到手机」，
   * 而不是「先理解点文件夹会递归下载」这层语义，所以给它一个独立的主按钮。
   */
  private renderSyncBar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: 'vault-bridge-syncbar' });

    const button = bar.createEl('button', {
      cls: 'mod-cta vault-bridge-sync-all',
      text: '⬇ 一键同步整个库到手机',
    });
    button.title = '把电脑 vault 里的全部文件下载到手机；已存在且未变化的文件自动跳过';
    button.disabled = !this.state.connected || this.state.busy.length > 0;
    button.addEventListener('click', () => {
      void this.downloadFolder({ name: '整个库', path: '', kind: 'folder', size: 0, mtime: 0 });
    });

    const hint = bar.createDiv({ cls: 'vault-bridge-sync-hint' });
    hint.setText(
      this.state.connected
        ? '保存到：' +
            (this.plugin.settings.clientDownloadDir || 'vault 根目录') +
            '（首次全量，之后只传改动过的文件）'
        : '先在上方填写电脑地址与令牌，点「连接」'
    );
  }

  private renderHeader(root: HTMLElement): void {
    const header = root.createDiv({ cls: 'vault-bridge-header' });
    const title = header.createDiv({ cls: 'vault-bridge-title' });
    const dot = title.createSpan({ cls: 'vault-bridge-dot' + (this.state.connected ? ' is-on' : '') });
    dot.setText(this.state.connected ? '●' : '○');
    title.createSpan({ text: this.state.connected ? '已连接' : '电脑地址' });

    // 第一行：地址 + 历史记录入口
    const row = header.createDiv({ cls: 'vault-bridge-addr-row' });
    const input = row.createEl('input', {
      type: 'text',
      cls: 'vault-bridge-input',
      attr: {
        placeholder: Platform.isDesktopApp ? 'http://127.0.0.1:8770' : 'http://192.168.1.44:8770',
        value: this.plugin.settings.clientServerUrl,
        autocapitalize: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
      },
    });
    input.addEventListener('change', () => {
      void (async () => {
        // 整条浏览器链接（…/obs?token=xxx）也能直接用：地址只留前缀，令牌顺手取走
        const pastedToken = extractTokenFromUrl(input.value);
        this.plugin.settings.clientServerUrl = normalizeBaseUrl(input.value);
        if (pastedToken) this.state.serverToken = pastedToken;
        await this.plugin.saveSettings();
        if (pastedToken) await this.render();
      })();
    });

    const historyBtn = row.createEl('button', {
      text: this.state.showHistory ? '收起' : '历史',
      cls: 'vault-bridge-history-toggle',
    });
    historyBtn.title = '选择之前连接过的地址与令牌，不必每次手输';
    historyBtn.addEventListener('click', () => {
      this.state.showHistory = !this.state.showHistory;
      void this.render();
    });

    // 第二行：令牌 + 连接。令牌单独一行，手机上才看得清、也方便点按。
    const tokenRow = header.createDiv({ cls: 'vault-bridge-addr-row' });
    const tokenInput = tokenRow.createEl('input', {
      type: 'password',
      cls: 'vault-bridge-input',
      attr: {
        placeholder: '电脑的访问令牌',
        value: this.state.serverToken,
        autocapitalize: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
      },
    });
    tokenInput.addEventListener('change', () => {
      this.state.serverToken = tokenInput.value.trim();
    });

    const connectBtn = tokenRow.createEl('button', {
      text: this.state.connected ? '重新连接' : '连接',
    });
    connectBtn.addEventListener('click', () => {
      void (async () => {
        const pastedToken = extractTokenFromUrl(input.value);
        this.plugin.settings.clientServerUrl = normalizeBaseUrl(input.value);
        this.state.serverToken = tokenInput.value.trim() || pastedToken;
        await this.plugin.saveSettings();
        await this.tryConnect(false);
      })();
    });

    if (this.state.showHistory) {
      this.renderHistoryList(header);
    }
  }

  /**
   * 历史连接记录。
   * 点一条即切换地址与令牌并尝试连接；右侧 ✕ 删除不再需要的记录。
   */
  private renderHistoryList(parent: HTMLElement): void {
    const profiles = this.plugin.settings.serverProfiles;
    const box = parent.createDiv({ cls: 'vault-bridge-history' });

    if (profiles.length === 0) {
      box.createDiv({
        cls: 'vault-bridge-history-empty',
        text: '还没有历史记录。成功连接一次后，地址与令牌会自动记在这里。',
      });
      return;
    }

    for (const profile of profiles) {
      const item = box.createDiv({ cls: 'vault-bridge-history-row' });

      const info = item.createDiv({ cls: 'vault-bridge-history-info' });
      info.createDiv({ cls: 'vault-bridge-history-label', text: profile.label });
      info.createDiv({ cls: 'vault-bridge-history-url', text: profile.url });

      const meta = item.createDiv({ cls: 'vault-bridge-history-meta' });
      meta.createDiv({ text: formatRelativeTime(profile.lastUsedAt) });
      meta.createDiv({ text: maskProfileToken(profile.token) });

      const remove = item.createEl('button', { cls: 'vault-bridge-history-remove', text: '✕' });
      remove.title = '删除这条记录';
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        void this.removeProfile(profile.url);
      });

      item.addEventListener('click', () => {
        void this.applyProfile(profile);
      });
    }
  }

  /** 选中一条历史：填入地址与令牌后立即尝试连接 */
  private async applyProfile(profile: ServerProfile): Promise<void> {
    this.plugin.settings.clientServerUrl = profile.url;
    this.state.serverToken = profile.token;
    this.state.showHistory = false;
    await this.plugin.saveSettings();
    await this.tryConnect(false);
  }

  /** 删除一条历史记录 */
  private async removeProfile(url: string): Promise<void> {
    this.plugin.settings.serverProfiles = forgetProfile(this.plugin.settings.serverProfiles, url);
    await this.plugin.saveSettings();
    await this.render();
  }

  private renderTabs(root: HTMLElement): void {
    const tabs = root.createDiv({ cls: 'vault-bridge-tabs' });

    const downloadTab = tabs.createEl('button', { text: '⬇ 下载到手机' });
    downloadTab.toggleClass('is-active', this.state.tab === 'download');
    downloadTab.addEventListener('click', () => {
      void (async () => {
        this.state.tab = 'download';
        await this.render();
      })();
    });

    const uploadTab = tabs.createEl('button', { text: '⬆ 上传到电脑' });
    uploadTab.toggleClass('is-active', this.state.tab === 'upload');
    uploadTab.addEventListener('click', () => {
      void (async () => {
        this.state.tab = 'upload';
        await this.render();
      })();
    });
  }

  /** 面包屑 + 条目列表的通用渲染 */
  private renderBrowser(
    body: HTMLElement,
    options: {
      label: string;
      path: string;
      entries: BridgeEntry[];
      emptyText: string;
      onNavigate: (path: string) => void;
      onActivate: (entry: BridgeEntry) => void;
      actionIcon: string;
      actionTitle: string;
    }
  ): void {
    const box = body.createDiv({ cls: 'vault-bridge-browser' });
    box.createDiv({ cls: 'vault-bridge-section-label', text: options.label });

    // 面包屑
    const crumb = box.createDiv({ cls: 'vault-bridge-crumb' });
    const rootLink = crumb.createEl('a', { text: '根目录' });
    rootLink.addEventListener('click', (e) => {
      e.preventDefault();
      options.onNavigate('');
    });
    if (options.path) {
      let acc = '';
      for (const part of options.path.split('/')) {
        acc = acc ? acc + '/' + part : part;
        crumb.createSpan({ text: ' / ' });
        const link = crumb.createEl('a', { text: part });
        const target = acc;
        link.addEventListener('click', (e) => {
          e.preventDefault();
          options.onNavigate(target);
        });
      }
    }

    const parent = parentOf(options.path);
    if (parent !== null) {
      const up = box.createEl('button', { text: '↑ 返回上一级', cls: 'vault-bridge-up' });
      up.addEventListener('click', () => options.onNavigate(parent));
    }

    if (options.entries.length === 0) {
      box.createDiv({ cls: 'vault-bridge-empty', text: options.emptyText });
      return;
    }

    const list = box.createDiv({ cls: 'vault-bridge-list' });
    for (const entry of options.entries) {
      const row = list.createDiv({ cls: 'vault-bridge-row' });
      const icon = row.createSpan({ cls: 'vault-bridge-row-icon' });
      icon.setText(entry.kind === 'folder' ? '📁' : '📄');

      const meta = row.createDiv({ cls: 'vault-bridge-row-meta' });
      meta.createDiv({ cls: 'vault-bridge-row-name', text: entry.name });
      meta.createDiv({
        cls: 'vault-bridge-row-sub',
        text: entry.kind === 'folder' ? '文件夹' : formatBytes(entry.size),
      });

      const button = row.createEl('button', { cls: 'vault-bridge-row-action' });
      setIcon(button, entry.kind === 'folder' ? 'folder-open' : options.actionIcon);
      button.title = entry.kind === 'folder' ? '打开' : options.actionTitle;
      button.disabled = this.state.busy.length > 0;
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        options.onActivate(entry);
      });

      // 整行也可点击：文件夹进目录，文件执行动作
      row.addEventListener('click', () => {
        if (this.state.busy) return;
        if (entry.kind === 'folder') options.onNavigate(entry.path);
        else options.onActivate(entry);
      });
      row.toggleClass('is-folder', entry.kind === 'folder');
    }
  }

  private renderRemoteBrowser(body: HTMLElement): void {
    this.renderBrowser(body, {
      label: '电脑上的目录',
      path: this.state.remotePath,
      entries: this.state.remoteEntries,
      emptyText: this.state.connected ? '这个文件夹是空的' : '尚未连接电脑',
      onNavigate: (path) => {
        void (async () => {
          this.state.remotePath = path;
          await this.refreshRemote();
          await this.render();
        })();
      },
      onActivate: (entry) => {
        if (entry.kind === 'folder') {
          void this.downloadFolder(entry);
        } else {
          void this.downloadFile(entry);
        }
      },
      actionIcon: 'download',
      actionTitle: '下载到手机',
    });
  }

  private renderLocalBrowser(body: HTMLElement): void {
    this.renderBrowser(body, {
      label: '手机上的目录',
      path: this.state.localPath,
      entries: this.state.localEntries,
      emptyText: '这个文件夹是空的',
      onNavigate: (path) => {
        void (async () => {
          this.state.localPath = path;
          await this.refreshLocal();
          await this.render();
        })();
      },
      onActivate: (entry) => {
        if (entry.kind === 'folder') {
          void this.uploadFolder(entry);
        } else {
          void this.uploadFile(entry);
        }
      },
      actionIcon: 'upload',
      actionTitle: '上传到电脑',
    });
  }

  private renderFooter(root: HTMLElement): void {
    const footer = root.createDiv({ cls: 'vault-bridge-footer' });

    const targetRow = footer.createDiv({ cls: 'vault-bridge-target' });
    if (this.state.tab === 'download') {
      targetRow.createSpan({ text: '保存到手机：' });
      const value = targetRow.createEl('code', {
        text: this.plugin.settings.clientDownloadDir || '(vault 根目录)',
      });
      value.title = '在设置里修改';
    } else {
      targetRow.createSpan({ text: '上传到电脑：' });
      const value = targetRow.createEl('code', {
        text: this.plugin.settings.clientUploadDir || '(电脑 vault 根目录)',
      });
      value.title = '在设置里修改';
    }

    if (this.state.lastMessage) {
      footer.createDiv({
        cls: 'vault-bridge-message is-' + this.state.lastMessageKind,
        text: this.state.lastMessage,
      });
    }

    const actions = footer.createDiv({ cls: 'vault-bridge-footer-actions' });
    const settingsBtn = actions.createEl('button', { text: '⚙ 设置' });
    settingsBtn.addEventListener('click', () => {
      this.plugin.openSettings();
    });

    // 手机端换版本很麻烦（要手动替换 3 个文件），直接给一个从电脑拉最新版的入口
    if (Platform.isMobileApp) {
      const updateBtn = actions.createEl('button', { text: '⇧ 更新插件' });
      updateBtn.title = '从电脑取最新版插件文件覆盖本机，之后重启 Obsidian 生效';
      updateBtn.disabled = !this.state.connected || this.state.busy.length > 0;
      updateBtn.addEventListener('click', () => {
        void this.updatePluginFromServer();
      });
    }

    const refreshBtn = actions.createEl('button', { text: '↻ 刷新' });
    refreshBtn.addEventListener('click', () => {
      void (async () => {
        await this.refreshLocal();
        if (this.state.connected) await this.refreshRemote();
        await this.render();
      })();
    });
  }

  // ───────────────────────────── 动作 ─────────────────────────────

  /** 计算下载到本地后的完整路径，保持与电脑端一致的相对结构 */
  private localTargetPath(remotePath: string): string {
    return resolveDownloadTarget(this.plugin.settings.clientDownloadDir, remotePath);
  }

  /** 计算上传到电脑后的完整路径 */
  private remoteTargetPath(localPath: string): string {
    return resolveUploadTarget(this.plugin.settings.clientUploadDir, localPath);
  }

  /** 确保本地父目录存在 */
  private async ensureLocalFolder(filePath: string): Promise<void> {
    const parent = parentOf(filePath);
    if (!parent) return;
    const existing = this.app.vault.getAbstractFileByPath(parent);
    if (existing instanceof TFolder) return;
    if (existing) throw new Error('同名文件已存在：' + parent);
    await this.app.vault.createFolder(parent);
  }

  private async downloadFile(entry: BridgeEntry): Promise<void> {
    const client = this.buildClient();
    if (!client) {
      new Notice('请先填写电脑地址并连接');
      return;
    }
    this.state.busy = '正在下载 ' + entry.name;
    await this.render();
    try {
      const data = await client.download(entry.path);
      const target = this.localTargetPath(entry.path);
      await this.ensureLocalFolder(target);
      const existing = this.app.vault.getAbstractFileByPath(target);
      if (existing instanceof TFile) {
        await this.app.vault.modifyBinary(existing, data);
      } else if (existing) {
        throw new Error('本地存在同名文件夹：' + target);
      } else {
        await this.app.vault.createBinary(target, data);
      }
      this.state.lastMessage = '已下载 ' + entry.name + ' → ' + target;
      this.state.lastMessageKind = 'ok';
      new Notice('已下载：' + entry.name);
    } catch (error) {
      this.state.lastMessage = describeError(error);
      this.state.lastMessageKind = 'err';
    } finally {
      this.state.busy = '';
      await this.refreshLocal();
      await this.render();
    }
  }

  /** 递归下载整个文件夹 */
  private async downloadFolder(entry: BridgeEntry): Promise<void> {
    const client = this.buildClient();
    if (!client) return;
    // 根目录（path 为空）= 整个库，文案上直接说清楚正在做什么
    this.state.busy = entry.path ? '正在读取 ' + entry.name + ' …' : '正在统计电脑上的文件…';
    await this.render();
    try {
      const unreadable: string[] = [];
      // 收集与落地都走 library-sync：设置页的「一键同步」用的是同一段逻辑
      const files = await collectRemoteFiles(client, entry.path, 0, unreadable);
      if (files.length === 0) {
        this.state.lastMessage = entry.path ? entry.name + ' 里没有文件' : '电脑上没有可同步的文件';
        this.state.lastMessageKind = 'info';
        return;
      }
      const summary = await syncFilesToVault({
        vault: this.app.vault,
        client,
        files,
        downloadDir: this.plugin.settings.clientDownloadDir,
        unreadable: unreadable.length,
        capped: files.length >= MAX_SYNC_FILES,
        onProgress: async (progress) => {
          this.state.busy = '下载 ' + progress.done + '/' + progress.total + '：' + progress.path;
          await this.render();
        },
      });

      this.state.lastMessage = describeSyncSummary(summary, this.plugin.settings.clientDownloadDir);
      this.state.lastMessageKind = summary.failed > 0 ? 'err' : summary.unreadable > 0 ? 'info' : 'ok';
      new Notice(
        '已下载 ' +
          summary.downloaded +
          ' 个文件' +
          (summary.skipped ? '，跳过 ' + summary.skipped + ' 个' : '')
      );
    } catch (error) {
      this.state.lastMessage = describeError(error);
      this.state.lastMessageKind = 'err';
    } finally {
      this.state.busy = '';
      await this.refreshLocal();
      await this.render();
    }
  }

  /**
   * 从电脑取最新版插件文件，覆盖本机插件目录。
   *
   * 手机上没有称手的文件管理器，替换 main.js/manifest.json/styles.css 是件苦差事；
   * 电脑端已经在同一地址上提供这三个文件（/setup/file?name=…），直接取回来写盘即可。
   */
  private async updatePluginFromServer(): Promise<void> {
    const client = this.buildClient();
    if (!client) {
      new Notice('请先填写电脑地址与令牌并连接');
      return;
    }
    this.state.busy = '正在从电脑取插件文件…';
    await this.render();
    try {
      const manifestText = await client.fetchPluginFile('manifest.json');
      const remoteVersion = readRemotePluginVersion(manifestText);
      if (!remoteVersion) {
        throw new BridgeClientError('电脑返回的不是本插件的安装文件，已中止更新', 'server');
      }
      const mainJs = await client.fetchPluginFile('main.js');
      const styles = await client.fetchPluginFile('styles.css');

      const dir = this.app.vault.configDir + '/plugins/' + this.plugin.manifest.id;
      await this.app.vault.adapter.write(dir + '/main.js', mainJs);
      await this.app.vault.adapter.write(dir + '/styles.css', styles);
      // manifest 最后写：中途失败时本机仍是可用的旧版本
      await this.app.vault.adapter.write(dir + '/manifest.json', manifestText);

      this.state.lastMessage = '插件已更新到 v' + remoteVersion + '：重启 Obsidian（或重新加载）后生效';
      this.state.lastMessageKind = 'ok';
      new Notice('插件已更新到 v' + remoteVersion + '，请重启 Obsidian 生效');
    } catch (error) {
      this.state.lastMessage = describeError(error);
      this.state.lastMessageKind = 'err';
    } finally {
      this.state.busy = '';
      await this.render();
    }
  }

  private async uploadFile(entry: BridgeEntry): Promise<void> {
    const client = this.buildClient();
    if (!client) {
      new Notice('请先填写电脑地址并连接');
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(entry.path);
    if (!(file instanceof TFile)) return;

    this.state.busy = '正在上传 ' + entry.name;
    await this.render();
    try {
      const data = await this.app.vault.readBinary(file);
      const target = this.remoteTargetPath(entry.path);
      const result = await client.upload(target, data);
      this.state.lastMessage = (result.action === 'created' ? '已上传 ' : '已覆盖 ') + result.path;
      this.state.lastMessageKind = 'ok';
      new Notice('已上传：' + entry.name);
      await this.refreshRemote();
    } catch (error) {
      this.state.lastMessage = describeError(error);
      this.state.lastMessageKind = 'err';
    } finally {
      this.state.busy = '';
      await this.render();
    }
  }

  /** 递归上传整个文件夹 */
  private async uploadFolder(entry: BridgeEntry): Promise<void> {
    const client = this.buildClient();
    if (!client) return;
    const folder = this.app.vault.getAbstractFileByPath(entry.path);
    if (!(folder instanceof TFolder)) return;

    const files = this.collectLocalFiles(folder);
    if (files.length === 0) {
      this.state.lastMessage = entry.name + ' 里没有文件';
      this.state.lastMessageKind = 'info';
      await this.render();
      return;
    }

    this.state.busy = '准备上传 ' + files.length + ' 个文件…';
    await this.render();
    let done = 0;
    let failed = 0;
    try {
      for (const file of files) {
        this.state.busy = '上传 ' + (done + failed + 1) + '/' + files.length + '：' + file.name;
        await this.render();
        try {
          const data = await this.app.vault.readBinary(file);
          await client.upload(this.remoteTargetPath(file.path), data);
          done++;
        } catch {
          failed++;
        }
      }
      this.state.lastMessage = '上传完成：成功 ' + done + ' 个' + (failed ? '，失败 ' + failed + ' 个' : '');
      this.state.lastMessageKind = failed ? 'err' : 'ok';
      new Notice('已上传 ' + done + ' 个文件');
      await this.refreshRemote();
    } finally {
      this.state.busy = '';
      await this.render();
    }
  }

  private collectLocalFiles(folder: TFolder): TFile[] {
    const files: TFile[] = [];
    for (const child of folder.children) {
      if (child instanceof TFile) {
        files.push(child);
      } else if (child instanceof TFolder) {
        if (child.name === this.app.vault.configDir || child.name === '.trash' || child.name === '.git')
          continue;
        for (const nested of this.collectLocalFiles(child)) files.push(nested);
      }
    }
    return files;
  }
}
