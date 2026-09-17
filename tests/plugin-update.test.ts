/**
 * 在线更新插件的校验逻辑。
 *
 * 覆盖更新的风险点是「拿错文件覆盖自己」，所以这里穷举非本插件的输入。
 */

import { describe, expect, it } from 'vitest';
import { PLUGIN_ID, readRemotePluginVersion } from '../src/shared/plugin-update';

describe('远端 manifest 校验', () => {
  it('是本插件时返回版本号', () => {
    expect(readRemotePluginVersion(JSON.stringify({ id: PLUGIN_ID, version: '1.2.3' }))).toBe('1.2.3');
  });

  it('是别的插件时拒绝，避免把别的插件覆盖成自己', () => {
    expect(readRemotePluginVersion(JSON.stringify({ id: 'other-plugin', version: '1.2.3' }))).toBeNull();
  });

  it('缺版本号或版本号不是字符串时拒绝', () => {
    expect(readRemotePluginVersion(JSON.stringify({ id: PLUGIN_ID }))).toBeNull();
    expect(readRemotePluginVersion(JSON.stringify({ id: PLUGIN_ID, version: '' }))).toBeNull();
    expect(readRemotePluginVersion(JSON.stringify({ id: PLUGIN_ID, version: 3 }))).toBeNull();
  });

  it('不是合法 JSON 时拒绝（网关出错页、空响应都不会被写进插件目录）', () => {
    expect(readRemotePluginVersion('<html>404</html>')).toBeNull();
    expect(readRemotePluginVersion('')).toBeNull();
  });

  it('JSON 不是对象时拒绝', () => {
    expect(readRemotePluginVersion('[]')).toBeNull();
    expect(readRemotePluginVersion('"vault-bridge"')).toBeNull();
    expect(readRemotePluginVersion('null')).toBeNull();
  });
});
