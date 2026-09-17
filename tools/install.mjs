#!/usr/bin/env node
/**
 * 把构建产物安装到 Obsidian vault，并可选打包成手机安装包。
 *
 * 用法：
 *   node tools/install.mjs                    # 安装到默认 vault
 *   node tools/install.mjs <vault路径>        # 安装到指定 vault
 *   node tools/install.mjs --zip              # 额外生成手机安装包 zip
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ID = 'vault-bridge';
const FILES = ['main.js', 'manifest.json', 'styles.css'];

const DEFAULT_VAULT = '/home/as-workstation01/Documents/team-kb';

const args = process.argv.slice(2);
const wantZip = args.includes('--zip');
const vaultArg = args.find((arg) => !arg.startsWith('--'));
const vaultPath = resolve(vaultArg || DEFAULT_VAULT);

function fail(message) {
  console.error('❌ ' + message);
  process.exit(1);
}

if (!existsSync(vaultPath)) {
  fail('vault 路径不存在：' + vaultPath);
}
if (!existsSync(join(vaultPath, '.obsidian'))) {
  fail('该目录不是 Obsidian vault（找不到 .obsidian）：' + vaultPath);
}
for (const file of FILES) {
  if (!existsSync(join(projectRoot, file))) {
    fail('缺少构建产物 ' + file + '，请先运行 npm run build');
  }
}

const targetDir = join(vaultPath, '.obsidian', 'plugins', PLUGIN_ID);
mkdirSync(targetDir, { recursive: true });

for (const file of FILES) {
  copyFileSync(join(projectRoot, file), join(targetDir, file));
  console.log('  ✅ ' + file);
}

const manifest = JSON.parse(readFileSync(join(projectRoot, 'manifest.json'), 'utf8'));
console.log(`\n已安装 ${manifest.name} v${manifest.version}`);
console.log('目标：' + targetDir);

// 提示启用状态
const communityPath = join(vaultPath, '.obsidian', 'community-plugins.json');
let enabled = [];
if (existsSync(communityPath)) {
  try {
    enabled = JSON.parse(readFileSync(communityPath, 'utf8'));
  } catch {
    enabled = [];
  }
}
if (!Array.isArray(enabled)) enabled = [];

if (enabled.includes(PLUGIN_ID)) {
  console.log('\n✅ 该插件已在启用列表中');
} else {
  console.log('\n⚠️  尚未启用。两种启用方式：');
  console.log('   1) Obsidian → 设置 → 第三方插件 → 已安装插件 → 打开 Vault Bridge');
  console.log('   2) 或执行：node tools/install.mjs --enable');
}

if (args.includes('--enable')) {
  if (!enabled.includes(PLUGIN_ID)) {
    enabled.push(PLUGIN_ID);
    writeFileSync(communityPath, JSON.stringify(enabled, null, 2) + '\n');
    console.log('\n✅ 已写入 community-plugins.json，重启 Obsidian 后生效');
  }
}

if (wantZip) {
  const zipPath = join(projectRoot, 'vault-bridge-plugin.zip');
  try {
    execFileSync('zip', ['-j', '-q', zipPath, ...FILES.map((f) => join(projectRoot, f))]);
    console.log('\n📦 手机安装包：' + zipPath);
  } catch (error) {
    console.log('\n⚠️  生成 zip 失败（可能未安装 zip 命令）：' + error.message);
  }
}
