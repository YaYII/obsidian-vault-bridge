/** 插件设置的数据模型与电脑端设置界面。 */

import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import { DEFAULT_MAX_UPLOAD_BYTES, DEFAULT_PORT, DEFAULT_EXCLUDED_DIRS } from './shared/protocol';
import { generateToken } from './shared/token';
import { formatTime } from './shared/format';
import { listListenAddresses } from './server/net';
import type VaultBridgePlugin from './main';

/** 持久化到 data.json 的设置 */
export interface VaultBridgeSettings {
  /** 电脑端是否开启服务 */
  enabled: boolean;
  /** Obsidian 启动时自动开启 */
  autoStart: boolean;
  /** 监听端口 */
  port: number;
  /** 访问令牌 */
  token: string;
  /** 是否允许手机上传/新建（关闭后手机只能下载） */
  allowUpload: boolean;
  /** 单次上传上限（MB） */
  maxUploadMB: number;
  /** 列表里跳过的目录名，逗号分隔 */
  excludeDirs: string;
  /** 是否记录访问日志（设置页可查看） */
  keepAccessLog: boolean;
  /** 手机端保存的电脑地址（在手机上填写，电脑端不用） */
  clientServerUrl: string;
  /** 手机端默认下载到本地的目录 */
  clientDownloadDir: string;
  /** 手机端默认上传到电脑的目录 */
  clientUploadDir: string;
}

export const DEFAULT_SETTINGS: VaultBridgeSettings = {
  enabled: true,
  autoStart: true,
  port: DEFAULT_PORT,
  token: '',
  allowUpload: true,
  maxUploadMB: Math.round(DEFAULT_MAX_UPLOAD_BYTES / 1024 / 1024),
  excludeDirs: DEFAULT_EXCLUDED_DIRS.join(','),
  keepAccessLog: true,
  clientServerUrl: '',
  clientDownloadDir: 'VaultBridge下载',
  clientUploadDir: '',
};

