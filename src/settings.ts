/** 插件设置的数据模型与电脑端设置界面。 */

import { App, Notice, PluginSettingTab, Setting, type SettingDefinitionItem } from 'obsidian';
import { DEFAULT_MAX_UPLOAD_BYTES, DEFAULT_PORT, DEFAULT_EXCLUDED_DIRS } from './shared/protocol';
import { generateToken } from './shared/token';
import { formatTime } from './shared/format';
import { listListenAddresses } from './server/net';
import { MAX_PROFILES, inferProfileLabel, type ServerProfile } from './shared/server-profile';
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
  /**
   * 连接档案：曾经连通过的「地址 + 令牌」，按最近使用排序。
   *
   * 存在的理由：手机要连的地址不止一个——在家是局域网 IP，出门是公网隧道域名，
   * 而隧道域名每次重建都会变；令牌又是 32 位随机串。
   * 把两者一起存下来，换网络时直接选一条即可，不必每次手输。
   *
   * 注意其中的 token 是【电脑的】访问令牌，与顶层 token（本机服务端令牌）不是一回事。
   */
  serverProfiles: ServerProfile[];
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
  serverProfiles: [],
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

  // 清洗连接档案：丢掉结构损坏的条目，补齐缺失字段，并按上限裁剪。
  // 这些数据可能来自旧版本或被手工编辑过的 data.json，不能让它们把设置页搞崩。
  const rawProfiles: unknown = (merged as { serverProfiles?: unknown }).serverProfiles;
  merged.serverProfiles = (Array.isArray(rawProfiles) ? rawProfiles : [])
    .filter((item): item is Partial<ServerProfile> => !!item && typeof item === 'object')
    .map((item) => {
      const url = typeof item.url === 'string' ? item.url.trim() : '';
      return {
        url,
        token: typeof item.token === 'string' ? item.token : '',
        label: typeof item.label === 'string' && item.label.trim() ? item.label : inferProfileLabel(url),
        lastUsedAt:
          typeof item.lastUsedAt === 'number' && Number.isFinite(item.lastUsedAt) ? item.lastUsedAt : 0,
      };
    })
    .filter((item) => item.url.length > 0)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, MAX_PROFILES);

  return merged;
}

/**
 * 电脑端设置界面。
 *
 * 采用 Obsidian 1.13.0 引入的声明式设置 API：每个条目的 name/desc 会被框架用于
 * 渲染与【设置搜索】，这样用户按「令牌」「端口」等关键词就能直接搜到本插件的设置项。
 *
 * 条目内部仍用 render 回调做命令式渲染——因为这一页不只有静态表单：
 * 运行状态随服务起停变化、访问地址要按网卡枚举、令牌需要一键复制、
 * 底部还有一张访问日志表格。声明式的 control 结构表达不了这些，
 * 而 render 恰好是官方为这类情况留的口子。
 */
