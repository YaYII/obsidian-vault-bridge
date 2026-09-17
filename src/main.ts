/**
 * Vault Bridge 插件入口。
 *
 * 同一份产物在两端承担不同角色：
 *   电脑端 —— 开启 HTTP 服务并对外提供带令牌保护的传输接口；
 *   手机端 —— 只做客户端，通过 URL 连接电脑完成上传与下载。
 * 角色由 Platform.isDesktopApp 决定，服务端代码在移动端永不执行。
 */

import { Notice, Platform, Plugin } from 'obsidian';
import { BridgeServer } from './server/http-server';
import type { BridgeRuntimeSettings } from './server/router';
import { BridgePanel, VIEW_TYPE_BRIDGE_PANEL } from './client/panel';
import {
  DEFAULT_SETTINGS,
  VaultBridgeSettingTab,
  normalizeSettings,
  parseExcludeDirs,
  type VaultBridgeSettings,
} from './settings';
import { BridgeClient } from './client/api-client';
import { findProfile } from './shared/server-profile';
import type { AccessLogEntry } from './shared/types';

/** 内存中最多保留的访问日志条数 */
const MAX_LOG_ENTRIES = 200;

export default class VaultBridgePlugin extends Plugin {
  settings: VaultBridgeSettings = Object.assign({}, DEFAULT_SETTINGS);
  /** 仅电脑端存在 */
  server: BridgeServer | null = null;
  accessLog: AccessLogEntry[] = [];
  /** 最近一次服务端异常，显示在设置页 */
  lastError = '';

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new VaultBridgeSettingTab(this.app, this));
    this.registerView(VIEW_TYPE_BRIDGE_PANEL, (leaf) => new BridgePanel(leaf, this));

    this.addCommand({
      id: 'open-transfer-panel',
      name: '打开传输面板',
      callback: () => {
        void this.openPanel();
      },
    });

    if (Platform.isDesktopApp) {
      this.addCommand({
        id: 'restart-bridge-server',
        name: '重启电脑端服务',
        callback: () => {
          void this.restartServer();
        },
      });
      this.addRibbonIcon('arrow-left-right', 'Vault Bridge 传输面板', () => {
        void this.openPanel();
      });

      if (this.settings.enabled && this.settings.autoStart) {
        await this.applyServerState();
      }
    }
  }

  onunload(): void {
    // 插件被停用/重载时必须释放端口，否则下次启动会报端口占用
    const server = this.server;
    this.server = null;
    if (server) {
      void server.stop();
    }
  }

  // ───────────────────────── 设置持久化 ─────────────────────────

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<VaultBridgeSettings> | null;
    const hadToken = typeof stored?.token === 'string' && stored.token.length >= 16;
    this.settings = normalizeSettings(stored);
    // 首次运行会生成令牌，立刻落盘，用户才能在设置页看到稳定值
    if (!hadToken) {
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ───────────────────────── 服务端控制 ─────────────────────────

  /** 根据当前设置决定启动还是停止服务 */
  async applyServerState(): Promise<void> {
    if (!Platform.isDesktopApp) return;
    if (this.settings.enabled) {
      await this.startServer();
    } else {
      await this.stopServer();
    }
  }

  async startServer(): Promise<void> {
    if (!Platform.isDesktopApp) return;
    this.lastError = '';
    try {
      if (!this.server) {
        this.server = new BridgeServer({
          vault: this.app.vault,
          version: this.manifest.version,
          getRuntimeSettings: () => this.runtimeSettings(),
          logAccess: (entry) => this.pushLog(entry),
          reportError: (message) => {
            this.lastError = message;
          },
          getPluginDir: () => this.resolvePluginDir(),
        });
      }
      await this.server.start(this.settings.port);
      new Notice('Vault Bridge 已开启，端口 ' + this.server.port);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      new Notice('Vault Bridge 启动失败：' + this.lastError);
      await this.stopServer();
    }
  }

  async stopServer(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await server.stop();
    this.server = null;
  }

  async restartServer(): Promise<void> {
    if (!Platform.isDesktopApp) return;
    await this.stopServer();
    if (this.settings.enabled) {
      await this.startServer();
    }
  }

  /**
   * 解析插件自身的安装目录（绝对路径）。
   * 手机下载安装包时服务端要读这个目录里的 main.js / manifest.json / styles.css。
   */
  private resolvePluginDir(): string {
    const adapter = this.app.vault.adapter as unknown as { basePath?: string };
    const basePath = adapter && typeof adapter.basePath === 'string' ? adapter.basePath : '';
    const relative = this.manifest.dir;
    if (!basePath || !relative) return '';
    return basePath.replace(/\/+$/, '') + '/' + relative.replace(/^\/+/, '');
  }

  /** 每次请求都读这个快照，改设置无需重启即可生效 */
  private runtimeSettings(): BridgeRuntimeSettings {
    return {
      token: this.settings.token,
      allowUpload: this.settings.allowUpload,
      excludedDirs: parseExcludeDirs(this.settings.excludeDirs),
      maxUploadBytes: this.settings.maxUploadMB * 1024 * 1024,
    };
  }

  private pushLog(entry: AccessLogEntry): void {
    if (!this.settings.keepAccessLog) return;
    this.accessLog.unshift(entry);
    if (this.accessLog.length > MAX_LOG_ENTRIES) {
      this.accessLog.length = MAX_LOG_ENTRIES;
    }
  }

  // ───────────────────────── 连接与界面入口 ─────────────────────────

  /**
   * 解析当前连接信息。
   *
   * 令牌优先级：调用方显式给出（面板里刚输入的） > 该地址的历史记录 > 本机令牌。
   * 面板与设置页共用这一处，避免两边的回退规则悄悄走偏。
   */
  resolveConnection(overrideToken = ''): { url: string; token: string } {
    const url = this.settings.clientServerUrl;
    const profile = findProfile(this.settings.serverProfiles, url);
    return {
      url,
      token:
        overrideToken ||
        (profile ? profile.token : '') ||
        this.settings.clientToken ||
        // 兜底：旧版本把电脑令牌存在顶层 token 里（vault 连同 data.json 一起同步的场景）
        this.settings.token,
    };
  }

  /** 构造访问电脑的客户端；地址或令牌缺失时返回 null */
  createClient(overrideToken = ''): BridgeClient | null {
    const { url, token } = this.resolveConnection(overrideToken);
    const client = new BridgeClient(url, token);
    return client.configured ? client : null;
  }

  /** 打开（或聚焦已有的）传输面板 */
  async openPanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_BRIDGE_PANEL);
    if (existing.length > 0) {
      void this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE_BRIDGE_PANEL, active: true });
    void this.app.workspace.revealLeaf(leaf);
  }

  /** 跳到本插件的设置页 */
  openSettings(): void {
    const setting = (
      this.app as unknown as {
        setting?: { open: () => void; openTabById: (id: string) => void };
      }
    ).setting;
    if (!setting) return;
    setting.open();
    setting.openTabById(this.manifest.id);
  }
}
