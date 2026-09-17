/** 传输落点计算——「下载后文件跑哪去了」的根因大多在这里。 */

import { describe, expect, it } from 'vitest';
import {
  isUpToDate,
  normalizeDirPrefix,
  resolveDownloadTarget,
  resolveUploadTarget,
} from '../src/shared/transfer-path';

describe('normalizeDirPrefix', () => {
  it('去掉首尾斜杠', () => {
    expect(normalizeDirPrefix('/收件箱/')).toBe('收件箱');
    expect(normalizeDirPrefix('///a/b///')).toBe('a/b');
  });

  it('空串与纯斜杠都表示根目录', () => {
    expect(normalizeDirPrefix('')).toBe('');
    expect(normalizeDirPrefix('/')).toBe('');
    expect(normalizeDirPrefix('///')).toBe('');
  });

  it('去掉设置里误输入的空格', () => {
    expect(normalizeDirPrefix('  收件箱  ')).toBe('收件箱');
  });

  it('非字符串输入不崩', () => {
    expect(normalizeDirPrefix(null as unknown as string)).toBe('');
  });
});

describe('resolveDownloadTarget', () => {
  it('保持与电脑一致的相对结构', () => {
    expect(resolveDownloadTarget('VaultBridge下载', '团队知识库/IHM2/需求清单.md')).toBe(
      'VaultBridge下载/团队知识库/IHM2/需求清单.md'
    );
  });

  it('下载目录留空时落到 vault 根', () => {
    expect(resolveDownloadTarget('', '团队知识库/a.md')).toBe('团队知识库/a.md');
  });

  it('下载目录带多余斜杠也能拼对', () => {
    expect(resolveDownloadTarget('/下载/', 'a.md')).toBe('下载/a.md');
  });

  it('远程路径带前导斜杠不会拼出双斜杠', () => {
    expect(resolveDownloadTarget('下载', '/a/b.md')).toBe('下载/a/b.md');
  });

  it('顶层文件直接落在一级目录下', () => {
    expect(resolveDownloadTarget('下载', 'README.md')).toBe('下载/README.md');
  });

  it('中文与空格路径原样保留', () => {
    expect(resolveDownloadTarget('下载', '团队知识库/我的 笔记.md')).toBe('下载/团队知识库/我的 笔记.md');
  });
});

describe('resolveUploadTarget', () => {
  it('落到目标目录之下', () => {
    expect(resolveUploadTarget('收件箱', '随手记/笔记.md')).toBe('收件箱/随手记/笔记.md');
  });

  it('本地路径已含目标前缀时不重复拼接', () => {
    expect(resolveUploadTarget('收件箱', '收件箱/笔记.md')).toBe('收件箱/笔记.md');
    expect(resolveUploadTarget('收件箱', '收件箱/深/笔记.md')).toBe('收件箱/深/笔记.md');
  });

  it('只是名字前缀相同但并非该目录时要照常拼接', () => {
    // '收件箱备份' 不是 '收件箱' 的子路径，不能被误判为已在目标目录下
    expect(resolveUploadTarget('收件箱', '收件箱备份/笔记.md')).toBe('收件箱/收件箱备份/笔记.md');
  });

  it('目标目录留空时保持原路径', () => {
    expect(resolveUploadTarget('', '团队知识库/a.md')).toBe('团队知识库/a.md');
  });

  it('目标目录带斜杠也能正确判断前缀', () => {
    expect(resolveUploadTarget('/收件箱/', '收件箱/a.md')).toBe('收件箱/a.md');
  });

  it('相同路径不会拼成两遍', () => {
    expect(resolveUploadTarget('收件箱', '收件箱')).toBe('收件箱');
  });
});

describe('isUpToDate（增量同步的判定）', () => {
  const remote = { size: 1024, mtime: 1_700_000_000_000 };

  it('本地不存在 → 需要下载', () => {
    expect(isUpToDate(null, remote)).toBe(false);
    expect(isUpToDate(undefined, remote)).toBe(false);
  });

  it('大小不同 → 需要下载', () => {
    expect(isUpToDate({ size: 512, mtime: remote.mtime }, remote)).toBe(false);
  });

  it('大小相同且时间一致 → 跳过', () => {
    expect(isUpToDate({ size: 1024, mtime: remote.mtime }, remote)).toBe(true);
  });

  it('时间在容差内 → 跳过（容忍不同文件系统的时间精度）', () => {
    expect(isUpToDate({ size: 1024, mtime: remote.mtime - 1500 }, remote)).toBe(true);
    expect(isUpToDate({ size: 1024, mtime: remote.mtime + 1500 }, remote)).toBe(true);
  });

  it('时间超出容差 → 需要下载', () => {
    expect(isUpToDate({ size: 1024, mtime: remote.mtime - 5000 }, remote)).toBe(false);
  });

  it('远程时间戳缺失 → 保守重下，不误判为最新', () => {
    expect(isUpToDate({ size: 1024, mtime: 123 }, { size: 1024, mtime: 0 })).toBe(false);
    expect(isUpToDate({ size: 1024, mtime: 123 }, { size: 1024, mtime: Number.NaN })).toBe(false);
  });

  it('本地字段异常 → 不误判为最新', () => {
    expect(isUpToDate({ size: Number.NaN, mtime: remote.mtime }, remote)).toBe(false);
  });
});