/** 把逗号分隔的设置项拆成数组并去空白 */
export function parseExcludeDirs(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** 补齐缺省值与类型矫正，避免手工改坏的 data.json 让插件崩溃 */
export function normalizeSettings(raw: Partial<VaultBridgeSettings> | null | undefined): VaultBridgeSettings {
  const merged: VaultBridgeSettings = Object.assign({}, DEFAULT_SETTINGS, raw || {});
  const port = Number(merged.port);
  merged.port = Number.isFinite(port) && port >= 1024 && port <= 65535 ? Math.floor(port) : DEFAULT_PORT;
  const maxMB = Number(merged.maxUploadMB);
  merged.maxUploadMB =
    Number.isFinite(maxMB) && maxMB > 0 ? Math.min(Math.floor(maxMB), 512) : DEFAULT_SETTINGS.maxUploadMB;
  if (typeof merged.token !== 'string' || merged.token.length < 16) {
    merged.token = generateToken();
  }
  merged.enabled = merged.enabled !== false;
  merged.autoStart = merged.autoStart !== false;
  merged.allowUpload = merged.allowUpload !== false;
  merged.keepAccessLog = merged.keepAccessLog !== false;
  if (typeof merged.clientDownloadDir !== 'string')
    merged.clientDownloadDir = DEFAULT_SETTINGS.clientDownloadDir;
  if (typeof merged.clientUploadDir !== 'string') merged.clientUploadDir = DEFAULT_SETTINGS.clientUploadDir;
  if (typeof merged.clientServerUrl !== 'string') merged.clientServerUrl = '';
  return merged;
}

/** 电脑端设置界面 */
export class VaultBridgeSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: VaultBridgePlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Vault Bridge · 知识库桥' });

    this.renderStatusSection(containerEl);
    this.renderSecuritySection(containerEl);
    this.renderClientSection(containerEl);
    this.renderLogSection(containerEl);
  }

  /** 手机端（传输面板）使用的设置，电脑端保存后随 vault 一起同步到手机 */
  private renderClientSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: '手机端' });

    containerEl.createEl('div', {
      cls: 'vault-bridge-hint',
      text: '以下几项填写在手机上打开「传输面板」时使用；在电脑上填这里也会随设置同步过去。',
    });

    new Setting(containerEl)
      .setName('电脑地址')
      .setDesc('手机连接电脑用的地址，例如 http://192.168.1.44:8770；外出时填公网 https 地址')
      .addText((text) =>
        text
          .setPlaceholder('http://192.168.1.44:8770')
          .setValue(this.plugin.settings.clientServerUrl)
          .onChange(async (value) => {
            this.plugin.settings.clientServerUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('下载保存到手机的目录')
      .setDesc('手机下载电脑文件时的落地目录，保持与电脑一致的相对结构。留空表示 vault 根目录')
      .addText((text) =>
        text
          .setPlaceholder('VaultBridge下载')
          .setValue(this.plugin.settings.clientDownloadDir)
          .onChange(async (value) => {
            this.plugin.settings.clientDownloadDir = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('上传到电脑的目标目录')
      .setDesc('手机上传文件时落到电脑的哪个目录。留空表示电脑 vault 根目录')
      .addText((text) =>
        text
          .setPlaceholder('（留空 = 根目录）')
          .setValue(this.plugin.settings.clientUploadDir)
          .onChange(async (value) => {
            this.plugin.settings.clientUploadDir = value.trim();
            await this.plugin.saveSettings();
          })
      );
  }

  /** 运行状态与手机访问地址 */
  private renderStatusSection(containerEl: HTMLElement): void {
    const server = this.plugin.server;
    const running = !!server && server.isRunning;

    const statusEl = containerEl.createDiv({ cls: 'vault-bridge-status' });
    statusEl.createEl('strong', { text: running ? '✅ 服务运行中' : '⏹ 服务已停止' });
    if (this.plugin.lastError) {
      statusEl.createEl('div', { text: '⚠️ ' + this.plugin.lastError, cls: 'vault-bridge-error' });
    }

    if (running && server) {
      const addresses = listListenAddresses(server.port);
      if (addresses.length === 0) {
        statusEl.createEl('div', { text: '未检测到局域网地址（请确认已连接 WiFi 或网线）' });
      } else {
        const list = statusEl.createEl('div', { cls: 'vault-bridge-addresses' });
        addresses.forEach((address, index) => {
          const line = list.createDiv({ cls: 'vault-bridge-address' });
          line.createSpan({ text: address.iface + '：' });
          const link = line.createEl('code', { text: address.url + '/?token=' + this.plugin.settings.token });
          if (index === 0 && address.preferred) {
            line.createSpan({ text: '  ← 手机优先用这个', cls: 'vault-bridge-hint' });
          }
          link.style.cursor = 'pointer';
          link.title = '点击复制';
          link.onclick = () => {
            void this.copy(address.url + '/?token=' + this.plugin.settings.token);
          };
        });
        statusEl.createEl('div', {
          text:
            '手机浏览器打开上面的地址即可传文件；手机 Obsidian 插件里填 ' +
            addresses[0].url +
            ' 与下方令牌。',
          cls: 'vault-bridge-hint',
        });
      }
    }

    new Setting(containerEl)
      .setName('开启服务')
      .setDesc('在电脑上监听端口，供手机通过局域网或公网地址访问')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
          await this.plugin.applyServerState();
          this.display();
        })
      );

    new Setting(containerEl)
      .setName('随 Obsidian 启动')
      .setDesc('Obsidian 打开时自动开启服务，无需手动点')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoStart).onChange(async (value) => {
          this.plugin.settings.autoStart = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('监听端口')
      .setDesc('默认 8770。改动后服务会自动重启；若提示被占用请换一个')
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_PORT))
          .setValue(String(this.plugin.settings.port))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed < 1024 || parsed > 65535) return;
            this.plugin.settings.port = Math.floor(parsed);
            await this.plugin.saveSettings();
          })
      )
      .addButton((button) =>
        button.setButtonText('重启服务').onClick(async () => {
          await this.plugin.restartServer();
          this.display();
        })
      );
  }

  /** 令牌与写权限 */
  private renderSecuritySection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: '授权与安全' });

    new Setting(containerEl)
      .setName('访问令牌')
      .setDesc('手机端必须携带此令牌才能访问。泄漏后请立即重新生成')
      .addText((text) => {
        text.setValue(this.plugin.settings.token);
        text.inputEl.style.width = '320px';
        text.inputEl.readOnly = true;
        return text;
      })
      .addExtraButton((button) =>
        button
          .setIcon('copy')
          .setTooltip('复制令牌')
          .onClick(() => {
            void this.copy(this.plugin.settings.token);
          })
      )
      .addExtraButton((button) =>
        button
          .setIcon('refresh-cw')
          .setTooltip('重新生成（旧令牌立即失效）')
          .onClick(async () => {
            this.plugin.settings.token = generateToken();
            await this.plugin.saveSettings();
            new Notice('已生成新令牌，请在手机上更新');
            this.display();
          })
      );

    new Setting(containerEl)
      .setName('允许手机上传')
      .setDesc('关闭后手机只能下载，不能写入或新建文件')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.allowUpload).onChange(async (value) => {
          this.plugin.settings.allowUpload = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('单次上传上限 (MB)')
      .setDesc('手机把文件读进内存再发送，过大容易失败。默认 32 MB')
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxUploadMB)).onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed <= 0) return;
          this.plugin.settings.maxUploadMB = Math.min(Math.floor(parsed), 512);
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('排除的目录')
      .setDesc('列表里不显示的目录名，逗号分隔。默认隐藏 .obsidian、.trash、.git')
      .addText((text) =>
        text.setValue(this.plugin.settings.excludeDirs).onChange(async (value) => {
          this.plugin.settings.excludeDirs = value;
          await this.plugin.saveSettings();
        })
      );
  }

  /** 访问日志，便于用户确认「谁在什么时候动了文件」 */
  private renderLogSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: '访问记录' });

    new Setting(containerEl)
      .setName('记录访问日志')
      .setDesc('只保留在内存中，重启 Obsidian 后清空')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.keepAccessLog).onChange(async (value) => {
          this.plugin.settings.keepAccessLog = value;
          if (!value) this.plugin.accessLog = [];
          await this.plugin.saveSettings();
          this.display();
        })
      );

    const entries = this.plugin.accessLog;
    if (entries.length === 0) {
      containerEl.createEl('div', { text: '暂无访问记录', cls: 'vault-bridge-hint' });
      return;
    }

    const table = containerEl.createEl('table', { cls: 'vault-bridge-log' });
    const head = table.createEl('thead').createEl('tr');
    ['时间', '来源', '动作', '状态'].forEach((label) => head.createEl('th', { text: label }));
    const body = table.createEl('tbody');
    entries.slice(0, 40).forEach((entry) => {
      const row = body.createEl('tr');
      row.createEl('td', { text: formatTime(entry.at) });
      row.createEl('td', { text: entry.ip });
      row.createEl('td', { text: entry.action });
      row.createEl('td', { text: String(entry.status) });
    });
  }

  private async copy(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      new Notice('已复制到剪贴板');
    } catch {
      new Notice('复制失败，请手动选择文本');
    }
  }
}
