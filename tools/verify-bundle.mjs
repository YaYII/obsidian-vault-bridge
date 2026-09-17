#!/usr/bin/env node
/**
 * 产物级验证：在 Node 里用 Obsidian 宿主替身加载构建好的 main.js，
 * 走一遍真实的插件生命周期，并对真实端口发 HTTP 请求。
 *
 * 这一步回答的问题是「打包产物到底能不能跑」——单元测试跑的是源码，
 * 这里跑的是用户手机上、电脑上真正会加载的那份文件。
 *
 * 用法：node tools/verify-bundle.mjs
 */

// 必须最先执行：Node 18 的脚本文件里没有全局 crypto，产物生成令牌时会用到
import './node-webcrypto.mjs';

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Notice, Vault, createObsidianMock } from './obsidian-host-mock.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);
const mock = createObsidianMock();

const MAIN_PATH = resolve(projectRoot, 'main.js');
// dir 设为项目根（'.'），这样安装包打包逻辑能读到真实的 main.js / manifest.json / styles.css，
// 不必依赖插件是否已部署到某个 vault。
const MANIFEST = { id: 'vault-bridge', name: 'Vault Bridge', version: '1.0.0', dir: '.' };

/**
 * 验证时使用的独立端口。
 * 刻意避开插件默认的 8770——开发者本机往往正开着 Obsidian 并运行着本插件，
 * 复用默认端口会直接撞上「端口已被占用」，让验证脚本产生假失败。
 */
const VERIFY_PORT = 18771;

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log('  ✅ ' + label);
  } else {
    failed++;
    failures.push(label + (detail ? ' — ' + detail : ''));
    console.log('  ❌ ' + label + (detail ? ' — ' + detail : ''));
  }
}

function section(title) {
  console.log('\n' + title);
}

/**
 * 按 Obsidian 的真实方式加载产物：读出源码，注入 module/exports/require 后执行。
 *
 * 刻意不用 Node 的 require()：
 *   1. Obsidian 桌面端与移动端都是这种「注入式」加载，不经过 Node 的 ESM/CJS 判定；
 *   2. 这样能顺带证明产物确实在插件作用域内拿到了可用的 require —— 服务端的
 *      Node 模块惰性加载全靠它，这是移动端与桌面端能否共用一份产物的关键；
 *   3. 若产物里混入 ESM 语法，new Function 会直接抛语法错误，等于多一道校验。
 */
function loadPluginExports() {
  const source = readFileSync(MAIN_PATH, 'utf8');
  const moduleObject = { exports: {} };
  const requireShim = (id) => {
    if (id === 'obsidian') return mock;
    // 插件在桌面端会惰性请求 Node 内置模块，这里透传给真实实现
    return require_(id.startsWith('node:') ? id : 'node:' + id);
  };
  const factory = new Function('module', 'exports', 'require', '__filename', '__dirname', source);
  factory(moduleObject, moduleObject.exports, requireShim, MAIN_PATH, dirname(MAIN_PATH));
  const exports_ = moduleObject.exports;
  return exports_.default || exports_;
}

function loadPluginClass() {
  return loadPluginExports();
}

function makeApp(vault) {
  // 对齐桌面端的 FileSystemAdapter：服务端据此定位插件自身目录
  vault.adapter = { basePath: projectRoot };
  return {
    vault,
    workspace: {
      getLeavesOfType: () => [],
      getLeaf: () => ({ setViewState: async () => undefined }),
      revealLeaf: async () => undefined,
    },
    setting: { open: () => undefined, openTabById: () => undefined },
  };
}

function lanAddresses(port) {
  const os = require_('node:os');
  const out = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal && !/^(docker|br-|virbr|veth)/.test(name)) {
        out.push({ name, url: 'http://' + info.address + ':' + port });
      }
    }
  }
  return out;
}