export class VaultBridgeSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: VaultBridgePlugin
  ) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        type: 'group',
        heading: '运行状态',
        items: [
          {
            name: '服务状态',
            desc: '手机要访问电脑，需要这个服务处于运行中',
            render: (setting) => this.renderStatus(setting),
          },
          {
            name: '开启服务',
            desc: '在电脑上监听端口，供手机通过局域网或公网地址访问',
            render: (setting) => {
              setting.addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
                  this.plugin.settings.enabled = value;
                  await this.plugin.saveSettings();
                  await this.plugin.applyServerState();
                  this.update();
                })
              );
            },
          },
          {
            name: '随 Obsidian 启动',
            desc: 'Obsidian 打开时自动开启服务，无需手动点',
            render: (setting) => {
              setting.addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.autoStart).onChange(async (value) => {
                  this.plugin.settings.autoStart = value;
                  await this.plugin.saveSettings();
                })
              );
            },
          },
          {
            name: '监听端口',
            desc: '默认 8770。改动后需要点「重启服务」；若提示被占用请换一个',
            render: (setting) => {
              setting
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
                    this.update();
                  })
                );
            },
          },
        ],
      },
      {
        type: 'group',
        heading: '授权与安全',
        items: [
          {
            name: '访问令牌',
            desc: '手机端必须携带此令牌才能访问。泄漏后请立即重新生成',
            render: (setting) => {
              setting
                .addText((text) => {
                  text.setValue(this.plugin.settings.token);
                  text.inputEl.addClass('vault-bridge-token-input');
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
                      this.update();
                    })
                );
            },
          },
          {
            name: '允许手机上传',
            desc: '关闭后手机只能下载，不能写入或新建文件',
            render: (setting) => {
              setting.addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.allowUpload).onChange(async (value) => {
                  this.plugin.settings.allowUpload = value;
                  await this.plugin.saveSettings();
                })
              );
            },
          },
          {
            name: '单次上传上限 (MB)',
            desc: '手机把文件读进内存再发送，过大容易失败。默认 32 MB',
            render: (setting) => {
              setting.addText((text) =>
                text.setValue(String(this.plugin.settings.maxUploadMB)).onChange(async (value) => {
                  const parsed = Number(value);
                  if (!Number.isFinite(parsed) || parsed <= 0) return;
                  this.plugin.settings.maxUploadMB = Math.min(Math.floor(parsed), 512);
                  await this.plugin.saveSettings();
                })
              );
            },
          },
          {
            name: '排除的目录',
            desc: '列表里不显示的目录名，逗号分隔。默认隐藏 .trash、.git；配置目录始终禁止通过网络访问',
            render: (setting) => {
              setting.addText((text) =>
                text.setValue(this.plugin.settings.excludeDirs).onChange(async (value) => {
                  this.plugin.settings.excludeDirs = value;
                  await this.plugin.saveSettings();
                })
              );
            },
          },
        ],
      },
      {
        type: 'group',
        heading: '手机端',
        items: [
          {
            name: '电脑地址',
            desc: '手机连接电脑用的地址，例如 http://192.168.1.44:8770；外出时填公网 https 地址',
            render: (setting) => {
              setting.addText((text) =>
                text
                  .setPlaceholder('http://192.168.1.44:8770')
                  .setValue(this.plugin.settings.clientServerUrl)
                  .onChange(async (value) => {
                    this.plugin.settings.clientServerUrl = value.trim();
                    await this.plugin.saveSettings();
                  })
              );
            },
          },
          {
            name: '下载保存到手机的目录',
            desc: '手机下载电脑文件时的落地目录，保持与电脑一致的相对结构。留空表示 vault 根目录',
            render: (setting) => {
              setting.addText((text) =>
                text
                  .setPlaceholder('VaultBridge下载')
                  .setValue(this.plugin.settings.clientDownloadDir)
                  .onChange(async (value) => {
                    this.plugin.settings.clientDownloadDir = value.trim();
                    await this.plugin.saveSettings();
                  })
              );
            },
          },
          {
            name: '上传到电脑的目标目录',
            desc: '手机上传文件时落到电脑的哪个目录。留空表示电脑 vault 根目录',
            render: (setting) => {
              setting.addText((text) =>
                text
                  .setPlaceholder('（留空 = 根目录）')
                  .setValue(this.plugin.settings.clientUploadDir)
                  .onChange(async (value) => {
                    this.plugin.settings.clientUploadDir = value.trim();
                    await this.plugin.saveSettings();
                  })
              );
            },
          },
        ],
      },
      {
        type: 'group',
        heading: '访问记录',
        items: [
          {
            name: '记录访问日志',
            desc: '只保留在内存中，重启 Obsidian 后清空',
            render: (setting) => {
              setting.addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.keepAccessLog).onChange(async (value) => {
                  this.plugin.settings.keepAccessLog = value;
                  if (!value) this.plugin.accessLog = [];
                  await this.plugin.saveSettings();
                  this.update();
                })
              );
            },
          },
          {
            name: '最近访问',
            desc: '谁在什么时候下载或上传了什么',
            render: (setting) => this.renderLogTable(setting),
          },
        ],
      },
    ];
  }

  /** 把 IPv6 映射地址还原成易读的 IPv4 已在服务端处理，这里只负责展示 */
  private renderStatus(setting: Setting): void {
    const server = this.plugin.server;
    const running = !!server && server.isRunning;

    const body = setting.settingEl.createDiv({ cls: 'vault-bridge-status' });
    body.createDiv({ text: running ? '✅ 服务运行中' : '⏹ 服务已停止' });

    if (this.plugin.lastError) {
      body.createDiv({ text: '⚠️ ' + this.plugin.lastError, cls: 'vault-bridge-error' });
    }

    if (!running || !server) return;

    const addresses = listListenAddresses(server.port);
    if (addresses.length === 0) {
      body.createDiv({ text: '未检测到局域网地址（请确认已连接 WiFi 或网线）' });
      return;
    }

    const list = body.createDiv({ cls: 'vault-bridge-addresses' });
    addresses.forEach((address, index) => {
      const line = list.createDiv({ cls: 'vault-bridge-address' });
      line.createSpan({ text: address.iface + '：' });
      const link = line.createEl('code', {
        text: address.url + '/?token=' + this.plugin.settings.token,
      });
      if (index === 0 && address.preferred) {
        line.createSpan({ text: '  ← 手机优先用这个', cls: 'vault-bridge-hint' });
      }
      link.addClass('vault-bridge-copyable');
      link.title = '点击复制';
      link.onclick = () => {
        void this.copy(address.url + '/?token=' + this.plugin.settings.token);
      };
    });

    body.createDiv({
      text:
        '手机浏览器打开上面的地址即可传文件；手机 Obsidian 插件里填 ' + addresses[0].url + ' 与上方令牌。',
      cls: 'vault-bridge-hint',
    });
  }

  /** 访问日志表格 */
  private renderLogTable(setting: Setting): void {
    const entries = this.plugin.accessLog;
    const body = setting.settingEl.createDiv({ cls: 'vault-bridge-log-wrap' });

    if (entries.length === 0) {
      body.createDiv({ text: '暂无访问记录', cls: 'vault-bridge-hint' });
      return;
    }

    const table = body.createEl('table', { cls: 'vault-bridge-log' });
    const head = table.createEl('thead').createEl('tr');
    ['时间', '来源', '动作', '状态'].forEach((label) => head.createEl('th', { text: label }));
    const tbody = table.createEl('tbody');
    entries.slice(0, 40).forEach((entry) => {
      const row = tbody.createEl('tr');
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
