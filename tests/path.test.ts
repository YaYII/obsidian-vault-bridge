/** 路径安全是服务端第一道防线，这里把已知的越界手法逐个钉死。 */

import { describe, expect, it } from 'vitest';
import {
  UnsafePathError,
  baseName,
  blockedDirNames,
  joinPath,
  normalizeVaultPath,
  parentOf,
} from '../src/shared/path';

describe('normalizeVaultPath · 合法输入', () => {
  it('空串代表 vault 根目录', () => {
    expect(normalizeVaultPath('')).toBe('');
  });

  it('普通中文路径原样保留', () => {
    expect(normalizeVaultPath('团队知识库/IHM2-无息贷款/需求清单.md')).toBe(
      '团队知识库/IHM2-无息贷款/需求清单.md'
    );
  });

  it('去掉重复分隔符与当前目录标记', () => {
    expect(normalizeVaultPath('./a//b/./c.md')).toBe('a/b/c.md');
  });

  it('Windows 反斜杠被统一成正斜杠', () => {
    expect(normalizeVaultPath('a\\b\\c.md')).toBe('a/b/c.md');
  });

  it('前导斜杠被去掉，视作 vault 内相对路径', () => {
    expect(normalizeVaultPath('/a/b.md')).toBe('a/b.md');
  });

  it('中间的回退段被正确抵消', () => {
    expect(normalizeVaultPath('a/b/../c.md')).toBe('a/c.md');
  });
});

describe('normalizeVaultPath · 攻击面', () => {
  const attacks = [
    '../etc/passwd',
    '../../../../etc/shadow',
    'a/../../x',
    'a/b/../../../x',
    '..',
    './..',
    'a/../..',
  ];

  for (const attack of attacks) {
    it('拒绝越界路径 ' + JSON.stringify(attack), () => {
      expect(() => normalizeVaultPath(attack)).toThrow(UnsafePathError);
    });
  }

  it('拒绝含 NUL 字节的路径', () => {
    expect(() => normalizeVaultPath('a\u0000b')).toThrow(UnsafePathError);
  });

  it('拒绝 Windows 盘符绝对路径', () => {
    expect(() => normalizeVaultPath('C:/Windows/System32')).toThrow(UnsafePathError);
  });

  it('拒绝非字符串输入', () => {
    expect(() => normalizeVaultPath(null as unknown as string)).toThrow(UnsafePathError);
  });
});

describe('normalizeVaultPath · 受保护目录', () => {
  const blocked = [
    '.obsidian',
    '.obsidian/app.json',
    '.obsidian/plugins/vault-bridge/data.json',
    '.OBSIDIAN/app.json',
    'a/../.obsidian/x.json',
    'a/b/../../.obsidian/y',
  ];

  for (const target of blocked) {
    it('拒绝访问 ' + JSON.stringify(target), () => {
      expect(() => normalizeVaultPath(target)).toThrow(UnsafePathError);
    });
  }

  it('显式放行时可以访问（供内部调用）', () => {
    expect(normalizeVaultPath('.obsidian/app.json', { allowHidden: true })).toBe('.obsidian/app.json');
  });

  it('名字里含 obsidian 但非配置目录的照常放行', () => {
    expect(normalizeVaultPath('笔记/obsidian 使用心得.md')).toBe('笔记/obsidian 使用心得.md');
  });
});

describe('路径工具', () => {
  it('parentOf 逐级回退', () => {
    expect(parentOf('a/b/c.md')).toBe('a/b');
    expect(parentOf('a')).toBe('');
    expect(parentOf('')).toBeNull();
  });

  it('baseName 取末段', () => {
    expect(baseName('a/b/c.md')).toBe('c.md');
    expect(baseName('c.md')).toBe('c.md');
    expect(baseName('')).toBe('');
  });

  it('joinPath 拼接', () => {
    expect(joinPath('', 'a.md')).toBe('a.md');
    expect(joinPath('a/b', 'c.md')).toBe('a/b/c.md');
  });
});

describe('配置目录保护 · 不依赖硬编码的 .obsidian', () => {
  it('用户自定义的配置目录同样被拒绝', () => {
    expect(() => normalizeVaultPath('.my-config/app.json', { configDir: '.my-config' })).toThrow(
      UnsafePathError
    );
    expect(() => normalizeVaultPath('.my-config', { configDir: '.my-config' })).toThrow(UnsafePathError);
  });

  it('配置目录名带前导斜杠也能正确比较', () => {
    expect(() => normalizeVaultPath('.cfg/app.json', { configDir: '/.cfg/' })).toThrow(UnsafePathError);
  });

  it('拿不到 configDir 时，隐藏目录仍被兜底规则拒绝', () => {
    // 这是「保护不依赖调用方是否记得传参」的关键保证
    expect(() => normalizeVaultPath('.anything/x.md')).toThrow(UnsafePathError);
    expect(() => normalizeVaultPath('.trash/删掉的.md')).toThrow(UnsafePathError);
    expect(() => normalizeVaultPath('笔记/.隐藏/x.md')).toThrow(UnsafePathError);
  });

  it('深层路径里的隐藏段同样被拦下', () => {
    expect(() => normalizeVaultPath('团队知识库/.cache/a.md')).toThrow(UnsafePathError);
  });

  it('点不在开头的目录不受影响', () => {
    expect(normalizeVaultPath('a.b/c.md')).toBe('a.b/c.md');
    expect(normalizeVaultPath('版本1.0/说明.md')).toBe('版本1.0/说明.md');
    expect(normalizeVaultPath('笔记/obsidian 使用心得.md')).toBe('笔记/obsidian 使用心得.md');
  });

  it('allowHidden 仍可显式放行（供内部调用）', () => {
    expect(normalizeVaultPath('.config/a.json', { allowHidden: true })).toBe('.config/a.json');
  });
});

describe('blockedDirNames', () => {
  it('没有配置目录信息时返回空（保护由隐藏目录兜底规则承担）', () => {
    expect(blockedDirNames()).toEqual([]);
    expect(blockedDirNames('')).toEqual([]);
    expect(blockedDirNames('   ')).toEqual([]);
  });

  it('规范化大小写与斜杠', () => {
    expect(blockedDirNames('.Obsidian')).toEqual(['.obsidian']);
    expect(blockedDirNames('/.cfg/')).toEqual(['.cfg']);
  });
});