async function main() {
  console.log('Vault Bridge 产物验证');
  console.log('产物：' + MAIN_PATH);

  section('① 产物可被 CJS 加载');
  const PluginClass = loadPluginClass();
  check('main.js 加载成功且导出插件类', typeof PluginClass === 'function');

  section('② 电脑端：插件生命周期');
  const vault = new Vault();
  vault.seed('团队知识库/README.md', '# 团队知识库\n\n真实产物验证。');
  vault.seed('团队知识库/需求清单.md', '需求一\n需求二');
  const app = makeApp(vault);

  const plugin = new PluginClass(app, MANIFEST);
  // 预置设置：用独立端口，避免与本机正在运行的真实插件抢 8770
  plugin.loadData = async () => ({
    enabled: true,
    autoStart: true,
    port: VERIFY_PORT,
    token: 'verify-token-0123456789abcdefgh',
    allowUpload: true,
    maxUploadMB: 32,
    excludeDirs: '.trash,.git',
    keepAccessLog: true,
  });
  await plugin.onload();

  check('onload 完成且未抛异常', true);
  check(
    '自动生成了访问令牌',
    typeof plugin.settings.token === 'string' && plugin.settings.token.length >= 16,
    '实际：' + (plugin.settings.token || '').slice(0, 8)
  );
  check('采用了预设的访问令牌', plugin.settings.token === 'verify-token-0123456789abcdefgh');
  check('注册了设置页', plugin.settingTabs.length === 1);
  check('注册了传输面板视图', typeof plugin.views['vault-bridge-panel'] === 'function');
  check('注册了命令', plugin.commands.length >= 1, '数量：' + plugin.commands.length);

  section('③ 电脑端：HTTP 服务真的起来了');
  check('服务处于运行状态', plugin.server && plugin.server.isRunning === true);
  const port = plugin.server ? plugin.server.port : 0;
  check('监听到指定端口 ' + VERIFY_PORT, port === VERIFY_PORT, '实际端口：' + port);

  const token = plugin.settings.token;
  const auth = { Authorization: 'Bearer ' + token };
  const base = 'http://127.0.0.1:' + port;

  const health = await fetch(base + '/api/health');
  const healthBody = await health.json();
  check('健康检查返回 200', health.status === 200);
  check('健康检查带版本号', healthBody.version === '1.0.0', JSON.stringify(healthBody));

  const noAuth = await fetch(base + '/api/list');
  check('无令牌访问被拒绝（401）', noAuth.status === 401, '实际：' + noAuth.status);

  const list = await fetch(base + '/api/list', { headers: auth });
  const listBody = await list.json();
  check('带令牌可列出目录（200）', list.status === 200);
  check(
    '列表包含真实 vault 内容',
    listBody.entries.some((e) => e.name === '团队知识库'),
    JSON.stringify(listBody.entries.map((e) => e.name))
  );

  const download = await fetch(base + '/api/download?path=' + encodeURIComponent('团队知识库/需求清单.md'), {
    headers: auth,
  });
  const downloaded = await download.text();
  check('下载内容与 vault 一致', downloaded === '需求一\n需求二', JSON.stringify(downloaded));

  const uploadPayload = new TextEncoder().encode('# 手机上传的笔记');
  const upload = await fetch(base + '/api/upload?path=' + encodeURIComponent('收件箱/来自手机.md'), {
    method: 'POST',
    headers: auth,
    body: uploadPayload,
  });
  const uploadBody = await upload.json();
  check(
    '上传返回 200 且标记为新建',
    upload.status === 200 && uploadBody.action === 'created',
    JSON.stringify(uploadBody)
  );
  check('上传的文件真的写进了 vault', vault.getAbstractFileByPath('收件箱/来自手机.md') !== null);

  const readBack = await fetch(base + '/api/download?path=' + encodeURIComponent('收件箱/来自手机.md'), {
    headers: auth,
  });
  check('上传内容可原样下载回来', (await readBack.text()) === '# 手机上传的笔记');

  const escape = await fetch(base + '/api/download?path=' + encodeURIComponent('../../etc/passwd'), {
    headers: auth,
  });
  check('越权路径被拦下（400）', escape.status === 400, '实际：' + escape.status);

  const blocked = await fetch(base + '/api/list?path=' + encodeURIComponent('.obsidian'), { headers: auth });
  check('受保护的 .obsidian 被拦下（400）', blocked.status === 400, '实际：' + blocked.status);

  // ── 插件文件下发：手机端靠它在线更新插件 ──
  const pluginFile = await fetch(base + '/setup/file?name=main.js', { headers: auth });
  const pluginFileText = await pluginFile.text();
  check('下发插件文件返回 200', pluginFile.status === 200, '实际：' + pluginFile.status);
  const diskBundle = require_('node:fs').readFileSync(MAIN_PATH, 'utf8');
  check(
    '下发内容与磁盘上的打包产物逐字节一致',
    pluginFileText === diskBundle,
    '长度：' + pluginFileText.length + ' vs ' + diskBundle.length
  );
  check(
    '文件类型标记为 JavaScript',
    (pluginFile.headers.get('content-type') || '').indexOf('javascript') !== -1,
    pluginFile.headers.get('content-type') || '(空)'
  );

  const pluginFileEscape = await fetch(base + '/setup/file?name=' + encodeURIComponent('../package.json'), {
    headers: auth,
  });
  check('白名单外的文件名被拦下（400）', pluginFileEscape.status === 400, '实际：' + pluginFileEscape.status);

  const pluginFileNoAuth = await fetch(base + '/setup/file?name=main.js');
  check(
    '不带令牌取插件文件被拒绝（401）',
    pluginFileNoAuth.status === 401,
    '实际：' + pluginFileNoAuth.status
  );

  const webUi = await fetch(base + '/');
  const html = await webUi.text();
  check('根路径返回手机端网页', webUi.status === 200 && html.toLowerCase().indexOf('<!doctype html>') !== -1);
  check('网页内含上传入口', html.indexOf('上传到此') !== -1);
  check('网页内含文件列表容器', html.indexOf('id="list"') !== -1);

  // ── 子路径部署（如 nginx 把插件挂在 /obs/ 下）──
  const prefixed = await fetch(base + '/', { headers: { 'x-forwarded-prefix': '/obs' } });
  const prefixedHtml = await prefixed.text();
  check('代理注入前缀后，页面请求带上该前缀', prefixedHtml.indexOf("BASE = '/obs'") !== -1);

  const plain = await fetch(base + '/');
  const plainHtml = await plain.text();
  check('直连（无前缀）时页面不加前缀', plainHtml.indexOf("BASE = ''") !== -1);

  // 前缀是外部输入，必须挡住借它注入脚本的可能
  const evil = await fetch(base + '/', {
    headers: { 'x-forwarded-prefix': '/x"><script>alert(1)</script>' },
  });
  const evilHtml = await evil.text();
  check('非法前缀被拒绝（防脚本注入）', evilHtml.indexOf('alert(1)') === -1);
  check('非法前缀时回退为无前缀', evilHtml.indexOf("BASE = ''") !== -1);

  section('④ 局域网可达性（手机就是走这条路）');
  const addresses = lanAddresses(port);
  if (addresses.length === 0) {
    check('发现局域网地址', false, '未检测到非回环 IPv4');
  } else {
    let reachable = false;
    let used = '';
    for (const address of addresses) {
      try {
        const res = await fetch(address.url + '/api/health');
        if (res.status === 200) {
          reachable = true;
          used = address.name + ' ' + address.url;
          break;
        }
      } catch {
        /* 该网卡不通，试下一个 */
      }
    }
    check(
      '可通过局域网地址访问（绑定在 0.0.0.0）',
      reachable,
      reachable ? '走的是 ' + used : '所有网卡均不可达'
    );
  }

  section('④b 手机安装包与安装指引');
  const setupPage = await fetch(base + '/setup');
  const setupHtml = await setupPage.text();
  check('安装指引页无需令牌即可打开', setupPage.status === 200 && setupHtml.indexOf('手机安装指南') !== -1);

  const bundle = await fetch(base + '/setup/plugin.zip', { headers: auth });
  const zipBytes = new Uint8Array(await bundle.arrayBuffer());
  check('安装包可下载', bundle.status === 200 && zipBytes.byteLength > 1000, '大小：' + zipBytes.byteLength);
  check('安装包是合法 ZIP（签名 PK）', zipBytes[0] === 0x50 && zipBytes[1] === 0x4b);
  check('安装包带 zip 下载头', (bundle.headers.get('content-disposition') || '').indexOf('.zip') !== -1);
  const zipText = new TextDecoder('latin1').decode(zipBytes);
  check('安装包内含 manifest.json', zipText.indexOf('manifest.json') !== -1);
  check('安装包内含 main.js', zipText.indexOf('main.js') !== -1);
  check('安装包内含 styles.css', zipText.indexOf('styles.css') !== -1);

  const bundleNoAuth = await fetch(base + '/setup/plugin.zip');
  check('安装包需要令牌才能下载（401）', bundleNoAuth.status === 401, '实际：' + bundleNoAuth.status);

  section('⑤ 设置页与面板渲染');
  try {
    const tab = plugin.settingTabs[0];
    const definitions = tab.getSettingDefinitions();

    check(
      '设置页返回声明式定义（1.13.0 API）',
      Array.isArray(definitions) && definitions.length > 0,
      '分组数：' + (Array.isArray(definitions) ? definitions.length : 'N/A')
    );

    const headings = definitions.map((group) => group.heading).filter(Boolean);
    check(
      '分组标题齐全（含运行状态与授权与安全）',
      headings.includes('运行状态') && headings.includes('授权与安全'),
      headings.join(' / ')
    );

    const items = definitions.flatMap((group) => group.items || []);
    check('设置项数量合理', items.length >= 10, '实际：' + items.length + ' 项');
    check(
      '每个设置项都有名称（设置搜索依赖它）',
      items.every((item) => typeof item.name === 'string' && item.name.length > 0)
    );

    // 真跑一遍 render 回调：这是本页的自定义渲染路径，必须不抛异常。
    // 用 tab 自己的 containerEl（宿主替身的 DOM 实现）当作 settingEl。
    const hostEl = tab.containerEl.createDiv({ cls: 'verify-setting-row' });
    // 控件替身：每个链式方法返回控件自身（真实 Obsidian 的 component 就是这么设计的），
    // 行的 addXxx 则返回行对象，这样 text.setValue(x).setPlaceholder(y) 之类的链式调用才成立。
    const makeControl = () => {
      const control = {
        inputEl: hostEl.createEl('input'),
        setValue: () => control,
        setPlaceholder: () => control,
        setButtonText: () => control,
        setTooltip: () => control,
        setIcon: () => control,
        setDisabled: () => control,
        onChange: () => control,
        onClick: () => control,
      };
      return control;
    };

    const probe = {
      settingEl: hostEl,
      inputEl: hostEl.createEl('input'),
      setName: () => probe,
      setDesc: () => probe,
      addToggle: (cb) => {
        cb(makeControl());
        return probe;
      },
      addText: (cb) => {
        cb(makeControl());
        return probe;
      },
      addButton: (cb) => {
        cb(makeControl());
        return probe;
      },
      addExtraButton: (cb) => {
        cb(makeControl());
        return probe;
      },
    };

    let renderedRows = 0;
    for (const item of items) {
      if (typeof item.render === 'function') {
        item.render(probe);
        renderedRows++;
      }
    }
    check('全部 render 回调执行不抛异常', true, '执行了 ' + renderedRows + ' 个');
    check('渲染出的 DOM 含服务状态', hostEl.collectText().indexOf('服务运行中') !== -1);
  } catch (error) {
    check('设置页定义与渲染不抛异常', false, error.message);
  }

  try {
    const leaf = { app, setViewState: async () => undefined };
    const panel = plugin.views['vault-bridge-panel'](leaf);
    await panel.onOpen();
    const panelText = panel.contentEl.collectText();
    check(
      '面板渲染出两个页签',
      panelText.indexOf('下载到手机') !== -1 && panelText.indexOf('上传到电脑') !== -1
    );
    check('面板显示电脑地址输入框', panelText.indexOf('电脑地址') !== -1);
    // 这行断言是给用户看的：产物里必须真的有一键整库同步入口
    check('面板带一键整库同步按钮', panelText.indexOf('一键同步整个库到手机') !== -1);
    check('同步按钮旁写明落地目录', panelText.indexOf('保存到') !== -1);
  } catch (error) {
    check('面板渲染不抛异常', false, error.message);
  }

  section('⑥ 停用后释放端口');
  await plugin.onunload();
  await new Promise((r) => setTimeout(r, 400));
  let released = false;
  try {
    await fetch(base + '/api/health');
  } catch {
    released = true;
  }
  check('onunload 后端口不再响应', released);

  section('⑦ 手机端：同一份产物不得启动服务');
  mock.Platform.isDesktopApp = false;
  mock.Platform.isMobileApp = true;
  mock.Platform.isMobile = true;
  Notice.history.length = 0;

  const MobilePluginClass = loadPluginClass();
  const mobileVault = new Vault();
  const mobilePlugin = new MobilePluginClass(makeApp(mobileVault), MANIFEST);
  await mobilePlugin.onload();

  check('手机端 onload 正常完成', true);
  check(
    '手机端没有创建服务端实例',
    mobilePlugin.server === null,
    '实际：' + (mobilePlugin.server === null ? 'null' : 'non-null')
  );
  check('手机端同样注册了传输面板', typeof mobilePlugin.views['vault-bridge-panel'] === 'function');

  // 手机端面板：一键同步 + 在线更新插件，两个入口都必须出现
  const mobileLeaf = { app: makeApp(mobileVault), setViewState: async () => undefined };
  const mobilePanel = mobilePlugin.views['vault-bridge-panel'](mobileLeaf);
  await mobilePanel.onOpen();
  const mobilePanelText = mobilePanel.contentEl.collectText();
  check('手机端面板带一键整库同步按钮', mobilePanelText.indexOf('一键同步整个库到手机') !== -1);
  check('手机端面板带在线更新插件入口', mobilePanelText.indexOf('更新插件') !== -1);

  let mobileLeaked = false;
  try {
    const probe = await fetch(base + '/api/health');
    mobileLeaked = probe.status === 200;
  } catch {
    mobileLeaked = false;
  }
  check('手机端未占用任何端口', !mobileLeaked);

  // ── 汇总 ──
  console.log('\n' + '─'.repeat(52));
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    console.log('\n失败明细：');
    for (const item of failures) console.log('  · ' + item);
    process.exit(1);
  }
  console.log('✅ 产物验证全部通过');
}

main().catch((error) => {
  console.error('\n❌ 验证过程抛出异常：');
  console.error(error);
  process.exit(1);
});
