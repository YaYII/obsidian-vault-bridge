/** 展示层格式化与 MIME 推断——两端共用，出错会直接影响界面可读性。 */

import { describe, expect, it } from 'vitest';
import { formatBytes, formatTime, truncate } from '../src/shared/format';
import { isTextLike, mimeOf } from '../src/shared/mime';

describe('formatBytes', () => {
  it('小于 1KB 直接显示字节', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('按 1024 进制逐级换算', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
  });

  it('大于等于 10 时省略小数', () => {
    expect(formatBytes(15 * 1024)).toBe('15 KB');
    expect(formatBytes(200 * 1024)).toBe('200 KB');
  });

  it('非法输入返回占位符而不是崩掉界面', () => {
    expect(formatBytes(-1)).toBe('-');
    expect(formatBytes(Number.NaN)).toBe('-');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('-');
  });
});

describe('formatTime', () => {
  it('补零到分钟', () => {
    const stamp = new Date(2026, 0, 5, 9, 7).getTime();
    expect(formatTime(stamp)).toBe('2026-01-05 09:07');
  });

  it('非法时间戳返回占位符', () => {
    expect(formatTime(0)).toBe('-');
    expect(formatTime(Number.NaN)).toBe('-');
  });
});

describe('truncate', () => {
  it('短文本原样返回', () => {
    expect(truncate('abc', 10)).toBe('abc');
  });

  it('超长文本截断并加省略号', () => {
    const result = truncate('a'.repeat(30), 10);
    expect(result).toHaveLength(10);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('mimeOf', () => {
  it('常见文本类型带 charset', () => {
    expect(mimeOf('笔记.md')).toContain('text/markdown');
    expect(mimeOf('说明.txt')).toContain('text/plain');
    expect(mimeOf('数据.json')).toContain('application/json');
  });

  it('图片与文档类型', () => {
    expect(mimeOf('图.png')).toBe('image/png');
    expect(mimeOf('照片.JPG')).toBe('image/jpeg');
    expect(mimeOf('报告.pdf')).toBe('application/pdf');
    expect(mimeOf('表.xlsx')).toContain('spreadsheetml');
  });

  it('扩展名大小写无关', () => {
    expect(mimeOf('A.PNG')).toBe('image/png');
    expect(mimeOf('B.Md')).toContain('text/markdown');
  });

  it('无扩展名或未知扩展名回落为二进制流', () => {
    expect(mimeOf('没有扩展名')).toBe('application/octet-stream');
    expect(mimeOf('文件.unknownext')).toBe('application/octet-stream');
  });

  it('isTextLike 正确区分文本与二进制', () => {
    expect(isTextLike('a.md')).toBe(true);
    expect(isTextLike('a.json')).toBe(true);
    expect(isTextLike('a.png')).toBe(false);
  });
});
